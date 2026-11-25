//! Memory estimate for a subgame, computed before dcfr-solver allocates anything.

use dcfr_solver::card::{combo_from_index, NUM_COMBOS};
use dcfr_solver::game::{GameState, NodeType};
use dcfr_solver::iso::canonical_next_cards;

use crate::request::SolveRequest;
use crate::solve::bet_config;

/// Per (live combo, action) slot: an i16 regret plus an f32 cumulative strategy.
const BYTES_PER_SLOT: u64 = 2 + 4;
/// Fixed cost per tree node (TreeNode, CfrData, child and permutation vectors). Measured 205-243 B with
/// examples/calibrate.rs across wide and two-combo ranges; rounded up for margin.
const BYTES_PER_TREE_NODE: u64 = 320;
/// Showdown cache and other per-solve allocations (measured up to ~4 MB).
const FIXED_BYTES: u64 = 32 * 1024 * 1024;
/// Hard bound on nodes walked, independent of ranges, so rejecting a huge tree stays cheap.
pub const MAX_TREE_NODES: u64 = 3_000_000;

pub struct TreeEstimate {
    pub decision_nodes: u64,
    /// Decision, chance, and terminal nodes.
    pub tree_nodes: u64,
    pub action_slots: u64,
    pub live_combos: u64,
    pub bytes: u64,
}

/// Counts nodes and actions the way dcfr-solver builds the tree (chance nodes expand canonical cards only, as with
/// `use_iso: true`), stopping as soon as the byte budget or the node bound is exceeded.
struct Walk { decision_nodes: u64, tree_nodes: u64, slots: u64, live: u64, max_bytes: u64 }

impl Walk {
    fn bytes(&self) -> u64 {
        self.slots.saturating_mul(self.live).saturating_mul(BYTES_PER_SLOT)
            .saturating_add(self.tree_nodes.saturating_mul(BYTES_PER_TREE_NODE))
            .saturating_add(FIXED_BYTES)
    }

    fn within_limits(&self) -> bool {
        self.tree_nodes <= MAX_TREE_NODES && self.bytes() <= self.max_bytes
    }

    fn visit(&mut self, state: &GameState) -> bool {
        self.tree_nodes += 1;
        match state.node_type() {
            NodeType::Decision(_) => {
                let actions = state.actions();
                self.decision_nodes += 1;
                self.slots += actions.len() as u64;
                self.within_limits() && actions.iter().all(|&action| self.visit(&state.apply(action)))
            }
            NodeType::Chance(_) => self.within_limits() && canonical_next_cards(state.board).iter().all(|canonical| self.visit(&state.deal_street(&[canonical.card]))),
            _ => self.within_limits(),
        }
    }
}

/// Same rule as dcfr-solver's ComboMap: a combo is live unless both ranges give it zero weight or the board blocks it.
fn live_combos(request: &SolveRequest) -> u64 {
    (0..NUM_COMBOS)
        .filter(|&combo| request.ranges.iter().any(|range| range.weights[combo] != 0.0))
        .filter(|&combo| {
            let (first, second) = combo_from_index(combo as u16);
            !request.board.contains(first) && !request.board.contains(second)
        })
        .count() as u64
}

/// Returns the estimate, or `Err(bytes_counted_so_far)` once the tree is known to exceed `max_bytes` or the node bound.
pub fn estimate(request: &SolveRequest, max_bytes: u64) -> Result<TreeEstimate, u64> {
    let mut walk = Walk { decision_nodes: 0, tree_nodes: 0, slots: 0, live: live_combos(request).max(1), max_bytes };
    let root = GameState::new_postflop_with_bets(request.street, request.pot, request.stacks, request.board, bet_config(request));
    if !walk.visit(&root) {
        return Err(walk.bytes());
    }
    Ok(TreeEstimate { decision_nodes: walk.decision_nodes, tree_nodes: walk.tree_nodes, action_slots: walk.slots, live_combos: walk.live, bytes: walk.bytes() })
}
