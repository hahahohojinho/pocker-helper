//! Native multiway (2-3 player) river solver used by `rangelab-dcfr-adapter --json-multiway`.
//!
//! Takes the street-start ranges and stacks of every live player in action order and returns Hero's strategy and
//! per-action counterfactual EV at the requested node, in the same envelope as rangelab-dcfr-core. 3-player CFR has
//! no Nash guarantee, so convergence is reported as each player's best-response gain against the others' average
//! strategies (percent of the street-start pot), not as exploitability.

mod game;
mod request;
mod showdown;
mod solver;

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

pub use game::MAX_PLAYERS;
pub use request::{MultiwayRequest, MAX_REQUEST_BYTES};

use game::{Action, Node, Rules};
use solver::Solver;

/// Fewer iterations than this give strategies too noisy to act on, so the deadline never stops earlier.
pub const MIN_ITERATIONS: u32 = 3;
pub const MAX_TREE_NODES: usize = 1_000_000;
/// Storage cap for native solves (regrets, strategy sums, and node overhead).
pub const MAX_TREE_BYTES: u64 = 1024 * 1024 * 1024;
/// Regret and strategy-sum storage per decision slot (two f64).
const BYTES_PER_SLOT: u64 = 16;
const MIB: u64 = 1024 * 1024;
/** How far past the time budget the convergence pass may run; presets leave >5 s to the 10 s answer limit. */
const CONVERGENCE_SLACK: Duration = Duration::from_millis(1000);

#[derive(Clone, Copy)]
pub struct MultiwayOptions<'a> {
    pub source: &'a str,
    pub max_tree_bytes: u64,
}

/// Solves a JSON request and returns the `{"ok":...}` envelope.
pub fn solve_json(request_json: &str, options: MultiwayOptions) -> String {
    match MultiwayRequest::parse(request_json).and_then(|request| solve(&request, options)) {
        Ok(result) => json!({"ok": true, "result": result}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    }
}

/// UI category of an action; a facing-bet node has Fold, so Bet means raise there.
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

fn rules(request: &MultiwayRequest) -> Rules {
    Rules {
        players: request.ranges.len(),
        pot: request.pot,
        start_layers: request.start_layers.clone(),
        stacks: request.stacks,
        bet_sizes: request.bet_sizes.clone(),
        max_raises: request.max_raises,
        // As dcfr-core: all-in at SPR <= 1 or when a size needs it, everywhere if the observed line went all-in.
        allin_always: request.history.contains(&Action::AllIn),
    }
}

pub fn solve(request: &MultiwayRequest, options: MultiwayOptions) -> Result<Value, String> {
    let start = Instant::now();
    let max_slots = (options.max_tree_bytes / BYTES_PER_SLOT) as usize;
    let mut solver = Solver::new(rules(request), request.board, request.ranges.clone(), MAX_TREE_NODES, max_slots).map_err(|_| format!(
        "multiway solver tree needs more than {} MB or {MAX_TREE_NODES} nodes; narrow the ranges or use fewer bet sizes and raises",
        options.max_tree_bytes / MIB
    ))?;
    let hero = request.hero_seat;
    let (node, path) = solver.tree.walk(&request.history).ok_or("history does not reach a decision node in the multiway tree")?;
    let actions = match &solver.tree.nodes[node as usize] {
        Node::Decision { player, actions, .. } if *player == hero => actions.clone(),
        _ => return Err("history does not end at Hero's decision".into()),
    };

    let budget = request.time_budget_ms.map(|ms| Duration::from_millis(u64::from(ms)));
    let mut estimate: Option<Duration> = None;
    let mut stopped_by = "iterations";
    while solver.iterations < request.iterations {
        let began = Instant::now();
        solver.iterate();
        let step = began.elapsed();
        let smoothed = estimate.map_or(step, |previous| previous.mul_f64(0.7) + step.mul_f64(0.3));
        estimate = Some(smoothed);
        // Leave room for one more iteration, the EV pass (about one iteration), and the best-response pass (two).
        // The minimum iteration count never extends a solve that has already used its whole budget.
        if let Some(budget) = budget {
            let spent = start.elapsed() >= budget;
            if solver.iterations < request.iterations && (spent || (solver.iterations >= MIN_ITERATIONS && start.elapsed() + smoothed * 4 > budget)) {
                stopped_by = "deadline";
                break;
            }
        }
    }

    let reach = solver.reach_at(&path);
    let local = solver.combos[hero].iter().position(|&combo| combo as usize == request.hero_index).ok_or("hero combo is not in Hero's range")?;
    let mass = solver.opponent_mass(hero, &reach)[local];
    // The mass is an inclusion-exclusion difference, so "none" can come back as rounding residue; compare it with
    // the scale of the opponents' total reach.
    let scale: f64 = (0..reach.len()).filter(|&player| player != hero).map(|player| reach[player].iter().sum::<f64>()).product();
    if !(mass > 1e-9 * scale) {
        return Err("the opponents' ranges at this node hold no combo compatible with Hero's cards".into());
    }
    let action_evs: Vec<f64> = solver.action_values(node, &reach).iter().map(|values| values[local] / mass).collect();
    let Node::Decision { offset, .. } = &solver.tree.nodes[node as usize] else { unreachable!() };
    let average = solver.average_strategy(hero, *offset, actions.len());
    // Hero's combo can have zero reach on this line under the average strategy; its strategy there is then
    // undefined, so report the best response by EV instead (as dcfr-core does).
    let hero_unreached = !(reach[hero][request.hero_index] > 1e-9 * request.ranges[hero][request.hero_index]);
    let hero_strategy: Vec<f64> = if hero_unreached {
        let best = action_evs.iter().enumerate().max_by(|left, right| left.1.total_cmp(right.1)).map(|(index, _)| index);
        (0..actions.len()).map(|index| if Some(index) == best { 1.0 } else { 0.0 }).collect()
    } else {
        average[local * actions.len()..(local + 1) * actions.len()].to_vec()
    };

    let mut grouped: BTreeMap<&str, (f64, f64)> = BTreeMap::new();
    let mut details = Vec::new();
    for (index, &action) in actions.iter().enumerate() {
        let key = category(action, &actions);
        let (frequency, ev) = (hero_strategy[index], action_evs[index]);
        let entry = grouped.entry(key).or_insert((0.0, 0.0));
        entry.0 += frequency;
        entry.1 += frequency * ev;
        details.push(json!({"action": key, "label": action.to_string(), "frequency": frequency, "evChips": ev}));
    }
    // A category Hero never takes still reports its best-sized EV rather than 0.
    let strategy: Vec<Value> = grouped.iter().map(|(key, (frequency, weighted))| {
        let ev = if *frequency > 0.0 {
            weighted / frequency
        } else {
            actions.iter().zip(&action_evs).filter(|(action, _)| category(**action, &actions) == *key).map(|(_, ev)| *ev).fold(f64::NEG_INFINITY, f64::max)
        };
        json!({"action": key, "frequency": frequency, "evChips": ev})
    }).collect();
    let best_action = grouped.iter().max_by(|left, right| left.1 .0.total_cmp(&right.1 .0)).map(|(key, _)| *key).unwrap_or("check");

    // The best-response pass costs about two iterations. It may run up to CONVERGENCE_SLACK past the budget (the
    // budget is well inside the answer limit); under CPU load iteration times vary and a strict check skipped it.
    let room = match (budget, estimate) {
        (Some(budget), Some(estimate)) => start.elapsed() + estimate * 2 <= budget + CONVERGENCE_SLACK,
        _ => true,
    };
    let convergence = room.then(|| {
        let gains: Vec<f64> = solver.best_response_gains().iter().map(|gain| gain / f64::from(request.pot) * 100.0).collect();
        let max = gains.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        json!({"metric": "maxBrGainPctPot", "maxBrGain": max, "brGain": gains, "nashConv": gains.iter().sum::<f64>()})
    });
    Ok(json!({
        "source": options.source,
        "player": hero,
        "players": request.ranges.len(),
        "strategy": strategy,
        "details": details,
        "best_action": best_action,
        "exploitability": Value::Null,
        "convergence": convergence,
        "iterations": solver.iterations,
        "stoppedBy": stopped_by,
        "elapsedMs": start.elapsed().as_millis() as u64,
        "treeBytes": solver.slots() as u64 * BYTES_PER_SLOT,
        "heroUnreached": hero_unreached,
    }))
}
