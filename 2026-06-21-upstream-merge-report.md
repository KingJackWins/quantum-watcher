# Quantum Watcher — Upstream Merge Report

## Summary
Merged 32 upstream commits from getagentseal/codeburn into quantum-watcher/main. Resolved all conflicts, fixed 4 post-merge test failures, completed branding sweep.

## Commits
- `23bae8e` — merge upstream codeburn → quantum-watcher (32 commits)
- `32f71f4` — fix: resolve 4 post-merge test failures + complete branding sweep

## Conflicts Resolved (7 test files)
The actual merge produced 7 "both modified" test files (different from the 6 spec'd conflicts):
- `tests/antigravity-statusline.test.ts`
- `tests/models.test.ts`
- `tests/parser-gemini-cache.test.ts`
- `tests/plan-usage.test.ts`
- `tests/plans.test.ts`
- `tests/provider-turn-grouping.test.ts`
- `tests/providers/antigravity.test.ts`

All were auto-resolved by git (upstream's simplified env var management + our quantum-watcher branding). Staged as-is.

## Post-Merge Fixes (4 test failures)
1. **cursor-agent.ts** — Added dedup Set (`warnedUnrecognizedTranscripts`) for unrecognized transcript warnings (upstream feature, not auto-merged)
2. **cursor.ts** — Wired `CODEBURN_CURSOR_MAX_BUBBLES` env var to `MAX_BUBBLES` constant
3. **cursor-large-db-cap.test.ts** — Updated test expectations to match our ROWID windowing approach
4. **parser-filter.test.ts** — Updated case-insensitive test from `AGENTSEAL` to `QUANTUM MEMORY`
5. **minimax.test.ts** — Updated M3 pricing expectations to match current LiteLLM data ($0.3/$1.2 per M)

## Branding Sweep
Rebranded all new `codeburn`/`CodeBurn` references introduced by the merge:
- **src/**: main.ts, overview.ts, web-dashboard.ts, sharing/* (5 files), providers/zcode.ts, providers/cursor-agent.ts
- **dash/**: index.html, App.tsx, DeviceSearchModal.tsx, lib/api.ts, vite.config.ts
- **tests/**: antigravity-statusline.test.ts, setup/env-isolation.ts

Preserved: env var names (`CODEBURN_*`), upstream repo URL references, logo filename.

## Verification
- `npm run build` — clean (zero errors)
- `npm test` — 105 files passed, 1272 tests passed, 0 failures
- `git push origin main` — pushed to KingJackWins/quantum-watcher

## New Upstream Features Included
- Web dashboard (dash/)
- Device sharing (src/sharing/)
- Overview command (src/overview.ts)
- Grok, ZCode, ZeroStack providers
- Vitest config + env isolation setup
- Various test improvements
