//! Solves once and exports every combo's strategy and per-action EV at several decision nodes (flop library builds).

use dcfr_solver::card::{card_to_string, combo_from_index, NUM_COMBOS};
use dcfr_solver::cfr::SubgameSolver;
use dcfr_solver::game::Action;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::request::{parse_step, RawStep, SolveRequest};
use crate::solve::{best_response, category, solve_tree, Solved};
use crate::SolveOptions;

/// The flop library keeps the OOP root, IP after a check, and the two facing-bet nodes; a few spare.
pub const MAX_NODES: usize = 8;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawNodesRequest {
    /// A solve request whose `hero` and `history` are ignored.
    request: Value,
    nodes: Vec<Vec<RawStep>>,
}

/// Live combos of a range on this board, as (original combo index, "AhKd").
fn range_combos(request: &SolveRequest, player: usize) -> Vec<(usize, String)> {
    (0..NUM_COMBOS)
        .filter(|&combo| request.ranges[player].weights[combo] > 0.0)
        .filter_map(|combo| {
            let (first, second) = combo_from_index(combo as u16);
            (!request.board.contains(first) && !request.board.contains(second)).then(|| (combo, format!("{}{}", card_to_string(first), card_to_string(second))))
        })
        .collect()
}

/// One node: every combo of the acting player, its strategy (best response by EV where the equilibrium never
/// reaches it), and each action's EV in chips.
fn export_node(solver: &SubgameSolver, history: &[Action], combos: &[Vec<(usize, String)>; 2]) -> Result<Value, String> {
    let player = solver.get_player(history).ok_or("a node history does not reach a decision node")?;
    let strategy = solver.get_strategy(history).ok_or("strategy is unavailable at a node")?;
    let action_evs = solver.compute_action_evs(history, player).ok_or("action EVs are unavailable at a node")?;
    let actions: Vec<Action> = action_evs.iter().map(|(action, _)| *action).collect();
    let (mut freq, mut ev, mut unreached) = (Vec::new(), Vec::new(), Vec::new());
    for (position, (combo, _)) in combos[player as usize].iter().enumerate() {
        let reached = strategy.iter().find(|(index, _)| *index as usize == *combo).map(|(_, mix)| mix.clone());
        if reached.is_none() {
            unreached.push(position);
        }
        let mix = reached.unwrap_or_else(|| best_response(&action_evs, *combo));
        if mix.len() != actions.len() {
            return Err("strategy/action EV mismatch".into());
        }
        freq.extend(mix.iter().map(|(_, share)| *share));
        ev.extend(action_evs.iter().map(|(_, values)| values[*combo]));
    }
    Ok(json!({
        "player": if player == 0 { "oop" } else { "ip" },
        "actions": actions.iter().map(|action| json!({"category": category(*action, &actions), "label": action.to_string()})).collect::<Vec<_>>(),
        "freq": freq,
        "ev": ev,
        "unreached": unreached,
    }))
}

fn solve_nodes(input: &str, options: SolveOptions) -> Result<Value, String> {
    let raw: RawNodesRequest = serde_json::from_str(input).map_err(|error| format!("invalid nodes request: {error}"))?;
    if raw.nodes.is_empty() || raw.nodes.len() > MAX_NODES {
        return Err(format!("nodes must list 1..={MAX_NODES} histories"));
    }
    let request = SolveRequest::parse(&raw.request.to_string())?;
    let histories = raw.nodes.iter()
        .map(|steps| steps.iter().map(parse_step).collect::<Result<Vec<_>, _>>())
        .collect::<Result<Vec<_>, _>>()?;
    let Solved { solver, report, .. } = solve_tree(&request, options, &mut |_, _| {})?;
    let combos = [range_combos(&request, 0), range_combos(&request, 1)];
    let nodes = histories.iter().map(|history| export_node(&solver, history, &combos)).collect::<Result<Vec<_>, _>>()?;
    let joined = |player: usize| combos[player].iter().map(|(_, cards)| cards.as_str()).collect::<String>();
    Ok(json!({
        "source": options.source,
        "iterations": report.iterations,
        "elapsedMs": report.elapsed_ms,
        // Always measured: the library labels every stored answer with its convergence.
        "exploitability": solver.exploitability_pct(),
        "combos": {"oop": joined(0), "ip": joined(1)},
        "nodes": nodes,
    }))
}

/// `{"request": <solve request>, "nodes": [[steps]...]}` -> `{"ok":true,"result":{...}}` or `{"ok":false,"error":...}`.
pub fn solve_nodes_json(input: &str, options: SolveOptions) -> String {
    match solve_nodes(input, options) {
        Ok(result) => json!({"ok": true, "result": result}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPTIONS: SolveOptions = SolveOptions { source: "test", max_tree_bytes: 512 * 1024 * 1024 };

    fn river_request(nodes: &str) -> String {
        format!(r#"{{"request":{{"board":"KsTd7c4h2s","oopRange":"AA,KQs,KQo,72o","ipRange":"KK,QJs,65s","pot":1000,"stacks":[5000,5000],"iterations":200,"betSizes":[[[1,2]],[[1,1]]],"maxRaises":2}},"nodes":{nodes}}}"#)
    }

    #[test]
    fn exports_every_combo_at_each_node() {
        let output: Value = serde_json::from_str(&solve_nodes_json(&river_request(r#"[[],[{"action":"check"}],[{"action":"bet","size":[1,2]}]]"#), OPTIONS)).unwrap();
        assert_eq!(output["ok"], true, "{output}");
        let result = &output["result"];
        let oop = result["combos"]["oop"].as_str().unwrap().len() / 4;
        let ip = result["combos"]["ip"].as_str().unwrap().len() / 4;
        assert!(oop > 0 && ip > 0);
        for (node, combos, player) in [(0, oop, "oop"), (1, ip, "ip"), (2, ip, "ip")] {
            let entry = &result["nodes"][node];
            assert_eq!(entry["player"], player);
            let actions = entry["actions"].as_array().unwrap().len();
            let freq: Vec<f64> = entry["freq"].as_array().unwrap().iter().map(|value| value.as_f64().unwrap()).collect();
            assert_eq!(freq.len(), combos * actions);
            assert_eq!(entry["ev"].as_array().unwrap().len(), combos * actions);
            for mix in freq.chunks(actions) {
                assert!((mix.iter().sum::<f64>() - 1.0).abs() < 1e-3, "{mix:?}");
            }
        }
        assert!(result["exploitability"].as_f64().unwrap() >= 0.0);
    }

    #[test]
    fn rejects_bad_node_lists() {
        for nodes in ["[]", r#"[[{"action":"jump"}]]"#, r#"[[{"action":"check"},{"action":"check"}]]"#] {
            let output: Value = serde_json::from_str(&solve_nodes_json(&river_request(nodes), OPTIONS)).unwrap();
            assert_eq!(output["ok"], false, "{nodes}");
        }
        let too_many = format!("[{}]", vec!["[]"; MAX_NODES + 1].join(","));
        assert_eq!(serde_json::from_str::<Value>(&solve_nodes_json(&river_request(&too_many), OPTIONS)).unwrap()["ok"], false);
    }

    #[test]
    fn single_node_solve_still_needs_a_hero() {
        let request = r#"{"board":"KsTd7c4h2s","oopRange":"AA","ipRange":"KK","pot":1000,"stacks":[5000,5000],"iterations":10,"betSizes":[[[1,2]]],"maxRaises":1}"#;
        let output: Value = serde_json::from_str(&crate::solve_json(request, OPTIONS)).unwrap();
        assert_eq!(output["error"], "hero is required");
    }
}
