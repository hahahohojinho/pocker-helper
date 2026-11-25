//! In-browser DCFR subgame solver for RangeLab.
//!
//! JS calls `alloc`, writes a UTF-8 JSON request, calls `solve`, then reads `result_ptr`/`result_len`.
//! The result is `{"ok":true,"result":{...}}` or `{"ok":false,"error":"..."}`. Panics trap in wasm.

use std::cell::RefCell;

use serde_json::json;

/// wasm32 memory tops out at 4 GiB and browsers often refuse much more than 2 GiB, so trees stay well below that.
const OPTIONS: rangelab_dcfr_core::SolveOptions = rangelab_dcfr_core::SolveOptions { source: "dcfr-wasm", max_tree_bytes: 1536 * 1024 * 1024 };

/// Solves a JSON request and returns the JSON envelope; usable natively for tests and benchmarks.
pub fn solve_json(request_json: &str) -> String {
    rangelab_dcfr_core::solve_json(request_json, OPTIONS)
}

/// Like `solve_json`, calling `on_progress(completed, total)` as iterations finish.
pub fn solve_json_with_progress(request_json: &str, on_progress: &mut dyn FnMut(u32, u32)) -> String {
    rangelab_dcfr_core::solve_json_with_progress(request_json, OPTIONS, on_progress)
}

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Allocates `len` bytes in wasm memory for the request.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Frees a buffer returned by `alloc`.
///
/// # Safety
/// `pointer` must come from `alloc(len)` and must not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn dealloc(pointer: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(pointer, 0, len));
}

/// Solves the UTF-8 request at `pointer..pointer+len` and stores the response for `result_ptr`/`result_len`.
///
/// # Safety
/// `pointer` must reference `len` initialized bytes written by the caller.
#[no_mangle]
pub unsafe extern "C" fn solve(pointer: *const u8, len: usize) {
    let bytes = std::slice::from_raw_parts(pointer, len);
    let response = match std::str::from_utf8(bytes) {
        Ok(text) => solve_json_with_progress(text, &mut report_progress),
        Err(_) => json!({"ok": false, "error": "request is not UTF-8"}).to_string(),
    };
    RESULT.with(|result| *result.borrow_mut() = response.into_bytes());
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    /// Provided by the JS host when instantiating the module.
    fn progress(completed: u32, total: u32);
}

#[cfg(target_arch = "wasm32")]
fn report_progress(completed: u32, total: u32) {
    // SAFETY: a plain JS import taking two integers; it cannot access wasm memory.
    unsafe { progress(completed, total) }
}

#[cfg(not(target_arch = "wasm32"))]
fn report_progress(_completed: u32, _total: u32) {}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|result| result.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn result_len() -> usize {
    RESULT.with(|result| result.borrow().len())
}

// Solves use seeded RNGs; this backend only exists so rand's getrandom dependency links on wasm32.
#[cfg(target_arch = "wasm32")]
fn unavailable_entropy(_buffer: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}

#[cfg(target_arch = "wasm32")]
getrandom::register_custom_getrandom!(unavailable_entropy);
