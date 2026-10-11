//! Shared by `rangelab-dcfr-wasm` (single-threaded shims) and `rangelab-dcfr-adapter` (native rayon).
//! Both take the same JSON request and return the same `{"ok":...}` envelope.

mod request;
mod solve;

use serde_json::json;

pub use request::{SolveRequest, MAX_REQUEST_BYTES};

/// Solves a JSON request; `source` labels the result (e.g. "dcfr-wasm" or "dcfr-native").
pub fn solve_json(request_json: &str, source: &str) -> String {
    solve_json_with_progress(request_json, source, &mut |_, _| {})
}

/// Like `solve_json`, calling `on_progress(completed, total)` as iterations finish.
pub fn solve_json_with_progress(request_json: &str, source: &str, on_progress: &mut dyn FnMut(u32, u32)) -> String {
    let outcome = SolveRequest::parse(request_json).and_then(|request| solve::solve(&request, source, on_progress));
    match outcome {
        Ok(result) => json!({"ok": true, "result": result}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    }
}
