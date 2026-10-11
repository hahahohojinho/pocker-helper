use std::io::Write;
use std::process::{Command, Stdio};

fn run_json(input: &str) -> serde_json::Value {
    run_mode("--json", input)
}

fn run_mode(flag: &str, input: &str) -> serde_json::Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rangelab-dcfr-adapter"))
        .arg(flag).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("adapter starts");
    // The adapter stops reading past its input limit, so a broken pipe on oversized input is expected.
    let _ = child.stdin.take().unwrap().write_all(input.as_bytes());
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn solves_the_wasm_request_format_natively() {
    let response = run_json(r#"{"board":"JsTd7c2h3s","hero":"AsQh","oopRange":"KK,QQ,T9s","ipRange":"AsQh,AA,JJ","pot":1000,"stacks":[9000,9000],"iterations":100,"betSizes":[[[1,2]],[[3,5]]],"maxRaises":2,"history":[{"action":"check"}]}"#);
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["source"], "dcfr-native");
    assert_eq!(response["result"]["player"], "ip");
}

#[test]
fn rejects_oversized_input_inside_the_envelope() {
    let response = run_json(&"x".repeat(300 * 1024));
    assert_eq!(response["ok"], false);
    assert!(response["error"].as_str().unwrap().contains("bytes"));
}

#[test]
fn exports_every_combo_at_several_nodes() {
    let response = run_mode("--json-nodes", r#"{"request":{"board":"JsTd7c2h3s","oopRange":"KK,QQ,T9s","ipRange":"AA,JJ,AQo","pot":1000,"stacks":[9000,9000],"iterations":100,"betSizes":[[[1,2]],[[3,5]]],"maxRaises":2},"nodes":[[],[{"action":"check"}]]}"#);
    assert_eq!(response["ok"], true, "{response}");
    let nodes = response["result"]["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes[0]["player"], "oop");
    assert_eq!(nodes[1]["player"], "ip");
    assert!(response["result"]["exploitability"].as_f64().is_some());
}
