// Cross-revision check: build 8c31b27 separately and set WATCHER_BASE_CLI to
// its dist/main.js. Both commands see identical fixtures and a frozen clock.
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const base = process.env.WATCHER_BASE_CLI
let root: string | undefined
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

it.skipIf(!base)('base and candidate payloads match for today/week/30days/all, cold and warm', async () => {
  root = await mkdtemp(join(tmpdir(), 'watcher-base-diff-'))
  const clock = join(root, 'clock.cjs')
  await writeFile(clock, `const D=Date;global.Date=class extends D { constructor(...a){super(...(a.length?a:['2026-10-30T12:00:00Z']))}static now(){return D.parse('2026-10-30T12:00:00Z')}};`)
  const dirs = [0, 1, 2].map(i => join(root!, `claude${i}`))
  const transcript = (id: string, date: string, costTokens: number) => [
    { type: 'user', sessionId: id, timestamp: date, message: { role: 'user', content: 'edit the file' } },
    { type: 'assistant', sessionId: id, timestamp: date, message: { id, role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'tool', name: 'Edit', input: { file_path: '/fixture/a.ts' } }], usage: { input_tokens: costTokens, output_tokens: 10 } } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n'
  for (const [i, dir] of dirs.entries()) {
    await mkdir(join(dir, 'projects/project'), { recursive: true })
    await writeFile(join(dir, 'projects/project/session.jsonl'),
      transcript('duplicate', '2026-10-30T10:00:00Z', 100 + i) +
      transcript(`old-${i}`, ['2026-10-29', '2026-10-15', '2026-08-01'][i]! + 'T10:00:00Z', 1000))
  }
  const codex = join(root, 'codex')
  await mkdir(join(codex, 'sessions/2026/10/30'), { recursive: true })
  await writeFile(join(codex, 'sessions/2026/10/30/session.jsonl'), [
    { type: 'session_meta', payload: { id: 'codex-session', cwd: '/fixture/project' } },
    { type: 'turn_context', payload: { model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-10-30T09:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, reasoning_output_tokens: 0 } } } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  const configDir = join(root, '.config/quantum-watcher')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ claudeConfigDirs: dirs }))
  const outputs: Record<string, unknown[]> = {}
  for (const [name, cli] of [['base', base!], ['candidate', resolve('dist/main.js')]]) {
    const cache = join(root, `cache-${name}`)
    await mkdir(cache, { recursive: true })
    // Retained history has spend no surviving transcript can reconstruct.
    const day = { date: '2026-06-01', cost: 100, savingsUSD: 0, calls: 1, sessions: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, editTurns: 0, oneShotTurns: 0, models: {}, categories: {}, providers: { claude: { calls: 1, cost: 100, savingsUSD: 0 } } }
    await writeFile(join(cache, 'daily-cache.json'), JSON.stringify({ version: 8, savingsConfigHash: '', lastComputedDate: '2026-10-29', days: [day] }))
    // Fresh empty remote pricing cache uses the identical bundled fallback.
    await writeFile(join(cache, 'litellm-pricing.json'), JSON.stringify({ timestamp: Date.parse('2026-10-30T12:00:00Z'), data: {} }))
    outputs[name!] = []
    for (let pass = 0; pass < 2; pass++) for (const period of ['today', 'week', '30days', 'all']) {
      const run = spawnSync(process.execPath, [...(name === 'candidate' ? ['--single-threaded-gc'] : []), '--require', clock, cli!, 'status', '--format', 'menubar-json', '--provider', 'all', '--period', period, '--no-optimize'], {
        encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: '', CLAUDE_CONFIG_DIRS: '', CODEX_HOME: codex, CODEBURN_DESKTOP_SESSIONS_DIR: join(root, 'none'), QUANTUM_WATCHER_CACHE_DIR: cache, CODEBURN_CACHE_DIR: cache, TZ: 'UTC' },
      })
      expect(run.status, run.stderr).toBe(0)
      outputs[name!]!.push(JSON.parse(run.stdout))
    }
  }
  expect(outputs.candidate).toEqual(outputs.base)
  const batch = spawnSync(process.execPath, ['--single-threaded-gc', '--require', clock, resolve('dist/main.js'), 'status', '--format', 'menubar-json', '--provider', 'all', '--periods', 'today,week,30days,all', '--no-optimize'], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: '', CLAUDE_CONFIG_DIRS: '', CODEX_HOME: codex, CODEBURN_DESKTOP_SESSIONS_DIR: join(root, 'none'), QUANTUM_WATCHER_CACHE_DIR: join(root, 'cache-candidate'), CODEBURN_CACHE_DIR: join(root, 'cache-candidate'), TZ: 'UTC' },
  })
  expect(batch.status, batch.stderr).toBe(0)
  expect(Object.values(JSON.parse(batch.stdout).payloads)).toEqual(outputs.base!.slice(0, 4))
}, 120_000)
