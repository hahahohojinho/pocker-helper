//! Games with a known equilibrium, solved through the public request API (P0-3 in docs/SPEC_SOLVER_ROADMAP.md).

use rangelab_dcfr_core::{solve_nodes_json, SolveOptions};
use serde_json::Value;

const OPTIONS: SolveOptions = SolveOptions { source: "test", max_tree_bytes: 512 * 1024 * 1024 };
const POT: i32 = 1000;
/// Aggregate frequencies must match the closed form within half a percentage point.
const TOLERANCE: f64 = 0.005;

/// One decision node exported by `solve_nodes_json`: combos of the acting player and their action mixes.
struct Node {
    combos: Vec<String>,
    labels: Vec<String>,
    freq: Vec<f64>,
}

impl Node {
    fn from(result: &Value, index: usize) -> Node {
        let node = &result["nodes"][index];
        let player = node["player"].as_str().unwrap();
        let joined = result["combos"][player].as_str().unwrap();
        let combos = (0..joined.len() / 4).map(|position| joined[position * 4..position * 4 + 4].to_string()).collect();
        let labels = node["actions"].as_array().unwrap().iter().map(|action| action["label"].as_str().unwrap().to_lowercase()).collect();
        let freq = node["freq"].as_array().unwrap().iter().map(|value| value.as_f64().unwrap()).collect();
        Node { combos, labels, freq }
    }

    /// Summed frequency of `label` over the combos that pass `keep`, and how many combos passed.
    fn total(&self, keep: impl Fn(&str) -> bool, label: &str) -> (f64, usize) {
        let width = self.labels.len();
        let column = self.labels.iter().position(|candidate| candidate == label).unwrap_or_else(|| panic!("no {label} in {:?}", self.labels));
        let kept: Vec<&[f64]> = self.combos.iter().zip(self.freq.chunks(width)).filter(|(combo, _)| keep(combo)).map(|(_, mix)| mix).collect();
        (kept.iter().map(|mix| mix[column]).sum(), kept.len())
    }
}

fn solve(request: &str, nodes: &str) -> Value {
    let output: Value = serde_json::from_str(&solve_nodes_json(&format!(r#"{{"request":{request},"nodes":{nodes}}}"#), OPTIONS)).unwrap();
    assert_eq!(output["ok"], true, "{output}");
    output["result"].clone()
}

/// Value hands are the set of sevens; every other OOP combo is air.
fn is_set(combo: &str) -> bool {
    combo.starts_with('7')
}

/// River polarization game: OOP holds nuts (77, a set) or air (65), IP holds one bluff catcher (AQ, second pair).
/// The stacks equal one bet of `b` times the pot, so the only bet is all-in and IP can only call (all-in) or fold.
/// Equilibrium: value always bets, the bluff share of OOP's betting range is b/(1+2b), and IP calls 1/(1+b).
/// After an OOP check only air remains, so IP's bet-or-check choice there is indifferent and is not checked.
fn polarized_river(numerator: i32, denominator: i32) {
    let b = numerator as f64 / denominator as f64;
    let stack = POT * numerator / denominator;
    let request = format!(
        r#"{{"board":"KsQd7h4c2s","oopRange":"77,65s,65o","ipRange":"AQs,AQo","pot":{POT},"stacks":[{stack},{stack}],"iterations":3000,"betSizes":[[[{numerator},{denominator}]]],"maxRaises":1}}"#
    );
    let result = solve(&request, r#"[[],[{"action":"allin"}]]"#);
    let root = Node::from(&result, 0);
    let facing = Node::from(&result, 1);
    assert_eq!(root.labels, ["check", "allin"], "b={b}: the game must offer only check or all-in");
    assert_eq!(facing.labels, ["fold", "allin"], "b={b}: facing all-in, calling is all-in");

    let (value_bets, value_combos) = root.total(is_set, "allin");
    let (bluffs, air_combos) = root.total(|combo| !is_set(combo), "allin");
    let (calls, catchers) = facing.total(|_| true, "allin");
    // The closed form assumes these combo counts (board blocks one seven, the queen and ace of diamonds).
    assert_eq!((value_combos, air_combos, catchers), (3, 16, 12));

    assert!((value_bets / value_combos as f64 - 1.0).abs() < TOLERANCE, "b={b}: value bets {value_bets}/{value_combos}");
    let bluff_share = bluffs / (bluffs + value_bets);
    let expected_bluff_share = b / (1.0 + 2.0 * b);
    assert!((bluff_share - expected_bluff_share).abs() < TOLERANCE, "b={b}: bluff share {bluff_share:.4}, expected {expected_bluff_share:.4}");
    let call_share = calls / catchers as f64;
    let expected_call_share = 1.0 / (1.0 + b);
    assert!((call_share - expected_call_share).abs() < TOLERANCE, "b={b}: call share {call_share:.4}, expected {expected_call_share:.4}");
}

#[test]
fn polarized_river_half_pot() {
    polarized_river(1, 2);
}

#[test]
fn polarized_river_pot() {
    polarized_river(1, 1);
}

#[test]
fn polarized_river_overbet() {
    polarized_river(3, 2);
}

/// Exploitability falls overall as iterations grow. DCFR does not guarantee a strictly monotone average strategy, so
/// the middle checkpoint only has to stay below the start.
#[test]
fn exploitability_falls_with_iterations() {
    let exploitability = |iterations: u32| {
        let request = format!(
            r#"{{"board":"KsTd7c4h2s","oopRange":"AA,KK,KQs,KQo,QJs,JTs,T9s,98s,A5s,72o","ipRange":"KK,AKs,AKo,KJs,QJs,JTs,T9s,99,88,65s","pot":{POT},"stacks":[5000,5000],"iterations":{iterations},"betSizes":[[[1,2],[1,1]],[[1,1]]],"maxRaises":2}}"#
        );
        let result = solve(&request, "[[]]");
        assert_eq!(result["iterations"], iterations, "the solve must run every requested iteration");
        result["exploitability"].as_f64().unwrap()
    };
    let (early, middle, late) = (exploitability(100), exploitability(300), exploitability(1000));
    assert!(middle < early && late < early * 0.5, "exploitability did not fall: 100={early} 300={middle} 1000={late}");
}
