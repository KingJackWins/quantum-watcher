// Period totals come from the durable daily history, not from whichever
// transcripts survive. Claude Code deletes transcripts after ~30 days, so a
// period reaching past the oldest transcript must still total every recorded
// day, while a fully covered period must total exactly what the transcripts
// give.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { DAILY_CACHE_VERSION, type DailyCache, type DailyEntry } from '../src/daily-cache.js'
import { computeBreakdownCoverage, mergeHistoryDays, sumHistoryTotals } from '../src/usage-aggregator.js'

const DAY_MS = 24 * 3600_000

function runCli(args: string[], home: string, tz: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, '.claude'), HOME: home, TZ: tz },
    encoding: 'utf-8',
    timeout: 60_000,
  })
}

/// YYYY-MM-DD of `ms` in a fixed-offset zone (offsetHours east of UTC).
function dateIn(ms: number, offsetHours: number): string {
  return new Date(ms + offsetHours * 3600_000).toISOString().slice(0, 10)
}

/// Start of the local day containing `ms`, as a UTC epoch, for a fixed-offset zone.
function localDayStart(ms: number, offsetHours: number): number {
  const shifted = ms + offsetHours * 3600_000
  return shifted - (shifted % DAY_MS) - offsetHours * 3600_000
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
}

function sessionLines(sessionId: string, assistantMs: number, messageId: string): string[] {
  return [
    JSON.stringify({ type: 'user', sessionId, timestamp: iso(assistantMs - 30_000), message: { role: 'user', content: 'do the thing' } }),
    JSON.stringify({
      type: 'assistant', sessionId, timestamp: iso(assistantMs),
      message: {
        id: messageId, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      },
    }),
  ]
}

function entry(date: string, providers: Record<string, number>): DailyEntry {
  const cost = Object.values(providers).reduce((s, c) => s + c, 0)
  const calls = Object.keys(providers).length
  return {
    date, cost, savingsUSD: 0, calls, sessions: 1,
    inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    editTurns: 0, oneShotTurns: 0,
    models: { 'claude-sonnet-4-5': { calls, cost, savingsUSD: 0, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    categories: { coding: { turns: 1, cost, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 } },
    providers: Object.fromEntries(Object.entries(providers).map(([p, c]) => [p, { calls: 1, cost: c, savingsUSD: 0 }])),
  }
}

type Payload = {
  current: { cost: number; calls: number; providers: Record<string, number>; topModels: Array<{ cost: number }>; breakdownCoverage: { from: string | null; to: string } | null }
  history: { daily: Array<{ date: string; cost: number; calls: number }> }
}

async function setupHome(opts: { tz: number; transcriptDaysAgo: number[]; seedOldDays?: Array<{ daysAgo: number; providers: Record<string, number> }> }) {
  const home = await mkdtemp(join(tmpdir(), 'qw-period-history-'))
  const now = Date.now()
  const todayStart = localDayStart(now, opts.tz)
  const projectDir = join(home, '.claude', 'projects', 'myapp')
  await mkdir(projectDir, { recursive: true })
  const lines: string[] = []
  for (const daysAgo of opts.transcriptDaysAgo) {
    // An hour into the local day (or a minute ago, for a very young today).
    const ms = daysAgo === 0 ? Math.max(todayStart + 60_000, Math.min(now - 60_000, todayStart + 3600_000)) : todayStart - daysAgo * DAY_MS + 3600_000
    lines.push(...sessionLines(`s${daysAgo}`, ms, `msg-${daysAgo}`))
  }
  await writeFile(join(projectDir, 'session.jsonl'), lines.join('\n'))
  if (opts.seedOldDays) {
    // A daily cache that recorded days whose transcripts have since been
    // deleted. lastComputedDate sits before the surviving transcripts so the
    // CLI's own hydration fills the covered days from them.
    const days = opts.seedOldDays.map(d => entry(dateIn(todayStart - d.daysAgo * DAY_MS + 3600_000, opts.tz), d.providers))
    const oldest = Math.min(...opts.seedOldDays.map(d => d.daysAgo))
    const cache: DailyCache = {
      version: DAILY_CACHE_VERSION,
      savingsConfigHash: '',
      lastComputedDate: dateIn(todayStart - (oldest - 1) * DAY_MS + 3600_000, opts.tz),
      days: days.sort((a, b) => a.date.localeCompare(b.date)),
    }
    await mkdir(join(home, '.cache', 'quantum-watcher'), { recursive: true })
    await writeFile(join(home, '.cache', 'quantum-watcher', 'daily-cache.json'), JSON.stringify(cache))
  }
  return { home, todayStart }
}

function menubar(home: string, tz: string, period: string, provider = 'all'): Payload {
  const r = runCli(['status', '--format', 'menubar-json', '--period', period, '--provider', provider, '--no-optimize'], home, tz)
  expect(r.status, `stderr: ${r.stderr}`).toBe(0)
  return JSON.parse(r.stdout) as Payload
}

function historySum(p: Payload, fromDate: string): { cost: number; calls: number } {
  const days = p.history.daily.filter(d => d.date >= fromDate)
  return { cost: days.reduce((s, d) => s + d.cost, 0), calls: days.reduce((s, d) => s + d.calls, 0) }
}

describe('period totals = sum of the daily history', () => {
  it('a period reaching past the oldest transcript sums the history, and says what the breakdowns cover', async () => {
    const { home, todayStart } = await setupHome({
      tz: 0,
      transcriptDaysAgo: [2, 0],
      seedOldDays: [{ daysAgo: 40, providers: { claude: 10, codex: 5 } }],
    })
    try {
      const all = menubar(home, 'UTC', 'all')
      const transcriptOnly = runCli(['report', '--format', 'json', '--period', 'all'], home, 'UTC')
      expect(transcriptOnly.status, transcriptOnly.stderr).toBe(0)
      const parsedCost = (JSON.parse(transcriptOnly.stdout) as { overview: { cost: number } }).overview.cost
      expect(parsedCost).toBeGreaterThan(0)
      expect(all.current.cost).toBeCloseTo(15 + parsedCost, 8)
      expect(all.current.calls).toBe(2 + 2)
      const sum = historySum(all, '0000')
      expect(all.current.cost).toBeCloseTo(sum.cost, 8)
      expect(all.current.calls).toBe(sum.calls)
      // Per-model totals come from the same days.
      expect(all.current.topModels.reduce((s, m) => s + m.cost, 0)).toBeCloseTo(all.current.cost, 8)
      expect(all.current.providers['claude']).toBeCloseTo(10 + parsedCost, 8)
      expect(all.current.providers['codex']).toBeCloseTo(5, 8)
      expect(all.current.breakdownCoverage).toEqual({ from: dateIn(todayStart - 2 * DAY_MS, 0), to: dateIn(todayStart, 0) })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)

  it('a fully covered period is unchanged: it totals exactly what the transcripts give', async () => {
    const { home } = await setupHome({
      tz: 0,
      transcriptDaysAgo: [3, 1, 0],
      seedOldDays: [{ daysAgo: 40, providers: { claude: 10 } }],
    })
    try {
      for (const period of ['week', '30days']) {
        const p = menubar(home, 'UTC', period)
        const r = runCli(['report', '--format', 'json', '--period', period], home, 'UTC')
        expect(r.status, r.stderr).toBe(0)
        const parsed = JSON.parse(r.stdout) as { overview: { cost: number; calls: number } }
        expect(p.current.cost).toBeCloseTo(parsed.overview.cost, 10)
        expect(p.current.calls).toBe(parsed.overview.calls)
        expect(p.current.calls).toBe(3)
        expect(p.current.breakdownCoverage).toBeNull()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)

  it('a provider filter sums only that provider from the history', async () => {
    const { home } = await setupHome({
      tz: 0,
      transcriptDaysAgo: [2, 0],
      seedOldDays: [{ daysAgo: 40, providers: { claude: 10, codex: 5 } }],
    })
    try {
      const codex = menubar(home, 'UTC', 'all', 'codex')
      expect(codex.current.cost).toBeCloseTo(5, 8)
      expect(codex.current.calls).toBe(1)
      expect(historySum(codex, '0000').cost).toBeCloseTo(5, 8)

      const claude = menubar(home, 'UTC', 'all', 'claude')
      const all = menubar(home, 'UTC', 'all')
      expect(claude.current.cost).toBeCloseTo(all.current.cost - 5, 8)
      expect(claude.current.calls).toBe(all.current.calls - 1)
      expect(claude.current.cost).toBeCloseTo(historySum(claude, '0000').cost, 8)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)

  it('counts the live day once, on every period that contains it', async () => {
    const { home } = await setupHome({
      tz: 0,
      transcriptDaysAgo: [0],
      seedOldDays: [{ daysAgo: 40, providers: { claude: 10 } }],
    })
    try {
      const today = menubar(home, 'UTC', 'today')
      expect(today.current.calls).toBe(1)
      expect(today.current.cost).toBeGreaterThan(0)
      const week = menubar(home, 'UTC', 'week')
      expect(week.current.calls).toBe(1)
      expect(week.current.cost).toBeCloseTo(today.current.cost, 10)
      const all = menubar(home, 'UTC', 'all')
      expect(all.current.cost).toBeCloseTo(10 + today.current.cost, 8)
      expect(all.history.daily.filter(d => d.date === all.history.daily[all.history.daily.length - 1]!.date)).toHaveLength(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)

  it('buckets by the local day: a call just after local midnight stays in today, once', async () => {
    // Pacific/Kiritimati is UTC+14 with no DST: one minute after its local
    // midnight is still the previous day in UTC.
    const tz = 'Pacific/Kiritimati'
    const offset = 14
    const home = await mkdtemp(join(tmpdir(), 'qw-period-tz-'))
    try {
      const now = Date.now()
      const todayStart = localDayStart(now, offset)
      const projectDir = join(home, '.claude', 'projects', 'myapp')
      await mkdir(projectDir, { recursive: true })
      const justAfterMidnight = Math.min(todayStart + 60_000, now - 1000)
      const justBeforeMidnight = todayStart - 60_000
      await writeFile(join(projectDir, 'session.jsonl'), [
        ...sessionLines('after', justAfterMidnight, 'msg-after'),
        ...sessionLines('before', justBeforeMidnight, 'msg-before'),
      ].join('\n'))
      const today = menubar(home, tz, 'today')
      expect(today.current.calls).toBe(1)
      const week = menubar(home, tz, 'week')
      expect(week.current.calls).toBe(2)
      expect(week.current.cost).toBeCloseTo(2 * today.current.cost, 10)
      const days = Object.fromEntries(week.history.daily.map(d => [d.date, d.calls]))
      expect(days[dateIn(todayStart, offset)]).toBe(1)
      expect(days[dateIn(todayStart - 60_000, offset)]).toBe(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('mergeHistoryDays / sumHistoryTotals / computeBreakdownCoverage', () => {
  const cache: DailyCache = {
    version: DAILY_CACHE_VERSION,
    savingsConfigHash: '',
    lastComputedDate: '2026-10-15',
    // A stale cached entry dated today must never be summed alongside the live day.
    days: [entry('2026-09-01', { claude: 4, codex: 1 }), entry('2026-10-15', { claude: 2 }), entry('2026-10-16', { claude: 999 })],
  }
  const live = [entry('2026-10-15', { claude: 50 }), entry('2026-10-16', { claude: 3, codex: 7 })]

  it('takes completed days from the cache and only today from the live parse', () => {
    const days = mergeHistoryDays(cache, live, '2026-09-01', '2026-10-16', '2026-10-16', '2026-10-15')
    expect(days.map(d => [d.date, d.cost])).toEqual([['2026-09-01', 5], ['2026-10-15', 2], ['2026-10-16', 10]])
    expect(sumHistoryTotals(days, 'all')).toEqual({ cost: 17, calls: 5, savingsUSD: 0 })
    expect(sumHistoryTotals(days, 'codex')).toEqual({ cost: 8, calls: 2, savingsUSD: 0 })
    expect(sumHistoryTotals(days, 'cursor')).toEqual({ cost: 0, calls: 0, savingsUSD: 0 })
  })

  it('a range ending before today never reads the live day', () => {
    const days = mergeHistoryDays(cache, live, '2026-09-01', '2026-10-15', '2026-10-16', '2026-10-15')
    expect(days.map(d => d.date)).toEqual(['2026-09-01', '2026-10-15'])
  })

  it('names the covered range only when breakdowns fall short', () => {
    const hist = [{ date: '2026-09-01', cost: 100 }, { date: '2026-10-15', cost: 10 }, { date: '2026-10-16', cost: 5 }]
    expect(computeBreakdownCoverage(hist, hist, '2026-09-01', '2026-10-16')).toBeNull()
    expect(computeBreakdownCoverage(hist, hist.slice(1), '2026-09-01', '2026-10-16')).toEqual({ from: '2026-10-15', to: '2026-10-16' })
    expect(computeBreakdownCoverage(hist, [], '2026-09-01', '2026-10-16')).toEqual({ from: null, to: '2026-10-16' })
  })
})
