//! Runs a DCFR subgame solve and reports Hero's strategy and per-action EV at the requested node.

use std::collections::BTreeMap;
use std::sync::Arc;

use dcfr_solver::cfr::{DcfrMode, SubgameConfig, SubgameSolver};
use dcfr_solver::game::{Action, BetConfig, BetSize};
use serde_json::{json, Value};

use crate::request::SolveRequest;

fn subgame_config(request: &SolveRequest) -> SubgameConfig {
    let mut sizes: [Vec<Vec<BetSize>>; 4] = std::array::from_fn(|_| Vec::new());
    sizes[request.street.index()] = request.bet_sizes.clone();
    let history_has_allin = request.history.contains(&Action::AllIn);
    let bet_config = BetConfig {
        sizes,
        max_raises: request.max_raises,
        // Same collapse rule as the native adapter: only bets that need the whole stack become all-in.
        allin_threshold: 1.0,
        // Offer all-in at SPR <= 1 unless the observed history needs the all-in branch.
        allin_pot_ratio: if history_has_allin { 0.0 } else { 1.0 },
        no_donk: false,
        geometric_2bets: false,
    };
    SubgameConfig {
        board: request.board,
        pot: request.pot,
        stacks: request.stacks,
        ranges: request.ranges.clone(),
        iterations: request.iterations,
        street: request.street,
        warmup_frac: 0.0,
        bet_config: Some(Arc::new(bet_config)),
        dcfr: true,
        cfr_plus: true,
        skip_cum_strategy: false,
        dcfr_mode: DcfrMode::Standard,
        depth_limit: None,
        rake_pct: 0.0,
        rake_cap: 0.0,
        exploration_eps: 0.0,
        entropy_bonus: 0.0,
        entropy_anneal: false,
        entropy_root_only: false,
        softmax_temp: 0.0,
        current_iteration: 0,
        use_iso: true,
        opp_dilute: 0.0,
        rm_floor: 0.0,
        alternating: false,
        t_weight: false,
        frozen_root: None,
        check_bias: 0.0,
        pref_passive_delta: 1.0,
        pref_beta: 0.0,
        pref_beta_all_nodes: false,
        pruning: false,
        combo_check_bias: None,
        frozen_warmup: 0,
        unfreeze_decay: 1.0,
    }
}

/// UI category of a concrete solver action; a facing-bet node has Fold, so Bet means raise there.
fn category(action: Action, actions: &[Action]) -> &'static str {
    let facing_bet = actions.contains(&Action::Fold);
    match action {
        Action::Fold => "fold",
        Action::Check => "check",
        Action::Call => "call",
        Action::AllIn if facing_bet && !actions.contains(&Action::Call) => "call",
        Action::Bet(_) | Action::AllIn if facing_bet => "raise",
        Action::Bet(_) | Action::AllIn => "bet",
    }
}

fn best_response(action_evs: &[(Action, [f32; dcfr_solver::card::NUM_COMBOS])], hero_index: usize) -> Vec<(Action, f32)> {
    let best = action_evs.iter().enumerate()
        .max_by(|left, right| left.1 .1[hero_index].total_cmp(&right.1 .1[hero_index]))
        .map(|(index, _)| index);
    action_evs.iter().enumerate().map(|(index, (action, _))| (*action, if Some(index) == best { 1.0 } else { 0.0 })).collect()
}

/// Upper bound on progress reports per solve, so the browser worker posts at most about this many messages.
const MAX_PROGRESS_REPORTS: u32 = 100;

/// Solves the request, reporting `(completed, total)` iterations: once with 0 before the tree is built, then at
/// most MAX_PROGRESS_REPORTS more times, always ending with `(total, total)`.
pub fn solve(request: &SolveRequest, source: &str, on_progress: &mut dyn FnMut(u32, u32)) -> Result<Value, String> {
    let total = request.iterations;
    on_progress(0, total);
    let mut solver = SubgameSolver::new(subgame_config(request));
    let every = total.div_ceil(MAX_PROGRESS_REPORTS).max(1);
    solver.solve_with_report_interval(every, |done, _| on_progress(done.min(total), total));
    let history = &request.history;
    let player = solver.get_player(history).ok_or("history does not reach a decision node in the solver tree")?;
    let node_strategy = solver.get_strategy(history).ok_or("strategy is unavailable at the history node")?;
    let action_evs = solver.compute_action_evs(history, player).ok_or("action EVs are unavailable at the history node")?;
    if !request.ranges[player as usize].weights[request.hero_index].is_finite() || request.ranges[player as usize].weights[request.hero_index] <= 0.0 {
        return Err("hero combo is not in the acting player's range".into());
    }
    // The equilibrium can give Hero's combo zero reach on this line (e.g. a hand that always bets but checked);
    // its average strategy is then undefined, so report the best response by EV instead.
    let reached = node_strategy.iter().find(|(combo, _)| *combo as usize == request.hero_index).map(|(_, strategy)| strategy.clone());
    let hero_unreached = reached.is_none();
    let hero_strategy = reached.unwrap_or_else(|| best_response(&action_evs, request.hero_index));
    if action_evs.len() != hero_strategy.len() {
        return Err("strategy/action EV mismatch".into());
    }
    let actions: Vec<Action> = hero_strategy.iter().map(|(action, _)| *action).collect();
    let mut grouped: BTreeMap<&str, (f64, f64)> = BTreeMap::new();
    let mut details = Vec::new();
    for ((action, frequency), (_, evs)) in hero_strategy.iter().zip(action_evs.iter()) {
        let ev = evs[request.hero_index] as f64;
        let frequency = *frequency as f64;
        let key = category(*action, &actions);
        let entry = grouped.entry(key).or_insert((0.0, 0.0));
        entry.0 += frequency;
        entry.1 += frequency * ev;
        details.push(json!({"action": key, "label": action.to_string(), "frequency": frequency, "evChips": ev}));
    }
    let strategy: Vec<Value> = grouped.iter().map(|(action, (frequency, weighted))| {
        let ev = if *frequency > 0.0 { weighted / frequency } else { 0.0 };
        json!({"action": action, "frequency": frequency, "evChips": ev})
    }).collect();
    let best = grouped.iter()
        .max_by(|left, right| left.1 .0.total_cmp(&right.1 .0))
        .map(|(action, _)| *action)
        .unwrap_or("check");
    Ok(json!({
        "source": source,
        "player": if player == 0 { "oop" } else { "ip" },
        "strategy": strategy,
        "details": details,
        "best_action": best,
        "exploitability": solver.exploitability_pct(),
        "iterations": request.iterations,
        "heroUnreached": hero_unreached,
    }))
}
