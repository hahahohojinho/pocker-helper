//! Parses and validates a solve request coming from the browser.

use dcfr_solver::card::{combo_index, parse_card, parse_cards, Hand};
use dcfr_solver::game::{Action, BetSize, Street};
use dcfr_solver::range::Range;
use serde::Deserialize;

pub const MAX_ITERATIONS: u32 = 5000;
pub const MAX_RAISES: u8 = 4;
pub const MAX_SIZES_PER_DEPTH: usize = 6;
pub const MAX_HISTORY: usize = 20;
pub const MIN_BUDGET_MS: u32 = 200;
pub const MAX_BUDGET_MS: u32 = 120_000;
/// Request JSON limit; exact-combo ranges stay far below this (1326 combos is ~15KB per range).
pub const MAX_REQUEST_BYTES: usize = 256 * 1024;
/// Chip limit for pot and stacks.
pub const MAX_CHIPS: i32 = 10_000_000;
/// Largest bet or raise as a multiple of the pot it is sized from. dcfr-solver casts `frac * potAfterCall` to i32
/// before clamping to the stack; potAfterCall <= 4 * MAX_CHIPS, so 50x keeps that product below i32::MAX.
pub const MAX_SIZE_RATIO: i64 = 50;
const MAX_FRACTION_TERM: i32 = 1_000_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawRequest {
    pub board: String,
    /// Required for a single-node solve; omitted when every combo of several nodes is exported.
    #[serde(default)]
    pub hero: Option<String>,
    pub oop_range: String,
    pub ip_range: String,
    /// Chips at the start of the street; the caller chooses the chip unit (RangeLab uses 1/100 BB).
    pub pot: i32,
    pub stacks: [i32; 2],
    pub iterations: u32,
    /// `bet_sizes[depth]` lists `[numerator, denominator]` fractions of the pot (depth 0 = bet, 1 = first raise, ...).
    pub bet_sizes: Vec<Vec<[i32; 2]>>,
    pub max_raises: u8,
    #[serde(default)]
    pub history: Vec<RawStep>,
    /// Wall-clock budget for the solve; `iterations` is then an upper bound.
    #[serde(default)]
    pub time_budget_ms: Option<u32>,
    /// wasm only: measured nanoseconds per work unit (action slot x live combo) per iteration, for planning.
    #[serde(default)]
    pub iteration_cost_ns: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawStep {
    pub action: String,
    /// Fraction for "bet"/"raise", using the same pot basis as `bet_sizes`.
    #[serde(default)]
    pub size: Option<[i32; 2]>,
}

pub struct SolveRequest {
    pub board: Hand,
    pub street: Street,
    pub hero_index: Option<usize>,
    pub ranges: [Range; 2],
    pub pot: i32,
    pub stacks: [i32; 2],
    pub iterations: u32,
    pub bet_sizes: Vec<Vec<BetSize>>,
    pub max_raises: u8,
    pub history: Vec<Action>,
    pub time_budget_ms: Option<u32>,
    pub iteration_cost_ns: Option<f64>,
}

fn fraction(value: [i32; 2], label: &str) -> Result<BetSize, String> {
    let [numerator, denominator] = value;
    if numerator <= 0 || denominator <= 0 || numerator > MAX_FRACTION_TERM || denominator > MAX_FRACTION_TERM || numerator as i64 > denominator as i64 * MAX_SIZE_RATIO {
        return Err(format!("{label} must be a positive fraction of at most {MAX_SIZE_RATIO}x the pot"));
    }
    Ok(BetSize::Frac(numerator, denominator))
}

pub(crate) fn parse_step(step: &RawStep) -> Result<Action, String> {
    match (step.action.as_str(), step.size) {
        ("check", None) => Ok(Action::Check),
        ("call", None) => Ok(Action::Call),
        ("fold", None) => Ok(Action::Fold),
        ("allin", None) => Ok(Action::AllIn),
        ("bet" | "raise", Some(size)) => Ok(Action::Bet(fraction(size, "history size")?)),
        (action, _) => Err(format!("invalid history step: {action}")),
    }
}

fn parse_hero(hero: &str, board: Hand) -> Result<usize, String> {
    if hero.len() != 4 || !hero.is_ascii() {
        return Err("hero must contain two cards".into());
    }
    let first = parse_card(&hero[0..2]).ok_or("invalid hero card")?;
    let second = parse_card(&hero[2..4]).ok_or("invalid hero card")?;
    if first == second || board.contains(first) || board.contains(second) {
        return Err("hero cards must differ from each other and from the board".into());
    }
    Ok(combo_index(first, second) as usize)
}

impl SolveRequest {
    pub fn parse(json: &str) -> Result<SolveRequest, String> {
        if json.len() > MAX_REQUEST_BYTES {
            return Err(format!("request exceeds {MAX_REQUEST_BYTES} bytes"));
        }
        let raw: RawRequest = serde_json::from_str(json).map_err(|error| format!("invalid request: {error}"))?;
        let cards = parse_cards(&raw.board).ok_or("invalid board")?;
        let street = match cards.len() {
            3 => Street::Flop,
            4 => Street::Turn,
            5 => Street::River,
            _ => return Err("board must contain 3, 4, or 5 cards".into()),
        };
        let mut board = Hand::new();
        for card in cards {
            board = board.add(card);
        }
        let oop = Range::parse(&raw.oop_range).ok_or("invalid OOP range")?;
        let ip = Range::parse(&raw.ip_range).ok_or("invalid IP range")?;
        // Range::parse accepts any f32 (including nan, inf, and negatives); the solver and the memory estimate need 0..=1.
        if [&oop, &ip].iter().any(|range| range.weights.iter().any(|weight| !(0.0..=1.0).contains(weight))) {
            return Err("range weights must be between 0 and 1".into());
        }
        if !(1..=MAX_CHIPS).contains(&raw.pot) || raw.stacks.iter().any(|stack| !(1..=MAX_CHIPS).contains(stack)) {
            return Err(format!("pot and stacks must be 1..={MAX_CHIPS} chips"));
        }
        if !(1..=MAX_ITERATIONS).contains(&raw.iterations) {
            return Err(format!("iterations must be 1..={MAX_ITERATIONS}"));
        }
        if !(1..=MAX_RAISES).contains(&raw.max_raises) {
            return Err(format!("maxRaises must be 1..={MAX_RAISES}"));
        }
        if raw.bet_sizes.is_empty() || raw.bet_sizes.len() > MAX_RAISES as usize || raw.bet_sizes.iter().any(|sizes| sizes.is_empty() || sizes.len() > MAX_SIZES_PER_DEPTH) {
            return Err(format!("betSizes needs 1..={MAX_RAISES} depths of 1..={MAX_SIZES_PER_DEPTH} sizes"));
        }
        if raw.time_budget_ms.is_some_and(|budget| !(MIN_BUDGET_MS..=MAX_BUDGET_MS).contains(&budget)) {
            return Err(format!("timeBudgetMs must be {MIN_BUDGET_MS}..={MAX_BUDGET_MS}"));
        }
        if raw.iteration_cost_ns.is_some_and(|cost| !cost.is_finite() || cost < 1.0 || cost > 1e6) {
            return Err("iterationCostNs must be between 1 and 1e6".into());
        }
        if raw.history.len() > MAX_HISTORY {
            return Err(format!("history exceeds {MAX_HISTORY} actions"));
        }
        let bet_sizes = raw.bet_sizes.iter()
            .map(|sizes| sizes.iter().map(|&size| fraction(size, "bet size")).collect::<Result<Vec<_>, _>>())
            .collect::<Result<Vec<_>, _>>()?;
        let history = raw.history.iter().map(parse_step).collect::<Result<Vec<_>, _>>()?;
        Ok(SolveRequest {
            board,
            street,
            hero_index: raw.hero.as_deref().map(|hero| parse_hero(hero, board)).transpose()?,
            ranges: [oop, ip],
            pot: raw.pot,
            stacks: raw.stacks,
            iterations: raw.iterations,
            bet_sizes,
            max_raises: raw.max_raises,
            history,
            time_budget_ms: raw.time_budget_ms,
            iteration_cost_ns: raw.iteration_cost_ns,
        })
    }
}
