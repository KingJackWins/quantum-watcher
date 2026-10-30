import { measure } from './performance.js'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { computeEnvFingerprint, type CachedFile, type CachedTurn } from './session-cache.js'

// A disposable, compact replay plan, never transcript data or history. The r5b
// pre-dedup cache remains authoritative. One atomic snapshot, no locks/deltas.
// Every occurrence and fingerprint is keyed in base discovery order, including
// overlapping selections. A change anywhere replays the WHOLE ordered corpus:
// a changed early file can change the winner in any later, unchanged file.
type Plan = null | 'all' | Array<[number, null | number[]]>
type Snapshot = { version: 1; key: string; plans: Plan[] }
const cachePath = () => join(process.env.QUANTUM_WATCHER_CACHE_DIR ?? process.env.CODEBURN_CACHE_DIR ?? join(homedir(), '.cache', 'quantum-watcher'), 'claude-dedup-plan.json')

export async function dedupClaudeFiles(
  files: Array<{ path: string; file: CachedFile | undefined }>,
  replay: (file: CachedFile, seen: Set<string>) => CachedTurn[] | null,
  reusable = true,
): Promise<Map<string, CachedTurn[] | null>> {
  const done = measure('claude.dedup-plan')
  const key = createHash('sha256').update(computeEnvFingerprint('claude')).update(JSON.stringify(files.map(({ path, file }) =>
    [path, file?.fingerprint, file?.failed, file?.turns.length, file?.markers]))).digest('hex')
  const path = cachePath()
  if (reusable) {
    try {
      const snapshot = JSON.parse(await readFile(path, 'utf8')) as Snapshot
      if (snapshot.version === 1 && snapshot.key === key && snapshot.plans.length === files.length) {
        const result = new Map<string, CachedTurn[] | null>()
        for (let i = 0; i < files.length; i++) {
          const source = files[i]!
          const plan = snapshot.plans[i]!
          const turns = source.file?.turns ?? []
          const restored = plan === null ? null : plan === 'all' ? turns : plan.map(([t, calls]) => {
            if (!Number.isInteger(t) || !turns[t]) throw new Error('invalid turn')
            if (calls === null) return turns[t]!
            return { ...turns[t]!, calls: calls.map(c => {
              if (!Number.isInteger(c) || !turns[t]!.calls[c]) throw new Error('invalid call')
              return turns[t]!.calls[c]!
            }) }
          })
          result.set(source.path, restored)
        }
        done({ reused: 1, replayed: 0 })
        return result
      }
    } catch { /* absent/corrupt plans are always a full replay */ }
  }
  const seen = new Set<string>()
  const result = new Map<string, CachedTurn[] | null>()
  const plans: Plan[] = []
  for (const source of files) {
    const turns = source.file ? replay(source.file, seen) : null
    result.set(source.path, turns)
    if (turns === null) { plans.push(null); continue }
    if (turns.length === 0) { plans.push([]); continue }
    const original = source.file!.turns
    if (turns.length === original.length && turns.every((t, i) => t === original[i])) {
      plans.push('all'); continue
    }
    // Replay preserves order and each retained call's identity, even when it
    // copies a turn to remove duplicate calls. Index by call object, not id:
    // missing message IDs intentionally do not participate in dedup.
    const positions = new Map(original.flatMap((t, ti) => t.calls.map((c, ci) => [c, [ti, ci] as const] as const)))
    plans.push(turns.map(t => {
      const ti = positions.get(t.calls[0]!)![0]
      return [ti, t === original[ti] ? null : t.calls.map(c => positions.get(c)![1])]
    }))
  }
  if (reusable) {
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(temp, JSON.stringify({ version: 1, key, plans } satisfies Snapshot), { mode: 0o600 })
      await rename(temp, path)
    } catch { /* optimization failures never change results */ }
    finally { await unlink(temp).catch(() => {}) }
  }
  done({ reused: 0, replayed: files.length })
  return result
}
