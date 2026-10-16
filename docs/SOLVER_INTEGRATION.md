# RangeLab Solver Integration

RangeLab separates the interactive hand-state engine from expensive solver execution. A solver worker receives a versioned node and returns normalized action frequencies and optional EV values.

## Input contract

```json
{
  "contract": "rangelab.solver_node.v1",
  "street": "flop",
  "heroHole": ["As", "Qh"],
  "board": ["Js", "7d", "2c"],
  "pot": 10,
  "toCall": 5,
  "effectiveStack": 95,
  "candidateActions": ["fold", "call", "raise"]
}
```

## Normalized output

```json
{
  "source": "texassolver",
  "strategy": [
    { "action": "fold", "frequency": 0.2, "ev": 0 },
    { "action": "call", "frequency": 0.65, "ev": 4.1 },
    { "action": "raise", "frequency": 0.15, "ev": 3.8 }
  ],
  "best_action": "call",
  "exploitability": 0.5
}
```

`parseTexasSolverNode` also accepts a native TexasSolver strategy node containing `strategy.actions` and `strategy.strategy[combo]`. Multiple concrete bet sizes are merged into the UI's `bet` or `raise` action category.

RangeLab labels equity-based fallback values as `NOT GTO`. Only imported or locally executed solver output is shown as a solver strategy.

## Local preview profile

The local API supports flop, turn, and river root nodes when the board contains 3, 4, or 5 cards respectively. The current UI enables it for heads-up spots where Hero is the OOP root actor.

For heads-up intermediate nodes, the job may include an `actionHistory` array such as `[{"action":"check"}]` or `[{"action":"bet","amount":5},{"action":"call","amount":5}]`. Local TexasSolver still solves the complete street tree, then RangeLab follows the native `childrens` path and extracts Hero's exact OOP or IP combo strategy. Before a local TexasSolver run, `buildSolverTree` converts the bet and raise amounts already seen on the solved street into tree sizes and adds them to that street only (at most 8 merged sizes per action). TexasSolver's console tool uses `big_blind=1` and rounds every size to it, sizes a bet as `round(percent * streetStartPot)`, and sizes a raise as `B + round(percent * (streetStartPot + 2B))` where B is the solver's rounded bet; native BET and RAISE keys store the street-total commitment, the same unit as RangeLab amounts (verified in `GameTree.cpp` and `CommandLineTool.h`). The tree therefore targets `round(observed)`, and the lookup ranks children by distance to it, throws when two different sizes tie, and throws when the nearest differs from the observed amount by more than max(10%, 0.51BB), so a missing size is reported instead of silently reading a different node. An amount at the effective stack uses the all-in branch; other sizes above 500% of the pot are rejected. Histories are limited to 20 validated actions.

TexasSolver v0.2.0 accepts weighted 169-hand classes such as `AQo:0.75`, but exact combos such as `AsQh:0.75` can crash the native process. RangeLab keeps exact-combo weights for Equity, then aggregates them to weighted 169 classes immediately before a local solve. A class weight is the summed combo weight divided by the number of board-compatible combos in that class, because TexasSolver applies the class weight to every such combo. The UI sends every class; when a caller passes `maxClasses`, pruning keeps the classes with the most expected combos. The actual Hero class is retained.

Solve budgets come from `src/lib/solver-presets.ts` per backend and street (for example TexasSolver flop: up to 200 iterations, stop at 1% pot exploitability; river: up to 500 iterations, 0.5%). The tree still uses one bet size (50%) and one raise size (60%) with an all-in threshold of 1.0. The client requests all threads and the API clamps them to `min(32, SOLVER_MAX_THREADS, CPU count)`. Isomorphism stays off until a native dump confirms the exact Hero combo survives it. These budgets have not been calibrated against real solve times.

The API forwards TexasSolver's last logged exploitability (read from `tmp_log.txt` in the job directory, falling back to stdout) in the `x-solver-exploitability` header. The UI shows it as a percentage of the pot: up to 1% is OK, up to 5% is flagged as under-converged, and above 5% is flagged as not trustworthy. DCFR output carries its own `exploitability` field.

TexasSolver native dumps provide action frequencies but no counterfactual EV in the integrated format. When Equity is available, RangeLab labels the fallback as `SOLVER FREQ · MODEL EV`; imported formats that contain EV remain labeled `SOLVER EV`.

## In-browser DCFR solver (default for heads-up)

Heads-up spots are solved in the browser, with no installed binary, by `public/solver/rangelab_dcfr_wasm.wasm`. It is built from the pinned `tools/dcfr-solver` crate without modifying the submodule: `tools/dcfr-wasm` patches `rayon` (sequential iterators) and `memmap2` (heap-backed arena) with local shims through `[patch.crates-io]`, and exposes a raw `alloc`/`solve`/`result_ptr` ABI. A dedicated Web Worker (`src/workers/dcfr-solver.worker.ts`) runs each solve and is terminated on completion, timeout (240s), or cancellation.

- Every street and every heads-up decision node is supported, including IP decisions and nodes after bets and raises. Observed sizes are encoded as exact reduced fractions in 1/100 BB chips (`src/lib/wasm-solver/request.ts`), matching dcfr-solver's `bet = frac * pot` and `raise = facedBet + frac * potAfterCall`, so the history node is reproduced without rounding.
- Ranges are sent as exact weighted combos (DCFR accepts `AsQh:0.5`), using the street-start range: a user-edited range as entered, otherwise the preflop inference conditioned on earlier postflop streets.
- Output includes per-action counterfactual EV, so the UI labels it `SOLVER EV`, plus exploitability (% of pot).
- Budgets (`getSolverPreset("wasm", street)`): river 500, turn 100, flop 20 iterations. Single-threaded measurements with about 600-combo ranges: river 1000 iterations in 0.3s; turn 100 iterations in 4s at 0.03% pot exploitability; flop 12 iterations in 22s at 1.6%. Flop solves with wide ranges take one to two minutes.
- Limits: at most three bets/raises before the decision (`max_raises` 4); a re-raise whose increment is below the bet faced is rejected with an explanation because dcfr-solver does not generate it; sizes up to 50x the pot (keeps dcfr-solver's i32 bet arithmetic in range); request JSON up to 256KB.
- Rebuild with `npm run solver:wasm` (needs Rust with the `wasm32-unknown-unknown` target; `tools/dcfr-wasm/rust-toolchain.toml` pins 1.99.0). The script builds with `--locked`, writes `rangelab_dcfr_wasm.wasm.sha256`, copies the dcfr-solver MIT license, and generates `THIRD-PARTY-LICENSES.txt` for every crate linked into the module. The build is reproducible across checkout locations: source paths are remapped (`/rangelab`, `/cargo`) through `--config` so the target rustflags still apply, the release profile strips the wasm name section, and the Cargo workspace root is `tools/` so the dcfr-solver path dependency is hashed by relative path. Two clones in different directories produced the same hash. CI (`.github/workflows/ci.yml`) rebuilds the module on Windows and fails if `public/solver` differs.
- Progress: the module imports `env.progress(completed, total)` (at most ~100 reports per solve); the panel shows `SOLVING n/m` and a cancel button that terminates the worker.
- Multiway spots: 3-player rivers use the native multiway solver below; others use the server backends.

### Time budget (5 second answers)

DCFR requests carry `timeBudgetMs` (presets: 4500 ms; native flops outside the library 9000 ms, see Flop library); `iterations` is then a cap (native: flop 300, turn 500, river 1000; wasm: 100/300/500).

- Native: `tools/dcfr-core/src/run.rs` solves with a per-iteration callback and, when one more iteration plus the EV pass would cross the deadline, unwinds with `resume_unwind` (no panic hook output). The callback runs on the calling thread after a completed iteration, outside rayon, so the solver is exactly as if that iteration count had been configured; at least 3 iterations always run. Exploitability is computed only if about half an iteration remains (the pass measured ~1/4 of an iteration). The route subtracts time already spent and adapter overhead before forwarding the budget (`SOLVER_MAX_BUDGET_MS`, default 10000).
- wasm cannot unwind, so dcfr-core plans iterations from `iterationCostNs` (ns per action slot x live combo per iteration) using 80% of the budget. The panel starts from measured per-street defaults (river 110, turn 300, flop 340 ns) and blends each solve's measured cost into localStorage. Wide-range flops still exceed 5 s in the browser (one iteration is ~2 s); the panel says so and points to the native solver.
- Responses report `iterations`, `stoppedBy` (`deadline` or `iterations`), `workUnits`, and native `elapsedMs`; the panel shows end-to-end time and iterations.
- Measured end to end through `/api/solver` (native, 3 runs, max): flop 4.1-4.4 s (13-34 iterations, 0.13-1.41% pot exploitability depending on range width), turn 2.0-4.3 s (500 iterations), river 0.3-0.6 s.

### Tree size limit

Before solving, `tools/dcfr-core/src/estimate.rs` walks the betting tree with dcfr-solver's public `GameState` API and `canonical_next_cards`, exactly as the solver builds it (decision-node counts matched in calibration). Memory is estimated as action slots x live combos x 6 bytes (i16 regret + f32 cumulative strategy) plus 320 bytes per tree node and 32 MB fixed; `examples/calibrate.rs` measured 205-243 bytes per node and the estimate upper-bounds measured totals (wide flop with three raises: 1077 MB measured, 1176 MB estimated). Requests over 1.5 GiB (browser) or 4 GiB (native), or over 3,000,000 tree nodes, are rejected with a message before anything is allocated; the walk stops at those limits, so rejection is fast. Range weights outside 0..1 (including `nan`) are rejected.

### Native multi-threaded path (same request)

`tools/dcfr-core` holds the request parsing and solve code shared by the wasm module (sequential shims) and the native adapter (real rayon). `rangelab-dcfr-adapter --json` reads the wasm request from stdin (256KB limit) and prints the same envelope with `source: "dcfr-native"`. When `DCFR_ADAPTER_PATH` is set and the local API is allowed, `GET /api/solver` reports `nativeJson: true`, and the panel posts `{kind: "dcfr-json", request}` instead of solving in the browser, falling back to wasm on 403/404 or a network error. The route reads at most 300KB of body (413 beyond), applies the same same-origin, single-slot, iteration clamp, timeout, and abort handling, passes `RAYON_NUM_THREADS` from `SOLVER_MAX_THREADS`/CPU count, and gives the child only an allowlisted environment. Native presets: river 1000, turn 200, flop 60 iterations; measured with ~600-combo ranges: river 0.5s, turn 1.3s at 0.008% pot exploitability, flop 14s at 0.04%.

## Native multiway river solver (3 players)

`rangelab-dcfr-adapter --json-multiway` solves 2-3 player river spots with its own crate, `tools/multiway-core`. The submodule's postflop solver is two-player only, so only its card, evaluator, and range parsing are reused. The panel uses it when exactly three players start the river, the native adapter is advertised (`GET /api/solver` -> `nativeMultiway: {maxPlayers: 3, streets: ["river"]}`, probed once with `--capabilities`), and at least two of the three can still bet. Other multiway spots keep the MODEL EV with a notice.

- Request (`src/lib/wasm-solver/multiway-request.ts`, POST body `{kind:"multiway-json",request}`): `board` (5 cards), `hero`, `heroSeat` (index into `players`), `players: [{range, stack}]` in postflop action order with street-start stacks in 1/100 BB chips, `pot`, optional `potLayers` (`[{amount, eligible:[index]}]`: the street-start pot split into main and nested side pots when a player went all-in earlier; a zero stack marks that player), `iterations`, `betSizes`, `maxRaises`, `history`, `timeBudgetMs`. The panel builds the layers from each seat's earlier contributions (`streetStartPotLayers`), merging levels with the same players. History sizes use the heads-up encoding generalized to the largest bet: `bet = frac * (pot + street bets)`, `raise = largestBet + frac * (pot + street bets + toCall)`; a call or bet that needs the whole remaining stack is `allin`.
- Rules (`tools/multiway-core/src/game.rs`): dcfr-solver's sizing, rounding, minimum raise, and all-in collapse. A bet or raise reopens the action for every player who is not all-in; a call for less does not. As in NLHE and the UI, an all-in raise smaller than the last full raise lets players who already acted only call or fold (each all-in is judged alone; short all-ins do not add up). Pots are the street-start layers (restricted to players still in) plus this street's side pots by commitment; uncalled chips return through the top layer.
- Showdown (`src/showdown.rs`): exact card removal between Hero and both opponents in O(52) per Hero combo. Opponent pair masses are computed by inclusion-exclusion over shared cards for the sets "below Hero", "tied", and "any", giving 3-way shares (win 1, two-way tie 1/2, three-way tie 1/3) and heads-up layers where the third player only blocks cards. Tests compare every kernel with an O(n^3) brute force on paired, flush, straight, and dry boards.
- Solver (`src/solver.rs`): vector-form DCFR (alpha 1.5, beta 0, gamma 2) over full ranges with alternating updates; terminal kernels run on rayon. Values are net chips relative to the street-start stack, and per-combo action EV is the value divided by the compatible opponent reach, as in dcfr-solver. In a 2-player request it matches dcfr-core's root action EVs within 1% of the pot (test).
- Convergence: 3-player CFR has no Nash guarantee, so the result reports `convergence.maxBrGain`, the largest gain any one player gets by best-responding to the others' average strategies (percent of the street-start pot), plus per-player gains. The UI shows `MAX BR GAIN x.xx% POT` with the 1%/5% thresholds and labels the EV `SOLVER EV · 3-WAY CFR`; `exploitability` is null. The EV is conditional on the profile CFR reached and is not unique.
- Time: the deadline loop leaves room for one more iteration, the EV pass, and the best-response pass. Measured 2026-10-16 on 12 threads, river root and check-bet nodes, 4.5 s budget: BB/CO/BTN SRP ranges 261-344 iterations at max BR gain <= 0.019% of the pot; 100% ranges for all three at a 2 s budget, 118-139 iterations at <= 0.075%.
- Limits: river only, 3 players at most, at most three bets/raises before the decision, request JSON up to 256 KB, tree capped at 1,000,000 nodes and 1 GB of storage including node overhead (the heads-up path allows 4 GB). Once the budget is spent the solve stops even below the 3-iteration minimum.

## Flop library (precomputed heads-up flops)

- `scripts/build-flop-library.mjs` solves every one of the 1755 suit-canonical flops per scenario with the native adapter's `--json-nodes` mode (one solve, every combo's strategy and EV at the OOP root, IP after a check, and facing the first bet size from either player) and writes `public/data/flop-library/<scenario>/<board>.json` plus `index.json`. The output is gitignored (~80 MB per scenario).
- Scenarios (17, 6-max 100bb): single-raised pots BB vs BTN/CO/HJ/UTG, SB vs BB, BTN vs CO/HJ/UTG, CO vs HJ/UTG, HJ vs UTG; 3-bet pots (3-bet to 9bb, opener calls) CO vs BTN, BTN vs SB/BB, CO vs BB/SB, HJ vs BTN. Live native flops outside the library get a 9 s budget, which measured 0.8-4.6% exploitability on wide ranges (4.5 s: 4.6-17.9%), so the library remains the accurate path.
- Scenarios come from `src/data/flop-library-manifest.json`, generated by `src/lib/flop-library/manifest.ts` from the committed preflop packs with the same range inference, pot, stacks, and flop tree the postflop panel uses. `manifest.data.test.ts` fails when they drift; regenerate with `UPDATE_FLOP_MANIFEST=1 npx vitest run src/lib/flop-library/manifest.data.test.ts` and rebuild the library.
- The panel looks up the exact native solve request it would send (`matchFlopLibrary`): ranges, pot, stacks, bet sizes, and max raises must be identical and the line must be one of the stored nodes. Boards and hero cards are mapped to the canonical suit order; nearest-board approximation is not used because a different card changes combo-level answers arbitrarily. Anything else is a miss with a reason, and the live solver stays available.
- Strategies are stored in thousandths per combo, EVs in chips (1/100 BB). Each file carries the solve's exploitability, shown as the convergence badge, and a `specHash` of the ranges, pot, stacks, tree, and nodes; a file whose hash differs from the index scenario is never used (miss "stale") and the generator re-solves it. A re-solve only replaces a file when it converged further.
- Unlike the live solve, an action category the hand never takes shows its best concrete size's EV instead of 0.

## Counterfactual EV backend

Set `COUNTERFACTUAL_EV_BACKEND_URL` to send the same versioned solver job to an HTTP backend instead of running local TexasSolver. The backend must return the normalized output above, including a numeric `ev` for every strategy action to be labeled `SOLVER EV`. An optional `COUNTERFACTUAL_EV_BACKEND_TOKEN` is sent as a Bearer token.

The UI reads `GET /api/solver` capabilities. A configured counterfactual backend enables multiway jobs up to `COUNTERFACTUAL_EV_BACKEND_MAX_PLAYERS` (2–8, default 8). Such jobs include `players`, an array of `{seat, range, stack}`, and `actorSeat`. Without the remote backend, the API reports a two-player limit and rejects multiway execution because local TexasSolver is heads-up only.

The configured URL is server-only. Requests time out after `SOLVER_TIMEOUT_MS` (default 300 seconds, clamped to 10-1800 seconds), responses are limited to 4 MB, and the response is validated with the normalized solver-result parser before it reaches the client. When no backend URL is configured, the existing local TexasSolver path remains the fallback.

## Local DCFR counterfactual EV adapter

RangeLab includes `tools/dcfr-adapter`, a small Rust binary linked against the pinned `tools/dcfr-solver` submodule. Unlike the upstream display JSON's single mixed-strategy combo EV, the adapter calls `compute_action_evs()` and returns a distinct counterfactual EV for every root action. The solver normalizes raw utility by compatible opponent reach with card removal, and the adapter then converts its scaled chip units to BB before the result reaches the UI.

Build the adapter from a Visual Studio Developer PowerShell:

```powershell
cargo build --release --manifest-path tools\dcfr-adapter\Cargo.toml
$env:DCFR_ADAPTER_PATH="$PWD\tools\dcfr-adapter\target\release\rangelab-dcfr-adapter.exe"
$env:ALLOW_LOCAL_SOLVER_API='1'
npm run dev
```

When `COUNTERFACTUAL_EV_BACKEND_URL` is absent and `DCFR_ADAPTER_PATH` is set, `GET /api/solver` reports backend `dcfr` with a two-player limit. Legacy solver jobs are converted to the adapter's `--json` request (`src/lib/server/dcfr-job-request.ts`), so the job API solves any heads-up decision node: the OOP or IP street root and validated intermediate histories. `node.pot` is the street-start pot; with an `actionHistory` the node comes from the history, so `node.toCall` and `candidateActions` only apply to an empty history (which needs `toCall=0`). Actions alternate from OOP; a history is rejected if it folds, ends the street (check-check, a call), checks or bets while facing a bet, calls or raises without one, omits a bet amount, does not exceed the bet faced, exceeds the actor's stack, or raises an all-in. Call amounts are recomputed from the bet faced. Stacks come from the two `players` (role by `actorSeat`; their minimum must equal `effectiveStack`) or, without `players`, both default to `effectiveStack`. The job's bet and raise sizes become the tree sizes, observed sizes are added as on the native path, and `tree.includeAllIn` is ignored (dcfr-core offers all-in at SPR <= 1). Multiway jobs are rejected. Returned actions must be legal at the node (an all-in is reported as `bet`). It accepts 1–5,000 iterations through the shared validator, runs with the job's `threads`, hides the child window, limits output to 4 MB, and terminates after `SOLVER_TIMEOUT_MS`. The adapter's old flag-based root-only mode is no longer called from TypeScript.

Backend precedence is remote HTTP counterfactual backend, local DCFR adapter, then local TexasSolver. DCFR output containing numeric action EV is labeled `SOLVER EV`; TexasSolver frequency-only output remains `SOLVER FREQ · MODEL EV`.

The production API is disabled unless `ALLOW_LOCAL_SOLVER_API=1`. That flag is meant for local or single-user deployments: there is no authentication or rate limiting, and one request can hold the only solver slot for up to `SOLVER_TIMEOUT_MS`. Solver trees are size-checked before allocation (see below). The API accepts only same-origin `application/json` POSTs, so a third-party page cannot start a local solve. Local solves run one at a time by default (`SOLVER_MAX_CONCURRENCY`, extra requests get HTTP 429), client iterations are capped at `SOLVER_MAX_ITERATIONS` (default 1000) and accuracy is floored at 0.1%, and a cancelled request kills the solver process. Range strings are character-whitelisted, newlines are rejected, numeric limits are bounded, each job runs in a temporary directory, and the child process has a timeout and output-size limit.

References:

- TexasSolver: https://github.com/sniperHW/TexasSolver
- OpenSpiel universal poker: https://github.com/google-deepmind/open_spiel/tree/master/open_spiel/games/universal_poker
