use dcfr_solver::card::{combo_index, parse_card, parse_cards, Hand};
use dcfr_solver::cfr::{DcfrMode, SubgameConfig, SubgameSolver};
use dcfr_solver::game::{Action, BetConfig, BetSize, Street, OOP};
use dcfr_solver::range::Range;
use serde_json::json;
use std::collections::BTreeMap;
use std::env;
use std::sync::Arc;

fn option(name: &str) -> Result<String, String> {
    let args: Vec<String> = env::args().collect();
    let index = args.iter().position(|value| value == name).ok_or_else(|| format!("missing {name}"))?;
    args.get(index + 1).cloned().ok_or_else(|| format!("missing value for {name}"))
}

fn integer(name: &str) -> Result<i32, String> {
    option(name)?.parse().map_err(|_| format!("invalid {name}"))
}

fn percentage(name: &str) -> Result<i32, String> {
    let value = integer(name)?;
    if !(1..=1000).contains(&value) { return Err(format!("invalid {name}")); }
    Ok(value)
}

fn normalized_action(action: Action) -> &'static str {
    match action {
        Action::Fold => "fold",
        Action::Check => "check",
        Action::Call => "call",
        Action::Bet(_) | Action::AllIn => "bet",
    }
}

fn run() -> Result<(), String> {
    let board_text = option("--board")?;
    let cards = parse_cards(&board_text).ok_or("invalid board")?;
    let street = match cards.len() {
        3 => Street::Flop,
        4 => Street::Turn,
        5 => Street::River,
        _ => return Err("board must contain 3, 4, or 5 cards".into()),
    };
    let mut board = Hand::new();
    for card in cards { board = board.add(card); }

    let hero = option("--hero")?;
    if hero.len() != 4 { return Err("hero must contain two cards".into()); }
    let hero_one = parse_card(&hero[0..2]).ok_or("invalid hero card")?;
    let hero_two = parse_card(&hero[2..4]).ok_or("invalid hero card")?;
    let hero_index = combo_index(hero_one, hero_two) as usize;

    let oop_range = Range::parse(&option("--oop-range")?).ok_or("invalid OOP range")?;
    let ip_range = Range::parse(&option("--ip-range")?).ok_or("invalid IP range")?;
    let pot = integer("--pot")?;
    let stack = integer("--stack")?;
    let iterations = integer("--iterations")?;
    if pot <= 0 || stack <= 0 || !(1..=5000).contains(&iterations) { return Err("invalid solve limits".into()); }

    let bet = percentage("--bet-percent")?;
    let raise = percentage("--raise-percent")?;
    let street_index = street.index();
    let mut sizes: [Vec<Vec<BetSize>>; 4] = std::array::from_fn(|_| Vec::new());
    sizes[street_index] = vec![vec![BetSize::Frac(bet, 100)], vec![BetSize::Frac(raise, 100)]];
    let bet_config = BetConfig {
        sizes,
        max_raises: 1,
        allin_threshold: 1.0,
        allin_pot_ratio: 1.0,
        no_donk: false,
        geometric_2bets: false,
    };
    let config = SubgameConfig {
        board,
        pot,
        stacks: [stack, stack],
        ranges: [oop_range, ip_range],
        iterations: iterations as u32,
        street,
        warmup_frac: 0.0,
        bet_config: Some(Arc::new(bet_config)),
        dcfr: true,
        cfr_plus: true,
        skip_cum_strategy: false,
        dcfr_mode: DcfrMode::Standard,
        depth_limit: None,
        rake_pct: 0.0,
        rake_cap: 0.0,
        exploration_eps: 0.0,
        entropy_bonus: 0.0,
        entropy_anneal: false,
        entropy_root_only: false,
        softmax_temp: 0.0,
        current_iteration: 0,
        use_iso: true,
        opp_dilute: 0.0,
        rm_floor: 0.0,
        alternating: false,
        t_weight: false,
        frozen_root: None,
        check_bias: 0.0,
        pref_passive_delta: 1.0,
        pref_beta: 0.0,
        pref_beta_all_nodes: false,
        pruning: false,
        combo_check_bias: None,
        frozen_warmup: 0,
        unfreeze_decay: 1.0,
    };

    let mut solver = SubgameSolver::new(config);
    solver.solve();
    let strategy = solver.root_strategy(hero_index).ok_or("hero combo is absent from the root strategy")?;
    let action_evs = solver.compute_action_evs(&[], OOP).ok_or("root action EVs are unavailable")?;
    if action_evs.len() != strategy.len() { return Err("strategy/action EV mismatch".into()); }

    let mut grouped: BTreeMap<&str, (f64, f64)> = BTreeMap::new();
    for (position, (action, frequency)) in strategy.iter().enumerate() {
        let ev = action_evs.get(position).map(|(_, values)| values[hero_index]).ok_or("missing action EV")?;
        let key = normalized_action(*action);
        let entry = grouped.entry(key).or_insert((0.0, 0.0));
        entry.0 += *frequency as f64;
        entry.1 += *frequency as f64 * ev as f64;
    }
    let actions: Vec<_> = grouped.into_iter().map(|(action, (frequency, weighted_ev))| {
        let ev = if frequency > 0.0 { weighted_ev / frequency } else { 0.0 };
        json!({"action": action, "frequency": frequency, "ev": ev / 100.0})
    }).collect();
    let best = actions.iter().max_by(|left, right| left["frequency"].as_f64().partial_cmp(&right["frequency"].as_f64()).unwrap()).and_then(|value| value["action"].as_str()).unwrap_or("check");
    println!("{}", json!({
        "source": "openspiel",
        "strategy": actions,
        "best_action": best,
        "exploitability": solver.exploitability_pct(),
        "backend": "dcfr-local"
    }));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
