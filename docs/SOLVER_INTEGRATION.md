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

For heads-up intermediate nodes, the job may include an `actionHistory` array such as `[{"action":"check"}]` or `[{"action":"bet","amount":5},{"action":"call","amount":5}]`. Local TexasSolver still solves the complete street tree, then RangeLab follows the native `childrens` path and extracts Hero's exact OOP or IP combo strategy. Bet and raise paths select the closest configured native size. Histories are limited to 20 validated actions.

TexasSolver v0.2.0 accepts weighted 169-hand classes such as `AQo:0.75`, but exact combos such as `AsQh:0.75` can crash the native process. RangeLab keeps exact-combo weights for Equity, then aggregates and prunes them to the top eight weighted 169 classes immediately before a local solve. The actual Hero class is retained.

The UI profile is intentionally bounded to one thread, 10 iterations, one bet size, one raise size, and an all-in threshold of 1.0. It supports heads-up OOP/IP root and intermediate action nodes and is labeled `FAST PREVIEW`; it is not evidence of a fully converged GTO solution.

TexasSolver native dumps provide action frequencies but no counterfactual EV in the integrated format. When Equity is available, RangeLab labels the fallback as `SOLVER FREQ · MODEL EV`; imported formats that contain EV remain labeled `SOLVER EV`.

## Counterfactual EV backend

Set `COUNTERFACTUAL_EV_BACKEND_URL` to send the same versioned solver job to an HTTP backend instead of running local TexasSolver. The backend must return the normalized output above, including a numeric `ev` for every strategy action to be labeled `SOLVER EV`. An optional `COUNTERFACTUAL_EV_BACKEND_TOKEN` is sent as a Bearer token.

The UI reads `GET /api/solver` capabilities. A configured counterfactual backend enables multiway jobs up to `COUNTERFACTUAL_EV_BACKEND_MAX_PLAYERS` (2–8, default 8). Such jobs include `players`, an array of `{seat, range, stack}`, and `actorSeat`. Without the remote backend, the API reports a two-player limit and rejects multiway execution because local TexasSolver is heads-up only.

The configured URL is server-only. Requests time out after 120 seconds, responses are limited to 4 MB, and the response is validated with the normalized solver-result parser before it reaches the client. When no backend URL is configured, the existing local TexasSolver path remains the fallback.

## Local DCFR counterfactual EV adapter

RangeLab includes `tools/dcfr-adapter`, a small Rust binary linked against the pinned `tools/dcfr-solver` submodule. Unlike the upstream display JSON's single mixed-strategy combo EV, the adapter calls `compute_action_evs()` and returns a distinct counterfactual EV for every root action. The solver normalizes raw utility by compatible opponent reach with card removal, and the adapter then converts its scaled chip units to BB before the result reaches the UI.

Build the adapter from a Visual Studio Developer PowerShell:

```powershell
cargo build --release --manifest-path tools\dcfr-adapter\Cargo.toml
$env:DCFR_ADAPTER_PATH="$PWD\tools\dcfr-adapter\target\release\rangelab-dcfr-adapter.exe"
$env:ALLOW_LOCAL_SOLVER_API='1'
npm run dev
```

When `COUNTERFACTUAL_EV_BACKEND_URL` is absent and `DCFR_ADAPTER_PATH` is set, `GET /api/solver` reports backend `dcfr` with a two-player limit. The current adapter intentionally supports heads-up Hero-OOP street roots with `toCall=0`; action histories, IP roots, and multiway nodes are rejected instead of returning misleading EV. It uses the job's first bet and raise sizes, accepts 1–5,000 iterations through the shared validator, hides the child window, limits output to 4 MB, and terminates after 120 seconds.

Backend precedence is remote HTTP counterfactual backend, local DCFR adapter, then local TexasSolver. DCFR output containing numeric action EV is labeled `SOLVER EV`; TexasSolver frequency-only output remains `SOLVER FREQ · MODEL EV`.

The production API is disabled unless `ALLOW_LOCAL_SOLVER_API=1`. Range strings are character-whitelisted, newlines are rejected, numeric limits are bounded, each job runs in a temporary directory, and the child process has a timeout and output-size limit.

References:

- TexasSolver: https://github.com/sniperHW/TexasSolver
- OpenSpiel universal poker: https://github.com/google-deepmind/open_spiel/tree/master/open_spiel/games/universal_poker
