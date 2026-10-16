//! Parses and validates a multiway solve request.

use dcfr_solver::card::{combo_index, parse_card, parse_cards, Hand};
use dcfr_solver::range::Range;
use serde::Deserialize;

use crate::game::{Action, MAX_PLAYERS};

pub const MAX_ITERATIONS: u32 = 5000;
pub const MAX_RAISES: u8 = 4;
pub const MAX_SIZES_PER_DEPTH: usize = 6;
pub const MAX_HISTORY: usize = 30;
pub const MIN_BUDGET_MS: u32 = 200;
pub const MAX_BUDGET_MS: u32 = 120_000;
pub const MAX_REQUEST_BYTES: usize = 256 * 1024;
pub const MAX_CHIPS: i32 = 10_000_000;
/// Largest bet or raise as a multiple of the pot it is sized from (same bound as dcfr-core).
pub const MAX_SIZE_RATIO: i64 = 50;
const MAX_FRACTION_TERM: i32 = 1_000_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRequest {
    board: String,
    hero: String,
    /// Hero's index in `players`.
    hero_seat: usize,
    /// In postflop action order.
    players: Vec<RawPlayer>,
    pot: i32,
    iterations: u32,
    bet_sizes: Vec<Vec<[i32; 2]>>,
    max_raises: u8,
    #[serde(default)]
    history: Vec<RawStep>,
    #[serde(default)]
    time_budget_ms: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPlayer {
    range: String,
    /// Chips at the start of the street.
    stack: i32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawStep {
    action: String,
    #[serde(default)]
    size: Option<[i32; 2]>,
}

pub struct MultiwayRequest {
    pub board: Hand,
    pub hero_index: usize,
    pub hero_seat: usize,
    pub ranges: Vec<Vec<f64>>,
    pub pot: i32,
    pub stacks: [i32; MAX_PLAYERS],
    pub iterations: u32,
    pub bet_sizes: Vec<Vec<[i32; 2]>>,
    pub max_raises: u8,
    pub history: Vec<Action>,
    pub time_budget_ms: Option<u32>,
}

fn fraction(value: [i32; 2], label: &str) -> Result<[i32; 2], String> {
    let [numerator, denominator] = value;
    if numerator <= 0 || denominator <= 0 || numerator > MAX_FRACTION_TERM || denominator > MAX_FRACTION_TERM || numerator as i64 > denominator as i64 * MAX_SIZE_RATIO {
        return Err(format!("{label} must be a positive fraction of at most {MAX_SIZE_RATIO}x the pot"));
    }
    Ok(value)
}

fn parse_step(step: &RawStep) -> Result<Action, String> {
    match (step.action.as_str(), step.size) {
        ("check", None) => Ok(Action::Check),
        ("call", None) => Ok(Action::Call),
        ("fold", None) => Ok(Action::Fold),
        ("allin", None) => Ok(Action::AllIn),
        ("bet" | "raise", Some(size)) => Ok(Action::Bet(fraction(size, "history size")?)),
        _ => Err("invalid history step".into()),
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

impl MultiwayRequest {
    pub fn parse(json: &str) -> Result<MultiwayRequest, String> {
        if json.len() > MAX_REQUEST_BYTES {
            return Err(format!("request exceeds {MAX_REQUEST_BYTES} bytes"));
        }
        let raw: RawRequest = serde_json::from_str(json).map_err(|error| format!("invalid request: {error}"))?;
        let cards = parse_cards(&raw.board).ok_or("invalid board")?;
        if cards.len() != 5 {
            return Err("the multiway solver supports the river (5 board cards) only".into());
        }
        let board = cards.iter().fold(Hand::new(), |hand, &card| hand.add(card));
        if board.count() != 5 {
            return Err("board cards must differ".into());
        }
        if !(2..=MAX_PLAYERS).contains(&raw.players.len()) {
            return Err(format!("players must contain 2..={MAX_PLAYERS} entries"));
        }
        if raw.hero_seat >= raw.players.len() {
            return Err("heroSeat must index players".into());
        }
        let mut ranges = Vec::with_capacity(raw.players.len());
        let mut stacks = [0; MAX_PLAYERS];
        for (seat, player) in raw.players.iter().enumerate() {
            let range = Range::parse(&player.range).ok_or_else(|| format!("invalid range for player {seat}"))?;
            if range.weights.iter().any(|weight| !(0.0..=1.0).contains(weight)) {
                return Err("range weights must be between 0 and 1".into());
            }
            if !(1..=MAX_CHIPS).contains(&player.stack) {
                return Err(format!("stacks must be 1..={MAX_CHIPS} chips"));
            }
            ranges.push(range.weights.iter().map(|&weight| f64::from(weight)).collect::<Vec<f64>>());
            stacks[seat] = player.stack;
        }
        if !(1..=MAX_CHIPS).contains(&raw.pot) {
            return Err(format!("pot must be 1..={MAX_CHIPS} chips"));
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
        if raw.history.len() > MAX_HISTORY {
            return Err(format!("history exceeds {MAX_HISTORY} actions"));
        }
        let bet_sizes = raw.bet_sizes.iter()
            .map(|sizes| sizes.iter().map(|&size| fraction(size, "bet size")).collect::<Result<Vec<_>, _>>())
            .collect::<Result<Vec<_>, _>>()?;
        let history = raw.history.iter().map(parse_step).collect::<Result<Vec<_>, _>>()?;
        let hero_index = parse_hero(&raw.hero, board)?;
        if !(ranges[raw.hero_seat][hero_index] > 0.0) {
            return Err("hero combo is not in Hero's range".into());
        }
        Ok(MultiwayRequest {
            board, hero_index, hero_seat: raw.hero_seat, ranges, pot: raw.pot, stacks, iterations: raw.iterations,
            bet_sizes, max_raises: raw.max_raises, history, time_budget_ms: raw.time_budget_ms,
        })
    }
}
