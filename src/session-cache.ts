import { readFile, stat, open, rename, unlink, readdir, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'

import type { ToolCall } from './types.js'

// ── Types ──────────────────────────────────────────────────────────────

export type CachedUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  cacheCreationOneHourTokens: number
}

export type CachedCall = {
  provider: string
  model: string
  usage: CachedUsage
  costUSD?: number
  speed: 'standard' | 'fast'
  timestamp: string
  tools: string[]
  bashCommands: string[]
  skills: string[]
  subagentTypes: string[]
  deduplicationKey: string
  project?: string
  projectPath?: string
  toolSequence?: ToolCall[][]
  // Claude only: the call's transcript entry carried no message id, so its
  // deduplicationKey is the synthetic `claude:<timestamp>` and it takes no part
  // in cross-file message-id dedup (base `groupIntoTurns` only dedups on ids).
  noId?: boolean
}

export type CachedTurn = {
  timestamp: string
  sessionId: string
  userMessage: string
  calls: CachedCall[]
}

export type FileFingerprint = {
  dev: number
  ino: number
  mtimeMs: number
  sizeBytes: number
  // Claude only: status-change time. Any write, including one that restores
  // mtime with utimes, moves it, so the Claude reuse check also requires it to
  // match (an in-place same-size rewrite with mtime restored is re-read).
  ctimeMs?: number
}

export type ClaudeMarker = [number, number, string | null, 0 | 1]

export type CachedFile = {
  fingerprint: FileFingerprint
  lastCompleteLineOffset?: number
  canonicalCwd?: string
  canonicalProjectName?: string
  mcpInventory: string[]
  turns: CachedTurn[]
  // Claude Code only: for a subagent transcript (`subagents/.../agent-*.jsonl`),
  // the `agentType` from its sibling `.meta.json` (e.g. `workflow-subagent`,
  // `Explore`, `general-purpose`). Drives the Claude-scoped agent-type breakdown.
  agentType?: string
  // Negative-result marker: this file threw while parsing at the recorded
  // fingerprint. Cached so we don't re-read + re-throw it on every refresh; it
  // is re-parsed only when the file changes (fingerprint differs). Carries no
  // turns, so it contributes no usage. (issue #441 follow-up)
  failed?: boolean
  // Claude only. Claude entries are stored BEFORE cross-file dedup (a pure
  // function of the transcript); `replayClaudeDedup` in parser.ts applies the
  // dedup in discovery order (or reuses an identical-corpus replay plan). Each
  // marker places an assistant entry that is not a
  // plain call: [turn index, position before that call index, message id or
  // null, kind] with kind 1 = its call parsing threw (base then recorded the
  // whole file as failed after marking the ids seen so far) and kind 0 = an id
  // with no call (marks the id seen). Markers are in transcript order.
  markers?: ClaudeMarker[]
}

export type ProviderSection = {
  envFingerprint: string
  files: Record<string, CachedFile>
  /** True when the provider's cache entries survive source-file eviction. */
  durable?: boolean
}

export type SessionCache = {
  version: number
  providers: Record<string, ProviderSection>
}

// ── Constants ──────────────────────────────────────────────────────────

export const CACHE_VERSION = 4

const CACHE_FILE = 'session-cache.json'
const TEMP_FILE_MAX_AGE_MS = 5 * 60 * 1000

// Claude is deliberately absent: its entries are stored before cross-file dedup,
// so an entry depends only on its own transcript, never on which config dirs a
// run selected. Every selection (menu bar app, shells) shares one section.
const PROVIDER_ENV_VARS: Record<string, string[]> = {
  codex: ['CODEX_HOME'],
  droid: ['FACTORY_DIR'],
  cursor: ['XDG_DATA_HOME'],
  'cursor-agent': ['XDG_DATA_HOME'],
  opencode: ['XDG_DATA_HOME'],
  goose: ['XDG_DATA_HOME'],
  crush: ['XDG_DATA_HOME'],
  warp: ['WARP_DB_PATH'],
  antigravity: ['CODEBURN_CACHE_DIR'],
  qwen: ['QWEN_DATA_DIR'],
  'ibm-bob': ['XDG_CONFIG_HOME'],
}

// Names of providers whose cache entries are never evicted when source files
// disappear — they are preserved so month-to-date totals never drop.
export const DURABLE_PROVIDER_NAMES: ReadonlySet<string> = new Set(['copilot'])

const PROVIDER_PARSE_VERSIONS: Record<string, string> = {
  claude: 'cowork-space-grouping-v1+pre-dedup-v1',
  cline: 'worktree-project-grouping-v1',
  copilot: 'otel-durable-v1',
  'ibm-bob': 'worktree-project-grouping-v1',
  'kilo-code': 'worktree-project-grouping-v1',
  'roo-code': 'worktree-project-grouping-v1',
  warp: 'worktree-project-grouping-v1',
  antigravity: 'worktree-project-grouping-v3',
}

// ── Cache Dir ──────────────────────────────────────────────────────────

function getCacheDir(): string {
  return process.env['QUANTUM_WATCHER_CACHE_DIR'] ?? process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'quantum-watcher')
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

// ── Env Fingerprint ────────────────────────────────────────────────────

export function computeEnvFingerprint(provider: string): string {
  const vars = PROVIDER_ENV_VARS[provider] ?? []
  const parts = vars.map(v => `${v}=${process.env[v] ?? ''}`)
  const parseVersion = PROVIDER_PARSE_VERSIONS[provider]
  if (parseVersion) parts.push(`parser=${parseVersion}`)
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

// ── Load / Save ────────────────────────────────────────────────────────

export function emptyCache(): SessionCache {
  return { version: CACHE_VERSION, providers: {} }
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(e => typeof e === 'string')
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

function isOptionalNum(v: unknown): boolean {
  return v === undefined || isNum(v)
}

function isToolCall(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['tool'] === 'string'
    && isOptionalString(o['file'])
    && isOptionalString(o['command'])
}

function isToolCallArray(v: unknown): boolean {
  return Array.isArray(v) && (v as unknown[]).every(isToolCall)
}

function validateFingerprint(fp: unknown): fp is FileFingerprint {
  if (!fp || typeof fp !== 'object') return false
  const f = fp as Record<string, unknown>
  return isNum(f['dev']) && isNum(f['ino']) && isNum(f['mtimeMs']) && isNum(f['sizeBytes'])
    && isOptionalNum(f['ctimeMs'])
}

function validateUsage(u: unknown): u is CachedUsage {
  if (!u || typeof u !== 'object') return false
  const o = u as Record<string, unknown>
  return isNum(o['inputTokens']) && isNum(o['outputTokens'])
    && isNum(o['cacheCreationInputTokens']) && isNum(o['cacheReadInputTokens'])
    && isNum(o['cachedInputTokens']) && isNum(o['reasoningTokens'])
    && isNum(o['webSearchRequests']) && isNum(o['cacheCreationOneHourTokens'])
}

function validateCall(c: unknown): c is CachedCall {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return typeof o['provider'] === 'string'
    && typeof o['model'] === 'string'
    && typeof o['deduplicationKey'] === 'string'
    && typeof o['timestamp'] === 'string'
    && (o['speed'] === 'standard' || o['speed'] === 'fast')
    && isOptionalNum(o['costUSD'])
    && isStringArray(o['tools'])
    && isStringArray(o['bashCommands'])
    && isStringArray(o['skills'])
    && (o['subagentTypes'] === undefined || isStringArray(o['subagentTypes']))
    && isOptionalString(o['project'])
    && isOptionalString(o['projectPath'])
    && (o['toolSequence'] === undefined || (Array.isArray(o['toolSequence']) && (o['toolSequence'] as unknown[]).every(s => isToolCallArray(s))))
    && validateUsage(o['usage'])
    && (o['noId'] === undefined || typeof o['noId'] === 'boolean')
}

function validateTurn(t: unknown): t is CachedTurn {
  if (!t || typeof t !== 'object') return false
  const o = t as Record<string, unknown>
  return typeof o['timestamp'] === 'string'
    && typeof o['sessionId'] === 'string'
    && typeof o['userMessage'] === 'string'
    && Array.isArray(o['calls'])
    && (o['calls'] as unknown[]).every(validateCall)
}

/// True when `f` would survive a save + load: the loader rejects the WHOLE cache
/// if any entry fails this, so an entry that fails must never be saved. This
/// checks a superset of base's per-entry validation, so an entry that passes
/// also loads under base's reader.
export function isSaveableCachedFile(f: unknown): f is CachedFile {
  return validateCachedFile(f)
}

function validateCachedFile(f: unknown): f is CachedFile {
  if (!f || typeof f !== 'object') return false
  const o = f as Record<string, unknown>
  return validateFingerprint(o['fingerprint'])
    && isOptionalNum(o['lastCompleteLineOffset'])
    && isOptionalString(o['canonicalCwd'])
    && isOptionalString(o['canonicalProjectName'])
    && isStringArray(o['mcpInventory'])
    && Array.isArray(o['turns'])
    && (o['turns'] as unknown[]).every(validateTurn)
    && (o['markers'] === undefined || validateMarkers(o['markers'], o['turns'] as CachedTurn[]))
}

function validateMarkers(v: unknown, turns: CachedTurn[]): boolean {
  if (!Array.isArray(v)) return false
  let prevT = 0, prevI = 0
  for (const m of v) {
    if (!Array.isArray(m) || m.length !== 4) return false
    const [t, i, id, kind] = m as unknown[]
    if (!Number.isInteger(t) || !Number.isInteger(i)) return false
    const ti = t as number, ii = i as number
    if (ti < 0 || ti >= turns.length || ii < 0 || ii > turns[ti]!.calls.length) return false
    if (ti < prevT || (ti === prevT && ii < prevI)) return false
    if (!(id === null || typeof id === 'string')) return false
    if (kind !== 0 && kind !== 1) return false
    prevT = ti; prevI = ii
  }
  return true
}

function validateProviderSection(s: unknown): s is ProviderSection {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  if (typeof o['envFingerprint'] !== 'string') return false
  if (!o['files'] || typeof o['files'] !== 'object' || Array.isArray(o['files'])) return false
  return Object.values(o['files'] as Record<string, unknown>).every(validateCachedFile)
}

function validateCache(raw: unknown): raw is SessionCache {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  if (o['version'] !== CACHE_VERSION) return false
  if (!o['providers'] || typeof o['providers'] !== 'object' || Array.isArray(o['providers'])) return false
  return Object.values(o['providers'] as Record<string, unknown>).every(validateProviderSection)
}

// A single CLI invocation can ask for today and then a longer range. Reuse
// the validated snapshot while its on-disk identity is unchanged. This is not
// a TTL: replacement, deletion, or a same-size rewrite invalidates it.
// Only the sequential, one-shot menubar-json CLI action opts in. Long-lived
// servers and concurrent parser clients keep independent mutable snapshots.
let reuseLoadedSnapshot = false
export function enableSessionSnapshotReuse(enabled = true): void {
  reuseLoadedSnapshot = enabled
  loadedSnapshot = undefined
}
let loadedSnapshot: { path: string; fingerprint: string; cache: SessionCache } | undefined
export function clearLoadedSessionCache(): void { loadedSnapshot = undefined }
async function snapshotFingerprint(path: string): Promise<string> {
  const s = await stat(path)
  return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':')
}

export async function loadCache(): Promise<SessionCache> {
  const path = getCachePath()
  try {
    const before = await snapshotFingerprint(path)
    if (reuseLoadedSnapshot && loadedSnapshot?.path === path && loadedSnapshot.fingerprint === before) return loadedSnapshot.cache
    loadedSnapshot = undefined
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    if (!validateCache(parsed)) return emptyCache()
    if (reuseLoadedSnapshot && await snapshotFingerprint(path) === before) loadedSnapshot = { path, fingerprint: before, cache: parsed }
    return parsed
  } catch {
    loadedSnapshot = undefined
    return emptyCache()
  }
}

export async function saveCache(cache: SessionCache): Promise<void> {
  loadedSnapshot = undefined
  const dir = getCacheDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })

  const finalPath = getCachePath()
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  delete (cache as { _dirty?: boolean })._dirty
  const payload = JSON.stringify(cache)

  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(payload, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }

  const fingerprint = await snapshotFingerprint(tempPath)
  try {
    await rename(tempPath, finalPath)
    const after = await snapshotFingerprint(finalPath)
    // rename may update ctime. Only adopt the final fingerprint if it is
    // still our inode/size/mtime, never a competing writer's replacement.
    loadedSnapshot = reuseLoadedSnapshot && validateCache(cache) && after.split(':').slice(0, 4).join(':') === fingerprint.split(':').slice(0, 4).join(':')
      ? { path: finalPath, fingerprint: after, cache } : undefined
  } catch (err) {
    try { await unlink(tempPath) } catch {}
    throw err
  }
}

// ── File Fingerprinting ────────────────────────────────────────────────

export async function fingerprintFile(filePath: string, opts?: { ctime?: boolean }): Promise<FileFingerprint | null> {
  try {
    const s = await stat(filePath)
    if (opts?.ctime) return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size, ctimeMs: s.ctimeMs }
    return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
  } catch {
    // Providers encode extra context into source paths using virtual suffixes:
    // - Cursor: `<dbPath>#cursor-ws=<workspace>` (workspace-aware routing)
    // - OpenCode: `<dbPath>:<sessionId>` (session scoping)
    // These compound paths don't exist on disk; strip the suffix to stat the
    // underlying file. Try `#` first (rare in real paths), then `:` (must use
    // lastIndexOf to tolerate Windows drive letters like C:\...).
    const hashIdx = filePath.indexOf('#')
    if (hashIdx > 0) {
      try {
        const s = await stat(filePath.slice(0, hashIdx))
        return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
      } catch {
        // fall through to colon check
      }
    }
    const colonIdx = filePath.lastIndexOf(':')
    if (colonIdx > 0) {
      try {
        const s = await stat(filePath.slice(0, colonIdx))
        return { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, sizeBytes: s.size }
      } catch {
        return null
      }
    }
    return null
  }
}

// ── Reconciliation ─────────────────────────────────────────────────────

export type ReconcileAction =
  | { action: 'unchanged' }
  | { action: 'appended'; readFromOffset: number }
  | { action: 'modified' }
  | { action: 'new' }

export function reconcileFile(
  current: FileFingerprint,
  cached: CachedFile | undefined,
): ReconcileAction {
  if (!cached) return { action: 'new' }

  const fp = cached.fingerprint

  if (
    fp.dev === current.dev &&
    fp.ino === current.ino &&
    fp.mtimeMs === current.mtimeMs &&
    fp.sizeBytes === current.sizeBytes
  ) {
    return { action: 'unchanged' }
  }

  if (
    cached.lastCompleteLineOffset !== undefined &&
    fp.dev === current.dev &&
    fp.ino === current.ino &&
    current.sizeBytes > fp.sizeBytes
  ) {
    return { action: 'appended', readFromOffset: cached.lastCompleteLineOffset }
  }

  return { action: 'modified' }
}

// ── Dedup Merge ────────────────────────────────────────────────────────
// When appending incremental data, streaming Claude messages can re-emit
// the same dedup key with updated usage. Merge by key: keep the earliest
// timestamp, take incoming usage/tools/bashCommands/skills (latest wins).

export function mergeCallByDedupKey(
  existing: CachedCall,
  incoming: CachedCall,
): CachedCall {
  return {
    ...incoming,
    timestamp: existing.timestamp < incoming.timestamp
      ? existing.timestamp
      : incoming.timestamp,
  }
}

// ── Temp Cleanup ───────────────────────────────────────────────────────

export async function cleanupOrphanedTempFiles(): Promise<void> {
  const dir = getCacheDir()
  if (!existsSync(dir)) return

  try {
    const entries = await readdir(dir)
    const now = Date.now()

    const prefix = 'session-cache.json.'
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue
      try {
        const fullPath = join(dir, entry)
        const s = await stat(fullPath)
        if (now - s.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
          await unlink(fullPath)
        }
      } catch {}
    }
  } catch {}
}
