import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as files from '../src/fs-utils.js'
import { clearSessionCache, parseAllSessions, replayClaudeDedup } from '../src/parser.js'
import { dedupClaudeFiles } from '../src/claude-dedup-cache.js'
import { clearLoadedSessionCache, enableSessionSnapshotReuse, emptyCache, loadCache, saveCache, type CachedFile } from '../src/session-cache.js'

let root: string
const line = (id: string, day = '2026-10-30') => JSON.stringify({
  type: 'assistant', sessionId: 's', timestamp: `${day}T10:00:00Z`,
  message: { id, model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 100, output_tokens: 10 } },
}) + '\n'
const count = (projects: Awaited<ReturnType<typeof parseAllSessions>>) => projects.reduce((n, p) => n + p.totalApiCalls, 0)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'watcher-cpu-'))
  vi.stubEnv('QUANTUM_WATCHER_CACHE_DIR', join(root, 'cache'))
  vi.stubEnv('CODEBURN_CACHE_DIR', join(root, 'cache'))
  vi.stubEnv('CLAUDE_CONFIG_DIRS', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'))
  vi.stubEnv('CODEBURN_DESKTOP_SESSIONS_DIR', join(root, 'none'))
  await mkdir(join(root, 'claude/projects/p'), { recursive: true })
  clearSessionCache()
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); enableSessionSnapshotReuse(false); clearSessionCache(); await rm(root, { recursive: true, force: true }) })

it('unchanged corpus reads no transcripts; one changed file is the only reparse', async () => {
  const a = join(root, 'claude/projects/p/a.jsonl'), b = join(root, 'claude/projects/p/b.jsonl')
  await writeFile(a, line('a')); await writeFile(b, line('b'))
  const reads = vi.spyOn(files, 'readSessionLines')
  expect(count(await parseAllSessions(undefined, 'claude'))).toBe(2)
  expect(reads).toHaveBeenCalledTimes(2)
  reads.mockClear(); clearSessionCache()
  const plan = join(root, 'cache/claude-dedup-plan.json')
  const before = await stat(plan)
  expect(count(await parseAllSessions(undefined, 'claude'))).toBe(2)
  expect(reads).not.toHaveBeenCalled()
  expect((await stat(plan)).mtimeMs).toBe(before.mtimeMs)
  await appendFile(b, line('c')); reads.mockClear(); clearSessionCache()
  expect(count(await parseAllSessions(undefined, 'claude'))).toBe(3)
  expect(reads).toHaveBeenCalledTimes(1)
  expect(reads.mock.calls[0]![0]).toBe(b)
})

it('the reusable replay does not cache the date filter: midnight selects the new day', async () => {
  await writeFile(join(root, 'claude/projects/p/a.jsonl'), line('old', '2026-10-29') + JSON.stringify({ type: 'user', message: { role: 'user', content: 'next' } }) + '\n' + line('new'))
  const day = (d: string) => ({ start: new Date(`${d}T00:00:00Z`), end: new Date(`${d}T23:59:59Z`) })
  expect(count(await parseAllSessions(day('2026-10-29'), 'claude'))).toBe(1)
  clearSessionCache()
  const reads = vi.spyOn(files, 'readSessionLines')
  const next = await parseAllSessions(day('2026-10-30'), 'claude')
  expect(count(next)).toBe(1)
  expect(next[0]!.sessions[0]!.turns[0]!.assistantCalls[0]!.deduplicationKey).toBe('new')
  expect(reads).not.toHaveBeenCalled()
})

it('a changed early duplicate invalidates later winners; corruption and selection order replay safely', async () => {
  await writeFile(join(root, 'claude/projects/p/a.jsonl'), line('shared'))
  await writeFile(join(root, 'claude/projects/p/b.jsonl'), line('shared') + line('unique'))
  await parseAllSessions(undefined, 'claude')
  const cache = await loadCache()
  const sources = Object.entries(cache.providers.claude!.files).map(([path, file]) => ({ path, file }))
  const replay = vi.fn(replayClaudeDedup)
  const cold = await dedupClaudeFiles(sources, replay)
  replay.mockClear()
  expect(await dedupClaudeFiles(sources, replay)).toEqual(cold)
  expect(replay).not.toHaveBeenCalled()
  const reversed = [...sources].reverse()
  await dedupClaudeFiles(reversed, replay)
  expect(replay).toHaveBeenCalledTimes(2)
  replay.mockClear()
  const changed: CachedFile = { ...sources[0]!.file, turns: [], fingerprint: { ...sources[0]!.file.fingerprint, sizeBytes: 0 } }
  const result = await dedupClaudeFiles([{ ...sources[0]!, file: changed }, sources[1]!], replay)
  expect(replay).toHaveBeenCalledTimes(2)
  expect(result.get(sources[1]!.path)!.flatMap(t => t.calls).length).toBe(2)
  await writeFile(join(root, 'cache/claude-dedup-plan.json'), '{broken')
  replay.mockClear(); await dedupClaudeFiles(sources, replay)
  expect(replay).toHaveBeenCalledTimes(2)
})

it('shares one validated JSON snapshot, invalidating replacement and deletion', async () => {
  enableSessionSnapshotReuse()
  await saveCache(emptyCache()); clearLoadedSessionCache()
  const first = await loadCache()
  expect(await loadCache()).toBe(first)
  const file = join(root, 'cache/session-cache.json')
  await writeFile(file, await readFile(file))
  expect(await loadCache()).not.toBe(first)
  await rm(file)
  expect((await loadCache()).providers).toEqual({})
})

it('snapshot reuse never bypasses r5b validation after a save', async () => {
  enableSessionSnapshotReuse()
  await saveCache({ version: -1, providers: {} })
  expect(await loadCache()).toEqual(emptyCache())
})
