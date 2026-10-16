# Changelog

## Unreleased - fix/solver-quality (2026-10-11)

### Native 3-player river solver (2026-10-16)
- New crate `tools/multiway-core` linked into `rangelab-dcfr-adapter` (`--json-multiway`, `--capabilities`). Reuses only dcfr-solver's cards, evaluator, and range parser; dcfr-solver's postflop solver is two-player only and the submodule stays unmodified.
- Rules: dcfr-solver sizing, rounding, minimum raise, and all-in collapse for 2-3 players in action order; side pots by street commitment. Simplification: an incomplete all-in raise reopens the action.
- Showdown: exact card removal in O(52) per Hero combo via inclusion-exclusion over shared cards (sets below/tied/any), tested against an O(n^3) brute force. Solver: vector-form DCFR (1.5, 0, 2), alternating updates, average strategy weighted by own reach; 2-player results match dcfr-core root and facing-bet EVs within 1% of the pot.
- Convergence is reported as the largest per-player best-response gain (% of pot) because 3-player CFR has no Nash guarantee; the UI shows `MAX BR GAIN` and `SOLVER EV · 3-WAY CFR` instead of exploitability.
- App: `POST /api/solver` `{kind:"multiway-json"}`, `GET` advertises `nativeMultiway` (probe cached; failures retried after 60 s). The panel solves 3-player rivers natively; it now keys solver choice on the seats that started the street, so a same-street fold no longer sends a 3-player street to the heads-up solver with the folder's action mislabeled.
- Measured (12 threads, 4.5 s): SRP ranges 261-344 iterations at <= 0.019% pot; 100% ranges at 2 s <= 0.075%.
- Why: the user required turn/river answers within 10 s and asked for a real multiway backend; river 3-way fits easily, turn 3-way needs ~0.5-2 s per iteration on the full tree (planner estimate, not measured) and flop 3-way does not fit, so both stay on MODEL EV for now. MCCFR was rejected (noisy per-combo EV under a deadline).
- Reviews: code review found the average strategy was not weighted by own reach (fixed), a short all-in counted as a raise in the TS encoder (fixed), and a near-zero mass check (relative threshold now). Security review: storage cap lowered to 1 GB including node overhead, the solve stops once the budget is spent even below 3 iterations.

### Flop library generated (2026-10-14)
- `node scripts/build-flop-library.mjs --budget-ms 30000` finished all three 6-max 100bb SRP scenarios (BTN/CO/SB vs BB), 1755 canonical flops each, 0 failures, 379 MB, local only (gitignored). Exploitability median/max: BTN 0.058/0.521%, CO 0.060/0.392%, SB 0.050/0.359%. Run 2026-10-11 to 2026-10-14 with several resumes after PC shutdowns.

### Live turn/river solve time measured (2026-10-14)
- Native adapter `--json`, 12 threads, 4.5 s budget, root node, wall time including process start: BTN vs BB SRP ranges, turn 270-340 iterations in 4.5 s at 0.004% exploitability, river 1000 iterations in 1.2 s at <=0.002%; 100% vs 100% ranges, turn 194-240 iterations at <=0.016% (2 s budget: <=0.08%), river 1.7 s.
- Why: the user requires turn/river answers within 10 s and rejected precomputing turns/rivers (~2.5 months of CPU). The current `DCFR_TIME_BUDGET_MS` (4500) already meets it with exploitability far below the 1% "ok" threshold, so only the preset comment changed.

### CI builds and tests the native adapter on Linux and Windows (2026-10-12)
- New `adapter` matrix job: pinned toolchain (`tools/dcfr-adapter/rust-toolchain.toml`, 1.99.0 like the wasm build), `cargo build/test --release --locked` (tests single-threaded because `deadline.rs` measures wall time), then the vitest integration tests with `DCFR_ADAPTER_PATH` pointing at the built binary. The adapter test step moved out of `solver-wasm` so it does not run twice on Windows.
- `isAdapterExecutable`: the spawned binary must be `rangelab-dcfr-adapter.exe` on Windows (case-insensitive) and `rangelab-dcfr-adapter` elsewhere (case-sensitive); before, Linux binaries were always rejected.
- No `actions/cache` step: actions are SHA-pinned and the cache action's SHA was not verified. Add one if the job is slow.
- Dropped the TODO to convert the RFI run's 30 matchup exports into schema v2 spots: the 6-max/8-max packs cover them up to facing a 4-bet, and the exports are no longer on disk.

### Local DCFR job API solves every heads-up node (2026-10-12)
- Legacy solver jobs sent to the local DCFR adapter are converted to its `--json` request (`src/lib/server/dcfr-job-request.ts`) instead of the flag-based mode, so IP roots and intermediate histories are solved; previously only Hero-OOP street roots with nothing to call were accepted.
- The street history is replayed with OOP acting first and rejected if it folds, ends the street, or contains an illegal check/call/bet/raise, a missing or non-increasing amount, an amount over the stack, or a raise of an all-in. Call amounts are recomputed, and a bet covering the shorter stack becomes all-in (code review finding). Stacks come from the two players (role by `actorSeat`) or default to the effective stack. Returned actions must be legal at the node.
- Why: the UI already solves heads-up spots through `--json` when the adapter is advertised; routing the job API the same way gives one code path and one EV basis. TypeScript-only: the Rust flag mode is left in the binary (it was in use by the flop library build) but is no longer called. `buildDcfrAdapterArgs` was removed.
- Security review: no new issues; pre-existing items remain open (adapter stderr in client errors, no time budget on the job path, range type checks, sizes rounding to 0%).

### Flop library code (phase 5b)
- Precomputed heads-up flops answer instantly when the spot is exactly the stored one; otherwise the card shows why and the live solver answers. New `src/lib/flop-library` (suit canonicalization of the 1755 flop classes, strict file validation, lookup, cached loader with retry suppression), `FlopLibraryCard` in the postflop panel, the generator `scripts/build-flop-library.mjs`, and `src/data/flop-library-manifest.json` (BTN/CO/SB vs BB single-raised pots, 6-max 100bb).
- dcfr-core: `hero` is optional in the request (single-node solves still require it), solving is shared through `solve_tree`, and `solve_nodes_json` exports every combo's strategy and per-action EV at up to 8 nodes from one solve, always measuring exploitability. The native adapter exposes it as `--json-nodes`.
- Why exact matches only: an approximate board (e.g. K82 for K72) turns some combos from top pair into air, so per-combo answers can be arbitrarily wrong. Why gitignored: about 80 MB per scenario, generated on the user's PC.
- Decided against shipping in git and against nearest-stack matching for now (hit rate is limited to the pack's open sizes and exact 100bb stacks; tolerance is a v2 question).
- Review fixes: solution files carry a `specHash` of their inputs, checked by the generator (resume, index) and the app, so a regenerated manifest can never serve answers solved for old ranges; the index is built from an in-memory record instead of re-reading every file; `--redo-above` keeps the better of the old and new solve; an adapter that dies before reading stdin fails only that flop.
- The library data is not generated yet (needs ~6 h of CPU per scenario). The wasm module was rebuilt for the dcfr-core change (engine tests pass).

### Split pots among every tied player
- `calculateEquity` and `calculateRangeEquity` now give a tie 1/(players tied for the best hand) instead of always 1/2; the margin of error uses the per-sample second moment of that share.
- Why: a three-way chop counted as half the pot overstated multiway equity, which now feeds the multiway bet EV directly. Found comparing against a standalone Python equity engine that splits ties this way.

### Multiway model EV (phase 5a)
- New `src/lib/multiway-ev.ts`: bet/raise EV against independent opponents. Each subset of callers gets its own pot (grows per caller, short callers return the hero's uncalled excess, unmatched opponents pay what they owe first) and its own equity against those callers' calling ranges. The likeliest subsets (up to 8, until 98% of the probability) are exact; the rest share one all-callers estimate. One opponent reproduces the old heads-up formula.
- Why: the old model counted one caller's chips in the pot and computed equity against every opponent's calling range at once, even when only one called, so multiway bets were mispriced and only labeled "heads-up 근사".
- Default fold per opponent is alpha^(1/k) (alpha = risk / (pot + risk), k = opponents who can fold): everyone folds with the break-even rate, so a pure bluff still breaks even for any number of callers. Splitting alpha evenly has no such property.
- `estimateSubsetEquities` (called-equity) builds each calling range once and runs at most 9 equity calls; 7 opponents take ~0.2 s at 5000 iterations per subset. `cbetAdvice` and the postflop panel use the same path; `callerSubsets` is shared with the iso-raise model.
- Hero calls note opponents still to act behind (`seatsYetToRespond`), whose overcalls and squeezes are not modeled.
- Decided against a heads-up-reduced solver for 3+ players: multiway equilibria differ fundamentally (bluff and defense frequencies), and its exploitability would not describe the real game. The panel says local solvers do not support 3+ players.
- Review fixes: unmatched opponents' owed chips, a single all-in opponent no longer gets a fold share, always-folding opponents skipped, per-opponent array length checked, model EV errors no longer break rendering, opponent range textareas capped at 50,000 characters.

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

### 5-second answers (phase 1 of the real-time roadmap)
- DCFR solves take a `timeBudgetMs`. Natively the solve stops at the deadline by unwinding from dcfr-solver's per-iteration callback (state verified consistent at that point, rayon unaffected); wasm plans iterations from a learned per-street cost model. Why: the goal is a decision within 5 s on the user's PC for every heads-up street.
- Measured end to end (native): flop <= 4.4 s at 0.13-1.41% exploitability, turn <= 4.3 s, river <= 0.6 s. Browser E2E with the native solver dropped from 52 s to 12 s for the full flow.
- Roadmap agreed with the user: (1) 5 s answers [done], (2) preflop solve data for 6-max/8-max and multiple stack depths, (3) opponent profiling in a local SQLite DB (`node:sqlite`), (4) tendency-based exploits including isolation raises, (5) multiway approximation and a flop library.

### Preflop packs for 6-max/8-max and multiple stacks (phase 2)
- New `tools/rangelab-preflop`: dcfr-solver's preflop MCCFR generalized to 6/8 players and any stack (submodule untouched, MIT notice), resumable atomic checkpoints, and an exporter of every reachable decision spot (RFI, vs open, vs 3-bet/4-bet, squeeze lines, SB limp / BB isolation) keyed like the app's spot context. `scripts/run-preflop-matrix.mjs` runs the 10-job matrix. Why: the bundled data covered only 6-max 100bb RFI; everything else used a heuristic.
- App: preflop packs (`src/lib/preflop-packs.ts`) load per table size and nearest stack and take priority in `lookupStrategy`; new `limped` scenario, `aggressorPosition`, and `limperPositions` in the spot context; table size flows into recommendations and inferred ranges.
- Review fixes before data generation: forced all-in calls counted as calls (they were exported as aggression), callers who later fold stay callers (app semantics), blueprint loading validates sizes/spec/values, checkpoints sync before rename, resume refuses a mismatched table spec.
- App review fixes: packs are not used past facing a 4-bet (`raiseCount`), or when the stack or bet size is more than 2.5x from the solved one; equal stack distances go to the smaller bucket in both lookup and loading. An observed action no source explains (e.g. a UTG limp, which the solved model never makes) is skipped in range inference instead of collapsing the range to one hand. The loader skips HTML pages, unparseable packs, and packs for the wrong table or stack, then tries the next bucket; failed or empty loads retry after 60 s; parsing caps spots and position lists and rejects duplicate spots.
- Fix (found validating the first 20bb pack): the heads-up showdown position tax (20% of the pot scaled by positional gap, upstream model) was applied to all-in pots too. With no streets left, that made calling shoves cost up to 6.5bb extra, so the blinds called a 20bb button shove with 9.5% of hands and the button shoved 99.6%. All-in pots are now exempt (`showdown_tax`); a 10M-iteration check gives BTN 32.7% / BB call vs shove 20.5% and monotonic RFI widths. The matrix restarted from scratch on 2026-10-11 ~04:20 UTC; the earlier checkpoints were deleted.

### Opponent profiling in a local SQLite database (phase 3)
- `src/lib/profiling`: hand records are validated and replayed through the table helper's own preflop/postflop validators (only legal, finished hands are stored); each hand yields per-seat stat events as opportunity/taken pairs (VPIP, PFR, limp, limp vs iso fold/call/raise, 3-bet, fold to 3-bet, cold call, saw flop, flop c-bet, fold to c-bet, AF counts, WTSD, W$SD) and shown hands keyed by line and pot type. Tendencies (nit/TAG/LAG/calling station/maniac/passive) use Beta-shrunk rates (prior strength 20 hands, per table size) with a 20-hand minimum and per-stat minimums for tags such as "folds to iso". Why pairs: phase 4 shrinks small samples toward GTO instead of trusting raw percentages.
- `src/lib/server/profile-*`: `node:sqlite` loaded at run time (bundlers never see it), WAL, `user_version` migrations with a backup, idempotent saves (same id + same content = duplicate, different content = 409), and derived rows rebuilt from stored records when `STATS_VERSION` changes. Stats are per table size.
- `/api/profile/*`: loopback host allowlist (DNS rebinding), same-origin JSON writes, 64KB streamed body cap, `ALLOW_LOCAL_PROFILE_API` in production, Korean user messages with details only in server logs. `dev`/`start` now bind 127.0.0.1 (security review: a LAN client could spoof `Host: localhost`); `dev:lan`/`start:lan` keep the old behavior.
- UI: seat assignment panel (persisted per table size in localStorage), per-seat tendency badge, hand recorder in the postflop panel (shown cards, winners, save), and "next hand" rotating players, hero, and stacks with the button. Known limit: seat coordinates are tied to positions, so players move around the drawn table between hands.
- Review fixes before merge: replay rejected actions after the betting ended (they inflated AF), blinds no longer count as cold callers, limp-vs-iso counts only the response to the iso raise, winners must be exactly the best shown hands when those covered everyone, playedAt stored canonically, migration race and rollback masking.

### 6-max preflop packs committed
- `public/data/preflop/6max-{20,40,60,100,150}bb.json` (100M iterations each, after the all-in tax fix). RFI widths and model caveats are in docs/DCFR_PREFLOP.md. Browser check: the 6-max table loads the 100bb pack, switches to the 20bb pack when the stack changes, and labels the decision "SOLVED PACK".
- `src/lib/preflop-packs.data.test.ts` keeps committed packs loadable and sane in CI. `MAX_PACK_CHARS` lowered from 20M to 4M now that real sizes are known (largest 6-max pack 0.56 MB; security review MEDIUM).
- Why BTN opens wider than common charts: the generator approximates postflop play with showdown equity and a position tax; upstream's own 100bb data shows the same (BTN 71.6% there vs 61.7% here).

### Tendency-based exploit advice (phase 4)
- `src/lib/exploit`: stats shrunk toward priors (nothing applied below each stat's minimum sample; limp responses shrunk jointly so they still sum to 1), a 169-class strength order generated from heads-up equity vs a random hand, and range builders (bands, limp ranges sized to the recorded limp share with limp-reraise traps on top, split by response, scale by a width ratio).
- Isolation raises: EV of fold / over-limp (check in the BB) / iso raise against the limpers and players still to act, enumerating caller subsets (exact equity for the 8 most likely, a conservative all-callers estimate for the rest), position per subset, short stacks capped. Why a model and not a solve: non-SB limps are outside the solved packs and a per-opponent subgame would not fit the 5 s budget; a node-locked subgame stays a later option.
- Flop c-bet: per-size fold share = break-even share + (opponent's shrunk fold-to-c-bet - 1/3), against ranges widened or narrowed by the opponent's preflop frequency for their last action (range lock). Computed on request to keep the main thread free. An exploit re-solve with locked ranges is not built yet.
- UI: separate EXPLOIT cards labeled NOT GTO with the stats used, sample sizes, and assumptions; "기준 모델" when no stat had enough samples. The GTO card and solver output are unchanged.
- Range lock uses the stat whose population matches the action: calling a 3-bet after opening scales by 1 - fold-to-3-bet, a limper by the limp rate, and a limp-call of an iso raise is left unchanged (no recorded stat covers it). Earlier draft used cold-call there.
- Review fixes before merge: limp range was (1 + reraise) times too large, position was assumed for the hero even with callers acting later, empty calling ranges counted as 100% equity, empty stack input, unchecked server counts, responder count cap.
