// Claude session cache: entries are stored BEFORE cross-file dedup and the dedup
// is replayed fresh every run, so one cache serves every CLAUDE_CONFIG_DIR(S)
// selection. Required property: after ANY sequence of runs under ANY selection,
// with transcripts added, appended, rewritten or deleted in between (and crashes
// or concurrent writers disturbing the cache), each run's output equals a COLD
// run (empty cache) for that selection at that moment.
//
// The cold reference here is this code with an empty cache dir. That cold run
// equals base's cold run because (1) per file, `groupIntoClaudeSegments` +
// `replayClaudeDedup` is `groupIntoTurns` — the differential block below — and
// (2) the replay visits files in base's discovery order with one shared `seen`
// set, as base's cold scan did. (Round 5's maker harness additionally compared
// against the unpatched base code itself; see ROUND5-MAKER-REPORT.md.)

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  clearSessionCache,
  claudeSegmentsToCache,
  dedupeStreamingMessageIds,
  groupIntoClaudeSegments,
  groupIntoTurns,
  parseAllSessions,
  parseJsonlLine,
  compactEntry,
  replayClaudeDedup,
} from '../src/parser.js'
import { loadCache, type CachedFile } from '../src/session-cache.js'
import type { JournalEntry } from '../src/types.js'
import { mulberry32, runRandomSequence, selectionEnv, type DayRange, type World } from './fixtures/claude-world.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qw-claude-sel-'))
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(root, 'desktop-none')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function runClaude(env: { CLAUDE_CONFIG_DIRS?: string; CLAUDE_CONFIG_DIR?: string }, cacheDir: string, range?: DayRange): Promise<unknown> {
  clearSessionCache()
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CLAUDE_CONFIG_DIRS']
  Object.assign(process.env, env)
  process.env['QUANTUM_WATCHER_CACHE_DIR'] = cacheDir
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  const projects = await parseAllSessions(range, 'claude')
  return JSON.parse(JSON.stringify(projects))
}

let coldN = 0
async function runCold(env: { CLAUDE_CONFIG_DIRS?: string; CLAUDE_CONFIG_DIR?: string }, range?: DayRange): Promise<unknown> {
  const dir = join(root, `cold-${coldN++}`)
  const out = await runClaude(env, dir, range)
  await rm(dir, { recursive: true, force: true })
  return out
}

function calls(projects: unknown): number {
  return (projects as Array<{ totalApiCalls: number }>).reduce((s, p) => s + p.totalApiCalls, 0)
}

// ── per-file split equals groupIntoTurns (differential) ─────────────────

describe('groupIntoClaudeSegments + replayClaudeDedup == groupIntoTurns', () => {
  const ids = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']
  function randomEntries(rng: () => number): JournalEntry[] {
    const n = Math.floor(rng() * 14)
    const out: JournalEntry[] = []
    for (let i = 0; i < n; i++) {
      const r = rng()
      const ts = `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`
      let raw: unknown
      if (r < 0.3) raw = { type: 'user', timestamp: ts, sessionId: 's', message: { role: 'user', content: rng() < 0.3 ? '  ' : `u${i}` } }
      else if (r < 0.36) raw = { type: 'assistant', timestamp: ts, message: { id: ids[Math.floor(rng() * ids.length)], role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 't', name: 7, input: {} }], usage: { input_tokens: 1, output_tokens: 1 } } }
      else if (r < 0.4) raw = { type: 'assistant', timestamp: ts, message: { id: ids[Math.floor(rng() * ids.length)], role: 'assistant', model: 'claude-sonnet-4-5', content: [] } }
      else raw = { type: 'assistant', timestamp: ts, message: { ...(rng() < 0.1 ? {} : { id: ids[Math.floor(rng() * ids.length)] }), role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }], usage: { input_tokens: Math.floor(rng() * 100), output_tokens: 3 } } }
      out.push(compactEntry(parseJsonlLine(JSON.stringify(raw))!))
    }
    return out
  }

  it('matches for 3,000 random multi-file runs, including files that throw', () => {
    const rng = mulberry32(20261014)
    for (let run = 0; run < 3000; run++) {
      const files = Array.from({ length: 1 + Math.floor(rng() * 4) }, () => dedupeStreamingMessageIds(randomEntries(rng)))
      const seenBase = new Set<string>()
      const seenNew = new Set<string>()
      for (const entries of files) {
        let expected: unknown
        try {
          expected = groupIntoTurns(entries, seenBase).map(t => ({ u: t.userMessage, ts: t.timestamp, s: t.sessionId, c: t.assistantCalls.map(c => [c.deduplicationKey, c.usage.inputTokens]) }))
        } catch {
          expected = 'failed'
        }
        const { turns, markers } = claudeSegmentsToCache(groupIntoClaudeSegments(entries))
        const file: CachedFile = { fingerprint: { dev: 0, ino: 0, mtimeMs: 0, sizeBytes: 0 }, mcpInventory: [], turns, ...(markers ? { markers } : {}) }
        const replayed = replayClaudeDedup(file, seenNew)
        const actual = replayed === null ? 'failed' : replayed.map(t => ({ u: t.userMessage, ts: t.timestamp, s: t.sessionId, c: t.calls.map(c => [c.deduplicationKey, c.usage.inputTokens]) }))
        expect(actual).toEqual(expected)
        expect([...seenNew]).toEqual([...seenBase])
      }
    }
  })
})

// ── the round-3 and round-4 verdict scenarios ───────────────────────────

describe('selection switches with a message M duplicated across dirs', () => {
  // A (dir c1) and B (dir c2) both carry M; each also has one call of its own.
  async function setup(): Promise<{ A: string; B: string; world: World; cache: string }> {
    const world: World = { root, mtime: 1_767_225_600 }
    const mk = (id: string, input: number) => JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-01-01T10:00:00.000Z', message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: input, output_tokens: 10 } } })
    const user = JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-01-01T09:59:00.000Z', message: { role: 'user', content: 'go' } })
    const A = join(root, 'c1', 'projects', 'p', 'a.jsonl')
    const B = join(root, 'c2', 'projects', 'p', 'b.jsonl')
    await mkdir(join(root, 'c1', 'projects', 'p'), { recursive: true })
    await mkdir(join(root, 'c2', 'projects', 'p'), { recursive: true })
    await writeFile(A, [user, mk('M', 100), mk('A1', 200)].join('\n') + '\n')
    await writeFile(B, [user, mk('M', 100), mk('B1', 300)].join('\n') + '\n')
    return { A, B, world, cache: join(root, 'warm-cache') }
  }
  const AB = (w: World) => selectionEnv(w, ['c1', 'c2'])
  const Bonly = (w: World) => selectionEnv(w, ['c2'])

  it('round 3 finding 1: warm A+B, switch to B, delete A, return to A+B', async () => {
    const { A, world, cache } = await setup()
    expect(calls(await runClaude(AB(world), cache))).toBe(3)
    expect(calls(await runClaude(Bonly(world), cache))).toBe(2)
    await rm(A)
    const back = await runClaude(AB(world), cache)
    expect(calls(back)).toBe(2) // M (now from B) + B1; the slot design dropped M
    expect(back).toEqual(await runCold(AB(world)))
  })

  it('round 4 finding 1: warm A+B, delete A, run A+B, run B, return to A+B', async () => {
    const { A, world, cache } = await setup()
    await runClaude(AB(world), cache)
    await rm(A)
    const same = await runClaude(AB(world), cache)
    expect(calls(same)).toBe(2) // base WARM undercounts here (1); base cold says 2
    expect(same).toEqual(await runCold(AB(world)))
    expect(await runClaude(Bonly(world), cache)).toEqual(await runCold(Bonly(world)))
    const back = await runClaude(AB(world), cache)
    expect(calls(back)).toBe(2)
    expect(back).toEqual(await runCold(AB(world)))
  })

  it('round 4 finding 4: a run killed before its cache save, then the same selection again', async () => {
    const { A, world, cache } = await setup()
    await runClaude(AB(world), cache)
    await runClaude(Bonly(world), cache)
    await rm(A)
    const before = await readFile(join(cache, 'session-cache.json'))
    const killed = await runClaude(AB(world), cache)
    await writeFile(join(cache, 'session-cache.json'), before) // its save never landed
    await writeFile(join(cache, 'session-cache.json.00000000deadbeef.tmp'), '{"version":4,') // nor its rename
    expect(killed).toEqual(await runCold(AB(world)))
    const again = await runClaude(AB(world), cache)
    expect(calls(again)).toBe(2)
    expect(again).toEqual(await runCold(AB(world)))
  })

  it('B first, then A+B: M moves to A (first seen wins in discovery order); reversed order keeps it in B', async () => {
    const { world, cache } = await setup()
    await runClaude(Bonly(world), cache)
    const ab = await runClaude(AB(world), cache) as Array<{ sessions: Array<{ sessionId: string; apiCalls: number }> }>
    expect(ab).toEqual(await runCold(AB(world)))
    const sessions = ab.flatMap(p => p.sessions)
    expect(sessions.find(s => s.sessionId === 'a')!.apiCalls).toBe(2)
    expect(sessions.find(s => s.sessionId === 'b')!.apiCalls).toBe(1)
    const ba = await runClaude(selectionEnv(world, ['c2', 'c1']), cache)
    expect(ba).toEqual(await runCold(selectionEnv(world, ['c2', 'c1'])))
    const s2 = (ba as typeof ab).flatMap(p => p.sessions)
    expect(s2.find(s => s.sessionId === 'b')!.apiCalls).toBe(2)
    expect(s2.find(s => s.sessionId === 'a')!.apiCalls).toBe(1)
  })

  it('rewriting A without M while away, and appending M back later', async () => {
    const { A, world, cache } = await setup()
    await runClaude(AB(world), cache)
    await runClaude(Bonly(world), cache)
    await writeFile(A, JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-01-01T11:00:00.000Z', message: { id: 'A9', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 5, output_tokens: 1 } } }) + '\n')
    await utimes(A, new Date(1_800_000_000_000), new Date(1_800_000_000_000))
    expect(await runClaude(AB(world), cache)).toEqual(await runCold(AB(world)))
    await writeFile(A, (await readFile(A, 'utf8')) + JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-01-01T12:00:00.000Z', message: { id: 'M', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 100, output_tokens: 10 } } }) + '\n')
    await utimes(A, new Date(1_800_000_100_000), new Date(1_800_000_100_000))
    expect(await runClaude(Bonly(world), cache)).toEqual(await runCold(Bonly(world)))
    expect(await runClaude(AB(world), cache)).toEqual(await runCold(AB(world)))
  })

  it('app and shell selections share one cache: neither evicts the other', async () => {
    const { world, cache } = await setup()
    await runClaude(AB(world), cache)
    await runClaude(Bonly(world), cache)
    const saved = JSON.parse(await readFile(join(cache, 'session-cache.json'), 'utf8'))
    const files = Object.keys(saved.providers.claude.files)
    expect(files.some(f => f.endsWith('a.jsonl'))).toBe(true)
    expect(files.some(f => f.endsWith('b.jsonl'))).toBe(true)
  })
})

// ── round-5 verdict findings ───────────────────────────────────────────

function assistant(id: string, usage: Record<string, unknown>, ts = '2026-01-01T10:00:00.000Z'): string {
  return JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: ts, message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage } })
}
const userLine = JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-01-01T09:59:00.000Z', message: { role: 'user', content: 'go' } })

describe('finding 1: a call the cache validator rejects is never saved', () => {
  async function setup() {
    const world: World = { root, mtime: 0 }
    await mkdir(join(root, 'c1', 'projects', 'p'), { recursive: true })
    await mkdir(join(root, 'c2', 'projects', 'p'), { recursive: true })
    // A: valid M. B: the same M with usage.speed "invalid" (parses; fails validateCall).
    await writeFile(join(root, 'c1', 'projects', 'p', 'a.jsonl'), [userLine, assistant('M', { input_tokens: 100, output_tokens: 10 }), assistant('A1', { input_tokens: 5, output_tokens: 1 })].join('\n') + '\n')
    await writeFile(join(root, 'c2', 'projects', 'p', 'b.jsonl'), [userLine, assistant('M', { input_tokens: 100, output_tokens: 10, speed: 'invalid' }), assistant('B1', { input_tokens: 6, output_tokens: 1 })].join('\n') + '\n')
    return { world, cache: join(root, 'warm-cache') }
  }

  for (const order of [['c1', 'c2'], ['c2', 'c1']]) {
    it(`order ${order.join(':')} (${order[0] === 'c1' ? 'valid copy first' : 'malformed copy first'}): equals cold, and the saved cache still loads`, async () => {
      const { world, cache } = await setup()
      const env = selectionEnv(world, order)
      const first = await runClaude(env, cache)
      expect(first).toEqual(await runCold(env))
      process.env['QUANTUM_WATCHER_CACHE_DIR'] = cache
      const loaded = await loadCache() // rejects the WHOLE cache if any entry is invalid
      const files = Object.keys(loaded.providers['claude']?.files ?? {})
      expect(files.some(f => f.endsWith('a.jsonl'))).toBe(true)
      expect(files.some(f => f.endsWith('b.jsonl'))).toBe(false) // kept for the run only
      expect(await runClaude(env, cache)).toEqual(await runCold(env))
      expect(await runClaude(selectionEnv(world, ['c2']), cache)).toEqual(await runCold(selectionEnv(world, ['c2'])))
      expect(await runClaude(env, cache)).toEqual(await runCold(env))
    })
  }
})

describe('finding 2: an in-place same-size rewrite that restores mtime', () => {
  it('run A, run B, rewrite A 100 -> 900 keeping size and mtime, return to A: 900', async () => {
    const world: World = { root, mtime: 0 }
    const A = join(root, 'c1', 'projects', 'p', 'a.jsonl')
    await mkdir(join(root, 'c1', 'projects', 'p'), { recursive: true })
    await mkdir(join(root, 'c2', 'projects', 'p'), { recursive: true })
    await writeFile(A, [userLine, assistant('A1', { input_tokens: 100, output_tokens: 10 })].join('\n') + '\n')
    await utimes(A, 1_767_225_600, 1_767_225_600) // whole seconds, so restoring it later is exact
    await writeFile(join(root, 'c2', 'projects', 'p', 'b.jsonl'), [userLine, assistant('B1', { input_tokens: 7, output_tokens: 1 })].join('\n') + '\n')
    const cache = join(root, 'warm-cache')
    const input = (ps: unknown) => (ps as Array<{ sessions: Array<{ totalInputTokens: number }> }>).flatMap(p => p.sessions).reduce((s, x) => s + x.totalInputTokens, 0)
    expect(input(await runClaude(selectionEnv(world, ['c1']), cache))).toBe(100)
    await runClaude(selectionEnv(world, ['c2']), cache)
    const before = await stat(A)
    await writeFile(A, (await readFile(A, 'utf8')).replace('"input_tokens":100', '"input_tokens":900'))
    await utimes(A, before.atime, before.mtime)
    const after = await stat(A)
    expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino])
    const back = await runClaude(selectionEnv(world, ['c1']), cache)
    expect(input(back)).toBe(900)
    expect(back).toEqual(await runCold(selectionEnv(world, ['c1'])))
  })
})

describe('finding 3: one transcript discovered twice in a run (overlapping config dirs)', () => {
  it('/C and /C/projects/P/subagents/N with M in N/projects/Q: equals cold (base: the second parse suppresses M, 0 calls)', async () => {
    const C = join(root, 'C')
    const N = join(C, 'projects', 'P', 'subagents', 'N')
    await mkdir(join(N, 'projects', 'Q'), { recursive: true })
    await writeFile(join(N, 'projects', 'Q', 'x.jsonl'), [userLine, assistant('M', { input_tokens: 100, output_tokens: 10 })].join('\n') + '\n')
    const env = { CLAUDE_CONFIG_DIRS: `${C}:${N}` }
    const cache = join(root, 'warm-cache')
    const cold = await runCold(env)
    expect(calls(cold)).toBe(0)
    expect(await runClaude(env, cache)).toEqual(cold)
    expect(await runClaude(env, cache)).toEqual(cold) // warm
    expect(await runClaude({ CLAUDE_CONFIG_DIR: N }, cache)).toEqual(await runCold({ CLAUDE_CONFIG_DIR: N }))
    expect(await runClaude(env, cache)).toEqual(cold)
  })
})

// ── randomized: warm vs cold over random selections and mutations ───────

describe('random sequences of selections, transcript mutations and cache disturbances', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${seed}: every warm run equals the cold run`, async () => {
      const failure = await runRandomSequence({
        seed,
        steps: 40,
        root: join(root, 'world'),
        warmCacheDir: join(root, 'warm-cache'),
        runWarm: (w, sel, range) => runClaude(selectionEnv(w, sel), join(root, 'warm-cache'), range),
        runColdReference: (w, sel, range) => runCold(selectionEnv(w, sel), range),
        equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      })
      if (failure) expect({ step: failure.step, log: failure.log, warm: failure.warm }).toEqual({ step: failure.step, log: failure.log, warm: failure.cold })
    }, 120_000)
  }
})
