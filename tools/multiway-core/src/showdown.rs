//! Terminal values on the river with exact card removal between all players.
//!
//! For a Hero combo `h` and two opponents with reach vectors `x` and `y`, the mass of opponent pairs `(a, b)` that
//! share no card with `h` or with each other, with `a` in set S and `b` in set T, is
//!   F(S,T|h) = X_S * Y_T - sum_c X_S[c] * Y_T[c] + D_{S n T}
//! where X_S / Y_T are the masses avoiding `h`, `X_S[c]` the part holding card `c`, and D the mass of identical
//! combos (counted twice by the card sum). S and T are "below Hero", "tied with Hero", or "any". This is O(52) per
//! Hero combo instead of O(n^2).

use dcfr_solver::card::{combo_from_index, combo_index, Card, Hand, NUM_CARDS, NUM_COMBOS};
use dcfr_solver::eval::evaluate;
use rayon::prelude::*;

/// Board-blocked combos.
pub const BLOCKED: u16 = u16::MAX;
/// Hero combos per rayon task; kernels are cheap per combo.
const MIN_CHUNK: usize = 16;

pub struct Board {
    /// Cards not on the board.
    pub deck: Vec<Card>,
    /// Dense strength rank per combo (0 = weakest), `BLOCKED` if the combo touches the board.
    pub group: Vec<u16>,
    /// Live combos ordered by strength rank.
    pub live: Vec<u16>,
    pair: Vec<u16>,
}

impl Board {
    pub fn new(board: Hand) -> Board {
        let deck: Vec<Card> = (0..NUM_CARDS as Card).filter(|&card| !board.contains(card)).collect();
        let mut strengths: Vec<(u32, u16)> = Vec::new();
        for index in 0..NUM_COMBOS as u16 {
            let (c1, c2) = combo_from_index(index);
            if !board.contains(c1) && !board.contains(c2) {
                strengths.push((evaluate(board.add(c1).add(c2)).0, index));
            }
        }
        strengths.sort_unstable();
        let mut group = vec![BLOCKED; NUM_COMBOS];
        let mut rank = 0u16;
        for (position, &(strength, index)) in strengths.iter().enumerate() {
            if position > 0 && strength != strengths[position - 1].0 {
                rank += 1;
            }
            group[index as usize] = rank;
        }
        let mut pair = vec![0u16; NUM_CARDS * NUM_CARDS];
        for a in 0..NUM_CARDS as Card {
            for b in 0..NUM_CARDS as Card {
                if a != b {
                    pair[a as usize * NUM_CARDS + b as usize] = combo_index(a, b);
                }
            }
        }
        Board { deck, group, live: strengths.iter().map(|&(_, index)| index).collect(), pair }
    }

    #[inline]
    fn pair(&self, a: Card, b: Card) -> usize {
        self.pair[a as usize * NUM_CARDS + b as usize] as usize
    }

    /// `combos` with the board-blocked ones removed, ordered by strength (the order `values` expects).
    pub fn sort_by_strength(&self, combos: &[u16]) -> Vec<u16> {
        let mut sorted: Vec<u16> = combos.iter().copied().filter(|&combo| self.group[combo as usize] != BLOCKED).collect();
        sorted.sort_by_key(|&combo| (self.group[combo as usize], combo));
        sorted
    }
}

/// Hero's terminal value is `z * Z + head[k] * H_k + all * T`, where Z is the compatible opponent mass, H_k the
/// heads-up share against opponent slot k (win 1, tie 1/2; the other opponent only blocks cards), and T the 3-way
/// share (win 1, two-way tie 1/2, three-way tie 1/3).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Coeffs {
    pub z: f64,
    pub head: [f64; 2],
    pub all: f64,
}

impl Coeffs {
    fn needs_ranks(&self) -> bool {
        self.head != [0.0; 2] || self.all != 0.0
    }
}

#[derive(Clone, Copy)]
struct Profile {
    tot: f64,
    pc: [f64; NUM_CARDS],
}

impl Profile {
    const ZERO: Profile = Profile { tot: 0.0, pc: [0.0; NUM_CARDS] };

    #[inline]
    fn add(&mut self, c1: Card, c2: Card, weight: f64) {
        self.tot += weight;
        self.pc[c1 as usize] += weight;
        self.pc[c2 as usize] += weight;
    }

    fn plus(&mut self, other: &Profile) {
        self.tot += other.tot;
        for (mine, theirs) in self.pc.iter_mut().zip(other.pc.iter()) {
            *mine += theirs;
        }
    }

    /// Mass avoiding Hero's two cards, before adding Hero's own combo back.
    #[inline]
    fn without(&self, h1: Card, h2: Card) -> f64 {
        self.tot - self.pc[h1 as usize] - self.pc[h2 as usize]
    }
}

/// Profiles of one set for x, y, and x*y.
#[derive(Clone, Copy)]
struct Sets {
    x: Profile,
    y: Profile,
    xy: Profile,
}

impl Sets {
    const ZERO: Sets = Sets { x: Profile::ZERO, y: Profile::ZERO, xy: Profile::ZERO };

    fn add(&mut self, combo: u16, x: &[f64], y: &[f64]) {
        let (c1, c2) = combo_from_index(combo);
        let (wx, wy) = (x[combo as usize], y[combo as usize]);
        self.x.add(c1, c2, wx);
        self.y.add(c1, c2, wy);
        self.xy.add(c1, c2, wx * wy);
    }

    fn plus(&mut self, other: &Sets) {
        self.x.plus(&other.x);
        self.y.plus(&other.y);
        self.xy.plus(&other.xy);
    }
}

/// Terminal value per Hero combo (`hero` ordered by strength, see `Board::sort_by_strength`).
/// `opponents` holds one (heads-up) or two reach vectors over all 1326 combos.
pub fn values(board: &Board, hero: &[u16], opponents: &[&[f64]], coeffs: &Coeffs) -> Vec<f64> {
    match opponents {
        [x] => values2(board, hero, x, coeffs),
        [x, y] => values3(board, hero, x, y, coeffs),
        _ => panic!("1 or 2 opponents"),
    }
}

/// For each Hero combo, the profiles of combos strictly below it and tied with it.
fn rank_sets(board: &Board, hero: &[u16], x: &[f64], y: &[f64]) -> (Vec<(Sets, Sets)>, Vec<usize>) {
    let mut snapshots = Vec::new();
    let mut index_of = Vec::with_capacity(hero.len());
    let mut below = Sets::ZERO;
    let mut next = 0;
    let live = &board.live;
    let mut start = 0;
    while start < live.len() && next < hero.len() {
        let rank = board.group[live[start] as usize];
        let mut end = start;
        let mut tied = Sets::ZERO;
        while end < live.len() && board.group[live[end] as usize] == rank {
            tied.add(live[end], x, y);
            end += 1;
        }
        if board.group[hero[next] as usize] == rank {
            snapshots.push((below, tied));
            while next < hero.len() && board.group[hero[next] as usize] == rank {
                index_of.push(snapshots.len() - 1);
                next += 1;
            }
        }
        below.plus(&tied);
        start = end;
    }
    (snapshots, index_of)
}

fn values3(board: &Board, hero: &[u16], x: &[f64], y: &[f64], coeffs: &Coeffs) -> Vec<f64> {
    let mut any = Sets::ZERO;
    for &combo in &board.live {
        any.add(combo, x, y);
    }
    if !coeffs.needs_ranks() {
        return hero.par_iter().with_min_len(MIN_CHUNK).map(|&h| coeffs.z * pair_mass_any(board, h, x, y, &any)).collect();
    }
    let (snapshots, index_of) = rank_sets(board, hero, x, y);
    hero.par_iter().zip(index_of.par_iter()).with_min_len(MIN_CHUNK)
        .map(|(&h, &snapshot)| hand3(board, h, x, y, &snapshots[snapshot], &any, coeffs))
        .collect()
}

fn pair_mass_any(board: &Board, h: u16, x: &[f64], y: &[f64], any: &Sets) -> f64 {
    let (h1, h2) = combo_from_index(h);
    let (xh, yh) = (x[h as usize], y[h as usize]);
    let ax = any.x.without(h1, h2) + xh;
    let ay = any.y.without(h1, h2) + yh;
    let d = any.xy.without(h1, h2) + xh * yh;
    let mut shared = 0.0;
    for &card in &board.deck {
        if card == h1 || card == h2 {
            continue;
        }
        let (i1, i2) = (board.pair(card, h1), board.pair(card, h2));
        shared += (any.x.pc[card as usize] - x[i1] - x[i2]) * (any.y.pc[card as usize] - y[i1] - y[i2]);
    }
    ax * ay - shared + d
}

fn hand3(board: &Board, h: u16, x: &[f64], y: &[f64], (below, tied): &(Sets, Sets), any: &Sets, coeffs: &Coeffs) -> f64 {
    let (h1, h2) = combo_from_index(h);
    let rank = board.group[h as usize];
    let (xh, yh) = (x[h as usize], y[h as usize]);
    // Hero's own combo is tied with itself (and in "any"), never below.
    let (lx, ly) = (below.x.without(h1, h2), below.y.without(h1, h2));
    let (ex, ey) = (tied.x.without(h1, h2) + xh, tied.y.without(h1, h2) + yh);
    let (ax, ay) = (any.x.without(h1, h2) + xh, any.y.without(h1, h2) + yh);
    let d_below = below.xy.without(h1, h2);
    let d_tied = tied.xy.without(h1, h2) + xh * yh;
    let d_any = any.xy.without(h1, h2) + xh * yh;
    let mut s = [0.0f64; 9];
    for &card in &board.deck {
        if card == h1 || card == h2 {
            continue;
        }
        let c = card as usize;
        let (i1, i2) = (board.pair(card, h1), board.pair(card, h2));
        let (g1, g2) = (board.group[i1], board.group[i2]);
        let (x1, x2, y1, y2) = (x[i1], x[i2], y[i1], y[i2]);
        let low = |g: u16, w: f64| if g < rank { w } else { 0.0 };
        let tie = |g: u16, w: f64| if g == rank { w } else { 0.0 };
        let lxc = below.x.pc[c] - low(g1, x1) - low(g2, x2);
        let exc = tied.x.pc[c] - tie(g1, x1) - tie(g2, x2);
        let axc = any.x.pc[c] - x1 - x2;
        let lyc = below.y.pc[c] - low(g1, y1) - low(g2, y2);
        let eyc = tied.y.pc[c] - tie(g1, y1) - tie(g2, y2);
        let ayc = any.y.pc[c] - y1 - y2;
        s[0] += lxc * lyc;
        s[1] += exc * lyc;
        s[2] += lxc * eyc;
        s[3] += exc * eyc;
        s[4] += lxc * ayc;
        s[5] += exc * ayc;
        s[6] += axc * lyc;
        s[7] += axc * eyc;
        s[8] += axc * ayc;
    }
    let below_below = lx * ly - s[0] + d_below;
    let tied_below = ex * ly - s[1];
    let below_tied = lx * ey - s[2];
    let tied_tied = ex * ey - s[3] + d_tied;
    let below_any = lx * ay - s[4] + d_below;
    let tied_any = ex * ay - s[5] + d_tied;
    let any_below = ax * ly - s[6] + d_below;
    let any_tied = ax * ey - s[7] + d_tied;
    let any_any = ax * ay - s[8] + d_any;
    let head_x = below_any + tied_any / 2.0;
    let head_y = any_below + any_tied / 2.0;
    let three = below_below + (tied_below + below_tied) / 2.0 + tied_tied / 3.0;
    coeffs.z * any_any + coeffs.head[0] * head_x + coeffs.head[1] * head_y + coeffs.all * three
}

fn values2(board: &Board, hero: &[u16], x: &[f64], coeffs: &Coeffs) -> Vec<f64> {
    let mut any = Profile::ZERO;
    for &combo in &board.live {
        let (c1, c2) = combo_from_index(combo);
        any.add(c1, c2, x[combo as usize]);
    }
    let (snapshots, index_of) = if coeffs.needs_ranks() { rank_sets(board, hero, x, x) } else { (Vec::new(), Vec::new()) };
    hero.par_iter().enumerate().with_min_len(MIN_CHUNK).map(|(position, &h)| {
        let (h1, h2) = combo_from_index(h);
        let xh = x[h as usize];
        let mass = any.without(h1, h2) + xh;
        if !coeffs.needs_ranks() {
            return coeffs.z * mass;
        }
        let (below, tied) = &snapshots[index_of[position]];
        let share = below.x.without(h1, h2) + (tied.x.without(h1, h2) + xh) / 2.0;
        coeffs.z * mass + coeffs.head[0] * share
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use dcfr_solver::card::parse_cards;
    use rand::rngs::SmallRng;
    use rand::{Rng, SeedableRng};

    fn board_of(text: &str) -> (Hand, Board) {
        let hand = parse_cards(text).unwrap().into_iter().fold(Hand::new(), |hand, card| hand.add(card));
        (hand, Board::new(hand))
    }

    fn random_reach(rng: &mut SmallRng, board: &Board, density: f64) -> Vec<f64> {
        (0..NUM_COMBOS).map(|index| if board.group[index] != BLOCKED && rng.gen_bool(density) { rng.gen_range(0.0..1.0) } else { 0.0 }).collect()
    }

    fn overlaps(a: u16, b: u16) -> bool {
        let (a1, a2) = combo_from_index(a);
        let (b1, b2) = combo_from_index(b);
        a1 == b1 || a1 == b2 || a2 == b1 || a2 == b2
    }

    /// O(n^3) reference: share of the 3-way pot, the heads-up pots, and compatible mass.
    fn brute3(board: &Board, h: u16, x: &[f64], y: &[f64], coeffs: &Coeffs) -> f64 {
        let mut total = 0.0;
        for &a in &board.live {
            if x[a as usize] == 0.0 || overlaps(a, h) {
                continue;
            }
            for &b in &board.live {
                if y[b as usize] == 0.0 || overlaps(b, h) || overlaps(a, b) {
                    continue;
                }
                let (gh, ga, gb) = (board.group[h as usize], board.group[a as usize], board.group[b as usize]);
                let head = |g: u16| if gh > g { 1.0 } else if gh == g { 0.5 } else { 0.0 };
                let three = if gh < ga || gh < gb { 0.0 } else { 1.0 / (1 + (ga == gh) as u32 + (gb == gh) as u32) as f64 };
                let value = coeffs.z + coeffs.head[0] * head(ga) + coeffs.head[1] * head(gb) + coeffs.all * three;
                total += x[a as usize] * y[b as usize] * value;
            }
        }
        total
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() <= 1e-9 * expected.abs().max(1.0), "{actual} vs {expected}");
    }

    #[test]
    fn three_way_kernel_matches_brute_force() {
        let mut rng = SmallRng::seed_from_u64(7);
        // Paired, flush, straight, and dry boards so ties and shared groups occur.
        for text in ["AsAdKc7h2s", "Th9h4c2h8h", "8c7c6d5h4s", "KsTd7c4h2s", "2c2d2h3s3c"] {
            let (_, board) = board_of(text);
            let x = random_reach(&mut rng, &board, 0.25);
            let y = random_reach(&mut rng, &board, 0.25);
            let hero = board.sort_by_strength(&board.live.iter().copied().step_by(37).collect::<Vec<_>>());
            for coeffs in [Coeffs { z: 1.0, ..Default::default() }, Coeffs { z: -0.3, head: [2.0, -1.5], all: 4.0 }, Coeffs { head: [0.0, 1.0], ..Default::default() }] {
                let got = values(&board, &hero, &[&x, &y], &coeffs);
                for (position, &h) in hero.iter().enumerate() {
                    assert_close(got[position], brute3(&board, h, &x, &y, &coeffs));
                }
            }
        }
    }

    #[test]
    fn heads_up_kernel_matches_brute_force() {
        let mut rng = SmallRng::seed_from_u64(11);
        let (_, board) = board_of("Qh8d8c3s3d");
        let x = random_reach(&mut rng, &board, 0.4);
        let hero = board.sort_by_strength(&board.live.iter().copied().step_by(29).collect::<Vec<_>>());
        let coeffs = Coeffs { z: -0.25, head: [1.75, 0.0], all: 0.0 };
        let got = values(&board, &hero, &[&x], &coeffs);
        for (position, &h) in hero.iter().enumerate() {
            let expected: f64 = board.live.iter().filter(|&&a| !overlaps(a, h)).map(|&a| {
                let (gh, ga) = (board.group[h as usize], board.group[a as usize]);
                let share = if gh > ga { 1.0 } else if gh == ga { 0.5 } else { 0.0 };
                x[a as usize] * (coeffs.z + coeffs.head[0] * share)
            }).sum();
            assert_close(got[position], expected);
        }
    }

    #[test]
    fn strength_groups_rank_hands() {
        let (_, board) = board_of("AsKsQsJs2d");
        let royal = combo_index(parse_cards("Ts").unwrap()[0], parse_cards("3c").unwrap()[0]) as usize;
        let pair = combo_index(parse_cards("2c").unwrap()[0], parse_cards("3c").unwrap()[0]) as usize;
        assert!(board.group[royal] > board.group[pair]);
        assert_eq!(board.live.len(), 1081);
    }
}
