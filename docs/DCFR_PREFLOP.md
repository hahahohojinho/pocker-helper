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

### Committed 6-max packs (2026-10-11)

`public/data/preflop/6max-{20,40,60,100,150}bb.json`: 100M iterations each, seed 42, generator revision in each pack's provenance. Checked by `src/lib/preflop-packs.data.test.ts` (parses with the app's validator; no AA folds in spots reached at least 1% of the time; RFI width non-decreasing UTG -> BTN; UTG folds 72o).

| Stack | UTG | HJ | CO | BTN | SB (raise) | Spots |
|---|---|---|---|---|---|---|
| 20bb | 13.1% | 18.1% | 24.5% | 33.0% | 24.2% | 243 |
| 40bb | 14.2% | 21.7% | 29.8% | 41.3% | 22.3% | 312 |
| 60bb | 13.9% | 23.0% | 33.9% | 50.5% | 26.1% | 320 |
| 100bb | 13.8% | 24.1% | 38.2% | 61.7% | 30.7% | 312 |
| 150bb | 12.5% | 23.3% | 40.1% | 70.9% | 31.1% | 301 |

### Committed 8-max packs (2026-10-11)

`public/data/preflop/8max-{20,40,60,100,150}bb.json`: 200M iterations each, seed 42, same checks as 6-max. Sizes 0.9-1.1 MB (limit 4M characters). RFI widths:

| Stack | UTG | UTG+1 | MP | HJ | CO | BTN | SB (raise) | Spots |
|---|---|---|---|---|---|---|---|---|
| 20bb | 9.4% | 12.1% | 15.1% | 19.3% | 25.1% | 32.7% | 22.1% | 564 |
| 40bb | 9.3% | 12.2% | 16.8% | 23.4% | 30.5% | 41.2% | 24.2% | 607 |
| 60bb | 9.0% | 11.9% | 17.2% | 25.7% | 35.5% | 51.7% | 28.5% | 587 |
| 100bb | 8.5% | 11.4% | 17.2% | 27.0% | 39.2% | 63.1% | 32.4% | 560 |
| 150bb | 7.8% | 10.4% | 16.2% | 26.8% | 41.8% | 71.0% | 32.5% | 529 |

Model limits to keep in mind when reading these:

- Late-position opens are wider than common full-game solver charts (BTN 100bb ~62% vs ~43%). The upstream model has no postflop play: showdown equity plus a positional pot tax stands in for it, which makes stealing more profitable. Upstream's own 100bb RFI shows the same shape even more strongly (BTN 71.6%, `src/data/dcfr-6max-100bb-rfi-v1.json`).
- Spots reached less than about 0.3% of the time (e.g. BB facing a 3-bet after a squeeze) are still noisy at 100M iterations; AA can show a few percent folds there. The app uses them as solved data; treat rare-line frequencies as rough.
