//! rangelab-preflop: train (resumable) and export preflop strategy packs.
//!
//!   rangelab-preflop train --players 6 --stack 100 --iterations 100000000 --seed 42 --out bp.bin
//!       [--checkpoint-every 5000000] [--resume]
//!   rangelab-preflop export --blueprint bp.bin --out pack.json --id dcfr-6max-100bb-v1
//!       [--min-reach 0.0001] [--revision <git rev>] [--generated-at 2026-10-11] [--license "..."]

use std::path::PathBuf;
use std::time::Instant;

use rangelab_preflop::export::{export, to_pack_json, PackMetadata};
use rangelab_preflop::game::TableSpec;
use rangelab_preflop::trainer::{Blueprint, Trainer};

const DEFAULT_CHECKPOINT_EVERY: u64 = 5_000_000;
const DEFAULT_MIN_REACH: f32 = 1e-4;

/// The value after `name`, unless it is missing or another flag (so `--out --resume` is not a file named --resume).
fn option(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|arg| arg == name).and_then(|index| args.get(index + 1)).filter(|value| !value.starts_with("--")).cloned()
}

fn required(args: &[String], name: &str) -> Result<String, String> {
    option(args, name).ok_or_else(|| format!("missing {name}"))
}

fn number<T: std::str::FromStr>(args: &[String], name: &str, default: Option<T>) -> Result<T, String> {
    match option(args, name) {
        Some(text) => text.parse().map_err(|_| format!("invalid {name}: {text}")),
        None => default.ok_or_else(|| format!("missing {name}")),
    }
}

/// Deletes `<out>.<pid>.tmp` files left by an interrupted checkpoint; 8-max ones can be gigabytes.
fn remove_stale_temporaries(out: &std::path::Path) {
    let (Some(directory), Some(name)) = (out.parent(), out.file_name().and_then(|name| name.to_str())) else { return };
    let directory = if directory.as_os_str().is_empty() { std::path::Path::new(".") } else { directory };
    let Ok(entries) = std::fs::read_dir(directory) else { return };
    for entry in entries.flatten() {
        let file = entry.file_name();
        let Some(file) = file.to_str() else { continue };
        if file.starts_with(&format!("{name}.")) && file.ends_with(".tmp") {
            if let Err(error) = std::fs::remove_file(entry.path()) {
                eprintln!("could not remove stale checkpoint {file}: {error}");
            }
        }
    }
}

fn train(args: &[String]) -> Result<(), String> {
    let out = PathBuf::from(required(args, "--out")?);
    let target: u64 = number(args, "--iterations", None)?;
    let checkpoint_every: u64 = number(args, "--checkpoint-every", Some(DEFAULT_CHECKPOINT_EVERY))?.max(1);
    remove_stale_temporaries(&out);
    let blueprint = if args.iter().any(|arg| arg == "--resume") && out.exists() {
        let blueprint = Blueprint::load(&out).map_err(|error| format!("cannot resume from {}: {error}", out.display()))?;
        // A checkpoint for a different table must not be silently continued under this job's name.
        if let (Some(players), Some(stack)) = (option(args, "--players"), option(args, "--stack")) {
            let requested = TableSpec::for_stack(players.parse().map_err(|_| "invalid --players")?, stack.parse().map_err(|_| "invalid --stack")?)?;
            if requested != blueprint.spec {
                return Err(format!("{} holds a different table spec than --players {players} --stack {stack}", out.display()));
            }
        }
        eprintln!("resuming at iteration {} ({} info sets)", blueprint.iterations, blueprint.entries.len());
        blueprint
    } else {
        let players: usize = number(args, "--players", None)?;
        let stack: u32 = number(args, "--stack", None)?;
        Blueprint::new(TableSpec::for_stack(players, stack)?, number(args, "--seed", Some(42))?)
    };
    let mut trainer = Trainer::new(blueprint);
    let started = Instant::now();
    let start_iterations = trainer.blueprint.iterations;
    while trainer.blueprint.iterations < target {
        let chunk = checkpoint_every.min(target - trainer.blueprint.iterations);
        trainer.train(chunk);
        trainer.blueprint.save(&out).map_err(|error| format!("checkpoint failed: {error}"))?;
        let done = trainer.blueprint.iterations - start_iterations;
        let rate = done as f64 / started.elapsed().as_secs_f64().max(1e-9);
        let remaining = (target - trainer.blueprint.iterations) as f64 / rate.max(1e-9);
        eprintln!("checkpoint {}/{} | {} info sets | {:.0} it/s | ~{:.0} min left",
            trainer.blueprint.iterations, target, trainer.blueprint.entries.len(), rate, remaining / 60.0);
    }
    Ok(())
}

fn export_pack(args: &[String]) -> Result<(), String> {
    let blueprint_path = PathBuf::from(required(args, "--blueprint")?);
    let out = PathBuf::from(required(args, "--out")?);
    let blueprint = Blueprint::load(&blueprint_path).map_err(|error| format!("cannot read {}: {error}", blueprint_path.display()))?;
    let min_reach: f32 = number(args, "--min-reach", Some(DEFAULT_MIN_REACH))?;
    let report = export(&blueprint, min_reach);
    let id = required(args, "--id")?;
    let generated_at = option(args, "--generated-at").unwrap_or_else(|| "unknown".into());
    let revision = option(args, "--revision").unwrap_or_else(|| "unknown".into());
    let license = option(args, "--license").unwrap_or_else(|| "MIT generator; self-generated strategy output".into());
    let pack = to_pack_json(&blueprint, &report, &PackMetadata { id: &id, generated_at: &generated_at, revision: &revision, license: &license });
    std::fs::write(&out, serde_json::to_string(&pack).map_err(|error| error.to_string())?).map_err(|error| format!("cannot write {}: {error}", out.display()))?;
    eprintln!("exported {} spots ({} merged lines) to {}", report.spots.len(), report.merged_lines, out.display());
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = match args.get(1).map(String::as_str) {
        Some("train") => train(&args),
        Some("export") => export_pack(&args),
        _ => Err("usage: rangelab-preflop train|export ... (see the header of src/main.rs)".into()),
    };
    if let Err(error) = result {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}
