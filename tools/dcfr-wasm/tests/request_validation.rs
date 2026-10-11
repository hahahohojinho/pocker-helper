use rangelab_dcfr_wasm::{solve_json, solve_json_with_progress};
use serde_json::{json, Value};

fn request(overrides: Value) -> String {
    let mut base = json!({
        "board": "JsTd7c2h3s", "hero": "AsQh", "oopRange": "AsQh,KK,QQ", "ipRange": "AA,JJ,T9s",
        "pot": 1000, "stacks": [9000, 9000], "iterations": 50, "betSizes": [[[1, 2]], [[3, 5]]], "maxRaises": 2,
    });
    for (key, value) in overrides.as_object().unwrap() {
        base[key] = value.clone();
    }
    base.to_string()
}

fn error_of(overrides: Value) -> String {
    let response: Value = serde_json::from_str(&solve_json(&request(overrides))).unwrap();
    assert_eq!(response["ok"], false, "expected an error: {response}");
    response["error"].as_str().unwrap().to_string()
}

#[test]
fn rejects_out_of_range_limits() {
    assert!(error_of(json!({"iterations": 0})).contains("iterations"));
    assert!(error_of(json!({"pot": 10_000_001})).contains("chips"));
    assert!(error_of(json!({"maxRaises": 5})).contains("maxRaises"));
    assert!(error_of(json!({"betSizes": [[[51, 1]]]})).contains("50x"));
    assert!(error_of(json!({"hero": "JsQh"})).contains("board"));
    assert!(error_of(json!({"oopRange": "ZZ"})).contains("OOP range"));
    assert!(error_of(json!({"unexpected": 1})).contains("invalid request"));
}

#[test]
fn reports_bounded_monotonic_progress_ending_at_total() {
    let mut reports = Vec::new();
    let response: Value = serde_json::from_str(&solve_json_with_progress(&request(json!({"iterations": 250})), &mut |done, total| reports.push((done, total)))).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(reports.first(), Some(&(0, 250)));
    assert_eq!(reports.last(), Some(&(250, 250)));
    assert!(reports.windows(2).all(|pair| pair[0].0 <= pair[1].0), "{reports:?}");
    assert!(reports.len() <= 102, "{} reports", reports.len());
}

#[test]
fn rejects_trees_above_the_memory_limit_before_solving() {
    // Six sizes per level and four raises on the flop is far beyond any browser's memory.
    let everything = "22,33,44,55,66,77,88,99,TT,JJ,QQ,KK,AA,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,K8s,K7s,K6s,K5s,K4s,K3s,K2s,QJs,QTs,Q9s,Q8s,Q7s,Q6s,Q5s,JTs,J9s,J8s,J7s,T9s,T8s,T7s,98s,97s,96s,87s,86s,76s,75s,65s,64s,54s,AKo,AQo,AJo,ATo,A9o,A8o,A7o,A6o,A5o,KQo,KJo,KTo,K9o,QJo,QTo,Q9o,JTo,J9o,T9o,98o";
    let started = std::time::Instant::now();
    let error = error_of(json!({"board": "JsTd7c", "oopRange": format!("AsQh,{everything}"), "ipRange": everything, "iterations": 1,
        "betSizes": [[[1, 4], [1, 3], [1, 2], [3, 4], [1, 1], [3, 2]], [[1, 2], [3, 5], [3, 4], [1, 1], [5, 4], [3, 2]]], "maxRaises": 4}));
    assert!(error.contains("MB"), "{error}");
    assert!(started.elapsed().as_secs() < 5, "the estimate should reject before allocating");
}

#[test]
fn rejects_huge_trees_even_with_two_combo_ranges() {
    // Few live combos make per-node overhead dominate; the node bound and overhead term must still reject this quickly.
    let started = std::time::Instant::now();
    let error = error_of(json!({"board": "JsTd7c", "oopRange": "AsQh", "ipRange": "KsKh", "iterations": 1,
        "betSizes": [[[1, 4], [1, 3], [1, 2], [3, 4], [1, 1], [3, 2]], [[1, 2], [3, 5], [3, 4], [1, 1], [5, 4], [3, 2]]], "maxRaises": 4}));
    assert!(error.contains("nodes"), "{error}");
    assert!(started.elapsed().as_secs() < 10, "rejection took {:?}", started.elapsed());
}

#[test]
fn rejects_non_finite_and_out_of_range_weights() {
    assert!(error_of(json!({"oopRange": "AsQh,KK:nan"})).contains("between 0 and 1"));
    assert!(error_of(json!({"oopRange": "AsQh,KK:-1"})).contains("between 0 and 1"));
    assert!(error_of(json!({"ipRange": "AA:2"})).contains("between 0 and 1"));
}

#[test]
fn rejects_oversized_requests() {
    let huge = "AA,".repeat(100_000);
    assert!(error_of(json!({"oopRange": huge})).contains("bytes"));
}

#[test]
fn reports_unreached_hero_combos_with_a_best_response() {
    // Hero (OOP) holds KK, which never checks in this tiny game, then faces a bet after checking.
    let response: Value = serde_json::from_str(&solve_json(&request(json!({
        "hero": "KsKh", "oopRange": "KK", "ipRange": "AA,T9s", "iterations": 200,
        "history": [{"action": "check"}, {"action": "bet", "size": [1, 2]}],
    })))).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let strategy = response["result"]["strategy"].as_array().unwrap();
    let total: f64 = strategy.iter().map(|item| item["frequency"].as_f64().unwrap()).sum();
    assert!((total - 1.0).abs() < 1e-6, "{response}");
}

#[test]
fn reaches_an_ip_node_facing_a_raise() {
    let response: Value = serde_json::from_str(&solve_json(&request(json!({
        "oopRange": "KK,QQ,T9s", "ipRange": "AsQh,AA,JJ", "iterations": 100, "maxRaises": 3,
        "betSizes": [[[1, 2]], [[3, 5], [3, 4]]],
        "history": [{"action": "check"}, {"action": "bet", "size": [1, 2]}, {"action": "raise", "size": [3, 4]}],
    })))).unwrap();
    assert_eq!(response["result"]["player"], "ip", "{response}");
}
