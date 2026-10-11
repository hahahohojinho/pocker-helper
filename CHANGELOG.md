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

### In-browser DCFR solver (WASM)
- The service now solves heads-up spots itself: `tools/dcfr-wasm` compiles the pinned dcfr-solver crate to `public/solver/rangelab_dcfr_wasm.wasm` (373KB) without editing the submodule, using local `rayon`/`memmap2` shims via `[patch.crates-io]`. A Web Worker runs it; heads-up spots use it on every street.
- Why: users previously needed a TexasSolver binary or a self-built adapter, and the native DCFR adapter only handled the OOP street root (its `max_raises: 1` also meant no raises in the tree). The wasm path supports IP decisions, facing bets, and re-raises, returns per-action solver EV, and reproduces observed sizes exactly as reduced fractions.
- Measured (single thread, ~600-combo ranges): river 1000 iterations 0.3s, turn 100 iterations 4s at 0.03% pot exploitability, flop 12 iterations 22s at 1.6%. Presets: river 500, turn 100, flop 20. Browser E2E (Chromium, production build) solved a flop and a turn.
- Build: `npm run solver:wasm` (`--locked`, pinned Rust 1.99.0, sha256 written, third-party license notices generated from cargo metadata). The prebuilt module is committed so the app runs without Rust.
- Decided against: wasm threads (needs COOP/COEP headers and nightly build-std); TypeScript CFR rewrite (slower, duplicate of an existing MIT solver).

### Reproducible solver wasm and CI
- The wasm build remaps source paths (`/rangelab`, `/cargo`), strips the name section, and uses a Cargo workspace rooted at `tools/` (moving `Cargo.lock` to `tools/Cargo.lock`). Why: the module embedded the local user path and its hash changed with the checkout location; two clones now produce the same hash.
- Added `.github/workflows/ci.yml`: lint, vitest, and build on Ubuntu; Rust tests plus a wasm rebuild that must match the committed `public/solver` on Windows (remapped paths keep Windows separators).

### Solve progress and cancel
- The wasm module imports `env.progress(completed, total)` and reports at most ~100 times per solve; the worker forwards it and the panel shows `SOLVING n/m` (then "마무리 중…" during the exploitability pass) with a cancel button that terminates the worker. Why: flop solves take one to two minutes with no feedback.

### Native multi-threaded DCFR path
- New `tools/dcfr-core` crate shared by the wasm module and `rangelab-dcfr-adapter`; the adapter gained `--json` (stdin) with the same request/envelope. `/api/solver` accepts `{kind:"dcfr-json"}` when the adapter is configured and advertises `nativeJson`; the panel prefers it and falls back to the browser. Why: flop solves are ~3x faster end to end (E2E 52s vs 145s) and converge further (flop 60 iterations at 0.04% vs 20 at ~1%).
- Hardening from review: body read is streamed with a 300KB cap, adapter completion waits for stdio `close`, stdin EPIPE no longer masks the adapter's error envelope, the child gets an allowlisted environment, and CI runs the core and adapter tests with checkout credentials disabled.

### CI first run
- The first run failed in the wasm rebuild: after extracting `dcfr-core`, the license notice generator required a license file for every path crate. Repository crates are now listed as RangeLab code. Local verification had missed it because the build log was filtered for lowercase `error`. The second run passed on Ubuntu and Windows, with the rebuilt wasm identical to the committed one.

### Tree memory limit and pinned CI actions
- dcfr-core estimates a solve's memory before allocating by walking the same iso-reduced betting tree as dcfr-solver; it rejects trees over 1.5 GiB (browser) / 4 GiB (native) or 3M nodes. Why: a valid request (e.g. three flop sizes, three raises) needed ~1 GB and nothing prevented larger trees from exhausting memory. Review caught that the first version ignored per-node overhead (two-combo ranges were underestimated ~25x) and accepted `nan`/negative weights that skewed the live-combo count; both fixed and covered by tests.
- GitHub Actions pinned to commit SHAs verified via the GitHub API (checkout v7.0.1, setup-node v7.1.0) with Dependabot for actions.
