use std::io::Write;
use std::process::{Command, Stdio};

fn run(args: &[&str], input: &str) -> serde_json::Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rangelab-dcfr-adapter"))
        .args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("adapter starts");
    let _ = child.stdin.take().unwrap().write_all(input.as_bytes());
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

const PLAYERS: &str = r#"[{"range":"AA,KK,QQ,AKs,AKo,AQs,KQs,JJ,TT,99,AJs,KJs,QJs","stack":3000},{"range":"AKs,AKo,AQs,AQo,KQs,JJ,TT,99,88,JTs,T9s,98s,A5s","stack":3000},{"range":"QQ,JJ,AQs,AQo,KQs,KQo,QJs,JTs,T9s,A4s,K9s,AhJh","stack":2500}]"#;

#[test]
fn solves_a_three_way_river_node_with_convergence() {
    let request = format!(r#"{{"board":"Kd9h5c2s7d","hero":"AhJh","heroSeat":2,"players":{PLAYERS},"pot":1000,"iterations":200,"betSizes":[[[1,2]],[[3,5]]],"maxRaises":2,"history":[{{"action":"check"}},{{"action":"bet","size":[1,2]}}],"timeBudgetMs":3000}}"#);
    let response = run(&["--json-multiway"], &request);
    assert_eq!(response["ok"], true, "{response}");
    let result = &response["result"];
    assert_eq!(result["source"], "multiway-native");
    assert_eq!(result["player"], 2);
    assert_eq!(result["players"], 3);
    let actions: Vec<&str> = result["strategy"].as_array().unwrap().iter().map(|entry| entry["action"].as_str().unwrap()).collect();
    assert_eq!(actions, ["call", "fold", "raise"]);
    let frequency: f64 = result["strategy"].as_array().unwrap().iter().map(|entry| entry["frequency"].as_f64().unwrap()).sum();
    assert!((frequency - 1.0).abs() < 1e-6);
    assert_eq!(result["convergence"]["metric"], "maxBrGainPctPot");
    assert!(result["convergence"]["maxBrGain"].as_f64().unwrap() < 5.0, "{result}");
    assert!(result["exploitability"].is_null());
}

#[test]
fn rejects_non_river_boards_and_off_tree_histories() {
    let flop = format!(r#"{{"board":"Kd9h5c","hero":"AhJh","heroSeat":2,"players":{PLAYERS},"pot":1000,"iterations":10,"betSizes":[[[1,2]]],"maxRaises":2}}"#);
    let response = run(&["--json-multiway"], &flop);
    assert_eq!(response["ok"], false);
    assert!(response["error"].as_str().unwrap().contains("river"));
    let wrong_actor = format!(r#"{{"board":"Kd9h5c2s7d","hero":"AhJh","heroSeat":2,"players":{PLAYERS},"pot":1000,"iterations":10,"betSizes":[[[1,2]]],"maxRaises":2}}"#);
    let response = run(&["--json-multiway"], &wrong_actor);
    assert!(response["error"].as_str().unwrap().contains("Hero's decision"), "{response}");
}

#[test]
fn reports_capabilities() {
    let response = run(&["--capabilities"], "");
    assert_eq!(response["multiway"]["maxPlayers"], 3);
    assert_eq!(response["multiway"]["streets"][0], "river");
}
