//! External-sampling MCCFR trainer and blueprint storage (see NOTICE.md for provenance).

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use dcfr_solver::card::{Card, Hand, NUM_CARDS};
use dcfr_solver::infoset::RegretEntry;
use dcfr_solver::iso::canonical_hand;
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};

use crate::game::{NodeType, State, TableSpec, MAX_PLAYERS};

const BLUEPRINT_MAGIC: &[u8; 8] = b"RLPF\x00\x00\x00\x01";
/** Bounds for validating a blueprint read from disk (real trees stay far below them). */
const MAX_ACTIONS: usize = 16;
const MAX_HISTORY: usize = 64;
const MAX_PREALLOCATED_ENTRIES: usize = 1 << 20;
const HAND_BUCKETS: u8 = 169;

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct InfoKey {
    /// Canonical starting hand index, 0..169.
    pub bucket: u8,
    /// Action indices taken from the root.
    pub history: Vec<u8>,
}

pub struct Blueprint {
    pub spec: TableSpec,
    pub entries: HashMap<InfoKey, RegretEntry>,
    pub iterations: u64,
    pub seed: u64,
}

impl Blueprint {
    pub fn new(spec: TableSpec, seed: u64) -> Blueprint {
        Blueprint { spec, entries: HashMap::new(), iterations: 0, seed }
    }

    pub fn write_to<W: Write>(&self, w: &mut W) -> std::io::Result<()> {
        w.write_all(BLUEPRINT_MAGIC)?;
        w.write_u8(self.spec.players as u8)?;
        w.write_i32::<LittleEndian>(self.spec.stack_chips)?;
        w.write_u8(self.spec.raise_sizes.len() as u8)?;
        for sizes in &self.spec.raise_sizes {
            w.write_u8(sizes.len() as u8)?;
            for &size in sizes {
                w.write_i32::<LittleEndian>(size)?;
            }
        }
        w.write_u8(self.spec.sb_limp as u8)?;
        w.write_i32::<LittleEndian>(self.spec.sb_open_size.unwrap_or(-1))?;
        w.write_u8(self.spec.min_allin_depth)?;
        w.write_u64::<LittleEndian>(self.seed)?;
        w.write_u64::<LittleEndian>(self.iterations)?;
        w.write_u64::<LittleEndian>(self.entries.len() as u64)?;
        for (key, entry) in &self.entries {
            w.write_u8(key.bucket)?;
            w.write_u16::<LittleEndian>(key.history.len() as u16)?;
            w.write_all(&key.history)?;
            w.write_u16::<LittleEndian>(entry.n_actions as u16)?;
            for &value in entry.regrets.iter().chain(entry.cum_strategy.iter()) {
                w.write_f32::<LittleEndian>(value)?;
            }
        }
        Ok(())
    }

    pub fn read_from<R: Read>(r: &mut R) -> std::io::Result<Blueprint> {
        let invalid = |message: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, message.to_string());
        let mut magic = [0u8; 8];
        r.read_exact(&mut magic)?;
        if &magic != BLUEPRINT_MAGIC {
            return Err(invalid("not a RangeLab preflop blueprint"));
        }
        let players = r.read_u8()? as usize;
        let stack_chips = r.read_i32::<LittleEndian>()?;
        let depth_count = r.read_u8()? as usize;
        let mut raise_sizes = Vec::with_capacity(depth_count);
        for _ in 0..depth_count {
            let count = r.read_u8()? as usize;
            raise_sizes.push((0..count).map(|_| r.read_i32::<LittleEndian>()).collect::<std::io::Result<Vec<_>>>()?);
        }
        let sb_limp = r.read_u8()? != 0;
        let sb_open = r.read_i32::<LittleEndian>()?;
        let min_allin_depth = r.read_u8()?;
        let spec = TableSpec { players, stack_chips, raise_sizes, sb_limp, sb_open_size: (sb_open >= 0).then_some(sb_open), min_allin_depth };
        // Only specs this crate generates are accepted, so a corrupted header cannot drive the game arithmetic.
        let expected = (stack_chips > 0 && stack_chips % 2 == 0).then(|| TableSpec::for_stack(players, (stack_chips / 2) as u32).ok()).flatten();
        if expected.as_ref() != Some(&spec) {
            return Err(invalid("blueprint table spec is not one rangelab-preflop produces"));
        }
        let seed = r.read_u64::<LittleEndian>()?;
        let iterations = r.read_u64::<LittleEndian>()?;
        let count = r.read_u64::<LittleEndian>()? as usize;
        // The count comes from the file, so it only sizes a bounded preallocation.
        let mut entries = HashMap::with_capacity(count.min(MAX_PREALLOCATED_ENTRIES));
        for _ in 0..count {
            let bucket = r.read_u8()?;
            let length = r.read_u16::<LittleEndian>()? as usize;
            if bucket >= HAND_BUCKETS || length > MAX_HISTORY {
                return Err(invalid("blueprint entry has an invalid hand or history length"));
            }
            let mut history = vec![0u8; length];
            r.read_exact(&mut history)?;
            let n_actions = r.read_u16::<LittleEndian>()? as usize;
            if !(1..=MAX_ACTIONS).contains(&n_actions) {
                return Err(invalid("blueprint entry has an invalid action count"));
            }
            let mut values = (0..n_actions * 2).map(|_| r.read_f32::<LittleEndian>()).collect::<std::io::Result<Vec<_>>>()?;
            if values.iter().any(|value| !value.is_finite()) {
                return Err(invalid("blueprint entry contains a non-finite value"));
            }
            let cum_strategy = values.split_off(n_actions);
            entries.insert(InfoKey { bucket, history }, RegretEntry { regrets: values, cum_strategy, n_actions });
        }
        if r.read(&mut [0u8; 1])? != 0 {
            return Err(invalid("blueprint has trailing data"));
        }
        Ok(Blueprint { spec, entries, iterations, seed })
    }

    /// Writes to a temporary file and renames it over `path`, so an interrupted save never corrupts a checkpoint.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let mut temporary = path.as_os_str().to_owned();
        temporary.push(format!(".{}.tmp", std::process::id()));
        let temporary = std::path::PathBuf::from(temporary);
        {
            let mut writer = BufWriter::new(File::create(&temporary)?);
            self.write_to(&mut writer)?;
            writer.flush()?;
            // Durable before the rename, so a crash cannot leave a truncated checkpoint in place.
            writer.get_ref().sync_all()?;
        }
        std::fs::rename(&temporary, path)
    }

    pub fn load(path: &Path) -> std::io::Result<Blueprint> {
        Blueprint::read_from(&mut BufReader::new(File::open(path)?))
    }
}

pub struct Trainer {
    pub blueprint: Blueprint,
    rng: SmallRng,
    /// Board samples averaged at each showdown terminal.
    pub board_samples: usize,
    /// Fraction of the pot moved from the out-of-position to the in-position player at heads-up showdowns, scaled
    /// by their positional gap (upstream default 0.20).
    pub oop_pot_tax: f32,
}

impl Trainer {
    /// Seeds from the blueprint's seed and iteration count, so a resumed run continues on a fresh, reproducible stream.
    pub fn new(blueprint: Blueprint) -> Trainer {
        let rng = SmallRng::seed_from_u64(blueprint.seed ^ blueprint.iterations.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        Trainer { blueprint, rng, board_samples: 10, oop_pot_tax: 0.20 }
    }

    pub fn train(&mut self, iterations: u64) {
        let players = self.blueprint.spec.players;
        let root = State::new(&self.blueprint.spec);
        for _ in 0..iterations {
            let holes = self.deal_holes(players);
            let traverser = (self.blueprint.iterations % players as u64) as u8;
            let mut state = root.clone();
            state.holes = holes;
            let mut history = Vec::with_capacity(32);
            self.cfr_external(&state, traverser, &mut history);
            self.blueprint.iterations += 1;
        }
    }

    fn deal_holes(&mut self, players: usize) -> [Hand; MAX_PLAYERS] {
        let mut holes = [Hand::new(); MAX_PLAYERS];
        let mut dead = Hand::new();
        for hole in holes.iter_mut().take(players) {
            let first = self.draw_excluding(dead);
            dead = dead.add(first);
            let second = self.draw_excluding(dead);
            dead = dead.add(second);
            *hole = Hand::new().add(first).add(second);
        }
        holes
    }

    fn draw_excluding(&mut self, dead: Hand) -> Card {
        loop {
            let card = self.rng.gen_range(0..NUM_CARDS as u8);
            if !dead.contains(card) {
                return card;
            }
        }
    }

    fn sample_board(&mut self, mut dead: Hand) -> Hand {
        let mut board = Hand::new();
        for _ in 0..5 {
            let card = self.draw_excluding(dead);
            board = board.add(card);
            dead = dead.add(card);
        }
        board
    }

    fn showdown_value(&mut self, state: &State, traverser: u8) -> f32 {
        let spec = &self.blueprint.spec;
        let dead = state.holes[..state.n].iter().fold(Hand::new(), |dead, &hole| dead.union(hole));
        // Heads-up showdowns move a share of the pot to the player in position (upstream model).
        let tax = if self.oop_pot_tax > 0.001 && state.active_count() == 2 {
            let active: Vec<usize> = (0..state.n).filter(|&i| !state.folded[i]).collect();
            let (ip, oop) = if spec.postflop_rank(active[0]) > spec.postflop_rank(active[1]) { (active[0], active[1]) } else { (active[1], active[0]) };
            let gap = (spec.postflop_rank(ip) - spec.postflop_rank(oop)) as f32;
            let max_gap = (spec.players - 1) as f32;
            Some((ip, oop, state.pot() as f32 * self.oop_pot_tax * gap / max_gap))
        } else {
            None
        };
        let mut total = 0.0;
        for _ in 0..self.board_samples {
            let board = self.sample_board(dead);
            let mut payoffs = state.payoff_showdown(board);
            if let Some((ip, oop, amount)) = tax {
                payoffs[oop] -= amount;
                payoffs[ip] += amount;
            }
            total += payoffs[traverser as usize];
        }
        total / self.board_samples as f32
    }

    fn cfr_external(&mut self, state: &State, traverser: u8, history: &mut Vec<u8>) -> f32 {
        match state.node_type() {
            NodeType::TerminalFold(winner) => state.payoff_fold(winner)[traverser as usize],
            NodeType::TerminalShowdown => self.showdown_value(state, traverser),
            NodeType::Decision(player) => {
                let actions = state.actions(&self.blueprint.spec);
                let cards: Vec<Card> = state.holes[player as usize].iter().collect();
                let key = InfoKey { bucket: canonical_hand(cards[0], cards[1]).index(), history: history.clone() };
                let strategy = self.blueprint.entries.entry(key.clone()).or_insert_with(|| RegretEntry::new(actions.len())).current_strategy();
                if player != traverser {
                    let index = sample_action(&strategy, &mut self.rng);
                    history.push(index as u8);
                    let value = self.cfr_external(&state.apply(actions[index]), traverser, history);
                    history.pop();
                    return value;
                }
                let mut values = vec![0.0f32; actions.len()];
                let mut node_value = 0.0;
                for (index, &action) in actions.iter().enumerate() {
                    history.push(index as u8);
                    values[index] = self.cfr_external(&state.apply(action), traverser, history);
                    history.pop();
                    node_value += strategy[index] * values[index];
                }
                // CFR+ regret flooring with linearly weighted strategy accumulation, as upstream.
                let weight = self.blueprint.iterations as f32 + 1.0;
                if let Some(entry) = self.blueprint.entries.get_mut(&key) {
                    for index in 0..actions.len() {
                        entry.regrets[index] = (entry.regrets[index] + values[index] - node_value).max(0.0);
                        entry.cum_strategy[index] += weight * strategy[index];
                    }
                }
                node_value
            }
        }
    }
}

fn sample_action(strategy: &[f32], rng: &mut SmallRng) -> usize {
    let target: f32 = rng.gen();
    let mut cumulative = 0.0;
    for (index, &probability) in strategy.iter().enumerate() {
        cumulative += probability;
        if target < cumulative {
            return index;
        }
    }
    strategy.len() - 1
}
