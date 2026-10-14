// A small random world of Claude config dirs for cache/dedup property tests.
//
// Three config dirs (c1..c3), each with `projects/<slug>/<session>.jsonl` plus
// some `subagents/` transcripts. Every assistant message id comes from one small
// shared pool, so cross-file duplicates (resumed sessions, subagents echoing a
// parent) are the norm, not the exception. Mutations add, append to, rewrite,
// truncate, copy and delete transcripts and whole project dirs. Every write sets
// a fresh, strictly increasing mtime so a changed file is always visible to the
// fingerprint (a same-size same-mtime rewrite is invisible to base too).

import { mkdir, rm, writeFile, appendFile, utimes, readdir, stat, readFile } from 'fs/promises'
import { join, dirname } from 'path'

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))

// c4 is nested inside c1's alpha project's `subagents/`, so any transcript under
// c4/projects/ is discovered twice when c1 and c4 are both selected (once by
// c1's recursive subagent scan, once as a c4 project file).
export const CONFIG_DIRS = ['c1', 'c2', 'c3', 'c1/projects/-Users-me-alpha/subagents/nest'] as const
const SLUGS = ['-Users-me-alpha', '-Users-me-beta', '-Users-me-gamma'] as const
const MODELS = ['claude-sonnet-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'] as const
const ID_POOL = Array.from({ length: 14 }, (_, i) => `msg_${i}`)
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Agent', 'mcp__srv__do'] as const

export type World = { root: string; mtime: number }

export function worldDir(world: World, configDir: string): string {
  return join(world.root, configDir)
}

function line(rng: Rng, sessionId: string, day: number): string {
  const ts = `2026-01-0${day}T${String(int(rng, 0, 23)).padStart(2, '0')}:${String(int(rng, 0, 59)).padStart(2, '0')}:00.000Z`
  const r = rng()
  if (r < 0.28) {
    const text = pick(rng, ['fix the bug', 'add tests', '', '   ', 'refactor this', 'why?'])
    return JSON.stringify({ type: 'user', sessionId, timestamp: ts, ...(rng() < 0.3 ? { cwd: '/nonexistent/qw-world/proj' } : {}), message: { role: 'user', content: text } })
  }
  if (r < 0.31) {
    // Assistant entry without usage: compactEntry drops its message (and id).
    return JSON.stringify({ type: 'assistant', sessionId, timestamp: ts, message: { id: pick(rng, ID_POOL), role: 'assistant', model: pick(rng, MODELS), content: [] } })
  }
  if (r < 0.33) {
    // parseApiCall throws on it (a non-string tool name reaches startsWith):
    // base records the whole file as failed, after marking earlier ids seen.
    return JSON.stringify({ type: 'assistant', sessionId, timestamp: ts, message: { id: pick(rng, ID_POOL), type: 'message', role: 'assistant', model: pick(rng, MODELS), content: [{ type: 'tool_use', id: 't', name: 123, input: {} }], usage: { input_tokens: 5, output_tokens: 5 } } })
  }
  if (r < 0.35) return 'not json {'
  if (r < 0.39) {
    // Parses, but the cache validator rejects it (speed not standard|fast, or a
    // non-number token count): base saved it only when it was not suppressed.
    const bad = rng() < 0.5 ? { speed: 'invalid' } : { input_tokens: '120' }
    return JSON.stringify({ type: 'assistant', sessionId, timestamp: ts, message: { id: pick(rng, ID_POOL), type: 'message', role: 'assistant', model: pick(rng, MODELS), content: [], usage: { input_tokens: 7, output_tokens: 3, ...bad } } })
  }
  const tools = Array.from({ length: int(rng, 0, 2) }, () => ({ type: 'tool_use', id: `tu${int(rng, 0, 999)}`, name: pick(rng, TOOLS), input: { command: 'git status', file_path: '/x/y.ts', subagent_type: 'Explore' } }))
  const noId = rng() < 0.06
  return JSON.stringify({
    type: 'assistant', sessionId, timestamp: ts,
    message: {
      ...(noId ? {} : { id: pick(rng, ID_POOL) }),
      type: 'message', role: 'assistant', model: pick(rng, MODELS), content: tools,
      usage: { input_tokens: int(rng, 1, 5000), output_tokens: int(rng, 1, 2000), cache_read_input_tokens: int(rng, 0, 9000), cache_creation_input_tokens: int(rng, 0, 3000) },
    },
  })
}

function lines(rng: Rng, sessionId: string, n: number): string {
  const day = int(rng, 1, 3)
  return Array.from({ length: n }, () => line(rng, sessionId, day)).join('\n') + '\n'
}

async function touch(world: World, path: string): Promise<void> {
  world.mtime += 7
  const t = new Date(world.mtime * 1000)
  await utimes(path, t, t)
}

async function writeTranscript(world: World, path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  await touch(world, path)
}

export async function listTranscripts(world: World): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string): Promise<void> {
    const es = await readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of es) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  await walk(world.root)
  return out.sort()
}

function newTranscriptPath(world: World, rng: Rng): string {
  const cfg = pick(rng, CONFIG_DIRS)
  const slug = pick(rng, SLUGS)
  const sess = `s${int(rng, 0, 9)}`
  return rng() < 0.25
    ? join(world.root, cfg, 'projects', slug, sess, 'subagents', `agent-${int(rng, 0, 3)}.jsonl`)
    : join(world.root, cfg, 'projects', slug, `${sess}.jsonl`)
}

export async function createWorld(root: string, rng: Rng): Promise<World> {
  const world: World = { root, mtime: 1_767_225_600 }
  for (const cfg of CONFIG_DIRS) await mkdir(join(root, cfg, 'projects'), { recursive: true })
  const n = int(rng, 6, 12)
  for (let i = 0; i < n; i++) {
    const p = newTranscriptPath(world, rng)
    await writeTranscript(world, p, lines(rng, `s${i}`, int(rng, 1, 10)))
  }
  return world
}

/// One random filesystem mutation; returns a description for failure messages.
export async function mutate(world: World, rng: Rng): Promise<string> {
  const files = await listTranscripts(world)
  const op = rng()
  if (op < 0.2 || files.length === 0) {
    const p = newTranscriptPath(world, rng)
    await writeTranscript(world, p, lines(rng, `n${int(rng, 0, 99)}`, int(rng, 1, 8)))
    return `add ${p}`
  }
  const f = pick(rng, files)
  if (op < 0.42) {
    await appendFile(f, lines(rng, 'app', int(rng, 1, 5)))
    await touch(world, f)
    return `append ${f}`
  }
  if (op < 0.56) {
    await writeTranscript(world, f, lines(rng, 'rw', int(rng, 1, 9)))
    return `rewrite ${f}`
  }
  if (op < 0.64) {
    const size = (await stat(f)).size
    const keep = (await readFile(f, 'utf8')).slice(0, Math.floor(size * rng()))
    await writeTranscript(world, f, keep)
    return `truncate ${f}`
  }
  if (op < 0.74) {
    // Resume-style copy: another transcript starts with this one's history.
    const p = newTranscriptPath(world, rng)
    await writeTranscript(world, p, (await readFile(f, 'utf8')) + lines(rng, 'cp', int(rng, 0, 3)))
    return `copy ${f} -> ${p}`
  }
  if (op < 0.8) {
    // In-place rewrite that keeps the size and restores the mtime: only ctime
    // (and the content) show it. Swap every digit 1..8 for its successor.
    const before = await stat(f)
    const text = await readFile(f, 'utf8')
    await writeFile(f, text.replace(/[1-8]/g, d => String(Number(d) + 1)))
    await utimes(f, before.atime, before.mtime)
    return `rewrite-same-size-restore-mtime ${f}`
  }
  if (op < 0.94) {
    await rm(f, { force: true })
    return `delete ${f}`
  }
  const projDir = f.slice(0, f.indexOf('/', f.indexOf('/projects/') + '/projects/'.length))
  await rm(projDir, { recursive: true, force: true })
  return `delete-project ${projDir}`
}

/// A random ordered, non-empty selection of config dirs (order matters: it is
/// the discovery order, and cross-file dedup is first-seen-wins).
export function randomSelection(rng: Rng): string[] {
  const shuffled: string[] = [...CONFIG_DIRS]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }
  return shuffled.slice(0, int(rng, 1, CONFIG_DIRS.length))
}

export function selectionEnv(world: World, selection: string[]): { CLAUDE_CONFIG_DIRS?: string; CLAUDE_CONFIG_DIR?: string } {
  const paths = selection.map(c => worldDir(world, c))
  return paths.length === 1 ? { CLAUDE_CONFIG_DIR: paths[0] } : { CLAUDE_CONFIG_DIRS: paths.join(':') }
}

export type DayRange = { start: Date; end: Date }
export type Runner = (world: World, selection: string[], range?: DayRange) => Promise<unknown>

/// Drive a random sequence: before each step, mutate the world and/or disturb
/// the warm cache the way crashes and concurrent writers can; then run the warm
/// runner and the cold reference for a random selection and compare. Returns
/// the first mismatch (with the step log) or null.
export async function runRandomSequence(opts: {
  seed: number
  steps: number
  root: string
  warmCacheDir: string
  runWarm: Runner
  runColdReference: Runner
  equal: (a: unknown, b: unknown) => boolean
}): Promise<{ log: string[]; step: number; warm: unknown; cold: unknown } | null> {
  const rng = mulberry32(opts.seed)
  const world = await createWorld(opts.root, rng)
  const cacheFile = join(opts.warmCacheDir, 'session-cache.json')
  const snapshots: Buffer[] = []
  const log: string[] = []
  for (let step = 0; step < opts.steps; step++) {
    const nMut = rng() < 0.3 ? 0 : int(rng, 1, 3)
    for (let k = 0; k < nMut; k++) log.push(`${step}: ${await mutate(world, rng)}`)

    const ev = rng()
    let restoreAfter: Buffer | null = null
    const current = await readFile(cacheFile).catch(() => null)
    if (current) snapshots.push(current)
    if (ev < 0.1 && current) {
      // Killed after parsing, before saveCache landed: this run's save is lost.
      restoreAfter = current
      log.push(`${step}: lost-save`)
    } else if (ev < 0.2 && snapshots.length > 1) {
      // A slower concurrent writer saved last (whole-file last-writer-wins).
      const old = snapshots[int(rng, 0, snapshots.length - 1)]!
      await mkdir(opts.warmCacheDir, { recursive: true })
      await writeFile(cacheFile, old)
      log.push(`${step}: stale-writer`)
    } else if (ev < 0.25) {
      // Killed between the temp write and the rename.
      await mkdir(opts.warmCacheDir, { recursive: true })
      await writeFile(join(opts.warmCacheDir, `session-cache.json.${step.toString(16).padStart(16, '0')}.tmp`), '{"version":4,"prov')
      log.push(`${step}: torn-tmp`)
    } else if (ev < 0.28) {
      await mkdir(opts.warmCacheDir, { recursive: true })
      await writeFile(cacheFile, '{garbage')
      log.push(`${step}: corrupt-cache`)
    }

    const selection = randomSelection(rng)
    const day = int(rng, 0, 3)
    const range = day === 0 ? undefined : { start: new Date(`2026-01-0${day}T00:00:00.000Z`), end: new Date(`2026-01-0${day}T23:59:59.999Z`) }
    log.push(`${step}: run [${selection.join(',')}] ${range ? `day ${day}` : 'all'}`)

    const warm = await opts.runWarm(world, selection, range)
    if (restoreAfter) await writeFile(cacheFile, restoreAfter)
    const cold = await opts.runColdReference(world, selection, range)
    if (!opts.equal(warm, cold)) return { log, step, warm, cold }
  }
  return null
}

