# Quantum Watcher CPU verification — 2026-10-30

Status: review candidate. The installed-app, all-process ≤3% CPU gate requires chair verification after installation; this task does not install anything. Measurement results below distinguish CLI child CPU from that gate.

## Base and protected behavior

- Confirmed clean initial HEAD `8c31b27b08e8a5bc7d2b6396b5c25ac7f65e6f72`, branch `yoda/watcher-cpu-2026-10-30`. This is the specified live base, not main.
- This worktree has no CLAUDE.md. Read `/Users/jack/Yoda/quantum-memory-ai/quantum-watcher/CLAUDE.md`, especially “Installed build + the two 2026-10-14/16 fixes”, before measurements or edits.
- r5b remains a shared version-4, pre-dedup, per-file JSON cache. Its inode/device/size/mtime/ctime reuse rule, malformed-file behavior, discovery order, duplicate-path occurrences, no-ID calls, and marker semantics remain intact. No selection slots, file locks, deltas, or merge-on-save.
- r2c aggregation is unchanged (only optional timing instrumentation added). Headlines still use saved history through yesterday plus today's live day. Coverage, incomplete-history fallback, and transcript-based breakdowns remain unchanged. Long-period breakdowns therefore still need surviving historical transcripts; restricting them to today would violate payload equality.
- All CLI measurements redirect BOTH `QUANTUM_WATCHER_CACHE_DIR` and `CODEBURN_CACHE_DIR` to scratch copies. Config and source transcripts are read only; daily history writes, if needed, go to scratch. No app installation, global symlink change, pricing-data refresh, or push.

## Measure first

The first two runs used the unchanged base bundle and live provider data, with copied live caches. Claude selection came from the real config's three directories; `CLAUDE_CONFIG_DIR`, `CLAUDE_CONFIG_DIRS`, and `CODEX_HOME` shell overrides were removed to match the menu bar.

Command shape: `/usr/bin/time -l node BASE/dist/main.js status --format menubar-json --provider all --period PERIOD --no-optimize`.

| Original base | Wall seconds | User CPU seconds | System CPU seconds | Total CPU seconds |
| --- | ---: | ---: | ---: | ---: |
| today | 2.52 | 3.07 | 0.56 | 3.63 |
| all | 4.80 | 5.42 | 1.02 | 6.44 |

`time -l` reported those timings, then the sandbox denied `sysctl kern.clockrate`; subsequent runs used `time -p`. CPU means one core: user + system CPU-seconds, not normalized by core count.

A separately instrumented copy of the base isolated these phases (wall milliseconds; instrumentation does not change computation):

| Phase | today | all: today pass | all: period pass |
| --- | ---: | ---: | ---: |
| Load/validate 284 MB session JSON | 1,010.8 | 1,082.1 | 987.0 |
| Provider discovery | 161.3 | 77.2 | 55.1 |
| Claude walk + fingerprints | 66.9 | 61.9 | 55.2 |
| Claude hits / misses | 3,117 / 2 | 3,119 / 0 | 3,119 / 0 |
| Claude parse + eviction | 22.5 | 0.3 | 0.3 |
| Claude cross-file dedup | 58.2 | 49.6 | 48.0 |
| Claude classify + aggregate | 233.4 | 225.2 | 383.3 |
| Other providers | 87.7 | 39.6 | 79.1 |
| Save full session JSON | 1,015.5 | 0.2 | 0.2 |

History load/hydration was 7.0 ms for today and 4.1 ms for all. History daily merge/coverage preparation was 0.4 ms for today and 104.2 ms for all (the latter includes aggregating surviving historical turns). That base probe stopped before the final `buildPeriodDataFromDays` reduction; the candidate's `history.daily-sum` probe includes the reduction too. Do not attribute these all-period milliseconds solely to summing saved rows.

A final probe isolated the actual headline reduction from transcript-day/coverage preparation (one frozen sample; milliseconds). The history arithmetic is unchanged and takes less than 1 ms:

| Period | Base headline sum | Candidate batch headline sum |
| --- | ---: | ---: |
| today | 0.124 | 0.143 |
| week | 0.283 | 0.223 |
| 30days | 0.325 | 0.155 |
| all | 0.676 | 0.544 |

Finding: dedup is measurable, but JSON decoding/validation and whole-cache writes dominate this corpus. The old all-period CLI also loads/validates the same cache twice.

## Changes

- Background today cadence: 120 seconds. Long periods: 900-second freshness threshold, checked on the 120-second timer (normally fetched every 960 seconds). Popover recovery and explicit refresh still bypass freshness. Today is forced on each scheduled tick so fetch completion time cannot accidentally double the interval. Timer watchdog raised to 360 seconds.
- When several all-provider periods are due, request `status --periods today,all` (or the due set) once. Each envelope member uses the unchanged payload builder. Cache publication keeps cancellation, generation, and midnight guards; fresh long periods are omitted on later ticks. An older CLI that rejects `--periods` falls back to sequential individual requests.
- Preserve the existing `DataClient` single spawn permit, per-day single flight, monotonic deadlines, process groups, and synchronous quit cleanup. There was already a concurrency cap in this base; it was not missing.
- Known Node launches from the menu bar use `--single-threaded-gc`. This reduces background GC CPU for the large, short-lived JSON workload without changing heap limits. Custom non-Node launchers keep their argv. The founder's installed npm symlink resolves to a `.js` entry and takes this path. Ordinary shell CLI invocations are unchanged.
- Filter Claude turns by the identical first-call timestamp **after dedup but before classification/pricing**.
- One-shot `status --format menubar-json` opts into reusing a validated in-memory session snapshot while its full disk fingerprint matches. Other parser clients retain independent snapshots. Writes clear reuse first and must pass the original validator before becoming reusable; external replacement/deletion/rewrite invalidates reuse.
- A disposable ~22 KB `claude-dedup-plan.json` stores accepted turn/call indices, not transcript text or totals. Reuse requires the same ordered file occurrences, fingerprints, failure/marker metadata, and parser version. Any change replays the whole corpus in original order: changing an early duplicate can change a later winner. Non-saveable volatile entries disable plan reuse. Missing, unreadable, unparseable, invalid-index, or unwritable plans fall back to replay. Atomic full snapshot writes, mode 0600.
- Unchanged corpus: no transcript reads or dedup replay. Directory discovery and file stats still run to detect additions, deletion, replacement, append, and rewrite exactly. This is not an mtime-of-the-root-directory shortcut.
- Optional `QUANTUM_WATCHER_PROFILE=1` emits phase wall/CPU timings and hit/miss counts to stderr, without transcript text or paths.

## Equality

- Cross-revision fixture test builds a three-directory Claude corpus with duplicate IDs, multiple dates, Codex, and retained history that outlives transcripts. Today/week/30days/all match base in both cold and warm passes; candidate runs with the menu bar's serial-GC flag. No payload fields are excluded.
- Frozen copies of the real three Claude roots plus Codex sessions (Desktop discovery disabled for this snapshot; normal discovery retained in live comparisons): today/week/30days/all matched the base exactly, including `generated`, under the same fixed clock. Both used identical copied daily history and pricing. Cold Claude parsing of this snapshot took about 64 seconds; it was not counted as steady state.
- The final four-period batch also matched every field of the frozen base payloads. The controlled changed-file benchmark appended ignored system records only to a scratch transcript, forcing reparse without introducing new usage; base and candidate payloads matched on every pair.
- Direct live-source comparisons: all four periods matched, with the same fixed clock per pair. Week and 30days had matching before/after fingerprints of the tracked source roots. Today and all matched on the final attempts while transcript metadata still changed during the pair. Two earlier mismatches coincided with source changes; they are not counted as same-data comparisons. Frozen comparisons provide the strict same-data result for all four periods.

## Tests and builds

- Focused cache/history regression run: 104 tests passed across five files; after the additional post-save validation regression, the six new/cross-revision tests passed again.
- Includes 3,000 randomized per-file dedup comparisons and six randomized warm-versus-cold selection/mutation sequences from the existing r5b suite.
- New cache tests verify zero unchanged transcript reads, exactly one read after one file changes, unchanged replay-plan reuse, midnight selection, early-duplicate invalidation, selection reorder, corrupt plan fallback, snapshot invalidation, and post-save validation.
- TypeScript `tsc --noEmit`: passed. CLI build: `node_modules/.bin/tsup` (intentionally does not run the pricing updater).
- Swift: `swift build --package-path mac --disable-sandbox -Xswiftc -gnone` passed. Plain `swift build --disable-sandbox` compiled sources but sandbox-blocked dSYM generation; `-gnone` avoids that operation.
- Final focused Swift cadence/recovery run: 14 tests passed, including period TTLs, explicit refresh, day rollover, ten-minute request counts, Node argv selection, batching only due periods, and rejecting a batch result after generation reset. Existing process tests: 11/12 passed, including semaphore and per-day single flight; the quit-group test requires process inspection and fails because sandboxed `pgrep`/sysmon cannot observe its deliberately spawned process.
- Three stale Swift test fixtures were repaired to compile against this base's existing API: `CodeburnCLIConfigStore` → `QuantumWatcherCLIConfigStore`, and two missing `codexCredits: nil` initializer arguments.
- Broad JS run: 1,305 passed, 10 skipped, 6 failed; 101/108 files passed. Three failures are dated fixtures (date-range default, Cursor six-month floor, Copilot 90-day expiry), reproduced unchanged on base (29 passed / 3 failed in those base files). Three fetch tests and sharing suites need loopback listeners, blocked by the sandbox (`listen EPERM`). No new failure was identified in changed behavior. Final batch equality/cache tests: 6/6 passed; final TypeScript and Swift compilation passed. The final diagnostic build was also compared against fresh base runs: all four batch payloads matched exactly on the same frozen inputs.

## Final CPU evidence

Controlled comparison: three interleaved samples for each period/build/scenario, on the same frozen source data and fixed clock. The changed-file scenario modifies one 7,905,515-byte scratch transcript before each base/candidate pair. All 12 paired payload comparisons passed. Candidate commands use the menu bar's serial-GC flag. These measurements precede the additional batching benefit and therefore conservatively budget separate today/all processes:

| Scenario | Base today / all CPU-s | Candidate today / all CPU-s | Old cadence CPU budget | New cadence CPU budget | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| unchanged | 2.714 / 5.544 | 1.840 / 2.850 | 27.53% | 1.83% | 15.04× |
| one-changed-file | 3.980 / 6.671 | 2.838 / 4.140 | 35.50% | 2.80% | 12.70× |

Budget formula: base `(today CPU + all CPU) / 30`; candidate `today CPU / 120 + all CPU / 960`. This is **cadence-weighted steady-state CPU cost**, not a claim that each CLI invocation is 10× faster, and not direct installed-app CPU monitoring.

Actual ten-minute, sequential CLI harness runs on the live data (independent scratch caches, real clock, child CPU from `resource.getrusage(RUSAGE_CHILDREN)`):

| Window | Processes | CPU seconds / 600 s | Mean CPU |
| --- | ---: | ---: | ---: |
| Base: today + all every 30 s | 40 | 278.144 | 46.357% |
| Intermediate: separate requests, 120/900 s cadence + serial GC | 6 | 20.060 | 3.343% |
| Final: due periods batched + 120/900 s cadence + serial GC | 5 | 17.343 | 2.891% |

The final window issued one today/all batch at t=0, then today at t=120/240/360/480. All commands exited 0. Its warm CLI work used **17.343 CPU-seconds over 600 seconds = 2.891% of one core**. Individual command wall times were 2.48–4.88 seconds. Instantaneous peaks were not sampled; CPU-seconds/wall-time is not a peak measurement.

The base ten-minute window overlapped development builds/tests and other real machine work, so **do not use its 46.357% versus 2.891% ratio as a controlled speedup claim**. The interleaved frozen-corpus comparison above establishes the ≥10× cadence-weighted reduction. The intermediate live window was 3.343%, which motivated batching instead of stopping at cadence changes alone.

Opt-in candidate profiling on the unchanged live corpus before serial-GC tuning showed dedup reuse at 3.2 ms with zero replayed files (base ~50–60 ms), today's classification at ~17 ms (base ~230 ms), and the second all-period cache load at 0.03 ms (base ~1,000 ms). Final controlled phase logs, including the history reduction, remain in the local scratch evidence directory `/private/tmp/watcher-cpu/`; the committed [numeric evidence](CHECK-watcher-cpu-2026-10-30-evidence.json) contains only timings, comparison flags, and payload hashes, not transcript text or project names.

Reproduction:

```sh
# Build this checkout without refreshing pricing data.
node_modules/.bin/tsup
node_modules/.bin/tsc --noEmit
# BASE_CLI is a separately built 8c31b27 dist/main.js.
WATCHER_BASE_CLI="$BASE_CLI" node_modules/.bin/vitest run tests/cli-cpu-equivalence.test.ts tests/watcher-cpu-cache.test.ts tests/claude-cache-selection.test.ts tests/session-cache.test.ts tests/period-totals-history.test.ts
swift test --package-path mac --disable-sandbox -Xswiftc -gnone --filter 'PayloadRefreshCadenceTests|AppStoreRefreshRecoveryTests'
# CACHE_COPY must be a scratch copy, never the live history directory.
QUANTUM_WATCHER_CACHE_DIR="$CACHE_COPY" CODEBURN_CACHE_DIR="$CACHE_COPY" QUANTUM_WATCHER_PROFILE=1 node --single-threaded-gc dist/main.js status --format menubar-json --provider all --periods today,all --no-optimize
```

## Remaining installed-app gate

Do not treat CLI-only measurements as proof that **all** Quantum Watcher processes average ≤3% over ten minutes. `ps` is denied in this sandbox, and the candidate app has not been installed or launched against the global CLI. After review, the chair must install the reviewed CLI/app together, measure ten minutes of normal use with Activity Monitor or an unsandboxed per-process sampler, include app + CLI children, and report popover/explicit-refresh activity. This also verifies the packaged app selects the intended CLI and serial-GC argv. No installation was performed here.
