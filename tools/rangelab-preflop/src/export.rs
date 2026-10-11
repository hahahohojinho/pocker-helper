//! Walks a trained blueprint and emits every reachable decision spot as a RangeLab preflop pack.
//!
//! Spot fields follow the app's classification (src/lib/game-state.ts): callers are players who called a raise,
//! limpers called before any raise, the opener made the first raise, the aggressor the latest, and actionSize is the
//! current highest bet in big blinds.

use std::collections::BTreeMap;

use dcfr_solver::iso::CanonicalHand;
use serde::Serialize;
use serde_json::{json, Value};

use crate::game::{Action, NodeType, State, TableSpec, MAX_PLAYERS};
use crate::trainer::{Blueprint, InfoKey};

const HANDS: usize = 169;
/// The app classifies preflop spots up to facing a 4-bet; deeper nodes are not exported.
const MAX_EXPORTED_RAISES: u8 = 3;
const PERMILLE: f32 = 1000.0;

type Reach = [[f32; HANDS]; MAX_PLAYERS];

#[derive(Clone, Copy)]
struct Step { seat: usize, action: Action, raises_before: u8, raises_after: u8 }

#[derive(Serialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct SpotKey {
    pub position: String,
    pub scenario: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opener_position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggressor_position: Option<String>,
    pub caller_positions: Vec<String>,
    pub limper_positions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_size: Option<String>,
}

pub struct ExportedSpot {
    pub key: SpotKey,
    /// Probability the spot is reached, assuming independent hands (card removal ignored).
    pub reach: f32,
    /// Per canonical hand: [fold, passive] in permille; aggressive is the remainder.
    pub mix: Vec<[u16; 2]>,
    /// Hands the deciding player never brings to this spot under the averaged strategy.
    pub unreached: usize,
}

pub struct ExportReport {
    pub spots: Vec<ExportedSpot>,
    /// Distinct betting lines that mapped to an already exported spot key; the more reachable one is kept.
    pub merged_lines: usize,
}

fn combos(hand: &str) -> f32 {
    if hand.len() == 2 { 6.0 } else if hand.ends_with('s') { 4.0 } else { 12.0 }
}

/// Canonical starting hands in dcfr-solver index order (index 0 is "22").
pub fn hand_names() -> Vec<String> {
    (0..HANDS as u8).map(|index| CanonicalHand::from_index(index).to_string()).collect()
}

struct Walker<'a> {
    blueprint: &'a Blueprint,
    weights: Vec<f32>,
    min_reach: f32,
    spots: BTreeMap<SpotKey, ExportedSpot>,
    merged_lines: usize,
}

impl Walker<'_> {
    fn range_mass(&self, reach: &[f32; HANDS]) -> f32 {
        let total: f32 = self.weights.iter().sum();
        reach.iter().zip(&self.weights).map(|(r, w)| r * w).sum::<f32>() / total
    }

    fn spot_key(&self, spec: &TableSpec, state: &State, steps: &[Step], seat: usize) -> SpotKey {
        let name = |seat: usize| spec.position_name(seat).to_string();
        // Only actions that counted as a raise (a short all-in does not reopen the betting).
        let raisers: Vec<usize> = steps.iter().filter(|step| step.raises_after > step.raises_before).map(|step| step.seat).collect();
        // Like derivePreflopSpotContext, a player who called stays a caller even after folding later.
        let mut callers: Vec<usize> = steps.iter().filter(|step| step.action == Action::Call && step.raises_before >= 1).map(|step| step.seat).collect();
        let mut limpers: Vec<usize> = steps.iter().filter(|step| step.action == Action::Call && step.raises_before == 0).map(|step| step.seat).collect();
        callers.sort_unstable();
        callers.dedup();
        limpers.sort_unstable();
        limpers.dedup();
        let scenario = match state.n_raises {
            0 if limpers.is_empty() => "unopened",
            0 => "limped",
            1 if callers.is_empty() => "single-open",
            1 => "open-with-callers",
            2 => "facing-3bet",
            _ => "facing-4bet",
        };
        SpotKey {
            position: name(seat),
            scenario: scenario.to_string(),
            opener_position: raisers.first().map(|&seat| name(seat)),
            aggressor_position: raisers.last().map(|&seat| name(seat)),
            caller_positions: callers.into_iter().map(name).collect(),
            limper_positions: limpers.into_iter().map(name).collect(),
            action_size: (state.n_raises > 0).then(|| format!("{}", state.max_bet() as f32 / 2.0)),
        }
    }

    fn record(&mut self, key: SpotKey, reach: f32, mix: Vec<[u16; 2]>, unreached: usize) {
        match self.spots.get(&key) {
            Some(existing) if existing.reach >= reach => self.merged_lines += 1,
            Some(_) => {
                self.merged_lines += 1;
                self.spots.insert(key.clone(), ExportedSpot { key, reach, mix, unreached });
            }
            None => {
                self.spots.insert(key.clone(), ExportedSpot { key, reach, mix, unreached });
            }
        }
    }

    fn walk(&mut self, state: &State, history: &mut Vec<u8>, reach: &Reach, steps: &mut Vec<Step>) {
        let spec = &self.blueprint.spec;
        let NodeType::Decision(seat) = state.node_type() else { return };
        let seat = seat as usize;
        if state.n_raises > MAX_EXPORTED_RAISES {
            return;
        }
        let node_reach: f32 = (0..state.n).map(|player| self.range_mass(&reach[player])).product();
        if node_reach < self.min_reach {
            return;
        }
        let actions = state.actions(spec);
        // Average strategy per hand; hands without an entry never reached this node during training.
        let strategies: Vec<Option<Vec<f32>>> = (0..HANDS as u8)
            .map(|bucket| self.blueprint.entries.get(&InfoKey { bucket, history: history.clone() }).map(|entry| entry.average_strategy()))
            .collect();
        // Facing a bet that covers the stack, all-in is the only way to continue, so it counts as a call.
        let forced_all_in = state.max_bet() - state.bets[seat] >= state.stacks[seat];
        let is_fold = |action: &Action| *action == Action::Fold;
        let is_passive = |action: &Action| matches!(action, Action::Check | Action::Call) || (forced_all_in && *action == Action::AllIn);
        let mut mix = Vec::with_capacity(HANDS);
        let mut unreached = 0;
        for (bucket, strategy) in strategies.iter().enumerate() {
            match strategy {
                Some(strategy) if reach[seat][bucket] > 0.0 => {
                    let share = |wanted: &dyn Fn(&Action) -> bool| actions.iter().zip(strategy).filter(|(action, _)| wanted(action)).map(|(_, p)| p).sum::<f32>();
                    let fold = (share(&is_fold) * PERMILLE).round();
                    let passive = (share(&is_passive) * PERMILLE).round().min(PERMILLE - fold);
                    mix.push([fold as u16, passive as u16]);
                }
                _ => {
                    unreached += 1;
                    mix.push([PERMILLE as u16, 0]);
                }
            }
        }
        let key = self.spot_key(spec, state, steps, seat);
        self.record(key, node_reach, mix, unreached);
        for (index, &action) in actions.iter().enumerate() {
            let mut child_reach = *reach;
            for (bucket, strategy) in strategies.iter().enumerate() {
                child_reach[seat][bucket] *= strategy.as_ref().map_or(0.0, |strategy| strategy[index]);
            }
            let child = state.apply(action);
            history.push(index as u8);
            // A forced all-in is a call for spot classification, as the app records it.
            let recorded = if action == Action::AllIn && forced_all_in { Action::Call } else { action };
            steps.push(Step { seat, action: recorded, raises_before: state.n_raises, raises_after: child.n_raises });
            self.walk(&child, history, &child_reach, steps);
            steps.pop();
            history.pop();
        }
    }
}

pub fn export(blueprint: &Blueprint, min_reach: f32) -> ExportReport {
    let names = hand_names();
    let mut walker = Walker {
        blueprint,
        weights: names.iter().map(|name| combos(name)).collect(),
        min_reach,
        spots: BTreeMap::new(),
        merged_lines: 0,
    };
    let root = State::new(&blueprint.spec);
    walker.walk(&root, &mut Vec::new(), &[[1.0; HANDS]; MAX_PLAYERS], &mut Vec::new());
    ExportReport { spots: walker.spots.into_values().collect(), merged_lines: walker.merged_lines }
}

pub struct PackMetadata<'a> {
    pub id: &'a str,
    pub generated_at: &'a str,
    pub revision: &'a str,
    pub license: &'a str,
}

/// RangeLab preflop pack: one entry per spot with per-hand [fold, passive] permille values in `hands` order.
pub fn to_pack_json(blueprint: &Blueprint, report: &ExportReport, metadata: &PackMetadata) -> Value {
    let spec = &blueprint.spec;
    json!({
        "contract": "rangelab.preflop_pack.v1",
        "id": metadata.id,
        "license": metadata.license,
        "generatedAt": metadata.generated_at,
        "tableSize": spec.players,
        "stack": spec.stack_chips / 2,
        "provenance": {
            "generator": "rangelab-preflop (derived from exinori/DCFR-SOLVER preflop)",
            "revision": metadata.revision,
            "iterations": blueprint.iterations,
            "seed": blueprint.seed,
            "model": "External-sampling MCCFR over 169 hand classes; sampled-board showdown equity with heads-up OOP pot tax 0.20",
            "config": {"raiseSizesChips": spec.raise_sizes, "sbOpenChips": spec.sb_open_size, "sbLimp": spec.sb_limp, "minAllinDepth": spec.min_allin_depth},
        },
        "hands": hand_names(),
        "mergedLines": report.merged_lines,
        "spots": report.spots.iter().map(|spot| {
            let mut value = serde_json::to_value(&spot.key).unwrap_or(Value::Null);
            value["reach"] = json!(spot.reach);
            value["unreached"] = json!(spot.unreached);
            value["mix"] = json!(spot.mix);
            value
        }).collect::<Vec<_>>(),
    })
}
