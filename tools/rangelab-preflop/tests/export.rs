use rangelab_preflop::export::{export, hand_names, to_pack_json, PackMetadata};
use rangelab_preflop::game::TableSpec;
use rangelab_preflop::trainer::{Blueprint, Trainer};

fn trained(players: usize, stack: u32, iterations: u64) -> Blueprint {
    let mut trainer = Trainer::new(Blueprint::new(TableSpec::for_stack(players, stack).unwrap(), 11));
    trainer.train(iterations);
    trainer.blueprint
}

#[test]
fn exports_rfi_open_response_and_three_bet_spots_with_app_fields() {
    let blueprint = trained(6, 100, 300_000);
    let report = export(&blueprint, 1e-4);
    let find = |position: &str, scenario: &str, opener: Option<&str>, aggressor: Option<&str>, size: Option<&str>| report.spots.iter().find(|spot| {
        spot.key.position == position && spot.key.scenario == scenario && spot.key.action_size.as_deref() == size
            && spot.key.opener_position.as_deref() == opener && spot.key.aggressor_position.as_deref() == aggressor
            && spot.key.caller_positions.is_empty() && spot.key.limper_positions.is_empty()
    });
    for position in ["UTG", "HJ", "CO", "BTN", "SB"] {
        assert!(find(position, "unopened", None, None, None).is_some(), "{position} RFI missing");
    }
    assert!(find("BTN", "single-open", Some("CO"), Some("CO"), Some("2.5")).is_some(), "BTN vs CO open");
    // A 9bb 3-bet and a 3-bet shove are different spots, distinguished by size.
    assert!(find("CO", "facing-3bet", Some("CO"), Some("BTN"), Some("9")).is_some(), "CO open facing BTN 3-bet");
    assert!(report.spots.iter().any(|spot| spot.key.scenario == "limped" && spot.key.position == "BB" && spot.key.limper_positions == ["SB"]));

    // Aces open from under the gun far more often than they fold, even after a short run.
    let utg = find("UTG", "unopened", None, None, None).unwrap();
    let aces = utg.mix[hand_names().iter().position(|hand| hand == "AA").unwrap()];
    assert!(aces[0] < 300, "AA folds {} permille", aces[0]);
    for spot in &report.spots {
        assert_eq!(spot.mix.len(), 169);
        assert!(spot.mix.iter().all(|[fold, passive]| fold + passive <= 1000));
        assert!(spot.reach >= 1e-4);
    }
}

#[test]
fn short_stack_shove_responses_count_all_in_calls_as_passive() {
    // At 20bb a 3-bet is all-in, so the opener can only fold or call it all-in.
    let blueprint = trained(6, 20, 300_000);
    let report = export(&blueprint, 1e-4);
    let facing_shove = report.spots.iter().find(|spot| spot.key.scenario == "facing-3bet" && spot.key.action_size.as_deref() == Some("20"))
        .expect("a spot facing a 3-bet shove");
    assert!(facing_shove.mix.iter().all(|[fold, passive]| fold + passive == 1000), "aggressive share must be zero");
    assert!(facing_shove.mix.iter().any(|[_, passive]| *passive > 0));
}

#[test]
fn eight_max_names_every_seat_and_packs_metadata() {
    let blueprint = trained(8, 40, 100_000);
    let report = export(&blueprint, 1e-3);
    for position in ["UTG", "UTG+1", "MP", "HJ", "CO", "BTN", "SB"] {
        assert!(report.spots.iter().any(|spot| spot.key.position == position && spot.key.scenario == "unopened"), "{position}");
    }
    let pack = to_pack_json(&blueprint, &report, &PackMetadata { id: "test-8max-40bb", generated_at: "2026-10-11", revision: "abc", license: "MIT" });
    assert_eq!(pack["contract"], "rangelab.preflop_pack.v1");
    assert_eq!(pack["tableSize"], 8);
    assert_eq!(pack["stack"], 40);
    assert_eq!(pack["hands"].as_array().unwrap().len(), 169);
    assert_eq!(pack["hands"][0], "22");
    assert_eq!(pack["spots"].as_array().unwrap().len(), report.spots.len());
}
