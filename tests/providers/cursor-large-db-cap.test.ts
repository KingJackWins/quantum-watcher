import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { isSqliteAvailable } from '../../src/sqlite.js'
import { getAllProviders } from '../../src/providers/index.js'
import type { Provider, ParsedProviderCall } from '../../src/providers/types.js'
import type { DateRange } from '../../src/types.js'

/// Tests for the Cursor large-DB scan cap: when the database has more bubbles
/// than MAX_BUBBLES, the scan is limited to the most-recent rows by ROWID.
/// We shrink the budget via CODEBURN_CURSOR_MAX_BUBBLES so a tiny fixture
/// exercises the capped path. Note: the ROWID-based cap may drop in-range
/// sessions that have low ROWIDs when newer out-of-range rows exist.

const skipReason = isSqliteAvailable() ? null : 'node:sqlite not available — needs Node 22+; skipping'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cursor-cap-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

type Bubble = { conversationId: string; createdAt: string; model: string; tokens: number }

/// Inserts assistant bubbles in array order, so ROWID follows array index.
async function createDb(bubbles: Bubble[]): Promise<string> {
  const dbPath = join(tmpDir, 'state.vscdb')
  await writeFile(dbPath, '')
  const Module = await import('node:module')
  const requireForSqlite = Module.createRequire(import.meta.url)
  const { DatabaseSync } = requireForSqlite('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void
      prepare(sql: string): { run(...p: unknown[]): unknown }
      close(): void
    }
  }
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
  const stmt = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
  bubbles.forEach((b, i) => {
    stmt.run(
      `bubbleId:${b.conversationId}:bubble-${i}`,
      JSON.stringify({
        type: 2,
        conversationId: b.conversationId,
        text: 'def hello(): pass',
        tokenCount: { inputTokens: b.tokens, outputTokens: b.tokens },
        createdAt: b.createdAt,
        modelInfo: { modelName: b.model },
      }),
    )
  })
  db.close()
  return dbPath
}

async function getCursorProvider(): Promise<Provider> {
  const p = (await getAllProviders()).find(p => p.name === 'cursor')
  if (!p) throw new Error('cursor provider not registered')
  return p
}

async function parse(dbPath: string, range: DateRange): Promise<ParsedProviderCall[]> {
  const provider = await getCursorProvider()
  const source = { path: dbPath, project: 'test', provider: 'cursor' }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, new Set<string>(), range).parse()) {
    calls.push(call)
  }
  return calls
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
const last30Days = (): DateRange => ({ start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), end: new Date() })
const last120Days = (): DateRange => ({ start: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000), end: new Date() })

describe.skipIf(skipReason !== null)('cursor large-DB scan cap (#482)', () => {
  it('ROWID cap scans only newest rows — in-range low-ROWID rows may be skipped', async () => {
    // In-range bubbles inserted FIRST (low ROWID); out-of-range bubbles inserted
    // LATER (high ROWID). The ROWID cap keeps the 2 newest by ROWID (old-C, old-D),
    // which are out-of-range, so no in-range calls are returned.
    const dbPath = await createDb([
      { conversationId: 'recent-A', createdAt: iso(1), model: 'gpt-5', tokens: 100 },
      { conversationId: 'recent-B', createdAt: iso(2), model: 'gpt-5', tokens: 100 },
      { conversationId: 'old-C', createdAt: iso(300), model: 'gpt-5', tokens: 100 },
      { conversationId: 'old-D', createdAt: iso(300), model: 'gpt-5', tokens: 100 },
    ])
    process.env['CODEBURN_CURSOR_MAX_BUBBLES'] = '2' // total 4 > budget 2 -> capped path

    const calls = await parse(dbPath, last30Days())
    // ROWID cap scans only the 2 highest-ROWID rows, both out-of-range.
    expect(calls.length).toBe(0)
  })

  it('returns partial window when ROWID cap includes some in-range rows', async () => {
    const dbPath = await createDb([
      { conversationId: 'A', createdAt: iso(1), model: 'gpt-5', tokens: 100 },
      { conversationId: 'B', createdAt: iso(2), model: 'gpt-5', tokens: 100 },
      { conversationId: 'old', createdAt: iso(300), model: 'gpt-5', tokens: 100 },
      { conversationId: 'older', createdAt: iso(301), model: 'gpt-5', tokens: 100 },
    ])
    process.env['CODEBURN_CURSOR_MAX_BUBBLES'] = '3' // total 4 > budget 3, keeps 3 newest by ROWID
    const calls = await parse(dbPath, last30Days())
    expect(calls.length).toBe(1) // only B (ROWID 2) is in the top-3 AND in-range
  })

  it('truncates to the budget and keeps the newest in-range bubbles when over budget', async () => {
    // Four in-range bubbles, oldest->newest by ROWID; budget 2 keeps the two newest.
    const dbPath = await createDb([
      { conversationId: 'd1', createdAt: iso(40), model: 'old-model', tokens: 100 },
      { conversationId: 'd2', createdAt: iso(30), model: 'old-model', tokens: 100 },
      { conversationId: 'd3', createdAt: iso(2), model: 'new-model', tokens: 100 },
      { conversationId: 'd4', createdAt: iso(1), model: 'new-model', tokens: 100 },
    ])
    process.env['CODEBURN_CURSOR_MAX_BUBBLES'] = '2' // total 4 > budget 2
    const calls = await parse(dbPath, last120Days())
    expect(calls.length).toBe(2)
    // Budget keeps the highest-ROWID (newest-inserted) bubbles.
    expect(calls.every(c => c.model === 'new-model')).toBe(true)
  })
})
