//! Shared by `rangelab-dcfr-wasm` (single-threaded shims) and `rangelab-dcfr-adapter` (native rayon).
//! Both take the same JSON request and return the same `{"ok":...}` envelope.

mod estimate;
mod request;
mod run;
mod solve;

use serde_json::json;

pub use estimate::{estimate, TreeEstimate};
pub use run::{plan_iterations, MIN_ITERATIONS};
pub use request::{SolveRequest, MAX_REQUEST_BYTES};
#[doc(hidden)]
pub use solve::subgame_config as subgame_config_for;

/// How a caller runs solves: `source` labels results; `max_tree_bytes` rejects trees whose estimated regret and
/// strategy storage would exceed the memory the caller can afford.
#[derive(Clone, Copy)]
pub struct SolveOptions<'a> {
    pub source: &'a str,
    pub max_tree_bytes: u64,
}

/// Solves a JSON request and returns the `{"ok":...}` envelope.
pub fn solve_json(request_json: &str, options: SolveOptions) -> String {
    solve_json_with_progress(request_json, options, &mut |_, _| {})
}

/// Like `solve_json`, calling `on_progress(completed, total)` as iterations finish.
pub fn solve_json_with_progress(request_json: &str, options: SolveOptions, on_progress: &mut dyn FnMut(u32, u32)) -> String {
    let outcome = SolveRequest::parse(request_json).and_then(|request| solve::solve(&request, options, on_progress));
    match outcome {
        Ok(result) => json!({"ok": true, "result": result}).to_string(),
        Err(error) => json!({"ok": false, "error": error}).to_string(),
    }
}
