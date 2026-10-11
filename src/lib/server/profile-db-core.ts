import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** node:sqlite is missing (Node older than 22.5) or the database cannot be opened. */
export class ProfileUnavailableError extends Error {}

/**
 * Schema steps; index i upgrades user_version i to i+1. Hands keep their full JSON record as the source of truth;
 * stat events and shown hands are derived from it and can be rebuilt when stat definitions change.
 */
const MIGRATIONS: readonly string[] = [`
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE players(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE hands(
    id TEXT PRIMARY KEY, played_at TEXT NOT NULL, table_size INTEGER NOT NULL CHECK(table_size IN (6, 8)),
    end_street TEXT NOT NULL, showdown INTEGER NOT NULL, record_version INTEGER NOT NULL, record_json TEXT NOT NULL,
    content_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX hands_played_at ON hands(played_at);
  CREATE TABLE hand_players(
    hand_id TEXT NOT NULL REFERENCES hands(id) ON DELETE CASCADE, seat INTEGER NOT NULL, position TEXT NOT NULL,
    player_id TEXT REFERENCES players(id), PRIMARY KEY(hand_id, seat));
  CREATE INDEX hand_players_player ON hand_players(player_id, hand_id);
  CREATE TABLE player_stat_events(
    hand_id TEXT NOT NULL REFERENCES hands(id) ON DELETE CASCADE, player_id TEXT NOT NULL REFERENCES players(id),
    stat TEXT NOT NULL, n INTEGER NOT NULL, x INTEGER NOT NULL, PRIMARY KEY(hand_id, player_id, stat));
  CREATE INDEX stat_events_player ON player_stat_events(player_id, stat);
  CREATE TABLE showdown_hands(
    hand_id TEXT NOT NULL REFERENCES hands(id) ON DELETE CASCADE, player_id TEXT NOT NULL REFERENCES players(id),
    seat INTEGER NOT NULL, position TEXT NOT NULL, cards TEXT NOT NULL, hand_class TEXT NOT NULL, pot_type TEXT NOT NULL,
    line_key TEXT NOT NULL, is_pf_aggressor INTEGER NOT NULL, board TEXT NOT NULL, won INTEGER NOT NULL,
    PRIMARY KEY(hand_id, seat));
  CREATE INDEX showdown_player_line ON showdown_hands(player_id, pot_type, line_key);
`];
export const SCHEMA_VERSION = MIGRATIONS.length;

/** RANGELAB_DB_PATH, else the per-user app data folder (outside the repository). */
export function resolveProfileDbPath(env: Record<string, string | undefined>, platform = process.platform) {
  if (env.RANGELAB_DB_PATH) return path.resolve(env.RANGELAB_DB_PATH);
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "RangeLab", "rangelab.sqlite");
  return path.join(homedir(), ".local", "share", "rangelab", "rangelab.sqlite");
}

// Loaded at run time rather than imported, so bundlers never have to resolve the experimental builtin.
function loadSqlite(): typeof import("node:sqlite") {
  const sqlite = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!sqlite) throw new ProfileUnavailableError("node:sqlite is not available; Node 22.5 or newer is required.");
  return sqlite;
}

/** Runs fn in a write transaction (BEGIN IMMEDIATE takes the write lock up front), rolling back on any error. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrate(db: DatabaseSync, file: string) {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version > MIGRATIONS.length) throw new ProfileUnavailableError(`Profile database schema ${version} is newer than this app (${MIGRATIONS.length}).`);
  for (let step = version; step < MIGRATIONS.length; step++) {
    // An existing database is copied before it is changed.
    if (step > 0) db.exec(`VACUUM INTO '${`${file}.bak-v${step}`.replaceAll("'", "''")}'`);
    withTransaction(db, () => {
      db.exec(MIGRATIONS[step]);
      db.exec(`PRAGMA user_version = ${step + 1}`);
    });
  }
}

export function openProfileDb(file: string): DatabaseSync {
  const { DatabaseSync } = loadSqlite();
  const directory = path.dirname(file);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
  } catch (error) {
    throw new ProfileUnavailableError(`Profile database cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
  try {
    migrate(db, file);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
