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
/// All-in is offered when the remaining stack is at most this many pots; 0 offers it always.
pub const MAX_ALLIN_POT_RATIO: f32 = 100.0;
/// Rake as a percentage of the pot.
pub const MAX_RAKE_PERCENT: f32 = 10.0;
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
    /// Sizes for streets after the board's street, in the same depth format. A street left out is check-only
    /// (all-in at SPR <= 1), which was the only behaviour before this field existed.
    #[serde(default)]
    pub bet_sizes_by_street: Option<RawStreetSizes>,
    pub max_raises: u8,
    /// All-in is an action when the actor's remaining stack is at most this many current pots (default 1.0, the
    /// old fixed rule; 0 offers all-in everywhere).
    #[serde(default)]
    pub allin_pot_ratio: Option<f32>,
    /// Cash-game rake taken from every pot that ends in the subgame, capped per pot.
    #[serde(default)]
    pub rake: Option<RawRake>,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawRake {
    pub percent: f32,
    pub cap_chips: i32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawStreetSizes {
    #[serde(default)]
    pub turn: Option<Vec<Vec<[i32; 2]>>>,
    #[serde(default)]
    pub river: Option<Vec<Vec<[i32; 2]>>>,
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
    /// Sizes for later streets, indexed by `Street::index()`; empty for the solved street and earlier ones.
    pub later_bet_sizes: [Vec<Vec<BetSize>>; 4],
    pub max_raises: u8,
    pub allin_pot_ratio: f32,
    /// (fraction of the pot, cap in chips); `None` means no rake.
    pub rake: Option<(f32, f32)>,
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

/// Validates one street's `[depth][size]` fraction lists.
fn parse_depths(depths: &[Vec<[i32; 2]>], label: &str) -> Result<Vec<Vec<BetSize>>, String> {
    if depths.is_empty() || depths.len() > MAX_RAISES as usize || depths.iter().any(|sizes| sizes.is_empty() || sizes.len() > MAX_SIZES_PER_DEPTH) {
        return Err(format!("{label} needs 1..={MAX_RAISES} depths of 1..={MAX_SIZES_PER_DEPTH} sizes"));
    }
    depths.iter()
        .map(|sizes| sizes.iter().map(|&size| fraction(size, label)).collect::<Result<Vec<_>, _>>())
        .collect()
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
        if raw.time_budget_ms.is_some_and(|budget| !(MIN_BUDGET_MS..=MAX_BUDGET_MS).contains(&budget)) {
            return Err(format!("timeBudgetMs must be {MIN_BUDGET_MS}..={MAX_BUDGET_MS}"));
        }
        if raw.iteration_cost_ns.is_some_and(|cost| !cost.is_finite() || cost < 1.0 || cost > 1e6) {
            return Err("iterationCostNs must be between 1 and 1e6".into());
        }
        let allin_pot_ratio = raw.allin_pot_ratio.unwrap_or(1.0);
        if !allin_pot_ratio.is_finite() || !(0.0..=MAX_ALLIN_POT_RATIO).contains(&allin_pot_ratio) {
            return Err(format!("allinPotRatio must be between 0 and {MAX_ALLIN_POT_RATIO}"));
        }
        let rake = match &raw.rake {
            None => None,
            Some(rake) => {
                if !rake.percent.is_finite() || !(rake.percent > 0.0 && rake.percent <= MAX_RAKE_PERCENT) {
                    return Err(format!("rake.percent must be above 0 and at most {MAX_RAKE_PERCENT}"));
                }
                if !(1..=MAX_CHIPS).contains(&rake.cap_chips) {
                    return Err(format!("rake.capChips must be 1..={MAX_CHIPS}"));
                }
                Some((rake.percent / 100.0, rake.cap_chips as f32))
            }
        };
        if raw.history.len() > MAX_HISTORY {
            return Err(format!("history exceeds {MAX_HISTORY} actions"));
        }
        let bet_sizes = parse_depths(&raw.bet_sizes, "betSizes")?;
        let mut later_bet_sizes: [Vec<Vec<BetSize>>; 4] = std::array::from_fn(|_| Vec::new());
        if let Some(by_street) = &raw.bet_sizes_by_street {
            for (later, sizes, label) in [(Street::Turn, &by_street.turn, "betSizesByStreet.turn"), (Street::River, &by_street.river, "betSizesByStreet.river")] {
                let Some(sizes) = sizes else { continue };
                if later.index() <= street.index() {
                    return Err(format!("{label} must be a street after the board's street"));
                }
                later_bet_sizes[later.index()] = parse_depths(sizes, label)?;
            }
        }
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
            later_bet_sizes,
            max_raises: raw.max_raises,
            allin_pot_ratio,
            rake,
            history,
            time_budget_ms: raw.time_budget_ms,
            iteration_cost_ns: raw.iteration_cost_ns,
        })
    }
}
