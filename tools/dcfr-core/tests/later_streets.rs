//! Later-street bet sizes (`betSizesByStreet`, P0-1 in docs/SPEC_SOLVER_ROADMAP.md).

use rangelab_dcfr_core::{estimate, solve_json, SolveOptions, SolveRequest};
use serde_json::Value;

const OPTIONS: SolveOptions = SolveOptions { source: "test", max_tree_bytes: 512 * 1024 * 1024 };
const MAX_BYTES: u64 = 1 << 32;

fn turn_request(by_street: &str) -> String {
    format!(r#"{{"board":"KsTd7c4h","hero":"AhKh","oopRange":"AKs,AKo,KQs,KQo,QJs,JTs,98s,77,44","ipRange":"KK,AKs,AKo,KJs,KJo,QJs,T9s,65s","pot":1000,"stacks":[9000,9000],"iterations":50,"betSizes":[[[1,2]],[[3,5]]],"maxRaises":2{by_street}}}"#)
}

fn decision_nodes(request: &str) -> u64 {
    let parsed = SolveRequest::parse(request).unwrap();
    estimate(&parsed, MAX_BYTES).unwrap_or_else(|bytes| panic!("tree exceeds the bound ({bytes} bytes)")).decision_nodes
}

#[test]
fn river_sizes_add_river_betting_to_a_turn_tree() {
    let checked_down = decision_nodes(&turn_request(""));
    let with_river = decision_nodes(&turn_request(r#","betSizesByStreet":{"river":[[[1,2],[1,1]],[[3,5]]]}"#));
    // Without betSizesByStreet the tree is unchanged from before the field existed.
    assert_eq!(checked_down, 486);
    // Measured 486 -> 2406 for these ranges; every river subtree gains bet and raise nodes.
    assert!(with_river > checked_down * 3, "river betting should multiply decision nodes: {checked_down} -> {with_river}");
}

#[test]
fn turn_solve_with_river_sizes_runs() {
    let output: Value = serde_json::from_str(&solve_json(&turn_request(r#","betSizesByStreet":{"river":[[[1,2]],[[3,5]]]}"#), OPTIONS)).unwrap();
    assert_eq!(output["ok"], true, "{output}");
    let frequencies: f64 = output["result"]["strategy"].as_array().unwrap().iter().map(|entry| entry["frequency"].as_f64().unwrap()).sum();
    assert!((frequencies - 1.0).abs() < 1e-3);
}

#[test]
fn rejects_sizes_for_the_solved_or_an_earlier_street() {
    assert!(SolveRequest::parse(&turn_request(r#","betSizesByStreet":{"river":[[[1,2]]]}"#)).is_ok());
    let turn_for_turn = turn_request(r#","betSizesByStreet":{"turn":[[[1,2]]]}"#);
    assert!(SolveRequest::parse(&turn_for_turn).is_err());
    let river = r#"{"board":"KsTd7c4h2s","hero":"AhKh","oopRange":"AKs","ipRange":"QQ","pot":1000,"stacks":[9000,9000],"iterations":10,"betSizes":[[[1,2]]],"maxRaises":1,"betSizesByStreet":{"river":[[[1,2]]]}}"#;
    assert!(SolveRequest::parse(&river.replace(r#","betSizesByStreet":{"river":[[[1,2]]]}"#, "")).is_ok());
    assert!(SolveRequest::parse(river).is_err());
}

#[test]
fn rejects_invalid_later_sizes() {
    assert!(SolveRequest::parse(&turn_request("")).is_ok());
    for by_street in [
        r#","betSizesByStreet":{"river":[]}"#,
        r#","betSizesByStreet":{"river":[[]]}"#,
        r#","betSizesByStreet":{"river":[[[0,1]]]}"#,
        r#","betSizesByStreet":{"river":[[[51,1]]]}"#,
        r#","betSizesByStreet":{"river":[[[1,2],[1,2],[1,2],[1,2],[1,2],[1,2],[1,2]]]}"#,
        r#","betSizesByStreet":{"preflop":[[[1,2]]]}"#,
    ] {
        assert!(SolveRequest::parse(&turn_request(by_street)).is_err(), "{by_street}");
    }
}
