//! Upstream dcfr-solver preflop tests, ported to the generalized rules, plus 8-max and stack-depth cases.

use dcfr_solver::card::{card, Hand};
use rangelab_preflop::game::{Action, NodeType, State, TableSpec};
use rangelab_preflop::trainer::{Blueprint, Trainer};

fn six_max() -> TableSpec {
    TableSpec::for_stack(6, 100).unwrap()
}

fn apply_all(mut state: State, actions: &[Action]) -> State {
    for &action in actions {
        state = state.apply(action);
    }
    state
}

#[test]
fn hundred_bb_six_max_matches_upstream_sizes() {
    let spec = six_max();
    assert_eq!(spec.stack_chips, 200);
    assert_eq!(spec.raise_sizes, vec![vec![5], vec![18], vec![44]]);
    assert_eq!(spec.sb_open_size, Some(7));
    assert_eq!(spec.min_allin_depth, 1);
}

#[test]
fn initial_state_posts_blinds_from_the_last_two_seats() {
    let spec = six_max();
    let state = State::new(&spec);
    assert_eq!(state.to_act, 0);
    assert_eq!((state.bets[4], state.bets[5]), (1, 2));
    assert_eq!((state.stacks[4], state.stacks[5], state.stacks[0]), (199, 198, 200));
    assert_eq!(state.active_count(), 6);

    let eight = TableSpec::for_stack(8, 100).unwrap();
    let state = State::new(&eight);
    assert_eq!((state.bets[6], state.bets[7]), (1, 2));
    assert_eq!(state.active_count(), 8);
    assert_eq!(eight.position_name(1), "UTG+1");
    assert_eq!(eight.position_name(5), "BTN");
}

#[test]
fn utg_may_only_fold_or_open() {
    let spec = six_max();
    assert_eq!(State::new(&spec).actions(&spec), vec![Action::Fold, Action::Raise(5)]);
}

#[test]
fn folding_around_gives_the_big_blind_the_pot() {
    let spec = TableSpec::for_stack(8, 100).unwrap();
    let state = apply_all(State::new(&spec), &[Action::Fold; 7]);
    assert!(matches!(state.node_type(), NodeType::TerminalFold(7)));
}

#[test]
fn small_blind_limp_gives_the_big_blind_an_option_and_a_check_ends_the_hand() {
    let spec = six_max();
    let state = apply_all(State::new(&spec), &[Action::Fold, Action::Fold, Action::Fold, Action::Fold, Action::Call]);
    assert_eq!(state.to_act, 5);
    assert!(!state.is_closed());
    let actions = state.actions(&spec);
    assert!(actions.contains(&Action::Check));
    // Isolating one limper: the 2.5bb open size plus one big blind (upstream reused 2.5bb).
    assert!(actions.contains(&Action::Raise(7)), "{actions:?}");
    assert!(matches!(state.apply(Action::Check).node_type(), NodeType::TerminalShowdown));
}

#[test]
fn open_then_big_blind_call_goes_to_showdown() {
    let spec = six_max();
    let state = apply_all(State::new(&spec), &[Action::Raise(5), Action::Fold, Action::Fold, Action::Fold, Action::Fold, Action::Call]);
    assert!(matches!(state.node_type(), NodeType::TerminalShowdown));
}

#[test]
fn fold_payoff_returns_the_pot_to_the_opener() {
    let spec = six_max();
    let state = apply_all(State::new(&spec), &[Action::Raise(5), Action::Fold, Action::Fold, Action::Fold, Action::Fold, Action::Fold]);
    let payoffs = state.payoff_fold(0);
    assert_eq!((payoffs[0], payoffs[4], payoffs[5]), (3.0, -1.0, -2.0));
}

#[test]
fn showdown_and_side_pots_pay_the_right_players() {
    let board = Hand::new().add(card(0, 2)).add(card(1, 2)).add(card(2, 3)).add(card(3, 3)).add(card(6, 1));
    let spec = six_max();
    let mut limped = apply_all(State::new(&spec), &[Action::Fold, Action::Fold, Action::Fold, Action::Fold, Action::Call, Action::Check]);
    limped.holes[4] = Hand::new().add(card(12, 0)).add(card(12, 1));
    limped.holes[5] = Hand::new().add(card(11, 0)).add(card(11, 1));
    let payoffs = limped.payoff_showdown(board);
    assert_eq!((payoffs[4], payoffs[5]), (2.0, -2.0));

    let shove_spec = TableSpec { min_allin_depth: 0, ..six_max() };
    let mut state = State::new(&shove_spec);
    state.stacks[0] = 50;
    let mut state = apply_all(state, &[Action::AllIn, Action::Fold, Action::Fold, Action::Fold, Action::AllIn, Action::Call]);
    assert_eq!((state.bets[0], state.bets[4], state.bets[5]), (50, 200, 200));
    assert!(matches!(state.node_type(), NodeType::TerminalShowdown));
    state.holes[0] = Hand::new().add(card(12, 0)).add(card(12, 1));
    state.holes[4] = Hand::new().add(card(11, 0)).add(card(11, 1));
    state.holes[5] = Hand::new().add(card(10, 0)).add(card(10, 1));
    let payoffs = state.payoff_showdown(board);
    assert_eq!((payoffs[0], payoffs[4], payoffs[5]), (100.0, 100.0, -200.0));
}

#[test]
fn facing_an_open_offers_fold_call_three_bet_and_all_in() {
    let spec = six_max();
    let actions = State::new(&spec).apply(Action::Raise(5)).actions(&spec);
    for action in [Action::Fold, Action::Call, Action::Raise(18), Action::AllIn] {
        assert!(actions.contains(&action), "{actions:?}");
    }
}

#[test]
fn short_stacks_open_small_and_may_shove() {
    let spec = TableSpec::for_stack(6, 20).unwrap();
    assert_eq!(spec.raise_sizes, vec![vec![4]]);
    let actions = State::new(&spec).actions(&spec);
    assert_eq!(actions, vec![Action::Fold, Action::Raise(4), Action::AllIn]);
    // With no 3-bet size, re-raising means all-in.
    let facing = State::new(&spec).apply(Action::Raise(4)).actions(&spec);
    assert_eq!(facing, vec![Action::Fold, Action::Call, Action::AllIn]);
}

#[test]
fn deep_stacks_add_a_five_bet_size() {
    let spec = TableSpec::for_stack(8, 150).unwrap();
    assert_eq!(spec.raise_sizes.len(), 4);
    assert!(TableSpec::for_stack(7, 100).is_err());
    assert!(TableSpec::for_stack(6, 5).is_err());
}

#[test]
fn postflop_rank_puts_the_button_last_and_scales_with_table_size() {
    let eight = TableSpec::for_stack(8, 100).unwrap();
    assert_eq!(eight.postflop_rank(6), 0);
    assert_eq!(eight.postflop_rank(7), 1);
    assert_eq!(eight.postflop_rank(5), 7);
    assert_eq!(six_max().postflop_rank(3), 5);
}

#[test]
fn training_counts_iterations_and_blueprints_round_trip() {
    let mut trainer = Trainer::new(Blueprint::new(TableSpec::for_stack(8, 40).unwrap(), 7));
    trainer.train(500);
    assert_eq!(trainer.blueprint.iterations, 500);
    assert!(!trainer.blueprint.entries.is_empty());
    let mut bytes = Vec::new();
    trainer.blueprint.write_to(&mut bytes).unwrap();
    let loaded = Blueprint::read_from(&mut bytes.as_slice()).unwrap();
    assert_eq!(loaded.spec, trainer.blueprint.spec);
    assert_eq!((loaded.iterations, loaded.seed, loaded.entries.len()), (500, 7, trainer.blueprint.entries.len()));
    assert!(Blueprint::read_from(&mut &b"garbage!"[..]).is_err());
    // Trailing bytes and corrupted counts are rejected rather than trusted.
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(Blueprint::read_from(&mut trailing.as_slice()).is_err());
    let truncated = &bytes[..bytes.len() - 3];
    assert!(Blueprint::read_from(&mut &truncated[..]).is_err());
}
