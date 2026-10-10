# Changelog

## Unreleased - fix/solver-quality (2026-10-11)

### Solver range class weights (step 2a)
- `toTexasSolverRange` now weights a 169 class as summed combo weight / board-compatible combo count, and prunes by expected combos with a name tiebreak.
- Why: TexasSolver applies a class weight to every combo of the class. The old per-class average over present combos overstated partial classes (2 of 12 AQo combos at weight 1 became `AQo:1`), and equal weights were pruned in input order (a 28-class range became `22-99`).
- Board cards are excluded from both numerator and denominator, so board-blocked classes are not underweighted.
- `postflop-panel.tsx` now builds solver player ranges inside the error-handled block.

### Solver presets, compute budget, convergence display (step 1)
- New `src/lib/solver-presets.ts`: per backend/street iteration and accuracy budgets (TexasSolver flop 200 iter / 1% pot, river 500 / 0.5%), replacing the UI's hard-coded 10 iterations / 10% accuracy / 1 thread. The UI now sends every range class instead of the top 8.
- Exploitability is read from TexasSolver `tmp_log.txt` (fallback stdout), forwarded as `x-solver-exploitability`, and shown as % of pot with OK (<=1%) / under-converged (<=5%) / not trustworthy badges. Unit confirmed from TexasSolver `BestResponse::printExploitability` (`/ initial_pot * 100`).
- Env: `SOLVER_TIMEOUT_MS` (default 300s, 10-1800s), `SOLVER_MAX_THREADS`, `SOLVER_MAX_ITERATIONS` (default 1000), `SOLVER_MAX_CONCURRENCY` (default 1).
- Security (raised by the longer budget): one local solve at a time (429 otherwise), server-side iteration/accuracy clamps, request abort kills the solver, same-origin JSON requests only, cumulative stderr cap, range regex no longer accepts `\r`/tabs, job dir cleanup waits for process exit and retries on Windows locks.
- `useIsomorphism` is opt-in and off: whether exact Hero combos survive isomorphism in the native dump is unverified.
- Budgets are not calibrated against real solve times (no solver binary in this environment).

### Model EV (step 4)
- Default fold equity is now the bettor's break-even bluff frequency `risk / (pot + risk)` instead of a fixed 25%, so a pure bluff is break-even by construction.
- Bet/raise EV uses equity against the calling range: the opponent range minus its weakest `foldShare` of combo weight by made-hand strength plus draws (`src/lib/called-equity.ts`), with ties trimmed proportionally. Why: the old model assumed the whole range calls, so betting beat checking whenever equity exceeded 25%.
- Raise sizing uses the street total, the hero's committed chips, and the opponent's call amount; bets above what an opponent can match are capped; short-stack calls return the uncalled excess.
- Model EV is computed only on Hero's turn from Hero's seat (previously used the next actor's toCall). Called equity is invalidated when cards, ranges, or sizing change. Multiway values are labeled as a heads-up approximation.
- `scoreRangeOnBoard` was extracted from `conditionRangeOnPostflop` without behavior change.

### Equity performance (step 5)
- `bestHandScore` now uses rank counts and suit bitmasks and returns exactly the old score (the 21-combination evaluator is kept as `bestHandScoreReference`, the test oracle; 300k random hands and edge cases match). About 60x faster per evaluation.
- `calculateRangeEquity` prepares each range once and samples with cumulative weights, binary search, and rejection against already-dealt cards, falling back to the exact filtered draw; the distribution is unchanged.
- Result (5000 iterations): heads-up vs wide range 358ms -> 27ms, 4-way 969ms -> 40ms, 7-way preflop 1547ms -> 36ms. The UI now runs 20,000 equity and 10,000 called-equity iterations (MC error about +-0.65%p). A Web Worker was not added because runs stay well under a second.

### Observed bet sizes in the solver tree (step 3)
- New `src/lib/solver-tree.ts` adds bet/raise sizes seen on the solved street to that street's tree, reproducing TexasSolver's 1BB rounding and pot-after-call raise sizing (verified in `GameTree.cpp` / `CommandLineTool.h`: `big_blind=1`, `raise_limit=4`, RAISE keys store the street-total commitment).
- `parseTexasSolverNodeAtHistory` now rejects a lookup whose nearest native size is outside max(10%, 0.51BB) of the observed amount or ties between two sizes. Why: the tree had only a 50% bet, so a 120% pot bet was silently read from the 50% node.
- The validator dedupes merged sizes, caps them at 8 per action, and ignores malformed numeric child keys.
- Order note: steps ran 2a -> 1 -> 4 -> 5 -> 3; model EV and equity speed affect every user, while this step only affects local TexasSolver intermediate nodes.
