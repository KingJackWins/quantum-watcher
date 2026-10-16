// Period totals come from the durable daily history, not from whichever
// transcripts survive. Claude Code deletes transcripts after ~30 days, so a
// period reaching past the oldest transcript must still total every recorded
// day, while a fully covered period must total exactly what the transcripts
// give.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { DAILY_CACHE_VERSION, DailyCacheReadError, emptyCache, type DailyCache, type DailyEntry } from '../src/daily-cache.js'
import { computeBreakdownCoverage, incompleteCoveredFrom, isShortfall, mergeHistoryDays, resolveHistory, sumHistoryTotals } from '../src/usage-aggregator.js'

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
  current: {
    cost: number; calls: number; sessions: number; providers: Record<string, number>; topModels: Array<{ cost: number }>
    breakdownCoverage: { from: string | null; to: string } | null
    historyIncomplete: { reason: string; savedThrough: string | null; coveredFrom: string | null; to: string } | null
    costPerSession: number | null
  }
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

function menubar(home: string, tz: string, period: string, provider = 'all', extra: string[] = []): Payload {
  const args = extra.length > 0 ? extra : ['--period', period]
  const r = runCli(['status', '--format', 'menubar-json', ...args, '--provider', provider, '--no-optimize'], home, tz)
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
      // The deleted day 40 days ago is short; coverage starts the day after it.
      expect(all.current.breakdownCoverage).toEqual({ from: dateIn(todayStart - 39 * DAY_MS, 0), to: dateIn(todayStart, 0) })
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
      const st = JSON.parse(runCli(['status', '--format', 'json'], home, 'UTC').stdout) as { historyIncomplete: unknown }
      expect(st.historyIncomplete).toBeNull()
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

  it('coverage starts the day after the last short day (saved > transcripts by more than max($1, 1%))', () => {
    const all = () => true
    // The verdict's case: $100 on a deleted day + $10,000 today must name the range.
    const hist = [{ date: '2026-09-01', cost: 100 }, { date: '2026-10-16', cost: 10_000 }]
    expect(computeBreakdownCoverage(hist, [{ date: '2026-10-16', cost: 10_000 }], all, '2026-10-16')).toEqual({ from: '2026-09-02', to: '2026-10-16' })
    // Everything matches: complete, no line.
    expect(computeBreakdownCoverage(hist, hist, all, '2026-10-16')).toBeNull()
    // Nothing parsed at all: the last short day is the last day -> no covered day.
    expect(computeBreakdownCoverage(hist, [], all, '2026-10-16')).toEqual({ from: null, to: '2026-10-16' })
    // Out-of-scope short days do not count.
    expect(computeBreakdownCoverage(hist, [{ date: '2026-10-16', cost: 10_000 }], d => d >= '2026-10-01', '2026-10-16')).toBeNull()
  })

  it('(a) a surviving $0.18 call on the first saved day does not make coverage complete', () => {
    const saved = [{ date: '2026-04-20', cost: 0.18 }, { date: '2026-05-10', cost: 31.58 }, { date: '2026-09-15', cost: 1080 }, { date: '2026-09-16', cost: 1599 }, { date: '2026-10-16', cost: 60 }]
    const transcripts = [{ date: '2026-04-20', cost: 0.18 }, { date: '2026-09-15', cost: 572 }, { date: '2026-09-16', cost: 1590 }, { date: '2026-10-16', cost: 60 }]
    expect(computeBreakdownCoverage(saved, transcripts, () => true, '2026-10-16')).toEqual({ from: '2026-09-16', to: '2026-10-16' })
  })

  it('(b) a day where transcripts exceed the saved row does not start coverage late', () => {
    const saved = [{ date: '2026-09-01', cost: 500 }, { date: '2026-10-09', cost: 740 }, { date: '2026-10-10', cost: 762 }, { date: '2026-10-16', cost: 60 }]
    const transcripts = [{ date: '2026-09-01', cost: 100 }, { date: '2026-10-09', cost: 762 }, { date: '2026-10-10', cost: 835 }, { date: '2026-10-16', cost: 60 }]
    expect(computeBreakdownCoverage(saved, transcripts, () => true, '2026-10-16')).toEqual({ from: '2026-09-02', to: '2026-10-16' })
    expect(computeBreakdownCoverage(saved.slice(1), transcripts.slice(1), () => true, '2026-10-16')).toBeNull()
  })

  it('(c) tolerance edges: $1 floor and 1% of the saved day', () => {
    // $1 floor (saved $50: 1% = $0.50 < $1)
    expect(isShortfall(50, 49.01)).toBe(false) // short by $0.99
    expect(isShortfall(50, 49)).toBe(false) // exactly $1 is not more than $1
    expect(isShortfall(50, 48.98)).toBe(true) // short by $1.02
    // 1% (saved $1,000: 1% = $10 > $1)
    expect(isShortfall(1000, 990.5)).toBe(false) // short by $9.50
    expect(isShortfall(1000, 990)).toBe(false) // exactly 1%
    expect(isShortfall(1000, 989.5)).toBe(true) // short by $10.50
    const all = () => true
    expect(computeBreakdownCoverage([{ date: '2026-10-01', cost: 1000 }, { date: '2026-10-16', cost: 1 }], [{ date: '2026-10-01', cost: 990.5 }, { date: '2026-10-16', cost: 1 }], all, '2026-10-16')).toBeNull()
    expect(computeBreakdownCoverage([{ date: '2026-10-01', cost: 1000 }, { date: '2026-10-16', cost: 1 }], [{ date: '2026-10-01', cost: 989.5 }, { date: '2026-10-16', cost: 1 }], all, '2026-10-16')).toEqual({ from: '2026-10-02', to: '2026-10-16' })
  })

  it('an incomplete history dates its total by the same rule, else by the earliest transcript call', () => {
    const all = () => true
    const transcripts = [{ date: '2026-04-20', cost: 0.18, calls: 1 }, { date: '2026-10-12', cost: 800, calls: 10 }]
    expect(incompleteCoveredFrom([{ date: '2026-04-20', cost: 0.18 }, { date: '2026-09-20', cost: 900 }], transcripts, all, '2026-10-16')).toBe('2026-09-21')
    expect(incompleteCoveredFrom([], transcripts, all, '2026-10-16')).toBe('2026-04-20')
    expect(incompleteCoveredFrom([], [], all, '2026-10-16')).toBeNull()
  })
})

describe('resolveHistory never passes a failed history off as complete', () => {
  const ok = (last: string | null): DailyCache => ({ ...emptyCache(), lastComputedDate: last, days: [entry('2026-10-10', { claude: 1 })] })

  it('complete through yesterday: no flag', async () => {
    const r = await resolveHistory('2026-10-15', async () => ok('2026-10-15'))
    expect(r.incomplete).toBeNull()
  })

  it('unreadable saved history: flagged, empty, nothing rebuilt', async () => {
    const r = await resolveHistory('2026-10-15', async () => { throw new DailyCacheReadError('bad json') }, async () => ok('2026-10-14'))
    expect(r.incomplete).toEqual({ reason: 'unreadable', savedThrough: null })
    expect(r.cache.days).toEqual([])
  })

  it('hydration failure: flagged with the last saved day', async () => {
    const r = await resolveHistory('2026-10-15', async () => { throw new Error('EACCES') }, async () => ok('2026-10-13'))
    expect(r.incomplete).toEqual({ reason: 'hydration-failed', savedThrough: '2026-10-13' })
  })

  it('stale saved history: flagged', async () => {
    const r = await resolveHistory('2026-10-15', async () => ok('2026-10-13'))
    expect(r.incomplete).toEqual({ reason: 'stale', savedThrough: '2026-10-13' })
    const never = await resolveHistory('2026-10-15', async () => ok(null))
    expect(never.incomplete).toEqual({ reason: 'stale', savedThrough: null })
  })
})

describe('incomplete history, custom ranges, cost per session (CLI)', () => {
  it('an unreadable saved history: whole total from transcripts, flagged, file left untouched', async () => {
    const { home, todayStart } = await setupHome({ tz: 0, transcriptDaysAgo: [2, 0] })
    const cachePath = join(home, '.cache', 'quantum-watcher', 'daily-cache.json')
    try {
      await mkdir(join(home, '.cache', 'quantum-watcher'), { recursive: true })
      await writeFile(cachePath, '{"version": 8, "days": [ truncated')
      const p = menubar(home, 'UTC', 'all')
      const r = runCli(['report', '--format', 'json', '--period', 'all'], home, 'UTC')
      const parsed = JSON.parse(r.stdout) as { overview: { cost: number; calls: number } }
      expect(p.current.historyIncomplete).toEqual({ reason: 'unreadable', savedThrough: null, coveredFrom: dateIn(todayStart - 2 * DAY_MS, 0), to: dateIn(todayStart, 0) })
      expect(p.current.cost).toBeCloseTo(parsed.overview.cost, 10)
      expect(p.current.calls).toBe(2)
      const sum = historySum(p, '0000')
      expect(sum.cost).toBeCloseTo(p.current.cost, 10)
      expect(sum.calls).toBe(p.current.calls)
      expect(await readFile(cachePath, 'utf-8')).toBe('{"version": 8, "days": [ truncated')
      // status --format json carries the same field.
      const st = runCli(['status', '--format', 'json'], home, 'UTC')
      expect(st.status, st.stderr).toBe(0)
      const stJson = JSON.parse(st.stdout) as { historyIncomplete: { reason: string; to: string } | null }
      expect(stJson.historyIncomplete?.reason).toBe('unreadable')
      expect(stJson.historyIncomplete?.to).toBe(dateIn(todayStart, 0))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)

  it('a stale saved history whose hydration fails: whole total from transcripts, flagged with the last saved day', async () => {
    const { home, todayStart } = await setupHome({
      tz: 0,
      transcriptDaysAgo: [2, 0],
      seedOldDays: [{ daysAgo: 40, providers: { claude: 10 } }],
    })
    const dir = join(home, '.cache', 'quantum-watcher')
    try {
      await chmod(dir, 0o500) // hydration cannot save the gap it computed
      const p = menubar(home, 'UTC', 'all')
      await chmod(dir, 0o700)
      const r = runCli(['report', '--format', 'json', '--period', 'all'], home, 'UTC')
      const parsed = JSON.parse(r.stdout) as { overview: { cost: number } }
      expect(p.current.historyIncomplete?.reason).toBe('hydration-failed')
      expect(p.current.historyIncomplete?.savedThrough).toBe(dateIn(todayStart - 39 * DAY_MS + 3600_000, 0)) // seeded lastComputedDate
      // Never mixed: the saved $10 day is not added to the transcript total.
      expect(p.current.cost).toBeCloseTo(parsed.overview.cost, 10)
      expect(p.current.calls).toBe(2)
      expect(p.current.breakdownCoverage).toBeNull()
    } finally {
      await chmod(dir, 0o700).catch(() => {})
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)

  it('a custom range reaching a saved day older than the history window lists that day in history.daily', async () => {
    const { home, todayStart } = await setupHome({
      tz: 0,
      transcriptDaysAgo: [0],
      seedOldDays: [{ daysAgo: 400, providers: { claude: 100 } }, { daysAgo: 40, providers: { claude: 10 } }],
    })
    try {
      const from = dateIn(todayStart - 410 * DAY_MS, 0)
      const to = dateIn(todayStart - 30 * DAY_MS, 0)
      const p = menubar(home, 'UTC', '', 'all', ['--from', from, '--to', to])
      expect(p.current.cost).toBeCloseTo(110, 8)
      const inRange = p.history.daily.filter(d => d.date >= from && d.date <= to)
      expect(inRange.map(d => d.date)).toContain(dateIn(todayStart - 400 * DAY_MS + 3600_000, 0))
      expect(inRange.reduce((s, d) => s + d.cost, 0)).toBeCloseTo(p.current.cost, 8)
      expect(inRange.reduce((s, d) => s + d.calls, 0)).toBe(p.current.calls)
      // Preset periods keep the 365-entry window.
      const all = menubar(home, 'UTC', 'all')
      expect(all.history.daily.some(d => d.date < dateIn(todayStart - 365 * DAY_MS, 0))).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)

  it('cost per session never divides a history-wide cost by a transcript-only session count', async () => {
    const { home } = await setupHome({
      tz: 0,
      transcriptDaysAgo: [2, 0],
      seedOldDays: [{ daysAgo: 40, providers: { claude: 10 } }],
    })
    try {
      const claude = menubar(home, 'UTC', 'all', 'claude')
      expect(claude.current.breakdownCoverage).not.toBeNull()
      // Provider filter: transcript cost / transcript sessions.
      const parsed = JSON.parse(runCli(['report', '--format', 'json', '--period', 'all', '--provider', 'claude'], home, 'UTC').stdout) as { overview: { cost: number; sessions: number } }
      expect(parsed.overview.sessions).toBeGreaterThan(0)
      expect(claude.current.costPerSession).toBeCloseTo(parsed.overview.cost / parsed.overview.sessions, 10)
      expect(claude.current.costPerSession).not.toBeCloseTo(claude.current.cost / claude.current.sessions, 3)
      // All providers, coverage incomplete: sessions are the saved-days count
      // (includes the seeded day's session), so the ratio is saved/saved.
      const all = menubar(home, 'UTC', 'all')
      expect(all.current.breakdownCoverage).not.toBeNull()
      expect(all.current.sessions).toBeGreaterThan(parsed.overview.sessions)
      expect(all.current.costPerSession).toBeCloseTo(all.current.cost / all.current.sessions, 10)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)
})
