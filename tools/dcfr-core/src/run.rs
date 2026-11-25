//! Runs CFR iterations within an optional time budget.
//!
//! Native builds (panic = "unwind") stop at the deadline: the progress callback runs on the calling thread after
//! each completed iteration (outside rayon), so unwinding from it leaves the solver exactly as if `iterations` had
//! been that count. wasm32 cannot unwind, so its iteration count is planned up front from a cost model.

use dcfr_solver::cfr::SubgameSolver;

/// Fewer iterations than this give strategies too noisy to act on, so the deadline never stops earlier.
pub const MIN_ITERATIONS: u32 = 3;
/// Upper bound on progress reports per solve.
const MAX_PROGRESS_REPORTS: u32 = 100;
/// Share of the budget the wasm cost model may plan for; the rest absorbs tree building and model error.
const PLANNED_BUDGET_SHARE: f64 = 0.8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StoppedBy {
    Iterations,
    Deadline,
}

impl StoppedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            StoppedBy::Iterations => "iterations",
            StoppedBy::Deadline => "deadline",
        }
    }
}

pub struct RunReport {
    pub iterations: u32,
    pub stopped_by: StoppedBy,
    /// Measured natively; None on wasm, where the JS host times the solve.
    pub elapsed_ms: Option<u64>,
    /// Whether an extra traversal (exploitability) still fits in the budget.
    pub room_for_extra_pass: bool,
}

/// Iterations that fit `budget_ms` at `cost_ns` per work unit (action slot x live combo) per iteration.
pub fn plan_iterations(work_units: u64, budget_ms: Option<u32>, cost_ns: Option<f64>, cap: u32) -> u32 {
    match (budget_ms, cost_ns) {
        (Some(budget), Some(cost)) if work_units > 0 && cost > 0.0 => {
            let affordable = f64::from(budget) * 1e6 * PLANNED_BUDGET_SHARE / (cost * work_units as f64);
            (affordable.floor().min(f64::from(cap)) as u32).max(MIN_ITERATIONS.min(cap))
        }
        _ => cap,
    }
}

fn progress_interval(total: u32) -> u32 {
    total.div_ceil(MAX_PROGRESS_REPORTS).max(1)
}

/// Runs up to `total` iterations, reporting `(completed, total)`; with a budget on native builds, stops early.
pub fn run(solver: &mut SubgameSolver, total: u32, budget_ms: Option<u32>, on_progress: &mut dyn FnMut(u32, u32)) -> RunReport {
    #[cfg(all(panic = "unwind", not(target_arch = "wasm32")))]
    if let Some(budget) = budget_ms {
        return deadline::run(solver, total, std::time::Duration::from_millis(u64::from(budget)), on_progress);
    }
    let _ = budget_ms;
    let every = progress_interval(total);
    solver.solve_with_report_interval(every, |done, _| on_progress(done.min(total), total));
    RunReport { iterations: total, stopped_by: StoppedBy::Iterations, elapsed_ms: None, room_for_extra_pass: true }
}

#[cfg(all(panic = "unwind", not(target_arch = "wasm32")))]
mod deadline {
    use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
    use std::time::{Duration, Instant};

    use dcfr_solver::cfr::SubgameSolver;

    use super::{progress_interval, RunReport, StoppedBy, MIN_ITERATIONS};

    /// Unwinding payload; `resume_unwind` skips the panic hook, so nothing is printed.
    struct DeadlineReached;

    pub fn run(solver: &mut SubgameSolver, total: u32, budget: Duration, on_progress: &mut dyn FnMut(u32, u32)) -> RunReport {
        let start = Instant::now();
        let deadline = start + budget;
        let every = progress_interval(total);
        let mut completed = 0;
        let mut last = start;
        // Smoothed iteration time; the first callback also includes tree building, so it seeds nothing.
        let mut iteration_time: Option<Duration> = None;
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            solver.solve_with_report_interval(1, |iteration, _| {
                completed = iteration;
                let now = Instant::now();
                let step = now - last;
                last = now;
                if iteration >= 2 {
                    iteration_time = Some(iteration_time.map_or(step, |previous| previous.mul_f64(0.7) + step.mul_f64(0.3)));
                }
                if iteration % every == 0 || iteration == total {
                    on_progress(iteration.min(total), total);
                }
                // Stop if one more iteration plus the post-solve EV pass would cross the deadline.
                if let Some(estimate) = iteration_time {
                    if iteration >= MIN_ITERATIONS && iteration < total && now + estimate * 2 > deadline {
                        resume_unwind(Box::new(DeadlineReached));
                    }
                }
            })
        }));
        let stopped_by = match outcome {
            Ok(()) => StoppedBy::Iterations,
            Err(payload) if payload.is::<DeadlineReached>() => StoppedBy::Deadline,
            Err(payload) => resume_unwind(payload),
        };
        let now = Instant::now();
        // The exploitability pass measured ~1/4 of an iteration (about 50 ms vs 210 ms on a wide flop).
        let room_for_extra_pass = iteration_time.is_some_and(|estimate| now + estimate / 2 <= deadline);
        RunReport { iterations: completed, stopped_by, elapsed_ms: Some((now - start).as_millis() as u64), room_for_extra_pass }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_iterations_from_budget_and_cost() {
        // 4000 ms x 0.8 / (100 ns x 1,000,000 units) = 32 iterations.
        assert_eq!(plan_iterations(1_000_000, Some(4000), Some(100.0), 500), 32);
        assert_eq!(plan_iterations(1_000_000, Some(4000), Some(100.0), 20), 20);
        assert_eq!(plan_iterations(1_000_000_000, Some(500), Some(100.0), 500), MIN_ITERATIONS);
        assert_eq!(plan_iterations(1_000_000_000, Some(500), Some(100.0), 2), 2);
        assert_eq!(plan_iterations(1_000_000, None, Some(100.0), 500), 500);
        assert_eq!(plan_iterations(1_000_000, Some(4000), None, 500), 500);
    }
}
