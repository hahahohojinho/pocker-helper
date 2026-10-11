# Notice

`src/game.rs` and `src/trainer.rs` are derived from `src/preflop.rs` of
[exinori/DCFR-SOLVER](https://github.com/exinori/DCFR-SOLVER) at revision
`4ade6a9e15a841c41867afde1258b9d110cd6fb1`, used under the MIT License below. The submodule in
`tools/dcfr-solver` is not modified; this crate depends on it for cards, hand evaluation, canonical hands, and
regret entries.

Changes from the original:

- Player count (6 or 8) and starting stack are parameters instead of the `NUM_PLAYERS = 6` constant and the
  hard-coded 200-chip (100bb) stack; blind seats and the postflop position ranking follow the player count.
- Bet sizes come from a per-stack table; short stacks may open-shove.
- The heads-up showdown position tax is not applied to all-in pots, where no streets remain to realize position.
- A big blind raising over limpers sizes the raise as the open size plus one big blind per limper (the original
  reused the 2.5bb open size).
- Training runs in chunks with atomic checkpoints and can resume from a checkpoint.
- A new exporter walks the averaged strategy and emits every reachable decision spot in RangeLab's format.

The MCCFR update (external sampling, CFR+ regret flooring, linear strategy weighting), the showdown model
(sampled boards plus the heads-up out-of-position pot tax), and the action rules are otherwise unchanged.

---

MIT License

Copyright (c) 2025 POKERGOSU

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
