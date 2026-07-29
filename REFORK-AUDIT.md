# Quantum Watcher — Refork Audit & Thin-Brand-Layer Plan

**Author:** Tesla (CTO) · **Date:** 2026-07-27 · **Task:** 249c3cae (founder-approved)
**Repo:** `/Users/jack/Yoda/quantum-memory-ai/quantum-watcher`
`origin` = github.com/KingJackWins/quantum-watcher · `upstream` = github.com/getagentseal/codeburn (MIT)

---

## TL;DR
Our fork diverges from upstream by **145 files / 998+ / 940−** — and **379 commits behind**.
The divergence is **almost entirely self-inflicted churn from renaming things users never see.**
Reset to upstream HEAD, re-apply branding as a **~5-file thin layer that renames nothing internal**, and the every-release merge tax drops from a day to minutes.

- Archive branch created: **`archive/pre-refork-0.9.12`** @ `92fe148` (nothing is lost; reset is fully reversible).

---

## 1. Commit audit (our 13 commits, `upstream/main..HEAD`)

| Commit | Bucket | Disposition |
|---|---|---|
| `dcae96b` rebrand: CodeBurn → Quantum Watcher + forest glass | BRANDING | discard → re-apply via thin layer |
| `52e957d` complete rebrand across all source files | BRANDING | discard (this is the 145-file churn) |
| `c870258` rebrand with forest green theme | BRANDING | discard → theme override file |
| `20995f0` replace orange with green (#0a4a25) | BRANDING/color | discard → theme override file |
| `38e0ed4` rebrand remaining text + Failed→Retry badge | MIXED | discard; re-check "Failed→Retry" — if it's a genuine UX improvement, offer upstream, else drop |
| `f6f9223` liquid-glass UI | DESIGN | discard → theme/design override |
| `6d93119` adaptive glass light-mode | DESIGN | discard → theme/design override |
| `32f71f4` resolve 4 post-merge test failures + branding sweep | BRANDING-ACCOMMODATION | **discard** — these test edits exist only to match our renames; they vanish when we stop renaming |
| `23bae8e` merge upstream (32 commits) | MERGE | obsolete after reset |
| `f5db6ab` **add ~/node/bin to userNodePaths (exit 127 fix)** | **FUNCTIONAL** | **PRESERVE** — see §2 |
| `92fe148` add isOverDailyBudget/dailyTokenBudget to AppStore | FUNCTIONAL(stale) | **DROP** — see §2 |

## 2. Functional-fix survival (checked against upstream HEAD)

**`f5db6ab` — PRESERVE (the one real asset).**
Upstream `userNodePaths` (mac/Sources/CodeBurnMenubar/Security/CodeburnCLI.swift) still only lists
`.volta/bin`, `.npm-global/bin`, `.asdf/shims`, `.nvm`. It does **not** include `~/node/bin`, so the
exit-127 failure for direct-download node installs (Jack's `/Users/jack/node/bin`) is **not fixed upstream**.
→ Re-apply as a **1-line** patch on top of the reset. It's a genuine, generalizable fix — **offer it upstream** as a PR.

**`92fe148` — DROP (obsolete).**
Upstream HEAD already implements `dailyTokenBudget` and `isOverDailyBudget` in `AppStore.swift` (lines 86–105)
and wires them in `CodeBurnApp.swift`. Ours was an incomplete-merge reconciliation patch superseded by upstream's real implementation. → Nothing to preserve.

## 3. Where the 145 files come from (divergence composition)

```
 49 mac    ← mostly directory RENAME CodeBurnMenubar → QuantumWatcherMenubar (R087–R100)
 47 src    ← "codeburn" → "quantum-watcher" string edits (upstream has codeburn in 75 TS files)
 39 tests  ← changed ONLY to track the renames above  ← violates the zero-test-changes criterion
  5 dash
  1 package.json / package-lock / LICENSE / gnome / .gitignore
```

**Root cause (Musk algorithm — delete the part):** renaming the Swift module directory and internal
`codeburn` identifiers produces 145 files of churn for **zero user-visible benefit** and re-conflicts on
**every** upstream release. Users never see the module dir name, internal class names, UserDefaults keys, or test fixtures.

## 4. The thin brand layer (acceptance criterion: divergence ≤ ~5 files, ZERO test changes)

**Rename NOTHING internal.** Keep `CodeBurnMenubar`, internal `codeburn` identifiers, UserDefaults keys
(e.g. `CodeBurnDailyTokenBudget`), class names, and every test fixture exactly as upstream ships them.

Change ONLY the user-visible surface, each sourced from a single place:

1. **`package.json`** — `name: quantum-watcher`, `bin: quantum-watcher`, `description`, `repository`/`homepage`/`bugs` URLs. (npm identity + CLI command name.)
2. **`brand.ts`** (new, TS side) — one module exporting `BRAND = { displayName: "Quantum Watcher", cliName, dashboardTitle, urls, logPrefix }`. The handful of **user-facing** print/render sites read from it. Internal `codeburn` strings stay.
3. **`Brand.swift`** (new, mac side) — display name, menubar label, About text — OR just set `CFBundleDisplayName` in Info.plist. Keep the `CodeBurnMenubar` module name.
4. **Theme override** (1 file) — forest-green palette (#0a4a25) + glass recipe applied in upstream's existing theme file, in place, no rename.
5. **`README.md`** — fork attribution near the top (link to getagentseal/codeburn) + rebrand copy. **Non-negotiable (ethical + defensive).**
6. **`LICENSE`** — dual copyright (AgentSeal + Quantum Memory AI). **Already correct — keep.**

Plus **1 functional patch**: `f5db6ab` node/bin one-liner (offer upstream).

**Validation of the layer:** after reset+re-apply, `git diff upstream/main...HEAD --stat` should show
~5–6 files and **0 under `tests/`**. If a future `git merge upstream/main` conflicts in more than a
couple of files, the layer leaked into renames — iterate until it doesn't. *This is the criterion that matters.*

## 5. Execution plan (next phase)

1. `git checkout main` on the fork; confirm `archive/pre-refork-0.9.12` exists + push it to origin (safety).
2. `git reset --hard upstream/main` (⚠️ destructive but authorized by task + reversible via archive branch — reviewer-gated confirm before running).
3. Add the 5 brand files (§4). Cherry-pick/re-apply `f5db6ab` as a 1-liner.
4. `git diff upstream/main...HEAD --stat` → confirm ≤ ~6 files, 0 tests. **This is the number to report.**
5. Test suite green against the new base (unchanged upstream tests must pass as-is).
6. npm prep: verify `files`/`.npmignore` leak nothing (no secrets, no /Users/jack paths, no internal docs incl. this file, no client names); `bin` resolves; `npm pack` → global-install the tarball in a clean temp dir → run `quantum-watcher overview|optimize|compare|yield|menubar`.
7. `npm publish --dry-run` clean → **STOP.** npm is not authenticated (ENEEDAUTH, needs founder 2FA). Hand founder the exact command; he publishes.
8. Rewrite `CLAUDE.md` from verified CLI reality (current doc wrongly lists `today/month/status` as subcommands — they are period flags `-p today`).

## 7. Exact upstream file paths (turnkey for DaVinci execution)

Verified against `upstream/main` (v0.9.19). The brand layer touches ONLY these, in place, no renames:

- **package.json** — upstream: `name: codeburn`, `bin: { codeburn: dist/cli.js }`, `version: 0.9.19`.
  → set `name: quantum-watcher`, `bin: { quantum-watcher: dist/cli.js }`, update `description`/`repository`/`homepage`/`bugs`.
- **`src/brand.ts`** (NEW) — export `BRAND` (displayName, cliName, dashboardTitle, urls, logPrefix). Wire ONLY the user-facing sites:
  `src/cli.ts` (help/banner), `src/web-dashboard.ts` (dashboard title), `src/config.ts` (config dir/label if user-visible). Leave the other ~72 files' internal `codeburn` strings untouched.
- **mac display name** — no Info.plist in the SPM tree; the menubar title/About string is set in code (`mac/Sources/CodeBurnMenubar/CodeBurnApp.swift`). Route the display name through one `Brand.swift` constant; keep the `CodeBurnMenubar` module name.
- **theme override** — `mac/Sources/CodeBurnMenubar/Theme/Theme.swift` (+ `ThemeState.swift`). Apply forest-green (#0a4a25) + glass in place. This is the ONE mac theme file — do not scatter colors.
- **README.md** — fork attribution near top (link getagentseal/codeburn) + rebrand copy.
- **LICENSE** — dual copyright, already correct, keep.
- **functional patch** — `mac/Sources/CodeBurnMenubar/Security/CodeburnCLI.swift`: add `"\(home)/node/bin"` to the `userNodePaths` list (re-apply `f5db6ab`; 1 line) + offer upstream.
- **.npmignore** — add `REFORK-AUDIT.md`, `CLAUDE.md`, any internal docs so they never publish.

**Safety note (2026-07-27):** origin/main = `32f71f4`; local HEAD = `92fe148`. Commits `f5db6ab` (node/bin — the one asset) and `92fe148` are **local-only**, not on origin. Archive branch `archive/pre-refork-0.9.12` pushed to origin to protect them off-machine before any reset.

## 6. Dispatch note
Re-apply across Swift + TS is DaVinci-shaped implementation. Dispatch is currently infra-blocked
(stale yoda2 coordinator registration — escalated to COO). Once unblocked, this plan dispatches to
DaVinci as a mechanical execution spec; the FLAGGED review slice = npm-leak check (no secrets/paths in
the published tarball) → route to Cypher/Titan before the founder publishes.
