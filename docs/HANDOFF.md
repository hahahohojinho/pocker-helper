# RangeLab Handoff

Last updated: 2026-10-11

## Resume here (2026-10-11, branch fix/solver-quality)

- Roadmap phases 1-4 done (see "Real-time roadmap" below). Phase 5a (multiway model EV) done and committed locally (not pushed); phase 5b (flop library) not started.
- 8-max progress at 15:00: 20bb and 40bb packs exported (untracked in `public/data/preflop/`), 60bb running (~2 h), then 100bb/150bb.
- Running in the background: 8-max preflop packs (`node scripts/run-preflop-matrix.mjs "6:20,6:40,6:60,6:100,6:150@5;8:20,8:40,8:60,8:100,8:150@2"`, logs in `artifacts/preflop/logs/8max-*.log`). 6-max is finished and committed. If the PC restarted or the runner was killed, resume with only the 8-max group: `node scripts/run-preflop-matrix.mjs "8:20,8:40,8:60,8:100,8:150@2"`. Unfinished jobs continue from their last 5M-iteration checkpoint; finished ones are only re-exported (do not re-run the 6-max group: it would rewrite the committed 6-max packs with a new date).
- When all five 8-max packs exist in `public/data/preflop/`: `npx vitest run src/lib/preflop-packs.data.test.ts`, check the largest size against `MAX_PACK_CHARS` (4M) in `src/lib/preflop-packs.ts`, add an 8-max table to docs/DCFR_PREFLOP.md, commit.
- Watch memory while 8max-100bb and 8max-150bb run together (machine has 16 GB; 8max-40bb used ~1 GB at 5M info sets).
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
- Hero is OOP;
- flop, turn, or river street root;
- `toCall=0` and no action history;
- 1 to 5,000 iterations through the shared job validator.

Configure it with:

```powershell
$env:DCFR_ADAPTER_PATH="$PWD\tools\dcfr-adapter\target\release\rangelab-dcfr-adapter.exe"
$env:ALLOW_LOCAL_SOLVER_API='1'
npm run dev
```

Backend precedence is remote HTTP counterfactual backend, local DCFR adapter, then local TexasSolver. Unsupported DCFR IP roots, intermediate nodes, and multiway jobs are rejected rather than mislabeled as solver EV.

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
5. Multiway approximation [5a model EV done: `src/lib/multiway-ev.ts`]; flop library for instant flops.

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
- Deferred security items: no Host allowlist against DNS rebinding (would block LAN access), 512MB solver output read into memory, no request body size limit, solver error text returned to the client.

## Next TODO

1. Extend the local DCFR adapter to IP roots and validated intermediate action histories.
2. Decide whether to convert and bundle the 30 generated SRP/3-bet/4-bet matchup exports into strategy schema v2 spots.
3. Add a true multiway counterfactual backend; both bundled local solvers are heads-up only.
4. Add CI jobs that build the Rust adapter and run its conditional integration test on Windows and Linux.

## Session startup

Start by reading `README.md`, this file, `docs/DCFR_PREFLOP.md`, and `docs/SOLVER_INTEGRATION.md`. Then inspect `git status`, initialize submodules if necessary, and run the relevant validation before changing files. Preserve any existing worktree changes.
