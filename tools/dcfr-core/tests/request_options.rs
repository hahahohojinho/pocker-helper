//! `allinPotRatio` and `rake` request options (P0-2 and P3 in docs/SPEC_SOLVER_ROADMAP.md).

use rangelab_dcfr_core::{solve_nodes_json, SolveOptions, SolveRequest};
use serde_json::Value;

const OPTIONS: SolveOptions = SolveOptions { source: "test", max_tree_bytes: 512 * 1024 * 1024 };

fn river(extra: &str) -> String {
    format!(r#"{{"board":"KsQd7h4c2s","oopRange":"77,65s,65o","ipRange":"AQs,AQo","pot":1000,"stacks":[10000,10000],"iterations":2000,"betSizes":[[[1,1]]],"maxRaises":1{extra}}}"#)
}

fn nodes(request: &str, nodes: &str) -> Value {
    let output: Value = serde_json::from_str(&solve_nodes_json(&format!(r#"{{"request":{request},"nodes":{nodes}}}"#), OPTIONS)).unwrap();
    assert_eq!(output["ok"], true, "{output}");
    output["result"].clone()
}

fn root_labels(request: &str) -> Vec<String> {
    nodes(request, "[[]]")["nodes"][0]["actions"].as_array().unwrap().iter().map(|action| action["label"].as_str().unwrap().to_lowercase()).collect()
}

/// IP's average call frequency facing a pot-sized bet in the polarization game.
fn call_share(request: &str) -> f64 {
    let result = nodes(request, r#"[[{"action":"bet","size":[1,1]}]]"#);
    let node = &result["nodes"][0];
    let labels: Vec<&str> = node["actions"].as_array().unwrap().iter().map(|action| action["label"].as_str().unwrap()).collect();
    let call = labels.iter().position(|label| label.eq_ignore_ascii_case("call")).expect("IP can call");
    let freq: Vec<f64> = node["freq"].as_array().unwrap().iter().map(|value| value.as_f64().unwrap()).collect();
    let rows: Vec<&[f64]> = freq.chunks(labels.len()).collect();
    rows.iter().map(|mix| mix[call]).sum::<f64>() / rows.len() as f64
}

#[test]
fn all_in_is_offered_deep_only_when_asked() {
    // Stacks are ten pots: the default rule (SPR <= 1) leaves all-in out.
    let labels = root_labels(&river(""));
    assert!(!labels.iter().any(|label| label == "allin"), "{labels:?}");
    let labels = root_labels(&river(r#","allinPotRatio":0"#));
    assert!(labels.iter().any(|label| label == "allin"), "{labels:?}");
}

#[test]
fn rake_makes_calling_a_bluff_catcher_less_attractive() {
    // Without rake IP calls 1/(1+b) = 50% against a pot bet; rake shrinks the pot a bluff wins, so calls fall.
    let plain = call_share(&river(""));
    let raked = call_share(&river(r#","rake":{"percent":10,"capChips":100000}"#));
    assert!((plain - 0.5).abs() < 0.01, "plain call share {plain}");
    assert!(raked < plain - 0.01, "rake should reduce calls: {plain} -> {raked}");
}

#[test]
fn rejects_invalid_options() {
    for extra in [
        r#","allinPotRatio":-1"#,
        r#","allinPotRatio":101"#,
        r#","rake":{"percent":0,"capChips":100}"#,
        r#","rake":{"percent":11,"capChips":100}"#,
        r#","rake":{"percent":5,"capChips":0}"#,
        r#","rake":{"percent":5,"capChips":100,"extra":1}"#,
        r#","rake":{"percent":5}"#,
    ] {
        assert!(SolveRequest::parse(&river(extra)).is_err(), "{extra}");
    }
    assert!(SolveRequest::parse(&river(r#","allinPotRatio":0,"rake":{"percent":5,"capChips":300}"#)).is_ok());
}
