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

When `COUNTERFACTUAL_EV_BACKEND_URL` is absent and `DCFR_ADAPTER_PATH` is set, `GET /api/solver` reports backend `dcfr` with a two-player limit. The current adapter intentionally supports heads-up Hero-OOP street roots with `toCall=0`; action histories, IP roots, and multiway nodes are rejected instead of returning misleading EV. It uses the job's first bet and raise sizes, accepts 1–5,000 iterations through the shared validator, hides the child window, limits output to 4 MB, and terminates after `SOLVER_TIMEOUT_MS`.

Backend precedence is remote HTTP counterfactual backend, local DCFR adapter, then local TexasSolver. DCFR output containing numeric action EV is labeled `SOLVER EV`; TexasSolver frequency-only output remains `SOLVER FREQ · MODEL EV`.

The production API is disabled unless `ALLOW_LOCAL_SOLVER_API=1`. The API accepts only same-origin `application/json` POSTs, so a third-party page cannot start a local solve. Local solves run one at a time by default (`SOLVER_MAX_CONCURRENCY`, extra requests get HTTP 429), client iterations are capped at `SOLVER_MAX_ITERATIONS` (default 1000) and accuracy is floored at 0.1%, and a cancelled request kills the solver process. Range strings are character-whitelisted, newlines are rejected, numeric limits are bounded, each job runs in a temporary directory, and the child process has a timeout and output-size limit.

References:

- TexasSolver: https://github.com/sniperHW/TexasSolver
- OpenSpiel universal poker: https://github.com/google-deepmind/open_spiel/tree/master/open_spiel/games/universal_poker
