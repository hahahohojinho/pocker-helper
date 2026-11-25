//! Preflop betting rules for 6-max and 8-max tables (see NOTICE.md for provenance).
//!
//! Chip unit: 1 chip = 0.5bb (SB posts 1, BB posts 2). Seats are numbered in preflop action order: seat 0 opens the
//! action and the last two seats are the small and big blinds.

use dcfr_solver::card::Hand;
use dcfr_solver::eval::{evaluate, Strength};

pub const MAX_PLAYERS: usize = 8;
const SMALL_BLIND_CHIPS: i32 = 1;
const BIG_BLIND_CHIPS: i32 = 2;

const SIX_MAX_POSITIONS: [&str; 6] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const EIGHT_MAX_POSITIONS: [&str; 8] = ["UTG", "UTG+1", "MP", "HJ", "CO", "BTN", "SB", "BB"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Fold,
    Check,
    Call,
    /// Total bet in chips after the raise.
    Raise(i32),
    AllIn,
}

impl std::fmt::Display for Action {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Action::Fold => write!(f, "fold"),
            Action::Check => write!(f, "check"),
            Action::Call => write!(f, "call"),
            Action::Raise(total) => write!(f, "raise {total}"),
            Action::AllIn => write!(f, "allin"),
        }
    }
}

/// Table shape and bet sizing. `raise_sizes[depth]` lists total bet sizes in chips (depth 0 = open, 1 = 3-bet, ...);
/// beyond the last depth only all-in remains.
#[derive(Clone, Debug, PartialEq)]
pub struct TableSpec {
    pub players: usize,
    pub stack_chips: i32,
    pub raise_sizes: Vec<Vec<i32>>,
    pub sb_limp: bool,
    pub sb_open_size: Option<i32>,
    /// Raises needed before a voluntary all-in is offered (0 allows open-shoving).
    pub min_allin_depth: u8,
}

impl TableSpec {
    /// Standard sizes for a stack depth in big blinds, matching the upstream NL500 sizes at 100bb.
    pub fn for_stack(players: usize, stack_bb: u32) -> Result<TableSpec, String> {
        if players != 6 && players != 8 {
            return Err("players must be 6 or 8".into());
        }
        if !(10..=300).contains(&stack_bb) {
            return Err("stack must be 10..=300bb".into());
        }
        let stack_chips = stack_bb as i32 * 2;
        // Short stacks open small and 3-bet all-in; deep stacks size 3-bets and 4-bets up.
        let (raise_sizes, min_allin_depth) = match stack_bb {
            0..=25 => (vec![vec![4]], 0),
            26..=50 => (vec![vec![5], vec![18]], 1),
            51..=120 => (vec![vec![5], vec![18], vec![44]], 1),
            _ => (vec![vec![5], vec![20], vec![50], vec![120]], 1),
        };
        let raise_sizes = raise_sizes.into_iter()
            .map(|sizes: Vec<i32>| sizes.into_iter().filter(|&size| size < stack_chips).collect::<Vec<_>>())
            .filter(|sizes| !sizes.is_empty())
            .collect();
        Ok(TableSpec { players, stack_chips, raise_sizes, sb_limp: true, sb_open_size: Some(7), min_allin_depth })
    }

    pub fn sb(&self) -> usize { self.players - 2 }
    pub fn bb(&self) -> usize { self.players - 1 }

    pub fn position_name(&self, seat: usize) -> &'static str {
        if self.players == 8 { EIGHT_MAX_POSITIONS[seat] } else { SIX_MAX_POSITIONS[seat] }
    }

    /// Postflop acting order rank (higher = acts later = more in position): SB 0, BB 1, then seat order.
    pub fn postflop_rank(&self, seat: usize) -> usize {
        if seat == self.sb() { 0 } else if seat == self.bb() { 1 } else { seat + 2 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeType {
    TerminalFold(u8),
    TerminalShowdown,
    Decision(u8),
}

#[derive(Clone, Debug)]
pub struct State {
    pub n: usize,
    pub stacks: [i32; MAX_PLAYERS],
    pub bets: [i32; MAX_PLAYERS],
    pub folded: [bool; MAX_PLAYERS],
    pub has_acted: [bool; MAX_PLAYERS],
    pub all_in: [bool; MAX_PLAYERS],
    pub to_act: u8,
    pub n_raises: u8,
    pub holes: [Hand; MAX_PLAYERS],
    pub last_raise_size: i32,
}

impl State {
    pub fn new(spec: &TableSpec) -> State {
        let n = spec.players;
        let mut stacks = [0; MAX_PLAYERS];
        stacks[..n].fill(spec.stack_chips);
        let mut bets = [0; MAX_PLAYERS];
        stacks[spec.sb()] -= SMALL_BLIND_CHIPS;
        stacks[spec.bb()] -= BIG_BLIND_CHIPS;
        bets[spec.sb()] = SMALL_BLIND_CHIPS;
        bets[spec.bb()] = BIG_BLIND_CHIPS;
        let mut folded = [true; MAX_PLAYERS];
        folded[..n].fill(false);
        State {
            n,
            stacks,
            bets,
            folded,
            has_acted: [false; MAX_PLAYERS],
            all_in: [false; MAX_PLAYERS],
            to_act: 0,
            n_raises: 0,
            holes: [Hand::new(); MAX_PLAYERS],
            last_raise_size: BIG_BLIND_CHIPS,
        }
    }

    pub fn active_count(&self) -> usize {
        (0..self.n).filter(|&i| !self.folded[i]).count()
    }

    pub fn max_bet(&self) -> i32 {
        self.bets[..self.n].iter().copied().max().unwrap_or(0)
    }

    pub fn pot(&self) -> i32 {
        self.bets[..self.n].iter().sum()
    }

    pub fn is_closed(&self) -> bool {
        if self.active_count() <= 1 {
            return true;
        }
        // Closed once every player who can still act has acted and matched the highest bet (upstream applies the
        // same rule whether or not others are all-in).
        let max_bet = self.max_bet();
        (0..self.n)
            .filter(|&i| !self.folded[i] && !self.all_in[i])
            .all(|i| self.has_acted[i] && self.bets[i] == max_bet)
    }

    pub fn node_type(&self) -> NodeType {
        if self.active_count() == 1 {
            let winner = (0..self.n).find(|&i| !self.folded[i]).unwrap_or(0);
            return NodeType::TerminalFold(winner as u8);
        }
        if self.is_closed() {
            return NodeType::TerminalShowdown;
        }
        NodeType::Decision(self.to_act)
    }

    fn next_active_player(&self, after: u8) -> u8 {
        let mut seat = (after as usize + 1) % self.n;
        for _ in 0..self.n {
            if !self.folded[seat] && !self.all_in[seat] {
                return seat as u8;
            }
            seat = (seat + 1) % self.n;
        }
        after
    }

    /// Players who limped (called the big blind before any raise) and are still in the hand.
    pub fn limper_count(&self) -> usize {
        if self.n_raises > 0 {
            return 0;
        }
        (0..self.n).filter(|&i| !self.folded[i] && self.has_acted[i] && self.bets[i] == BIG_BLIND_CHIPS).count()
    }

    pub fn actions(&self, spec: &TableSpec) -> Vec<Action> {
        let seat = self.to_act as usize;
        let my_bet = self.bets[seat];
        let my_stack = self.stacks[seat];
        let max_bet = self.max_bet();
        let to_call = max_bet - my_bet;
        let depth = self.n_raises as usize;
        let mut actions = Vec::new();

        if to_call > 0 {
            actions.push(Action::Fold);
            if to_call >= my_stack {
                actions.push(Action::AllIn);
                return actions;
            }
            // Before any raise only the small blind may limp; facing a raise, calling is always available.
            if self.n_raises > 0 || (seat == spec.sb() && spec.sb_limp) {
                actions.push(Action::Call);
            }
            if let Some(sizes) = spec.raise_sizes.get(depth) {
                for &size in sizes {
                    let total = if depth == 0 && seat == spec.sb() { spec.sb_open_size.unwrap_or(size) } else { size };
                    let chips_needed = total - my_bet;
                    if total - max_bet < self.last_raise_size || chips_needed >= my_stack || chips_needed <= to_call {
                        continue;
                    }
                    actions.push(Action::Raise(total));
                }
            }
            if my_stack > to_call && self.n_raises >= spec.min_allin_depth {
                actions.push(Action::AllIn);
            }
        } else {
            // Big blind option after limps (or any unraised spot with nothing to call).
            actions.push(Action::Check);
            if let Some(sizes) = spec.raise_sizes.get(depth) {
                let limpers = if depth == 0 { self.limper_count() as i32 } else { 0 };
                for &size in sizes {
                    // An isolation raise grows by one big blind per limper.
                    let total = if depth == 0 { size + BIG_BLIND_CHIPS * limpers } else { size };
                    let chips_needed = total - my_bet;
                    if chips_needed >= my_stack || chips_needed <= 0 {
                        continue;
                    }
                    actions.push(Action::Raise(total));
                }
            }
            if my_stack > 0 && self.n_raises >= spec.min_allin_depth {
                actions.push(Action::AllIn);
            }
        }
        actions
    }

    fn reopen_action(&mut self, raiser: usize) {
        for i in 0..self.n {
            if i != raiser && !self.folded[i] && !self.all_in[i] {
                self.has_acted[i] = false;
            }
        }
    }

    pub fn apply(&self, action: Action) -> State {
        let mut s = self.clone();
        let seat = s.to_act as usize;
        match action {
            Action::Fold => {
                s.folded[seat] = true;
                s.has_acted[seat] = true;
            }
            Action::Check => {
                s.has_acted[seat] = true;
            }
            Action::Call => {
                let paid = (s.max_bet() - s.bets[seat]).min(s.stacks[seat]);
                s.stacks[seat] -= paid;
                s.bets[seat] += paid;
                s.has_acted[seat] = true;
                s.all_in[seat] = s.stacks[seat] == 0;
            }
            Action::Raise(total) => {
                let raise_size = total - s.max_bet();
                s.stacks[seat] -= total - s.bets[seat];
                s.bets[seat] = total;
                s.has_acted[seat] = true;
                s.n_raises += 1;
                s.last_raise_size = raise_size;
                s.all_in[seat] = s.stacks[seat] == 0;
                s.reopen_action(seat);
            }
            Action::AllIn => {
                let old_max = s.max_bet();
                s.bets[seat] += s.stacks[seat];
                s.stacks[seat] = 0;
                s.all_in[seat] = true;
                s.has_acted[seat] = true;
                if s.bets[seat] > old_max {
                    let raise_size = s.bets[seat] - old_max;
                    // A short all-in does not reopen raising, but everyone below the new bet must still act.
                    if raise_size >= s.last_raise_size {
                        s.n_raises += 1;
                        s.last_raise_size = raise_size;
                        s.reopen_action(seat);
                    }
                    for i in 0..s.n {
                        if i != seat && !s.folded[i] && !s.all_in[i] && s.bets[i] < s.bets[seat] {
                            s.has_acted[i] = false;
                        }
                    }
                }
            }
        }
        s.to_act = s.next_active_player(s.to_act);
        s
    }

    /// Winner takes the pot; returns each seat's profit in chips.
    pub fn payoff_fold(&self, winner: u8) -> [f32; MAX_PLAYERS] {
        let pot = self.pot();
        let mut payoffs = [0.0; MAX_PLAYERS];
        for i in 0..self.n {
            payoffs[i] = if i == winner as usize { (pot - self.bets[i]) as f32 } else { -(self.bets[i] as f32) };
        }
        payoffs
    }

    /// Showdown on a five-card board with side pots; returns each seat's profit in chips.
    pub fn payoff_showdown(&self, board: Hand) -> [f32; MAX_PLAYERS] {
        let mut payoffs = [0.0f32; MAX_PLAYERS];
        let strengths: Vec<(usize, Strength)> = (0..self.n)
            .filter(|&i| !self.folded[i])
            .map(|i| (i, evaluate(self.holes[i].union(board))))
            .collect();
        let mut levels: Vec<i32> = strengths.iter().map(|&(i, _)| self.bets[i]).collect();
        levels.sort_unstable();
        levels.dedup();
        let mut previous = 0;
        for level in levels {
            let layer: i32 = (0..self.n).map(|i| self.bets[i].min(level) - self.bets[i].min(previous)).sum();
            let eligible: Vec<(usize, Strength)> = strengths.iter().copied().filter(|&(i, _)| self.bets[i] >= level).collect();
            if layer > 0 {
                if let Some(best) = eligible.iter().map(|&(_, strength)| strength).max() {
                    let winners: Vec<usize> = eligible.iter().filter(|&&(_, strength)| strength == best).map(|&(i, _)| i).collect();
                    let share = layer as f32 / winners.len() as f32;
                    for winner in winners {
                        payoffs[winner] += share;
                    }
                }
            }
            previous = level;
        }
        for i in 0..self.n {
            payoffs[i] -= self.bets[i] as f32;
        }
        payoffs
    }
}
