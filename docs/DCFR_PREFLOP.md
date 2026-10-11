# DCFR-SOLVER Preflop Integration

RangeLab pins [`exinori/DCFR-SOLVER`](https://github.com/exinori/DCFR-SOLVER) as a Git submodule under `tools/dcfr-solver`. The audited revision is `4ade6a9e15a841c41867afde1258b9d110cd6fb1` and the upstream code is MIT licensed.

## Accuracy boundary

The upstream preflop command implements 6-max External Sampling MCCFR over 169 canonical hand classes. Its terminal postflop value uses sampled-board equity plus a configurable OOP pot tax; it does not solve every postflop continuation. Generated ranges must therefore be labeled as this model's output, not as an exact full-game GTO solution.

The upstream repository's library suite passes 107 tests with 2 long convergence tests ignored. Its full integration test target currently references private files under `../../Downloads` that are absent from the repository, so the complete upstream test command cannot compile without those fixtures.

## Initialize and build

```powershell
git submodule update --init --recursive

# Run from a Visual Studio Developer PowerShell, or initialize VsDevCmd first.
cd tools\dcfr-solver
cargo test --release --lib
cargo build --release
```

Windows requires Rustup and Visual Studio C++ Build Tools. RangeLab does not commit the compiled binary or Cargo `target` directory.

The same pinned crate also powers the local postflop counterfactual-EV adapter under `tools/dcfr-adapter`. Its build output is ignored. See [solver integration](SOLVER_INTEGRATION.md#local-dcfr-counterfactual-ev-adapter) for runtime configuration and supported nodes.

## Generate an RFI blueprint

Start with a 100,000-iteration pipeline solve. This is useful only for verifying complete export and conversion, not for shipping strategy data:

```powershell
.\target\release\dcfr-solver.exe preflop `
  --iterations 100000 `
  --output smoke-blueprint.bin `
  --chart-output smoke-charts.json `
  --seed 42
```

At 1,000 iterations some hand classes have no sampled strategy and RangeLab correctly rejects the incomplete output. At 100,000 iterations the audited revision exported all five RFI spots and all 845 rows. The upstream reference command uses 100,000,000 iterations for a substantive run. Record the exact revision, seed and configuration for every generated dataset.

## Bundled production dataset

RangeLab bundles `src/data/dcfr-6max-100bb-rfi-v1.json`, generated on 2026-08-28 with 100,000,000 iterations, seed 42, and revision `4ade6a9e15a841c41867afde1258b9d110cd6fb1`. The completed run produced 2,266,541 information sets at 45,822 iterations per second and exported five complete RFI charts (UTG, HJ, CO, BTN, and SB), 845 rows total.

This dataset is the default for matching 100bb unopened RFI decisions. User-imported validated datasets override it, and reset restores it. Spots outside those five RFI charts continue to use the explicitly labeled `baseline-v1` heuristic until matchup conversion is implemented. The generated blueprint and intermediate chart/matchup exports remain ignored build artifacts; only the normalized 152 KB strategy JSON is committed.

## Convert to RangeLab v2

```powershell
npm run strategy:data -- convert-dcfr tools\dcfr-solver\smoke-charts.json data\dcfr-rfi-v1.json `
  --id dcfr-6max-100bb-rfi-v1 `
  --license "Proprietary - self generated" `
  --revision 4ade6a9e15a841c41867afde1258b9d110cd6fb1 `
  --iterations 100000 `
  --seed 42 `
  --stack 100
```

The adapter maps `fold` to fold, `call/check` to passive, and `raise/allin` to aggressive. It validates all 169 hands per RFI spot and embeds generator provenance. Do not ship the 100,000-iteration pipeline output as strategy data. The bundled dataset uses the full 100,000,000-iteration run described above.

## 6-max and 8-max packs for multiple stack depths (rangelab-preflop)

`tools/rangelab-preflop` generalizes the upstream preflop MCCFR to 6 or 8 players and any starting stack without modifying the submodule (attribution and the list of changes are in `tools/rangelab-preflop/NOTICE.md`). Rules, the MCCFR update, and the showdown model match upstream; ported upstream tests pass. Documented differences: per-stack bet sizes (20bb: 2bb open, 3-bet all-in, open-shove allowed; 26-50bb: 2.5bb/9bb; 51-120bb: 2.5/9/22bb as upstream; deeper: 2.5/10/25/60bb), and a big blind raising over a limper sizes the raise as the open plus 1bb per limper.

```powershell
cd tools\rangelab-preflop
cargo build --release
cd ..\..
node scripts/run-preflop-matrix.mjs "6:20,6:40,6:60,6:100,6:150@5;8:20,8:40,8:60,8:100,8:150@2"
```

The runner trains each table/stack job with atomic checkpoints every 5M iterations (`artifacts/preflop/*.bin`, ignored) and resumes on re-run, then exports `public/data/preflop/<n>max-<stack>bb.json`. Iterations: 6-max 100M (upstream reference), 8-max 200M. Measured throughput on the development PC: 6-max 100bb 43.6k it/s (upstream 45.8k), 8-max 100bb 28.0k it/s with 5.1M information sets after 2M iterations. 8-max blueprints need several GB of RAM, so that group runs two jobs at a time.

The exporter walks the averaged strategy with per-player hand reach and emits every decision spot reached at least 0.01% of the time, up to facing a 4-bet, keyed like the app's `derivePreflopSpotContext` (position, scenario, opener, latest aggressor, callers, limpers, current bet size). Forced all-in calls count as calls. The app loads the pack for the current table size and nearest stack bucket and prefers it over the bundled RFI dataset and the baseline heuristic; spots without a pack match fall back as before.

Model limits stay the same as upstream: 169 hand classes, sampled-board equity with a heads-up out-of-position pot tax (multiway pots use raw equity), and only the small blind may limp, so limp/isolation spots other than SB-vs-BB come from the tendency-based subgame work planned next.
