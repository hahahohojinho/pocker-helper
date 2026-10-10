//! Native single-thread benchmark using the same sequential shims as the wasm build.
//! Usage: bench [range] [street] [comma-separated iterations]
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let default_range = "AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A9s,A5s,A4s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,76s,AKo,AQo,AJo,KQo";
    let range = args.get(1).map(String::as_str).unwrap_or(default_range);
    let streets: Vec<(&str, &str)> = vec![("river", "JsTd7c2h3s"), ("turn", "JsTd7c2h"), ("flop", "JsTd7c")];
    let only = args.get(2).map(String::as_str);
    let iteration_list: Vec<u32> = args.get(3).map(|text| text.split(',').filter_map(|value| value.parse().ok()).collect()).unwrap_or_else(|| vec![50]);
    for (street, board) in streets.into_iter().filter(|(street, _)| only.is_none_or(|name| name == *street)) {
    for &iterations in &iteration_list {
        let request = serde_json::json!({
            "board": board, "hero": "AsQh", "oopRange": range, "ipRange": range,
            "pot": 650, "stacks": [9750, 9750], "iterations": iterations,
            "betSizes": [[[1, 2]], [[3, 5]]], "maxRaises": 2,
        }).to_string();
        let start = Instant::now();
        let response = rangelab_dcfr_wasm::solve_json(&request);
        let parsed: serde_json::Value = serde_json::from_str(&response).unwrap();
        println!("{street} iter={iterations} {:.2}s exploit={} strategy={}", start.elapsed().as_secs_f64(), parsed["result"]["exploitability"], parsed["result"]["strategy"]);
    }
    }
}
