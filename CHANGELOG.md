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
