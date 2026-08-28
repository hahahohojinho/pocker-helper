# RangeLab Handoff

Last updated: 2026-08-28

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

## Next TODO

1. Extend the local DCFR adapter to IP roots and validated intermediate action histories.
2. Decide whether to convert and bundle the 30 generated SRP/3-bet/4-bet matchup exports into strategy schema v2 spots.
3. Add a true multiway counterfactual backend; both bundled local solvers are heads-up only.
4. Add CI jobs that build the Rust adapter and run its conditional integration test on Windows and Linux.

## Session startup

Start by reading `README.md`, this file, `docs/DCFR_PREFLOP.md`, and `docs/SOLVER_INTEGRATION.md`. Then inspect `git status`, initialize submodules if necessary, and run the relevant validation before changing files. Preserve any existing worktree changes.
