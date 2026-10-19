//! Measures the turn check-down approximation against dcfr-core's full turn solve (river betting included) on
//! heads-up spots, where the full solve is available. Prints per-action EV and frequency for both.
//!
//!   cargo run --release --example turn_checkdown_bias -- <manifest.json> [budget_ms]

use std::time::Instant;

use serde_json::{json, Value};

const HEROES: [&str; 6] = ["AhKh", "QcJc", "9s8s", "7h6h", "AdQs", "5c5d"];
const BOARDS: [&str; 3] = ["Ks7d2c5h", "Th9h4c2s", "8c7c6dQs"];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("manifest")).expect("json");
    let budget: u64 = args.get(2).and_then(|value| value.parse().ok()).unwrap_or(4500);
    let spec = manifest["scenarios"].as_array().unwrap().iter().find(|scenario| scenario["id"] == "6max-100bb-srp-btn-bb").unwrap();
    let (oop, ip) = (spec["oopRange"].as_str().unwrap(), spec["ipRange"].as_str().unwrap());
    // `FACING=1`: IP facing a half-pot bet instead of the OOP root.
    let facing = std::env::var("FACING").is_ok_and(|value| value == "1");
    let history = if facing { json!([{"action": "bet", "size": [1, 2]}]) } else { json!([]) };
    for board in BOARDS {
        for hero in HEROES {
            if hero.as_bytes().chunks(2).any(|card| board.as_bytes().chunks(2).any(|other| other.eq_ignore_ascii_case(card))) {
                continue;
            }
            let full = json!({"board": board, "hero": hero, "oopRange": oop, "ipRange": ip, "pot": 550, "stacks": [9750, 9750], "iterations": 5000, "betSizes": [[[1, 2]], [[3, 5]]], "maxRaises": 2, "history": history, "timeBudgetMs": 20000});
            let approx = json!({"board": board, "hero": hero, "heroSeat": if facing { 1 } else { 0 }, "players": [{"range": oop, "stack": 9750}, {"range": ip, "stack": 9750}], "pot": 550, "iterations": 5000, "betSizes": [[[1, 2]], [[3, 5]]], "maxRaises": 2, "history": history, "timeBudgetMs": budget});
            let started = Instant::now();
            let reference: Value = serde_json::from_str(&rangelab_dcfr_core::solve_json(&full.to_string(), rangelab_dcfr_core::SolveOptions { source: "full", max_tree_bytes: 1 << 32 })).unwrap();
            let full_ms = started.elapsed().as_millis();
            let started = Instant::now();
            let ours: Value = serde_json::from_str(&rangelab_multiway_core::solve_json(&approx.to_string(), rangelab_multiway_core::MultiwayOptions { source: "approx", max_tree_bytes: 1 << 30 })).unwrap();
            let approx_ms = started.elapsed().as_millis();
            let row = |value: &Value| value["result"]["strategy"].as_array().map(|strategy| strategy.iter().map(|entry| format!("{} {:.0}% {:+.0}", entry["action"].as_str().unwrap(), entry["frequency"].as_f64().unwrap() * 100.0, entry["evChips"].as_f64().unwrap())).collect::<Vec<_>>().join(", ")).unwrap_or_else(|| value.to_string());
            println!("{board} {hero} | full {full_ms}ms {} it, expl {:?}: {} | checkdown {approx_ms}ms {} it, brGain {:?}: {}",
                reference["result"]["iterations"], reference["result"]["exploitability"].as_f64().map(|value| (value * 1000.0).round() / 1000.0), row(&reference),
                ours["result"]["iterations"], ours["result"]["convergence"]["maxBrGain"].as_f64().map(|value| (value * 1000.0).round() / 1000.0), row(&ours));
        }
    }
}
