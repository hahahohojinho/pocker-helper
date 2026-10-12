# RangeLab Handoff

Last updated: 2026-10-12

## Resume here (2026-10-11, branch fix/solver-quality)

- 2026-10-12: the legacy DCFR job API now handles IP roots and validated intermediate histories through the adapter's `--json` mode (former Next TODO 1; CHANGELOG). Full `npm test` with `DCFR_ADAPTER_PATH`: 353 passed, 2 skipped; lint and tsc clean.
- 2026-10-12: CI `adapter` matrix job (ubuntu-latest, windows-latest) builds the adapter on the pinned 1.99.0 toolchain (`tools/dcfr-adapter/rust-toolchain.toml`), runs its cargo tests and the `DCFR_ADAPTER_PATH` vitest integration tests; the adapter accepts the extension-less binary name off Windows. Verified locally on Windows only (5 cargo tests, 37 vitest); not yet run on GitHub. The matchup-export TODO was dropped (the preflop packs cover those spots).
- Local MSVC env on 2026-10-12: only `C:\Program Files\Microsoft Visual Studio2\Community\Common7\Tools\VsDevCmd.bat` exists (no VS 18, no onecore append needed); the VS 18 command below is out of date.
- Roadmap phases 1-4 done (see "Real-time roadmap" below). Phase 5a (multiway model EV) done. Phase 5b (flop library) code done, library not generated yet. All committed locally, not pushed.
- Flop library (2026-10-11 pilot): 53 BTN vs BB flops generated locally (gitignored). The 10 s budget only reached 8-10 iterations at 1.6-3.1% exploitability on these wide ranges, so the build uses `--budget-ms 30000`: 28-29 iterations, median 0.23%, max 0.39%, ~30 s and ~72 KB per flop (90 s gives 0.018%). Full build: ~15 h and ~125 MB per scenario, heaviest flops first:
  `node scripts/build-flop-library.mjs --scenarios 6max-100bb-srp-btn-bb --budget-ms 30000` (resumable; then the CO and SB scenarios).
- Full build started 2026-10-11 18:41 KST as a detached process (node PID 24692 at start): `node scripts/build-flop-library.mjs --budget-ms 30000`, all three scenarios in manifest order, ~44 h. Progress: `artifacts/flop-library/logs/<scenario>.log` (one line per flop); runner output in `artifacts/flop-library/logs/run.out`/`run.err`. To stop: end the node process and its `rangelab-dcfr-adapter.exe`. To resume after a stop or reboot: run the same command; finished flops are skipped.
- Resumed 2026-10-12 08:51 KST (node PID 12944, detached, same command and logs); it continued from BTN vs BB flop 625 at ~29 s/flop. Earlier pause: 2026-10-11 ~23:20 KST for a PC shutdown: BTN vs BB at 624/1755 flops (CO and SB not started). To resume, from the repo root: `node scripts/build-flop-library.mjs --budget-ms 30000` (foreground), or detached in PowerShell: `Start-Process node -ArgumentList 'scripts/build-flop-library.mjs','--budget-ms','30000' -WorkingDirectory (Get-Location) -RedirectStandardOutput artifacts/flop-library/logs/run.out -RedirectStandardError artifacts/flop-library/logs/run.err -WindowStyle Hidden`. The flop being solved at shutdown is simply re-solved (writes are atomic).
- Dev E2E passed (scratch script, playwright from the global npm root): BTN 2.5 open / BB call / 4c3d2h / BB check shows the FLOP LIBRARY card (0.19%); the suit-permuted board 4h3s2d with AdKc gives the same answer; an uncomputed flop shows the miss reason and keeps the live solver. `next start` (checked 2026-10-12): it serves the files in `public/` when the server starts, not the ones present at build time. Files written while the server is running return 404 until it is restarted (no rebuild needed). `next dev` was not checked for this.
- 8-max packs: all five committed 2026-10-11 (see docs/DCFR_PREFLOP.md). The preflop matrix is finished.
- Exploit follow-ups: on-demand exploit re-solve with locked ranges, 3-bet bluff/defense adjustments, recalibrating priors in `src/lib/exploit/*.ts` from recorded hands.

## Current state

- Preflop action validation, exact pot accounting, and side pots are implemented.
- Flop, turn, and river state transitions are implemented.
- Weighted range equity is implemented.
- Local TexasSolver flop/turn/river heads-up root and intermediate-node `FAST PREVIEW` is implemented.
- Preflop strategy schema v2 distinguishes opener position, caller positions, and sizing while retaining v1 wildcard compatibility.
- Imported strategy JSON persists in browser local storage and can be reset to the bundled dataset.
- Remote HTTP counterfactual-EV client support remains available through `COUNTERFACTUAL_EV_BACKEND_URL`.

## Bundled preflop solve

- Generator: `exinori/DCFR-SOLVER`
- Submodule: `tools/dcfr-solver`
- Pinned revision: `4ade6a9e15a841c41867afde1258b9d110cd6fb1`
- License: MIT generator; self-generated strategy output
- Run: 100,000,000 iterations, seed 42, 100bb configuration
- Result: 2,266,541 information sets at 45,822 iterations/second
- Bundled file: `src/data/dcfr-6max-100bb-rfi-v1.json`
- Coverage: UTG, HJ, CO, BTN, and SB unopened RFI; 5 spots and 845 rows
- Intermediate blueprint, chart, and matchup files remain ignored under `artifacts/dcfr-preflop/`.

The bundled dataset is installed by default. A valid browser-imported dataset overrides it, and reset restores it. Non-RFI and non-100bb contexts still fall back to the explicitly labeled `baseline-v1` heuristic.

## Local DCFR counterfactual EV

`tools/dcfr-adapter` links to the pinned solver crate without modifying the submodule. It uses `compute_action_evs()` to obtain card-removal and opponent-reach-normalized per-action EV, then converts scaled chip units to BB.

Current supported scope:

- heads-up only;
- Hero OOP or IP;
- flop, turn, or river street root or a validated intermediate action history (see docs/SOLVER_INTEGRATION.md);
- 1 to 5,000 iterations through the shared job validator.

Configure it with:

```powershell
$env:DCFR_ADAPTER_PATH="$PWD\tools\dcfr-adapter\target\release\rangelab-dcfr-adapter.exe"
$env:ALLOW_LOCAL_SOLVER_API='1'
npm run dev
```

Backend precedence is remote HTTP counterfactual backend, local DCFR adapter, then local TexasSolver. Legacy jobs go through the adapter's `--json` mode, so IP roots and validated intermediate histories are solved (2026-10-12); multiway jobs are rejected rather than mislabeled as solver EV.

On the current Windows installation, release linking required preserving the Developer Prompt SDK paths and appending the installed OneCore CRT directory:

```powershell
cmd.exe /d /v:on /s /c 'call "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -arch=x64 && set "LIB=!LIB!;C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.51.36231\lib\onecore\x64" && "%USERPROFILE%\.cargo\bin\cargo.exe" build --release --manifest-path tools\dcfr-adapter\Cargo.toml'
```

The adapter binary and Cargo `target` directory are intentionally not committed.

## Last verification

- `node scripts/preflop-data.mjs validate src/data/dcfr-6max-100bb-rfi-v1.json`: 5 spots, 845 rows
- `npm test` with `DCFR_ADAPTER_PATH`: 55 passed, 1 skipped
- `npm run lint`: passed with zero warnings
- `npm run build`: passed
- Browser E2E against local TexasSolver: passed
- Browser E2E against local DCFR adapter, including `SOLVER EV` labeling: passed
- DCFR upstream library tests from the prior integration: 107 passed, 2 ignored

## Real-time roadmap (agreed 2026-10-11)

Goal: on the user's PC, answer each decision in 6-max/8-max within 5 s from board, hero cards, and opponent actions; record opponent tendencies and adjust (including isolation raises). For study use.
1. 5 s answers: done (native deadline solve, wasm cost model). See docs/SOLVER_INTEGRATION.md "Time budget".
2. Preflop packs: solver, exporter, runner, and app loading done and pushed (commits 2288350, 8d0ba21; docs/DCFR_PREFLOP.md). 6-max packs committed and validated (docs/DCFR_PREFLOP.md table). Remaining: 8-max packs (matrix still running, `artifacts/preflop/logs/8max-*.log`); when done, run `npx vitest run src/lib/preflop-packs.data.test.ts`, check sizes against `MAX_PACK_CHARS` (4M), commit. Generation runs detached via `node scripts/run-preflop-matrix.mjs ...`; logs in `artifacts/preflop/logs`. Re-running the same command resumes. After it finishes, re-export all packs with the current binary if the running matrix started before the latest export fixes (the matrix was restarted 2026-10-11 ~04:20 UTC with the all-in position-tax fix, so its own exports are current).
3. Opponent profiling: done (commits 4045bb7, 3f61203, 43e5f4c; README "상대 성향 기록"). Records, stats, tendencies, SQLite store, `/api/profile/*`, seat assignment and hand recorder UI. Phase 4 should read `getPlayerStats` totals ({n,x} pairs) and shrink toward the solved strategy with `posteriorMean`.
4. Tendency-based exploits: done for iso raises (preflop) and flop c-bets with range lock (commits f93c25f, 03a889e; README "상대 성향 기반 조언"). Not built: on-demand exploit re-solve with locked ranges, 3-bet bluff / 3-bet defense adjustments, turn/river advice (no stats recorded for them), blind fold-to-steal stat. Priors in src/lib/exploit/*.ts are heuristics to recalibrate from recorded hands.
5. Multiway approximation [5a model EV done: `src/lib/multiway-ev.ts`]; flop library for instant flops [5b code done: `src/lib/flop-library`, data not generated].

## In-browser solver (2026-10-11, branch fix/solver-quality)

- Heads-up spots solve in the browser via `public/solver/rangelab_dcfr_wasm.wasm` (built by `npm run solver:wasm` from `tools/dcfr-wasm`). See docs/SOLVER_INTEGRATION.md.
- Local Rust setup on this machine: rustup default host x86_64-pc-windows-msvc (the GNU host fails to link under the non-ASCII user path), VS 2022 Community C++ tools present.
- With `DCFR_ADAPTER_PATH` set, heads-up spots solve natively and multi-threaded through the same request (`rangelab-dcfr-adapter --json`); the browser is the fallback.
- Known limits: browser flop takes one to two minutes single-threaded with wide ranges; re-raises smaller than the bet faced are not in the dcfr-solver tree. Tree memory is now capped before allocation (dcfr-core estimate).
- Done since: solve progress and cancel; reproducible wasm (path remap, strip, tools/ workspace) and CI (`.github/workflows/ci.yml`); run 38104538365 on 2026-10-11 passed both jobs, and the GitHub Windows rebuild matched the committed module byte for byte.
- Next: wasm threads (COOP/COEP) for browser flop speed; auth/rate limiting before exposing the native API beyond local use.

## Known issues (2026-10-11 solver quality review, branch fix/solver-quality)

Plan (reordered): 2a range weights (done) -> 1 presets/budget (done) -> 4 model EV (done) -> 5 equity perf (done) -> 3 observed bet sizes (done). All planned steps are committed on `fix/solver-quality` (not pushed). See CHANGELOG.md.

- Solver budgets in `src/lib/solver-presets.ts` are uncalibrated; run one local TexasSolver/DCFR solve per street and tune iterations and `SOLVER_TIMEOUT_MS`.
- Manual checks needing a solver binary: isomorphism=1 keeps the exact Hero combo in the dump; an observed-size tree resolves a bet -> raise -> call history end to end; solve times per street fit `SOLVER_TIMEOUT_MS`.
- Histories with more than 4 raises exceed TexasSolver's default `raise_limit=4` and will be reported as a missing size.
- Model EV is a one-street heuristic (no future betting); equity itself is not invalidated when cards change.
- Multiway model EV limits: opponents fold/call independently (real callers tighten behind a caller), no raises after the bet, no overcall/squeeze on a hero call (labeled), side pots not separated, unlikely caller subsets share one all-callers equity, the alpha^(1/k) default fold split is uncalibrated. Local solvers stay heads-up only; 3+ players show the model EV with a notice.
- Equity still runs synchronously on the main thread; ranges whose heavy combos all collide with dealt cards fall back to a full scan per sample and can freeze the UI for seconds.
- Deferred security items: no Host allowlist against DNS rebinding (would block LAN access), 512MB solver output read into memory, no request body size limit, solver error text returned to the client; the legacy DCFR job path has no `timeBudgetMs` (only `SOLVER_TIMEOUT_MS`).

## Next TODO

1. Add a true multiway counterfactual backend; both bundled local solvers are heads-up only.
2. Check the first GitHub run of the new `adapter` CI job (ubuntu + windows); the branch is not pushed yet.

## Session startup

Start by reading `README.md`, this file, `docs/DCFR_PREFLOP.md`, and `docs/SOLVER_INTEGRATION.md`. Then inspect `git status`, initialize submodules if necessary, and run the relevant validation before changing files. Preserve any existing worktree changes.
