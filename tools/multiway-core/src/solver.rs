//! Vector-form DCFR over full ranges for 2-3 players on the river, with alternating updates.
//!
//! Values are counterfactual: weighted by the opponents' reach, not the traverser's. Utilities are net chips
//! relative to the street-start stacks, as in dcfr-solver, so a per-combo EV is the value divided by the compatible
//! opponent reach.

use dcfr_solver::card::{Hand, NUM_COMBOS};

use crate::game::{Node, Rules, Tree, TooLarge};
use crate::showdown::{values, Board, Coeffs};

/// DCFR discounting (Brown & Sandholm 2019): positive regrets t^1.5/(t^1.5+1), negative 1/2, strategy (t/(t+1))^2.
const ALPHA: f64 = 1.5;
const GAMMA: f64 = 2.0;

pub struct Solver {
    pub rules: Rules,
    pub board: Board,
    pub tree: Tree,
    /// Street-start range per player over all 1326 combos (board-blocked combos are zero).
    pub ranges: Vec<Vec<f64>>,
    /// Combos each player can hold, ordered by strength; values and regrets are indexed by position here.
    pub combos: Vec<Vec<u16>>,
    regrets: Vec<Vec<f64>>,
    strategy_sums: Vec<Vec<f64>>,
    pub iterations: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Average,
    BestResponse,
}

fn regret_matching(regrets: &[f64], out: &mut [f64]) {
    let positive: f64 = regrets.iter().map(|regret| regret.max(0.0)).sum();
    if positive > 0.0 {
        for (slot, regret) in out.iter_mut().zip(regrets) {
            *slot = regret.max(0.0) / positive;
        }
    } else {
        out.fill(1.0 / out.len() as f64);
    }
}

impl Solver {
    pub fn new(rules: Rules, board_cards: Hand, ranges: Vec<Vec<f64>>, max_nodes: usize, max_slots: usize) -> Result<Solver, TooLarge> {
        let board = Board::new(board_cards);
        let combos: Vec<Vec<u16>> = ranges.iter().map(|range| {
            let held: Vec<u16> = (0..NUM_COMBOS as u16).filter(|&combo| range[combo as usize] > 0.0).collect();
            board.sort_by_strength(&held)
        }).collect();
        let ranges: Vec<Vec<f64>> = ranges.iter().zip(&combos).map(|(range, held)| {
            let mut live = vec![0.0; NUM_COMBOS];
            for &combo in held {
                live[combo as usize] = range[combo as usize];
            }
            live
        }).collect();
        let live = std::array::from_fn(|player| combos.get(player).map_or(0, Vec::len));
        let tree = Tree::build(&rules, live, max_nodes, max_slots)?;
        let regrets: Vec<Vec<f64>> = (0..rules.players).map(|player| vec![0.0; tree.slots[player]]).collect();
        let strategy_sums = regrets.clone();
        Ok(Solver { rules, board, tree, ranges, combos, regrets, strategy_sums, iterations: 0 })
    }

    pub fn slots(&self) -> usize {
        self.tree.slots.iter().sum()
    }

    fn opponents(&self, player: usize) -> Vec<usize> {
        (0..self.rules.players).filter(|&other| other != player).collect()
    }

    /// Hero's value coefficients at a terminal: pot layers Hero can win and the chips Hero put in.
    fn coeffs(&self, node: &Node, player: usize) -> Coeffs {
        let Node::Terminal { layers, invested } = node else { unreachable!() };
        let opponents = self.opponents(player);
        let mut coeffs = Coeffs { z: -invested[player], ..Default::default() };
        for layer in layers {
            if layer.eligible & (1 << player) == 0 {
                continue;
            }
            let others: Vec<usize> = opponents.iter().copied().filter(|&other| layer.eligible & (1 << other) != 0).collect();
            match others.as_slice() {
                [] => coeffs.z += layer.amount,
                [other] => coeffs.head[opponents.iter().position(|o| o == other).unwrap()] += layer.amount,
                _ => coeffs.all += layer.amount,
            }
        }
        coeffs
    }

    fn terminal(&self, id: u32, player: usize, reach: &[Vec<f64>]) -> Vec<f64> {
        let coeffs = self.coeffs(&self.tree.nodes[id as usize], player);
        let opponents: Vec<&[f64]> = self.opponents(player).iter().map(|&other| reach[other].as_slice()).collect();
        values(&self.board, &self.combos[player], &opponents, &coeffs)
    }

    /// Compatible opponent reach per combo of `player`: the divisor that turns values into per-combo EV.
    pub fn opponent_mass(&self, player: usize, reach: &[Vec<f64>]) -> Vec<f64> {
        let opponents: Vec<&[f64]> = self.opponents(player).iter().map(|&other| reach[other].as_slice()).collect();
        values(&self.board, &self.combos[player], &opponents, &Coeffs { z: 1.0, ..Default::default() })
    }

    fn current_strategy(&self, player: usize, offset: usize, actions: usize) -> Vec<f64> {
        let held = self.combos[player].len();
        let mut strategy = vec![0.0; held * actions];
        for local in 0..held {
            let at = offset + local * actions;
            regret_matching(&self.regrets[player][at..at + actions], &mut strategy[local * actions..(local + 1) * actions]);
        }
        strategy
    }

    pub fn average_strategy(&self, player: usize, offset: usize, actions: usize) -> Vec<f64> {
        let held = self.combos[player].len();
        let mut strategy = vec![0.0; held * actions];
        for local in 0..held {
            let at = offset + local * actions;
            let sums = &self.strategy_sums[player][at..at + actions];
            let total: f64 = sums.iter().sum();
            for (action, slot) in strategy[local * actions..(local + 1) * actions].iter_mut().enumerate() {
                *slot = if total > 0.0 { sums[action] / total } else { 1.0 / actions as f64 };
            }
        }
        strategy
    }

    /// Reach after `player` takes action `index` with `strategy`.
    fn narrowed(&self, reach: &[Vec<f64>], player: usize, strategy: &[f64], actions: usize, index: usize) -> Vec<Vec<f64>> {
        let mut next = reach.to_vec();
        for (local, &combo) in self.combos[player].iter().enumerate() {
            next[player][combo as usize] *= strategy[local * actions + index];
        }
        next
    }

    fn train(&mut self, id: u32, player: usize, reach: &[Vec<f64>]) -> Vec<f64> {
        let (actor, actions, children, offset) = match &self.tree.nodes[id as usize] {
            Node::Terminal { .. } => return self.terminal(id, player, reach),
            Node::Decision { player: actor, actions, children, offset } => (*actor, actions.len(), children.clone(), *offset),
        };
        let held = self.combos[player].len();
        let strategy = self.current_strategy(actor, offset, actions);
        if actor != player {
            let mut total = vec![0.0; held];
            for (index, &child) in children.iter().enumerate() {
                let next = self.narrowed(reach, actor, &strategy, actions, index);
                if next[actor].iter().all(|&weight| weight == 0.0) {
                    continue;
                }
                for (sum, value) in total.iter_mut().zip(self.train(child, player, &next)) {
                    *sum += value;
                }
            }
            return total;
        }
        // The traverser's own reach does not change values, but it weights the average strategy below.
        let mut child_values = Vec::with_capacity(actions);
        for (index, &child) in children.iter().enumerate() {
            let next = self.narrowed(reach, player, &strategy, actions, index);
            child_values.push(self.train(child, player, &next));
        }
        let mut node_value = vec![0.0; held];
        for local in 0..held {
            node_value[local] = (0..actions).map(|index| strategy[local * actions + index] * child_values[index][local]).sum();
        }
        for (local, &combo) in self.combos[player].iter().enumerate() {
            let own = reach[player][combo as usize];
            let at = offset + local * actions;
            for index in 0..actions {
                self.regrets[player][at + index] += child_values[index][local] - node_value[local];
                self.strategy_sums[player][at + index] += own * strategy[local * actions + index];
            }
        }
        node_value
    }

    fn discount(&mut self, player: usize) {
        let t = f64::from(self.iterations);
        let positive = t.powf(ALPHA) / (t.powf(ALPHA) + 1.0);
        let strategy = (t / (t + 1.0)).powf(GAMMA);
        for regret in &mut self.regrets[player] {
            *regret *= if *regret > 0.0 { positive } else { 0.5 };
        }
        for sum in &mut self.strategy_sums[player] {
            *sum *= strategy;
        }
    }

    /// One DCFR iteration: each player in turn updates against the others' current strategies.
    pub fn iterate(&mut self) {
        self.iterations += 1;
        for player in 0..self.rules.players {
            let reach = self.ranges.clone();
            self.train(0, player, &reach);
            self.discount(player);
        }
    }

    /// Value of `player` at `id` when everyone plays the average strategy, or `player` best-responds.
    fn evaluate(&self, id: u32, player: usize, reach: &[Vec<f64>], mode: Mode) -> Vec<f64> {
        let (actor, actions, children, offset) = match &self.tree.nodes[id as usize] {
            Node::Terminal { .. } => return self.terminal(id, player, reach),
            Node::Decision { player: actor, actions, children, offset } => (*actor, actions.len(), children, *offset),
        };
        let held = self.combos[player].len();
        let strategy = self.average_strategy(actor, offset, actions);
        if actor != player {
            let mut total = vec![0.0; held];
            for (index, &child) in children.iter().enumerate() {
                let next = self.narrowed(reach, actor, &strategy, actions, index);
                if next[actor].iter().all(|&weight| weight == 0.0) {
                    continue;
                }
                for (sum, value) in total.iter_mut().zip(self.evaluate(child, player, &next, mode)) {
                    *sum += value;
                }
            }
            return total;
        }
        let child_values: Vec<Vec<f64>> = children.iter().map(|&child| self.evaluate(child, player, reach, mode)).collect();
        (0..held).map(|local| match mode {
            Mode::Average => (0..actions).map(|index| strategy[local * actions + index] * child_values[index][local]).sum(),
            Mode::BestResponse => child_values.iter().map(|values| values[local]).fold(f64::NEG_INFINITY, f64::max),
        }).collect()
    }

    /// Per player, chips a best response gains over the average strategy, per unit of compatible range mass.
    pub fn best_response_gains(&self) -> Vec<f64> {
        (0..self.rules.players).map(|player| {
            let reach = &self.ranges;
            let average = self.evaluate(0, player, reach, Mode::Average);
            let best = self.evaluate(0, player, reach, Mode::BestResponse);
            let mass = self.opponent_mass(player, reach);
            let mut gain = 0.0;
            let mut weight = 0.0;
            for (local, &combo) in self.combos[player].iter().enumerate() {
                let own = reach[player][combo as usize];
                gain += own * (best[local] - average[local]);
                weight += own * mass[local];
            }
            if weight > 0.0 { gain / weight } else { 0.0 }
        }).collect()
    }

    /// Reach of every player at the end of `history` under the average strategies.
    pub fn reach_at(&self, path: &[(u32, usize)]) -> Vec<Vec<f64>> {
        let mut reach = self.ranges.clone();
        for &(id, index) in path {
            let Node::Decision { player, actions, offset, .. } = &self.tree.nodes[id as usize] else { unreachable!() };
            let strategy = self.average_strategy(*player, *offset, actions.len());
            reach = self.narrowed(&reach, *player, &strategy, actions.len(), index);
        }
        reach
    }

    /// Counterfactual value of each action at decision node `id` for its acting player, under average strategies.
    pub fn action_values(&self, id: u32, reach: &[Vec<f64>]) -> Vec<Vec<f64>> {
        let Node::Decision { player, children, .. } = &self.tree.nodes[id as usize] else { unreachable!() };
        children.iter().map(|&child| self.evaluate(child, *player, reach, Mode::Average)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dcfr_solver::card::parse_cards;
    use dcfr_solver::range::Range;

    fn board(text: &str) -> Hand {
        parse_cards(text).unwrap().into_iter().fold(Hand::new(), |hand, card| hand.add(card))
    }

    fn range(text: &str) -> Vec<f64> {
        Range::parse(text).unwrap().weights.iter().map(|&weight| f64::from(weight)).collect()
    }

    fn rules(players: usize, stacks: [i32; 3]) -> Rules {
        let start_layers = vec![crate::game::Layer { amount: 1000.0, eligible: (1u8 << players) - 1 }];
        Rules { players, pot: 1000, start_layers, stacks, bet_sizes: vec![vec![[1, 2]], vec![[3, 5]]], max_raises: 2, allin_always: false }
    }

    /// Expected net chips of each player under the average strategies, per unit of compatible deal mass.
    fn expected_values(solver: &Solver) -> Vec<f64> {
        (0..solver.rules.players).map(|player| {
            let values = solver.evaluate(0, player, &solver.ranges, Mode::Average);
            let mass = solver.opponent_mass(player, &solver.ranges);
            let own: Vec<f64> = solver.combos[player].iter().map(|&combo| solver.ranges[player][combo as usize]).collect();
            let total: f64 = own.iter().zip(&values).map(|(weight, value)| weight * value).sum();
            let deals: f64 = own.iter().zip(&mass).map(|(weight, mass)| weight * mass).sum();
            total / deals
        }).collect()
    }

    const SPOT: [&str; 3] = ["AA,KK,QQ,AKs,AKo,AQs,AQo,KQs,KQo,JJ,TT,99,AJs,KJs,QJs", "AKs,AKo,AQs,AQo,KQs,KQo,JJ,TT,99,88,JTs,T9s,98s,A5s", "QQ,JJ,AQs,AQo,KQs,KQo,QJs,QJo,JTs,JTo,T9s,A4s,K9s"];

    #[test]
    fn three_way_payoffs_sum_to_the_pot() {
        let ranges: Vec<Vec<f64>> = SPOT.iter().map(|text| range(text)).collect();
        let mut solver = Solver::new(rules(3, [3000, 2500, 4000]), board("Kd9h5c2s7d"), ranges, 100_000, usize::MAX).unwrap();
        for _ in 0..30 {
            solver.iterate();
        }
        let values = expected_values(&solver);
        let total: f64 = values.iter().sum();
        assert!((total - 1000.0).abs() < 1e-6, "{values:?} sums to {total}");
    }

    #[test]
    fn earlier_all_in_player_payoffs_still_sum_to_the_pot() {
        // Player 2 is all-in from an earlier street: 600 main pot for everyone, 400 side pot for players 0 and 1.
        let ranges: Vec<Vec<f64>> = SPOT.iter().map(|text| range(text)).collect();
        let start_layers = vec![crate::game::Layer { amount: 600.0, eligible: 0b111 }, crate::game::Layer { amount: 400.0, eligible: 0b011 }];
        let rules = Rules { start_layers, ..rules(3, [3000, 2500, 0]) };
        let mut solver = Solver::new(rules, board("Kd9h5c2s7d"), ranges, 100_000, usize::MAX).unwrap();
        for _ in 0..30 {
            solver.iterate();
        }
        let values = expected_values(&solver);
        assert!((values.iter().sum::<f64>() - 1000.0).abs() < 1e-6, "{values:?}");
        // Player 2 can only win the main pot.
        assert!(values[2] < 600.0 && values[2] > 0.0, "{values:?}");
    }

    #[test]
    fn three_way_best_response_gain_shrinks() {
        let ranges: Vec<Vec<f64>> = SPOT.iter().map(|text| range(text)).collect();
        let mut solver = Solver::new(rules(3, [3000, 3000, 3000]), board("Kd9h5c2s7d"), ranges, 100_000, usize::MAX).unwrap();
        solver.iterate();
        let early = solver.best_response_gains().iter().copied().fold(0.0, f64::max);
        for _ in 0..300 {
            solver.iterate();
        }
        let late = solver.best_response_gains();
        let worst = late.iter().copied().fold(0.0, f64::max);
        assert!(late.iter().all(|&gain| gain >= -1e-9), "{late:?}");
        assert!(worst < early / 5.0 && worst / 1000.0 < 0.01, "early {early}, late {late:?}");
    }

    #[test]
    fn heads_up_matches_dcfr_core() {
        let oop = "AA,KK,QQ,JJ,TT,AKs,AKo,AQs,AQo,KQs,KQo,AJs,KJs,QJs,JTs,T9s,98s";
        let ip = "QQ,JJ,TT,99,88,AQs,AQo,AJs,AJo,KQs,KQo,KJs,KJo,QJs,QJo,JTs,T9s,A5s,K9s";
        let request = format!(r#"{{"board":"Qd8h5c2s3d","hero":"AhKh","oopRange":"{oop}","ipRange":"{ip}","pot":1000,"stacks":[3000,3000],"iterations":1500,"betSizes":[[[1,2]],[[3,5]]],"maxRaises":2}}"#);
        let reference: serde_json::Value = serde_json::from_str(&rangelab_dcfr_core::solve_json(&request, rangelab_dcfr_core::SolveOptions { source: "test", max_tree_bytes: 1 << 30 })).unwrap();
        let reference_evs: Vec<f64> = reference["result"]["details"].as_array().unwrap().iter().map(|detail| detail["evChips"].as_f64().unwrap()).collect();

        let mut solver = Solver::new(rules(2, [3000, 3000, 0]), board("Qd8h5c2s3d"), vec![range(oop), range(ip)], 100_000, usize::MAX).unwrap();
        for _ in 0..1500 {
            solver.iterate();
        }
        let hero = dcfr_solver::card::combo_index(parse_cards("Ah").unwrap()[0], parse_cards("Kh").unwrap()[0]);
        let local = solver.combos[0].iter().position(|&combo| combo == hero).unwrap();
        let mass = solver.opponent_mass(0, &solver.ranges)[local];
        let evs: Vec<f64> = solver.action_values(0, &solver.ranges).iter().map(|values| values[local] / mass).collect();
        assert_eq!(evs.len(), reference_evs.len());
        for (ours, theirs) in evs.iter().zip(&reference_evs) {
            // Separate solvers stop at slightly different strategies; 1% of the pot is far below any action gap
            // that matters and far above float noise.
            assert!((ours - theirs).abs() < 10.0, "ours {evs:?} vs dcfr-core {reference_evs:?}");
        }
        let gains = solver.best_response_gains();
        assert!(gains.iter().all(|gain| gain / 1000.0 < 0.005), "{gains:?}");

        // A deeper node exercises reach narrowing and the reach-weighted average strategy: IP facing a half-pot bet.
        let deep = request.replace(r#""hero":"AhKh""#, r#""hero":"QhJh""#).replace(r#""maxRaises":2}"#, r#""maxRaises":2,"history":[{"action":"bet","size":[1,2]}]}"#);
        let reference: serde_json::Value = serde_json::from_str(&rangelab_dcfr_core::solve_json(&deep, rangelab_dcfr_core::SolveOptions { source: "test", max_tree_bytes: 1 << 30 })).unwrap();
        let details = reference["result"]["details"].as_array().unwrap_or_else(|| panic!("{reference}"));
        let (node, path) = solver.tree.walk(&[crate::game::Action::Bet([1, 2])]).unwrap();
        let reach = solver.reach_at(&path);
        let hero = dcfr_solver::card::combo_index(parse_cards("Qh").unwrap()[0], parse_cards("Jh").unwrap()[0]);
        let local = solver.combos[1].iter().position(|&combo| combo == hero).unwrap();
        let mass = solver.opponent_mass(1, &reach)[local];
        let evs: Vec<f64> = solver.action_values(node, &reach).iter().map(|values| values[local] / mass).collect();
        let Node::Decision { offset, actions, .. } = &solver.tree.nodes[node as usize] else { unreachable!() };
        let average = solver.average_strategy(1, *offset, actions.len());
        assert_eq!(evs.len(), details.len());
        for (index, detail) in details.iter().enumerate() {
            assert!((evs[index] - detail["evChips"].as_f64().unwrap()).abs() < 10.0, "ours {evs:?} vs dcfr-core {details:?}");
            assert!((average[local * actions.len() + index] - detail["frequency"].as_f64().unwrap()).abs() < 0.15, "ours {average:?} vs dcfr-core {details:?}");
        }
    }
}
