# Changelog

## Unreleased - fix/solver-quality (2026-10-11)

### Solver range class weights (step 2a)
- `toTexasSolverRange` now weights a 169 class as summed combo weight / board-compatible combo count, and prunes by expected combos with a name tiebreak.
- Why: TexasSolver applies a class weight to every combo of the class. The old per-class average over present combos overstated partial classes (2 of 12 AQo combos at weight 1 became `AQo:1`), and equal weights were pruned in input order (a 28-class range became `22-99`).
- Board cards are excluded from both numerator and denominator, so board-blocked classes are not underweighted.
- `postflop-panel.tsx` now builds solver player ranges inside the error-handled block.
