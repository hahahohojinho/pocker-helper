use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

const WIDE: &str = "AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,K8s,K7s,K6s,K5s,QJs,QTs,Q9s,Q8s,JTs,J9s,J8s,T9s,T8s,98s,97s,87s,86s,76s,75s,65s,54s,AKo,AQo,AJo,ATo,A9o,A8o,KQo,KJo,KTo,QJo,QTo,JTo";

fn solve(board: &str, iterations: u32, budget_ms: u32) -> (serde_json::Value, u128) {
    let request = format!(r#"{{"board":"{board}","hero":"AsQh","oopRange":"{WIDE}","ipRange":"{WIDE}","pot":650,"stacks":[9750,9750],"iterations":{iterations},"betSizes":[[[1,2]],[[3,5]]],"maxRaises":2,"timeBudgetMs":{budget_ms}}}"#);
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_rangelab-dcfr-adapter"))
        .arg("--json").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("adapter starts");
    child.stdin.take().unwrap().write_all(request.as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    (serde_json::from_slice(&output.stdout).unwrap(), started.elapsed().as_millis())
}

#[test]
fn stops_a_flop_solve_at_the_deadline_with_a_usable_strategy() {
    let (response, wall_ms) = solve("JsTd7c", 5000, 2000);
    let result = &response["result"];
    assert_eq!(result["stoppedBy"], "deadline", "{response}");
    let iterations = result["iterations"].as_u64().unwrap();
    assert!((3..5000).contains(&iterations), "{iterations}");
    assert!(result["elapsedMs"].as_u64().unwrap() <= 2300, "{response}");
    // Generous: shared CI runners are slower and noisier than a desktop.
    assert!(wall_ms <= 6000, "process took {wall_ms} ms");
    let total: f64 = result["strategy"].as_array().unwrap().iter().map(|item| item["frequency"].as_f64().unwrap()).sum();
    assert!((total - 1.0).abs() < 1e-3, "{response}");
    assert!(result["strategy"].as_array().unwrap().iter().all(|item| item["evChips"].as_f64().unwrap().is_finite()));
}

#[test]
fn finishes_all_iterations_when_the_budget_allows() {
    let (response, _) = solve("JsTd7c2h3s", 200, 5000);
    let result = &response["result"];
    assert_eq!(result["stoppedBy"], "iterations", "{response}");
    assert_eq!(result["iterations"], 200);
    assert!(result["exploitability"].is_number(), "{response}");
}
