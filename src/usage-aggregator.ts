import { measure } from './performance.js'
import { homedir } from 'node:os'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory, type DateRange } from './types.js'
import { type PeriodData, type ProviderCost, type BreakdownArrays, type BreakdownCoverage, type HistoryIncomplete, type HistoryIncompleteInfo, type MenubarPayload, buildMenubarPayload } from './menubar-json.js'
import { parseAllSessions, filterProjectsByName, filterProjectsByDays } from './parser.js'
import { getLocalModelSavingsConfigHash, getShortModelName } from './models.js'
import { getAllProviders } from './providers/index.js'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays } from './day-aggregator.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { aggregateModels } from './models-report.js'
import { scanAndDetect } from './optimize.js'
import { getDaysInRange, ensureCacheHydrated, loadDailyCache, emptyCache, DailyCacheReadError, DailyCacheMalformedError, BACKFILL_DAYS, toDateString, type DailyCache, type DailyEntry } from './daily-cache.js'

export function buildPeriodData(label: string, projects: ProjectSummary[]): PeriodData {
  const sessions = projects.flatMap(p => p.sessions)
  const catTotals: Record<string, { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }> = {}
  const modelTotals: Record<string, { calls: number; cost: number; savingsUSD: number }> = {}
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0

  for (const sess of sessions) {
    inputTokens += sess.totalInputTokens
    outputTokens += sess.totalOutputTokens
    cacheReadTokens += sess.totalCacheReadTokens
    cacheWriteTokens += sess.totalCacheWriteTokens
    for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
      if (!catTotals[cat]) catTotals[cat] = { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
      catTotals[cat].turns += d.turns
      catTotals[cat].cost += d.costUSD
      catTotals[cat].savingsUSD += d.savingsUSD
      catTotals[cat].editTurns += d.editTurns
      catTotals[cat].oneShotTurns += d.oneShotTurns
    }
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0, savingsUSD: 0 }
      modelTotals[model].calls += d.calls
      modelTotals[model].cost += d.costUSD
      modelTotals[model].savingsUSD += d.savingsUSD
    }
  }

  return {
    label,
    cost: projects.reduce((s, p) => s + p.totalCostUSD, 0),
    savingsUSD: projects.reduce((s, p) => s + p.totalSavingsUSD, 0),
    calls: projects.reduce((s, p) => s + p.totalApiCalls, 0),
    sessions: projects.reduce((s, p) => s + p.sessions.length, 0),
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    categories: Object.entries(catTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([cat, d]) => ({ name: CATEGORY_LABELS[cat as TaskCategory] ?? cat, ...d })),
    models: Object.entries(modelTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([name, d]) => ({ name, ...d })),
  }
}

async function defaultEnsureHydrated(): Promise<DailyCache> {
  return ensureCacheHydrated(
    (range) => parseAllSessions(range, 'all'),
    aggregateProjectsIntoDays,
    getLocalModelSavingsConfigHash(),
  )
}

/// The saved daily history could not be brought up to yesterday. Totals then
/// come wholly from the transcript parse and the payload says so.
export type HistoryState = { cache: DailyCache; incomplete: HistoryIncomplete | null }

/**
 * Loads and hydrates the saved daily history and decides whether it is a
 * complete record through yesterday. Never turns a failure into a
 * normal-looking history:
 * - a malformed saved row (validateDailyRow): `malformed`, empty cache, file
 *   left untouched;
 * - unreadable saved file (read/JSON/shape error): `unreadable`, empty cache,
 *   and the file is left untouched (hydration refuses to rebuild over it);
 * - any other hydration failure: `hydration-failed`, with whatever saved days
 *   can still be read (for the trend chart only);
 * - hydration returned but the last saved day is older than yesterday: `stale`.
 */
export async function resolveHistory(
  yesterdayStr: string,
  ensure: () => Promise<DailyCache> = defaultEnsureHydrated,
  loadSaved: () => Promise<DailyCache> = loadDailyCache,
): Promise<HistoryState> {
  let cache: DailyCache
  try {
    cache = await ensure()
  } catch (err) {
    const malformed = err instanceof DailyCacheMalformedError
    const unreadable = err instanceof DailyCacheReadError
    process.stderr.write(
      `quantum-watcher: daily history ${malformed ? 'has a malformed row' : unreadable ? 'could not be read' : 'backfill failed'}; ` +
      `totals fall back to surviving transcripts. ${err instanceof Error ? err.message : String(err)}\n`
    )
    if (malformed) return { cache: emptyCache(), incomplete: { reason: 'malformed', savedThrough: null } }
    if (unreadable) return { cache: emptyCache(), incomplete: { reason: 'unreadable', savedThrough: null } }
    const saved = await loadSaved()
    return { cache: saved, incomplete: { reason: 'hydration-failed', savedThrough: saved.lastComputedDate } }
  }
  if (cache.lastComputedDate === null || cache.lastComputedDate < yesterdayStr) {
    return { cache, incomplete: { reason: 'stale', savedThrough: cache.lastComputedDate } }
  }
  return { cache, incomplete: null }
}

/**
 * The one merge behind `history.daily` and every period total: completed days
 * (up to yesterday) from the daily cache, plus today's entry from the live
 * parse. Only a live entry dated exactly today is taken, and the cache is read
 * only up to yesterday, so no day can come from both sources.
 */
export function mergeHistoryDays(
  cache: DailyCache,
  liveDays: DailyEntry[],
  startStr: string,
  endStr: string,
  todayStr: string,
  yesterdayStr: string,
): DailyEntry[] {
  const cachedEnd = endStr < yesterdayStr ? endStr : yesterdayStr
  const cached = startStr <= cachedEnd ? getDaysInRange(cache, startStr, cachedEnd) : []
  const live = liveDays.filter(d => d.date === todayStr && d.date >= startStr && d.date <= endStr)
  return [...cached, ...live].sort((a, b) => a.date.localeCompare(b.date))
}

/// One day's cost/calls/savings for the provider filter ('all' = the whole day).
export function projectDay(d: DailyEntry, pf: string): { date: string; cost: number; savingsUSD: number; calls: number } {
  if (pf === 'all') return { date: d.date, cost: d.cost, savingsUSD: d.savingsUSD, calls: d.calls }
  const prov = d.providers[pf] ?? { calls: 0, cost: 0, savingsUSD: 0 }
  return { date: d.date, cost: prov.cost, savingsUSD: prov.savingsUSD ?? 0, calls: prov.calls }
}

export function sumHistoryTotals(days: DailyEntry[], pf: string): { cost: number; calls: number; savingsUSD: number } {
  let cost = 0, calls = 0, savingsUSD = 0
  for (const d of days) {
    const p = projectDay(d, pf)
    cost += p.cost
    calls += p.calls
    savingsUSD += p.savingsUSD
  }
  return { cost, calls, savingsUSD }
}

/// Earliest in-range day with any transcript-derived call (null when none).
export function earliestParsedDay(parsedDays: Array<{ date: string; calls: number }>, inScope: (date: string) => boolean): string | null {
  let earliest: string | null = null
  for (const d of parsedDays) {
    if (d.calls > 0 && inScope(d.date) && (earliest === null || d.date < earliest)) earliest = d.date
  }
  return earliest
}

/// A day counts as short when its saved spend exceeds the transcript spend by
/// more than max($1, 1% of the saved spend).
export const SHORTFALL_MIN_USD = 1
export const SHORTFALL_SHARE = 0.01

export function isShortfall(savedCost: number, transcriptCost: number): boolean {
  return savedCost - transcriptCost > Math.max(SHORTFALL_MIN_USD, SHORTFALL_SHARE * savedCost)
}

function nextDayStr(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return toDateString(new Date(y, m - 1, d + 1))
}

/**
 * Coverage start for the selected scope: the day AFTER the last in-scope day
 * whose saved spend exceeds its transcript spend by more than
 * max($1, 1% of that day's saved spend). Days where transcripts exceed the
 * saved row (stale low rows) never count. Returns null when no day is short,
 * i.e. the transcripts cover the whole period.
 */
export function coverageStartAfterShortfall(
  savedDays: Array<{ date: string; cost: number }>,
  transcriptDays: Array<{ date: string; cost: number }>,
  inScope: (date: string) => boolean,
): string | null {
  const transcript = new Map<string, number>()
  for (const d of transcriptDays) if (inScope(d.date)) transcript.set(d.date, (transcript.get(d.date) ?? 0) + d.cost)
  const saved = new Map<string, number>()
  for (const d of savedDays) if (inScope(d.date)) saved.set(d.date, (saved.get(d.date) ?? 0) + d.cost)
  let lastShort: string | null = null
  for (const [date, cost] of saved) {
    if (isShortfall(cost, transcript.get(date) ?? 0) && (lastShort === null || date > lastShort)) lastShort = date
  }
  return lastShort === null ? null : nextDayStr(lastShort)
}

/**
 * Breakdown coverage (see coverageStartAfterShortfall). null = complete, no
 * line. `from` is null when the last short day is the period's last day, so
 * no covered day remains.
 */
export function computeBreakdownCoverage(
  historyDays: Array<{ date: string; cost: number }>,
  parsedDays: Array<{ date: string; cost: number }>,
  inScope: (date: string) => boolean,
  rangeEndStr: string,
): BreakdownCoverage | null {
  const start = coverageStartAfterShortfall(historyDays, parsedDays, inScope)
  if (start === null) return null
  return { from: start <= rangeEndStr ? start : null, to: rangeEndStr }
}

/**
 * The "total covers X to Y" start for an incomplete history: the same
 * shortfall rule against whatever saved days could still be read; when none
 * shows a shortfall (e.g. the file is unreadable, so nothing is known about
 * deleted days) it is the earliest day with any transcript call. null = no
 * covered day.
 */
export function incompleteCoveredFrom(
  savedDays: Array<{ date: string; cost: number }>,
  transcriptDays: Array<{ date: string; cost: number; calls: number }>,
  inScope: (date: string) => boolean,
  rangeEndStr: string,
): string | null {
  const start = coverageStartAfterShortfall(savedDays, transcriptDays, inScope) ?? earliestParsedDay(transcriptDays, inScope)
  return start !== null && start <= rangeEndStr ? start : null
}

export type HistoryStatus = {
  /// History-derived totals, or null when the history is incomplete (the
  /// caller keeps its transcript total for the whole figure).
  totals: { cost: number; calls: number; savingsUSD: number } | null
  historyIncomplete: HistoryIncompleteInfo | null
}

/**
 * Cost/calls/savings for a date range from the daily history (the same merge
 * as `history.daily`), for callers outside the menubar payload. `liveDays` are
 * the caller's live-parsed days (only today's entry is used); `transcriptDays`
 * are its parsed days for the range (used to date an incomplete history).
 */
export async function historyStatusForRange(
  range: DateRange,
  pf: string,
  liveDays: DailyEntry[],
  transcriptDays: DailyEntry[],
): Promise<HistoryStatus> {
  const now = new Date()
  const todayStr = toDateString(now)
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const startStr = toDateString(range.start)
  const endStr = toDateString(range.end)
  const { cache, incomplete } = await resolveHistory(yesterdayStr)
  const days = mergeHistoryDays(cache, liveDays, startStr, endStr, todayStr, yesterdayStr)
  if (incomplete) {
    const inScope = (d: string) => d >= startStr && d <= endStr
    const saved = days.filter(d => d.date <= yesterdayStr).map(d => projectDay(d, pf))
    const coveredFrom = incompleteCoveredFrom(saved, transcriptDays.map(d => projectDay(d, pf)), inScope, endStr)
    return { totals: null, historyIncomplete: { ...incomplete, coveredFrom, to: endStr } }
  }
  return { totals: sumHistoryTotals(days, pf), historyIncomplete: null }
}

export type PeriodInfo = { range: DateRange; label: string }
export type AggregateOpts = {
  provider?: string
  project?: string[]
  exclude?: string[]
  daysSelection?: { range: DateRange; label: string; days: Set<string> } | null
  optimize?: boolean
}

/**
 * Resolved-range aggregation shared by `status --format menubar-json` and the MCP server.
 * Pricing must already be loaded (callers run loadPricing first). When opts.optimize is
 * false, the expensive scanAndDetect pass is skipped (retryTax/routingWaste still computed).
 */
export async function buildMenubarPayloadForRange(periodInfo: PeriodInfo, opts: AggregateOpts = {}): Promise<MenubarPayload> {
  const pf = opts.provider ?? 'all'
  const daysSelection = opts.daysSelection ?? null
  const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project ?? [], opts.exclude ?? [])

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayRange: DateRange = { start: todayStart, end: now }
  const todayStr = toDateString(todayStart)
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const rangeStartStr = toDateString(periodInfo.range.start)
  const rangeEndStr = toDateString(periodInfo.range.end)
  const isAllProviders = pf === 'all'

  let todayAllProjects: ProjectSummary[] | null = null
  let todayAllDays: ReturnType<typeof aggregateProjectsIntoDays> | null = null

  const getTodayAllProjects = async (): Promise<ProjectSummary[]> => {
    if (!todayAllProjects) {
      todayAllProjects = fp(await parseAllSessions(todayRange, 'all'))
    }
    return todayAllProjects
  }

  const getTodayAllDays = async (): Promise<ReturnType<typeof aggregateProjectsIntoDays>> => {
    if (!todayAllDays) {
      todayAllDays = aggregateProjectsIntoDays(await getTodayAllProjects())
    }
    return todayAllDays
  }

  let currentData: PeriodData
  let scanProjects: ProjectSummary[]
  let scanRange: DateRange
  let cache: DailyCache
  /// Live-parsed days. Only today's entry is ever taken from here by
  /// mergeHistoryDays; every earlier day comes from the daily cache.
  let liveDays: DailyEntry[]

  const historyDone = measure('history.load-hydrate')
  const history = await resolveHistory(yesterdayStr)
  historyDone()
  cache = history.cache

  if (isAllProviders) {
    const todayProjects = await getTodayAllProjects()
    liveDays = await getTodayAllDays()
    const isTodayOnly = rangeStartStr === todayStr && rangeEndStr === todayStr
    if (isTodayOnly) {
      scanProjects = todayProjects
      scanRange = todayRange
    } else {
      const rawProjects = fp(await parseAllSessions(periodInfo.range, 'all'))
      scanProjects = daysSelection ? filterProjectsByDays(rawProjects, daysSelection.days) : rawProjects
      scanRange = periodInfo.range
    }
  } else {
    const rawProviderProjects = fp(await parseAllSessions(periodInfo.range, pf))
    scanProjects = daysSelection ? filterProjectsByDays(rawProviderProjects, daysSelection.days) : rawProviderProjects
    scanRange = periodInfo.range
    liveDays = aggregateProjectsIntoDays(scanProjects)
  }

  // PERIOD TOTALS
  // The daily history (completed days from the daily cache + today's live day)
  // is the durable record: Claude Code deletes transcripts after ~30 days, so a
  // total parsed from surviving transcripts undercounts any period that reaches
  // further back. Every headline total is therefore the sum of the same merged
  // days that history.daily is built from. Breakdowns that the history cannot
  // carry (projects, sessions, tools, efficiency...) stay parse-derived, and
  // `breakdownCoverage` names the dates they cover when that is less.
  // When the saved history is incomplete (unreadable, failed or stale), the
  // WHOLE total comes from the transcript parse, history.daily carries those
  // same parsed days for the period, and `historyIncomplete` says so.
  // A project filter keeps the transcript totals (the history has no projects).
  const dailyDone = measure('history.daily-sum')
  const hasProjectFilter = (opts.project?.length ?? 0) > 0 || (opts.exclude?.length ?? 0) > 0
  const inScope = (date: string) =>
    date >= rangeStartStr && date <= rangeEndStr && (!daysSelection || daysSelection.days.has(date))
  // Call-dated days from the transcripts of this period and scope.
  const parsedDays = aggregateProjectsIntoDays(scanProjects).filter(d => inScope(d.date))
  const savedInScope = mergeHistoryDays(cache, liveDays, rangeStartStr, rangeEndStr, todayStr, yesterdayStr).filter(d => inScope(d.date))
  const historyIncomplete: HistoryIncompleteInfo | null = history.incomplete
    ? {
        ...history.incomplete,
        coveredFrom: incompleteCoveredFrom(
          savedInScope.filter(d => d.date <= yesterdayStr).map(d => projectDay(d, pf)),
          parsedDays.map(d => projectDay(d, pf)),
          inScope,
          rangeEndStr,
        ),
        to: rangeEndStr,
      }
    : null
  const useHistory = !hasProjectFilter && historyIncomplete === null
  const periodDays = historyIncomplete ? parsedDays : savedInScope
  const breakdownCoverage: BreakdownCoverage | null = useHistory
    ? computeBreakdownCoverage(periodDays.map(d => projectDay(d, pf)), parsedDays.map(d => projectDay(d, pf)), inScope, rangeEndStr)
    : null
  const parsedData = buildPeriodData(periodInfo.label, scanProjects)
  const parsedCost = parsedData.cost
  const parsedSessions = parsedData.sessions
  const headlineDone = measure('history.headline-sum')
  if (!hasProjectFilter && isAllProviders) {
    currentData = buildPeriodDataFromDays(periodDays, periodInfo.label)
    // Sessions are a count, not spend: the parse counts every session active in
    // the period, the history only sessions that started in it. Keep the parse
    // count while the transcripts cover the period, so covered periods are
    // unchanged; past that, the history count matches the history cost.
    if (breakdownCoverage === null) currentData.sessions = parsedData.sessions
  } else {
    currentData = parsedData
    if (!hasProjectFilter) {
      const totals = sumHistoryTotals(periodDays, pf)
      currentData.cost = totals.cost
      currentData.calls = totals.calls
      currentData.savingsUSD = totals.savingsUSD
    }
  }
  headlineDone()
  dailyDone()
  // Cost per session divides two numbers of the same coverage, never a
  // history-wide cost by a transcript-only session count:
  // - all providers (no project filter): saved-days cost / saved-days sessions
  //   (DailyEntry.sessions = sessions started that day), the same days;
  // - provider filter or project filter: transcript cost / transcript sessions
  //   (the history has no per-provider or per-project session count).
  const cpsCost = !hasProjectFilter && isAllProviders ? sumHistoryTotals(periodDays, 'all').cost : parsedCost
  const cpsSessions = !hasProjectFilter && isAllProviders
    ? periodDays.reduce((n, d) => n + d.sessions, 0)
    : parsedSessions
  const costPerSession = cpsSessions > 0 ? cpsCost / cpsSessions : null

  // Codex credits for the period. Reuses the models aggregation (folds reasoning
  // into output, keeps non-cached input + cached-read separate) so the figure
  // matches the official credit rates.
  const modelRows = await aggregateModels(scanProjects)
  currentData.codexCredits = modelRows.reduce(
    (sum, r) => sum + (r.provider === 'codex' && r.credits != null ? r.credits : 0),
    0,
  )

  // PROVIDERS
  // For .all: enumerate every provider with cost across the period (from cache) + installed-but-zero.
  // For specific: just this single provider with its scoped cost.
  const allProviders = await getAllProviders()
  const displayNameByName = new Map(allProviders.map(p => [p.name, p.displayName]))
  const providers: ProviderCost[] = []
  if (isAllProviders) {
    const providerTotals: Record<string, number> = {}
    for (const d of periodDays) {
      for (const [name, p] of Object.entries(d.providers)) {
        providerTotals[name] = (providerTotals[name] ?? 0) + p.cost
      }
    }
    for (const [name, cost] of Object.entries(providerTotals)) {
      providers.push({ name: displayNameByName.get(name) ?? name, cost })
    }
    for (const p of allProviders) {
      if (providers.some(pc => pc.name === p.displayName)) continue
      const sources = await p.discoverSessions()
      if (sources.length > 0) providers.push({ name: p.displayName, cost: 0 })
    }
  } else {
    const display = displayNameByName.get(pf) ?? pf
    providers.push({ name: display, cost: currentData.cost })
  }

  // DAILY HISTORY (last 365 days)
  // Cache stores per-provider cost+calls per day in DailyEntry.providers, so we can derive
  // a provider-filtered history without re-parsing. Tokens aren't broken down per provider
  // in the cache, so the filtered view shows zero tokens (heatmap/trend still works on cost).
  // The window reaches back to the period start when that is older (custom
  // ranges), so history.daily always lists every day the total sums.
  const defaultHistoryStartStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS))
  const historyStartStr = rangeStartStr < defaultHistoryStartStr ? rangeStartStr : defaultHistoryStartStr
  const mergedHistoryDays = mergeHistoryDays(cache, liveDays, historyStartStr, todayStr, todayStr, yesterdayStr)
  const historyDays = historyIncomplete
    ? [...mergedHistoryDays.filter(d => !inScope(d.date)), ...parsedDays].sort((a, b) => a.date.localeCompare(b.date))
    : mergedHistoryDays

  let dailyHistory
  if (isAllProviders) {
    dailyHistory = historyDays.map(d => {
      const topModels = Object.entries(d.models)
        .filter(([name]) => name !== '<synthetic>')
        .sort(([, a], [, b]) => b.cost - a.cost)
        .slice(0, 5)
        .map(([name, m]) => ({
          name,
          cost: m.cost,
          savingsUSD: m.savingsUSD,
          calls: m.calls,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
        }))
      return {
        date: d.date,
        cost: d.cost,
        savingsUSD: d.savingsUSD,
        calls: d.calls,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        cacheReadTokens: d.cacheReadTokens,
        cacheWriteTokens: d.cacheWriteTokens,
        topModels,
      }
    })
  } else {
    const emptyModels = [] as { name: string; cost: number; savingsUSD: number; calls: number; inputTokens: number; outputTokens: number }[]
    dailyHistory = historyDays.map(d => ({
      ...projectDay(d, pf),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      topModels: emptyModels,
    }))
  }

  const home = homedir()
  const friendlyProject = (p: ProjectSummary) => {
    const resolved = p.projectPath || p.project
    if (resolved === home || resolved === home + '/') return 'Home'
    return resolved.split('/').filter(Boolean).pop() || p.project
  }

  currentData.projects = scanProjects.map(p => ({
    name: friendlyProject(p),
    cost: p.totalCostUSD,
    savingsUSD: p.totalSavingsUSD,
    sessions: p.sessions.length,
    sessionDetails: [...p.sessions]
      .sort((a, b) => b.totalCostUSD - a.totalCostUSD)
      .slice(0, 10)
      .map(s => ({
        cost: s.totalCostUSD,
        savingsUSD: s.totalSavingsUSD,
        calls: s.apiCalls,
        inputTokens: s.totalInputTokens,
        outputTokens: s.totalOutputTokens,
        date: s.firstTimestamp?.split('T')[0] ?? '',
        models: Object.entries(s.modelBreakdown)
          .map(([name, m]) => ({ name, cost: m.costUSD, savingsUSD: m.savingsUSD }))
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 3),
      })),
  }))

  const effMap = aggregateModelEfficiency(scanProjects)
  currentData.modelEfficiency = [...effMap.entries()].map(([name, eff]) => ({
    name,
    costPerEdit: eff.costPerEditUSD,
    oneShotRate: eff.oneShotRate,
  }))

  const retryTaxByModel = [...effMap.values()]
    .filter(m => m.retries > 0 && m.editTurns > 0)
    .map(m => ({
      name: m.model,
      taxUSD: m.retries * (m.editCostUSD / m.editTurns),
      retries: m.retries,
      retriesPerEdit: m.retriesPerEdit,
    }))
    .sort((a, b) => b.taxUSD - a.taxUSD)
  const retryTax = {
    totalUSD: retryTaxByModel.reduce((s, m) => s + m.taxUSD, 0),
    retries: retryTaxByModel.reduce((s, m) => s + m.retries, 0),
    editTurns: [...effMap.values()].filter(m => m.retries > 0).reduce((s, m) => s + m.editTurns, 0),
    byModel: retryTaxByModel.slice(0, 5),
  }

  currentData.topSessions = scanProjects.flatMap(p =>
    p.sessions.map(s => ({
      project: friendlyProject(p),
      cost: s.totalCostUSD,
      savingsUSD: s.totalSavingsUSD,
      calls: s.apiCalls,
      date: s.firstTimestamp?.split('T')[0] ?? '',
    }))
  ).sort((a, b) => (b.cost + b.savingsUSD) - (a.cost + a.savingsUSD)).slice(0, 5)

  // Routing waste: find cheapest reliable model (≥90% 1-shot, ≥5 edits),
  // then compute how much each pricier model overpaid.
  const reliableModels = [...effMap.values()]
    .filter(m => m.oneShotRate !== null && m.oneShotRate >= 90 && m.editTurns >= 5
      && (m.costPerEditUSD ?? 0) >= 0.01)
    .sort((a, b) => (a.costPerEditUSD ?? Infinity) - (b.costPerEditUSD ?? Infinity))
  const baseline = reliableModels[0]
  const routingWasteByModel = baseline
    ? [...effMap.values()]
        .filter(m => m.model !== baseline.model && m.editTurns > 0 && (m.costPerEditUSD ?? 0) > (baseline.costPerEditUSD ?? 0))
        .map(m => {
          const counterfactual = m.editTurns * (baseline.costPerEditUSD ?? 0)
          return {
            name: m.model,
            costPerEdit: m.costPerEditUSD ?? 0,
            editTurns: m.editTurns,
            actualUSD: m.editCostUSD,
            counterfactualUSD: counterfactual,
            savingsUSD: m.editCostUSD - counterfactual,
          }
        })
        .filter(m => m.savingsUSD > 0)
        .sort((a, b) => b.savingsUSD - a.savingsUSD)
    : []
  const routingWaste = {
    totalSavingsUSD: routingWasteByModel.reduce((s, m) => s + m.savingsUSD, 0),
    baselineModel: baseline?.model ?? '',
    baselineCostPerEdit: baseline?.costPerEditUSD ?? 0,
    byModel: routingWasteByModel.slice(0, 5),
  }

  const breakdowns: BreakdownArrays = (() => {
    const toolMap: Record<string, number> = {}
    const skillMap: Record<string, { turns: number; cost: number }> = {}
    const subagentMap: Record<string, { calls: number; cost: number }> = {}
    const mcpMap: Record<string, number> = {}
    // Local-model savings rollup: avoided spend (cost forced to $0, baseline
    // recorded) grouped by model and provider. Mirrors the per-call savingsUSD
    // that applyLocalModelSavings stamps in the parser.
    const savingsByModel = new Map<string, { calls: number; actualUSD: number; savingsUSD: number; baselineModel: string; inputTokens: number; outputTokens: number }>()
    const savingsByProvider = new Map<string, { calls: number; savingsUSD: number }>()
    let totalSavings = 0
    let totalSavingsCalls = 0
    for (const p of scanProjects) for (const s of p.sessions) {
      for (const [t, d] of Object.entries(s.toolBreakdown)) { if (!t.startsWith('lang:')) toolMap[t] = (toolMap[t] ?? 0) + d.calls }
      for (const [sk, d] of Object.entries(s.skillBreakdown)) { const e = skillMap[sk] ?? { turns: 0, cost: 0 }; e.turns += d.turns; e.cost += d.costUSD; skillMap[sk] = e }
      for (const [sa, d] of Object.entries(s.subagentBreakdown)) { const e = subagentMap[sa] ?? { calls: 0, cost: 0 }; e.calls += d.calls; e.cost += d.costUSD; subagentMap[sa] = e }
      for (const [m, d] of Object.entries(s.mcpBreakdown)) { mcpMap[m] = (mcpMap[m] ?? 0) + d.calls }
      for (const turn of s.turns) for (const call of turn.assistantCalls) {
        if (!call.savingsUSD || call.savingsUSD <= 0) continue
        totalSavings += call.savingsUSD
        totalSavingsCalls += 1
        const modelKey = getShortModelName(call.model)
        const acc = savingsByModel.get(modelKey) ?? { calls: 0, actualUSD: 0, savingsUSD: 0, baselineModel: call.savingsBaselineModel ?? '', inputTokens: 0, outputTokens: 0 }
        acc.calls += 1
        acc.actualUSD += call.costUSD
        acc.savingsUSD += call.savingsUSD
        acc.baselineModel = acc.baselineModel || (call.savingsBaselineModel ?? '')
        acc.inputTokens += call.usage.inputTokens
        acc.outputTokens += call.usage.outputTokens
        savingsByModel.set(modelKey, acc)
        const provAcc = savingsByProvider.get(call.provider) ?? { calls: 0, savingsUSD: 0 }
        provAcc.calls += 1
        provAcc.savingsUSD += call.savingsUSD
        savingsByProvider.set(call.provider, provAcc)
      }
    }
    const localModelSavings = {
      totalUSD: totalSavings,
      calls: totalSavingsCalls,
      byModel: Array.from(savingsByModel.entries()).sort(([, a], [, b]) => b.savingsUSD - a.savingsUSD).slice(0, 5).map(([name, d]) => ({ name, ...d })),
      byProvider: Array.from(savingsByProvider.entries()).sort(([, a], [, b]) => b.savingsUSD - a.savingsUSD).slice(0, 5).map(([name, d]) => ({ name, ...d })),
    }
    return {
      tools: Object.entries(toolMap).sort(([, a], [, b]) => b - a).slice(0, 10).map(([name, calls]) => ({ name, calls })),
      skills: Object.entries(skillMap).sort(([, a], [, b]) => b.cost - a.cost).slice(0, 10).map(([name, d]) => ({ name, ...d })),
      subagents: Object.entries(subagentMap).sort(([, a], [, b]) => b.cost - a.cost).slice(0, 10).map(([name, d]) => ({ name, ...d })),
      mcpServers: Object.entries(mcpMap).sort(([, a], [, b]) => b - a).slice(0, 10).map(([name, calls]) => ({ name, calls })),
      // The saved total is a period total: it follows the headline source.
      localModelSavings: hasProjectFilter ? localModelSavings : { ...localModelSavings, totalUSD: currentData.savingsUSD },
      breakdownCoverage,
      historyIncomplete,
      costPerSession,
      historyFrom: historyStartStr,
    }
  })()

  const optimize = opts.optimize === false ? null : await scanAndDetect(scanProjects, scanRange)
  return buildMenubarPayload(currentData, providers, optimize, dailyHistory, retryTax, routingWaste, breakdowns)
}
