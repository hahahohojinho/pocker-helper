//! N-player (2-3) single-street betting rules and the arena tree built from them.
//!
//! Players are indexed in postflop action order. Bet sizing matches dcfr-solver: a bet is a fraction of the current
//! pot, a raise adds a fraction of the pot after calling on top of the largest bet, and a size that needs the whole
//! stack becomes the all-in branch. As in NLHE, an all-in raise smaller than the last full raise does not reopen
//! raising for players who already acted; they may only call or fold. Players all-in from an earlier street start
//! with a zero stack and only contest the pot layers they are eligible for.

use std::fmt;

pub const MAX_PLAYERS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Fold,
    Check,
    Call,
    /// `[numerator, denominator]` of the pot it is sized from.
    Bet([i32; 2]),
    AllIn,
}

impl fmt::Display for Action {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Action::Fold => write!(f, "fold"),
            Action::Check => write!(f, "check"),
            Action::Call => write!(f, "call"),
            Action::Bet([n, d]) => write!(f, "bet {n}/{d}"),
            Action::AllIn => write!(f, "allin"),
        }
    }
}

/// Rules shared by every node of one solve.
#[derive(Clone, Debug)]
pub struct Rules {
    pub players: usize,
    /// Chips in the pot at the start of the street.
    pub pot: i32,
    /// That pot split into main and side pots from earlier streets; amounts sum to `pot`.
    pub start_layers: Vec<Layer>,
    /// Stacks at the start of the street.
    pub stacks: [i32; MAX_PLAYERS],
    /// `bet_sizes[depth]`: depth 0 = bet, 1 = first raise, ...; deeper levels reuse the last list.
    pub bet_sizes: Vec<Vec<[i32; 2]>>,
    pub max_raises: u8,
    /// Offer all-in at every aggression; otherwise only when a size needs it or the stack is at most the pot.
    pub allin_always: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub bets: [i32; MAX_PLAYERS],
    pub stacks: [i32; MAX_PLAYERS],
    pub folded: u8,
    pub allin: u8,
    /// Players who still have to act before the street closes.
    pub pending: u8,
    pub to_act: usize,
    pub raises: u8,
    /// Players who may not raise: they acted before an incomplete all-in raise.
    pub raise_closed: u8,
    /// Increment of the last full bet or raise; an all-in raise below it is incomplete.
    pub last_full: i32,
}

/// Rounds half up, as dcfr-solver's `compute_bet_amount`.
fn sized(size: [i32; 2], pot: i32) -> i64 {
    let [n, d] = size;
    (pot as i64 * n as i64 + d as i64 / 2) / d as i64
}

impl State {
    pub fn root(rules: &Rules) -> State {
        let all = (1u8 << rules.players) - 1;
        let allin = (0..rules.players).filter(|&q| rules.stacks[q] == 0).fold(0u8, |mask, q| mask | (1 << q));
        let pending = all & !allin;
        let to_act = (0..rules.players).find(|&q| pending & (1 << q) != 0).unwrap_or(0);
        State { bets: [0; MAX_PLAYERS], stacks: rules.stacks, folded: 0, allin, pending, to_act, raises: 0, raise_closed: 0, last_full: 0 }
    }

    fn max_bet(&self) -> i32 {
        *self.bets.iter().max().unwrap()
    }

    fn current_pot(&self, rules: &Rules) -> i32 {
        rules.pot + self.bets.iter().sum::<i32>()
    }

    fn active(&self, rules: &Rules) -> u8 {
        ((1u8 << rules.players) - 1) & !self.folded
    }

    /// True once the street has ended: one player left, or nobody left to act.
    pub fn is_terminal(&self, rules: &Rules) -> bool {
        self.active(rules).count_ones() <= 1 || self.pending == 0
    }

    fn sizes(rules: &Rules, depth: u8) -> &[[i32; 2]] {
        let depth = (depth as usize).min(rules.bet_sizes.len() - 1);
        &rules.bet_sizes[depth]
    }

    pub fn actions(&self, rules: &Rules) -> Vec<Action> {
        let p = self.to_act;
        let stack = self.stacks[p];
        let to_call = self.max_bet() - self.bets[p];
        let pot = self.current_pot(rules);
        // Raising only matters if someone else could still put chips in.
        let others_can_act = (self.active(rules) & !self.allin & !(1 << p)) != 0;
        let mut actions = Vec::new();
        if to_call > 0 {
            actions.push(Action::Fold);
            if to_call >= stack {
                actions.push(Action::AllIn);
                return actions;
            }
            actions.push(Action::Call);
        } else {
            actions.push(Action::Check);
        }
        if self.raises >= rules.max_raises || !others_can_act || self.raise_closed & (1 << p) != 0 {
            return actions;
        }
        let basis = if to_call > 0 { pot + to_call } else { pot };
        let mut needs_allin = false;
        for &size in Self::sizes(rules, self.raises) {
            let amount = sized(size, basis);
            let chips = if to_call > 0 { amount + to_call as i64 } else { amount };
            if chips >= stack as i64 {
                needs_allin = true;
                continue;
            }
            // dcfr-solver's minimum: a raise increment of at least the bet faced minus one chip.
            if amount < 1 || (to_call > 0 && amount < (self.max_bet() - 1) as i64) {
                continue;
            }
            if !actions.contains(&Action::Bet(size)) {
                actions.push(Action::Bet(size));
            }
        }
        if stack > to_call && (needs_allin || rules.allin_always || stack <= pot) {
            actions.push(Action::AllIn);
        }
        actions
    }

    pub fn apply(&self, rules: &Rules, action: Action) -> State {
        let mut s = self.clone();
        let p = s.to_act;
        let bit = 1u8 << p;
        let max_bet = s.max_bet();
        let to_call = max_bet - s.bets[p];
        let put = match action {
            Action::Fold => {
                s.folded |= bit;
                0
            }
            Action::Check => 0,
            Action::Call => to_call.min(s.stacks[p]),
            Action::AllIn => s.stacks[p],
            Action::Bet(size) => {
                let pot = s.current_pot(rules);
                let chips = if to_call > 0 { sized(size, pot + to_call) + to_call as i64 } else { sized(size, pot) };
                chips.min(s.stacks[p] as i64) as i32
            }
        };
        s.stacks[p] -= put;
        s.bets[p] += put;
        if s.stacks[p] == 0 && action != Action::Fold {
            s.allin |= bit;
        }
        let already_acted = s.active(rules) & !s.allin & !s.pending & !bit;
        s.pending &= !bit;
        if s.bets[p] > max_bet {
            s.raises += 1;
            // Tree sizes satisfy the minimum raise up to a chip of rounding, so only an all-in can be incomplete.
            // Like the UI, each all-in is judged on its own: several short all-ins never add up to a reopening raise.
            let increment = s.bets[p] - max_bet;
            if matches!(action, Action::Bet(_)) || increment >= s.last_full {
                s.last_full = increment;
                s.raise_closed = 0;
            } else {
                s.raise_closed |= already_acted;
            }
            s.pending = s.active(rules) & !s.allin & !bit;
        }
        if s.pending != 0 {
            s.to_act = (1..=rules.players).map(|step| (p + step) % rules.players).find(|&q| s.pending & (1 << q) != 0).unwrap();
        }
        s
    }
}

/// One slice of the pot and the players who can win it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layer {
    pub amount: f64,
    pub eligible: u8,
}

/// The street-start layers (restricted to players still in) plus this street's main and side pots by commitment.
/// Folded chips stay in; chips nobody else matched return to their owner through the top layer.
pub fn pot_layers(rules: &Rules, state: &State) -> Vec<Layer> {
    let active = state.active(rules);
    let mut layers: Vec<Layer> = Vec::new();
    for layer in rules.start_layers.iter().filter(|layer| layer.amount > 0.0) {
        // A side pot whose players all folded goes to the layer below; the main pot always has someone left.
        let live = layer.eligible & active;
        match layers.last_mut() {
            Some(below) if live == 0 => below.amount += layer.amount,
            _ => layers.push(Layer { amount: layer.amount, eligible: if live != 0 { live } else { active } }),
        }
    }
    let mut levels: Vec<i32> = (0..rules.players).filter(|&q| active & (1 << q) != 0 && state.bets[q] > 0).map(|q| state.bets[q]).collect();
    levels.sort_unstable();
    levels.dedup();
    let mut previous = 0;
    for (index, &level) in levels.iter().enumerate() {
        let mut amount: i64 = (0..rules.players).map(|q| (state.bets[q].min(level) - state.bets[q].min(previous)) as i64).sum();
        if index + 1 == levels.len() {
            amount += (0..rules.players).map(|q| (state.bets[q] - state.bets[q].min(level)) as i64).sum::<i64>();
        }
        let eligible = (0..rules.players).filter(|&q| active & (1 << q) != 0 && state.bets[q] >= level).fold(0u8, |mask, q| mask | (1 << q));
        if amount > 0 {
            layers.push(Layer { amount: amount as f64, eligible });
        }
        previous = level;
    }
    layers
}

pub enum Node {
    Decision { player: usize, actions: Vec<Action>, children: Vec<u32>, /// Offset into the acting player's storage.
        offset: usize },
    Terminal { layers: Vec<Layer>, /// Street chips each player put in.
        invested: [f64; MAX_PLAYERS] },
}

pub struct Tree {
    pub nodes: Vec<Node>,
    /// Decision slots (actions x live combos) per player; sizes each player's regret storage.
    pub slots: [usize; MAX_PLAYERS],
}

#[derive(Debug)]
pub struct TooLarge;

/// Rough heap cost of one node (enum, action/child/layer vectors) in decision slots, so the cap also bounds the tree.
pub const NODE_SLOT_EQUIVALENT: usize = 16;

impl Tree {
    /// Builds the tree depth first; `live[p]` is the number of combos player `p` can hold.
    pub fn build(rules: &Rules, live: [usize; MAX_PLAYERS], max_nodes: usize, max_slots: usize) -> Result<Tree, TooLarge> {
        let mut tree = Tree { nodes: Vec::new(), slots: [0; MAX_PLAYERS] };
        tree.grow(rules, &State::root(rules), live, max_nodes, max_slots)?;
        Ok(tree)
    }

    fn grow(&mut self, rules: &Rules, state: &State, live: [usize; MAX_PLAYERS], max_nodes: usize, max_slots: usize) -> Result<u32, TooLarge> {
        if self.nodes.len() >= max_nodes {
            return Err(TooLarge);
        }
        let id = self.nodes.len() as u32;
        if state.is_terminal(rules) {
            let invested = std::array::from_fn(|q| state.bets[q] as f64);
            self.nodes.push(Node::Terminal { layers: pot_layers(rules, state), invested });
            return Ok(id);
        }
        let player = state.to_act;
        let actions = state.actions(rules);
        let offset = self.slots[player];
        self.slots[player] += actions.len() * live[player];
        if self.slots.iter().sum::<usize>() + self.nodes.len() * NODE_SLOT_EQUIVALENT > max_slots {
            return Err(TooLarge);
        }
        self.nodes.push(Node::Decision { player, actions: actions.clone(), children: Vec::new(), offset });
        let mut children = Vec::with_capacity(actions.len());
        for &action in &actions {
            children.push(self.grow(rules, &state.apply(rules, action), live, max_nodes, max_slots)?);
        }
        if let Node::Decision { children: slot, .. } = &mut self.nodes[id as usize] {
            *slot = children;
        }
        Ok(id)
    }

    /// Follows `history` from the root; returns the node id and the states along the way.
    pub fn walk(&self, history: &[Action]) -> Option<(u32, Vec<(u32, usize)>)> {
        let mut id = 0u32;
        let mut path = Vec::new();
        for action in history {
            match &self.nodes[id as usize] {
                Node::Decision { actions, children, .. } => {
                    let index = actions.iter().position(|candidate| candidate == action)?;
                    path.push((id, index));
                    id = children[index];
                }
                Node::Terminal { .. } => return None,
            }
        }
        Some((id, path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(players: usize, stacks: [i32; 3]) -> Rules {
        let all = (1u8 << players) - 1;
        Rules { players, pot: 300, start_layers: vec![Layer { amount: 300.0, eligible: all }], stacks, bet_sizes: vec![vec![[1, 2]], vec![[3, 5]]], max_raises: 2, allin_always: false }
    }

    fn play(rules: &Rules, actions: &[Action]) -> State {
        actions.iter().fold(State::root(rules), |state, &action| {
            assert!(state.actions(rules).contains(&action), "{action} not legal in {state:?}");
            state.apply(rules, action)
        })
    }

    #[test]
    fn checks_around_close_the_street() {
        let r = rules(3, [1000; 3]);
        let s = play(&r, &[Action::Check, Action::Check]);
        assert!(!s.is_terminal(&r));
        assert_eq!(s.to_act, 2);
        let s = s.apply(&r, Action::Check);
        assert!(s.is_terminal(&r));
        assert_eq!(pot_layers(&r, &s), vec![Layer { amount: 300.0, eligible: 0b111 }]);
    }

    #[test]
    fn a_bet_reopens_action_for_players_who_checked() {
        let r = rules(3, [1000; 3]);
        let s = play(&r, &[Action::Check, Action::Bet([1, 2])]);
        assert_eq!(s.bets, [0, 150, 0]);
        assert_eq!(s.to_act, 2);
        assert_eq!(s.pending, 0b101);
        let s = play(&r, &[Action::Check, Action::Bet([1, 2]), Action::Call, Action::Fold]);
        assert!(s.is_terminal(&r));
        assert_eq!(pot_layers(&r, &s), vec![Layer { amount: 300.0, eligible: 0b110 }, Layer { amount: 300.0, eligible: 0b110 }]);
    }

    #[test]
    fn raise_sizes_from_the_pot_after_calling() {
        let r = rules(3, [5000; 3]);
        // pot 300 + bet 150 = 450, call 150 -> 600; raise 3/5 * 600 = 360 over 150 -> 510 total.
        let s = play(&r, &[Action::Bet([1, 2]), Action::Bet([3, 5])]);
        assert_eq!(s.bets, [150, 510, 0]);
        assert_eq!(s.raises, 2);
        assert_eq!(s.actions(&r), vec![Action::Fold, Action::Call]);
    }

    #[test]
    fn everyone_folding_to_a_bet_returns_the_uncalled_chips() {
        let r = rules(3, [1000; 3]);
        let s = play(&r, &[Action::Bet([1, 2]), Action::Fold, Action::Fold]);
        assert!(s.is_terminal(&r));
        assert_eq!(pot_layers(&r, &s), vec![Layer { amount: 300.0, eligible: 0b001 }, Layer { amount: 150.0, eligible: 0b001 }]);
    }

    #[test]
    fn short_all_in_builds_side_pots() {
        // Player 2 is short; 0 bets, 1 raises all-in, 2 calls all-in for less, 0 calls off the rest (all-in).
        let r = Rules { allin_always: true, ..rules(3, [2000, 2000, 400]) };
        let s = play(&r, &[Action::Bet([1, 2]), Action::AllIn, Action::AllIn, Action::AllIn]);
        assert!(s.is_terminal(&r));
        assert_eq!(s.bets, [2000, 2000, 400]);
        let layers = pot_layers(&r, &s);
        assert_eq!(layers, vec![Layer { amount: 300.0, eligible: 0b111 }, Layer { amount: 1200.0, eligible: 0b111 }, Layer { amount: 3200.0, eligible: 0b011 }]);
        let total: f64 = layers.iter().map(|layer| layer.amount).sum();
        assert_eq!(total, 300.0 + 4400.0);
    }

    #[test]
    fn call_for_less_does_not_reopen_and_nobody_raises_into_all_ins() {
        let r = Rules { allin_always: true, ..rules(3, [3000, 500, 500]) };
        let s = play(&r, &[Action::AllIn]);
        assert_eq!(s.actions(&r), vec![Action::Fold, Action::AllIn]);
        let s = play(&r, &[Action::AllIn, Action::AllIn, Action::AllIn]);
        assert!(s.is_terminal(&r));
        // 0 put 3000 but only 500 can be called: 2500 goes back through the top layer.
        let layers = pot_layers(&r, &s);
        assert_eq!(layers, vec![Layer { amount: 300.0, eligible: 0b111 }, Layer { amount: 1500.0, eligible: 0b111 }, Layer { amount: 2500.0, eligible: 0b001 }]);
    }

    #[test]
    fn incomplete_all_in_raise_does_not_reopen_raising() {
        // 0 bets 150, 1 calls, 2 shoves 200: a 50 raise is below the 150 bet, so 0 and 1 may only call or fold.
        let r = Rules { allin_always: true, max_raises: 3, ..rules(3, [3000, 3000, 200]) };
        let s = play(&r, &[Action::Bet([1, 2]), Action::Call, Action::AllIn]);
        assert_eq!(s.to_act, 0);
        assert_eq!(s.actions(&r), vec![Action::Fold, Action::Call]);
        // A shove that is a full raise (450 over 150) reopens it.
        let r = Rules { allin_always: true, max_raises: 3, ..rules(3, [3000, 3000, 600]) };
        let s = play(&r, &[Action::Bet([1, 2]), Action::Call, Action::AllIn]);
        assert!(s.actions(&r).contains(&Action::AllIn));
        assert!(s.actions(&r).len() > 2);
    }

    #[test]
    fn earlier_all_in_player_only_contests_the_layers_they_are_in() {
        // Player 2 went all-in earlier: 200 main pot for everyone, 100 side pot for 0 and 1.
        let r = Rules { pot: 300, start_layers: vec![Layer { amount: 200.0, eligible: 0b111 }, Layer { amount: 100.0, eligible: 0b011 }], ..rules(3, [1000, 1000, 0]) };
        let root = State::root(&r);
        assert_eq!(root.allin, 0b100);
        assert_eq!(root.pending, 0b011);
        let s = play(&r, &[Action::Bet([1, 2]), Action::Call]);
        assert!(s.is_terminal(&r));
        assert_eq!(pot_layers(&r, &s), vec![Layer { amount: 200.0, eligible: 0b111 }, Layer { amount: 100.0, eligible: 0b011 }, Layer { amount: 300.0, eligible: 0b011 }]);
        let s = play(&r, &[Action::Bet([1, 2]), Action::Fold]);
        assert_eq!(pot_layers(&r, &s), vec![Layer { amount: 200.0, eligible: 0b101 }, Layer { amount: 100.0, eligible: 0b001 }, Layer { amount: 150.0, eligible: 0b001 }]);
    }

    #[test]
    fn heads_up_matches_two_player_rules() {
        let r = rules(2, [1000, 1000, 0]);
        let s = play(&r, &[Action::Check, Action::Check]);
        assert!(s.is_terminal(&r));
        let s = play(&r, &[Action::Bet([1, 2]), Action::Call]);
        assert!(s.is_terminal(&r));
        assert_eq!(pot_layers(&r, &s), vec![Layer { amount: 300.0, eligible: 0b11 }, Layer { amount: 300.0, eligible: 0b11 }]);
    }

    #[test]
    fn tree_walk_finds_history_nodes_and_rejects_missing_ones() {
        let r = rules(3, [1000; 3]);
        let tree = Tree::build(&r, [10; 3], 100_000, usize::MAX).unwrap();
        let (id, path) = tree.walk(&[Action::Check, Action::Bet([1, 2])]).unwrap();
        assert_eq!(path.len(), 2);
        assert!(matches!(tree.nodes[id as usize], Node::Decision { player: 2, .. }));
        assert!(tree.walk(&[Action::Bet([2, 3])]).is_none());
        assert!(Tree::build(&r, [10; 3], 5, usize::MAX).is_err());
    }
}
