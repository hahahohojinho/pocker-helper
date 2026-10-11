import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ID_PATTERN, parseHandRecord, type HandRecordV1, type ProfileTableSize } from "../profiling/hand-record";
import { replayHandRecord } from "../profiling/hand-replay";
import { extractShowdownHands, type ShowdownHand } from "../profiling/showdown-lines";
import { computeStatEvents, STATS_VERSION, STAT_KEYS, type StatKey } from "../profiling/stats";
import { classifyPlayer, type Classification, type StatTotals } from "../profiling/classify";
import { withTransaction } from "./profile-db-core";

export class ProfileInputError extends Error {}
export class ProfileConflictError extends Error {}

export interface PlayerSummary { id: string; name: string; note: string; archived: boolean; hands: number; }
export interface PlayerStats { hands: number; totals: StatTotals; classification: Classification; }

const MAX_NAME = 40;
const MAX_NOTE = 500;
export const MAX_STATS_PLAYERS = 8;
const MAX_SHOWDOWN_LIMIT = 200;

const now = () => new Date().toISOString();
const normalizeName = (name: string) => name.normalize("NFC").trim().replace(/\s+/g, " ");

function checkedName(value: unknown) {
  const name = typeof value === "string" ? normalizeName(value) : "";
  if (name.length < 1 || name.length > MAX_NAME) throw new ProfileInputError(`플레이어 이름은 1~${MAX_NAME}자여야 합니다.`);
  return name;
}
function checkedNote(value: unknown) {
  if (typeof value !== "string" || value.length > MAX_NOTE) throw new ProfileInputError(`메모는 ${MAX_NOTE}자 이하 문자열이어야 합니다.`);
  return value;
}
const isUniqueViolation = (error: unknown) => error instanceof Error && /UNIQUE constraint failed: players\.name_norm/.test(error.message);

export function createPlayer(db: DatabaseSync, input: { name: unknown; note?: unknown }): PlayerSummary {
  const name = checkedName(input.name);
  const note = input.note === undefined ? "" : checkedNote(input.note);
  const id = randomUUID(), stamp = now();
  try {
    db.prepare("INSERT INTO players(id, name, name_norm, note, archived, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
      .run(id, name, name.toLowerCase(), note, stamp, stamp);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProfileConflictError("같은 이름의 플레이어가 이미 있습니다.");
    throw error;
  }
  return { id, name, note, archived: false, hands: 0 };
}

export function updatePlayer(db: DatabaseSync, id: string, input: { name?: unknown; note?: unknown; archived?: unknown }): PlayerSummary | null {
  if (!ID_PATTERN.test(id)) return null;
  if (input.archived !== undefined && typeof input.archived !== "boolean") throw new ProfileInputError("archived는 true 또는 false여야 합니다.");
  const name = input.name === undefined ? undefined : checkedName(input.name);
  const note = input.note === undefined ? undefined : checkedNote(input.note);
  try {
    const result = db.prepare(`UPDATE players SET name = COALESCE(?, name), name_norm = COALESCE(?, name_norm), note = COALESCE(?, note),
      archived = COALESCE(?, archived), updated_at = ? WHERE id = ?`)
      .run(name ?? null, name?.toLowerCase() ?? null, note ?? null, input.archived === undefined ? null : Number(input.archived), now(), id);
    if (Number(result.changes) === 0) return null;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProfileConflictError("같은 이름의 플레이어가 이미 있습니다.");
    throw error;
  }
  return listPlayers(db).find(player => player.id === id) ?? null;
}

export function listPlayers(db: DatabaseSync): PlayerSummary[] {
  const rows = db.prepare(`SELECT p.id, p.name, p.note, p.archived, COUNT(hp.hand_id) AS hands FROM players p
    LEFT JOIN hand_players hp ON hp.player_id = p.id GROUP BY p.id ORDER BY p.archived, p.name_norm`).all() as { id: string; name: string; note: string; archived: number; hands: number }[];
  return rows.map(row => ({ id: row.id, name: row.name, note: row.note, archived: row.archived === 1, hands: Number(row.hands) }));
}

/** Stat events and shown hands for one stored record, written in the caller's transaction. */
function writeDerived(db: DatabaseSync, record: HandRecordV1) {
  const replay = replayHandRecord(record);
  if (!replay.ok || !replay.end.finished) throw new ProfileInputError(replay.ok ? `핸드가 아직 끝나지 않았습니다: ${replay.end.pending}` : `잘못된 핸드 기록입니다: ${replay.message}`);
  const playerBySeat = new Map(record.seats.flatMap(seat => seat.playerId ? [[seat.seat, seat.playerId] as const] : []));
  const insertEvent = db.prepare("INSERT INTO player_stat_events(hand_id, player_id, stat, n, x) VALUES (?, ?, ?, ?, ?)");
  for (const [seat, events] of computeStatEvents(record, replay.end, replay.preflopState)) {
    const playerId = playerBySeat.get(seat);
    if (playerId) for (const event of events) insertEvent.run(record.id, playerId, event.stat, event.n, event.x);
  }
  const insertShown = db.prepare(`INSERT INTO showdown_hands(hand_id, player_id, seat, position, cards, hand_class, pot_type, line_key,
    is_pf_aggressor, board, won) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const hand of extractShowdownHands(record, replay.end, replay.preflopState)) {
    insertShown.run(record.id, hand.playerId, hand.seat, hand.position, hand.cards, hand.handClass, hand.potType, hand.lineKey, Number(hand.isPfAggressor), hand.board, Number(hand.won));
  }
  return replay.end;
}

/**
 * Stores a finished hand once. Re-sending the same record is a no-op ("duplicate"); a different record under the
 * same id is a conflict, so a retried save can never count a hand twice.
 */
export function saveHand(db: DatabaseSync, raw: unknown): { status: "created" | "duplicate" } {
  let record: HandRecordV1;
  try {
    record = parseHandRecord(raw);
  } catch (error) {
    throw new ProfileInputError(error instanceof Error ? error.message : "잘못된 핸드 기록입니다.");
  }
  const json = JSON.stringify(record);
  const hash = createHash("sha256").update(json).digest("hex");
  return withTransaction(db, () => {
    const existing = db.prepare("SELECT content_hash FROM hands WHERE id = ?").get(record.id) as { content_hash: string } | undefined;
    if (existing) {
      if (existing.content_hash === hash) return { status: "duplicate" as const };
      throw new ProfileConflictError("같은 ID로 다른 핸드가 이미 저장되어 있습니다.");
    }
    const ids = record.seats.flatMap(seat => seat.playerId ? [seat.playerId] : []);
    const known = ids.length ? (db.prepare(`SELECT COUNT(*) AS count FROM players WHERE id IN (${ids.map(() => "?").join(",")})`).get(...ids) as { count: number }).count : 0;
    if (Number(known) !== ids.length) throw new ProfileInputError("등록되지 않은 플레이어가 좌석에 있습니다.");
    db.prepare("INSERT INTO hands(id, played_at, table_size, end_street, showdown, record_version, record_json, content_hash, created_at) VALUES (?, ?, ?, '', 0, ?, ?, ?, ?)")
      .run(record.id, record.playedAt, record.tableSize, record.version, json, hash, now());
    const insertSeat = db.prepare("INSERT INTO hand_players(hand_id, seat, position, player_id) VALUES (?, ?, ?, ?)");
    for (const seat of record.seats) insertSeat.run(record.id, seat.seat, seat.position, seat.playerId);
    const end = writeDerived(db, record);
    db.prepare("UPDATE hands SET end_street = ?, showdown = ? WHERE id = ?").run(end.endStreet, Number(end.showdown), record.id);
    return { status: "created" as const };
  });
}

export function deleteHand(db: DatabaseSync, id: string): boolean {
  if (!ID_PATTERN.test(id)) return false;
  return Number(db.prepare("DELETE FROM hands WHERE id = ?").run(id).changes) > 0;
}

export function getPlayerStats(db: DatabaseSync, ids: string[], tableSize: ProfileTableSize): Record<string, PlayerStats> {
  const wanted = [...new Set(ids)].filter(id => ID_PATTERN.test(id));
  if (wanted.length > MAX_STATS_PLAYERS) throw new ProfileInputError(`한 번에 최대 ${MAX_STATS_PLAYERS}명까지 조회할 수 있습니다.`);
  const totals = new Map<string, StatTotals>(wanted.map(id => [id, {}]));
  if (wanted.length) {
    const rows = db.prepare(`SELECT player_id, stat, SUM(n) AS n, SUM(x) AS x FROM player_stat_events WHERE player_id IN (${wanted.map(() => "?").join(",")})
      GROUP BY player_id, stat`).all(...wanted) as { player_id: string; stat: string; n: number; x: number }[];
    for (const row of rows) {
      if (STAT_KEYS.includes(row.stat as StatKey)) totals.get(row.player_id)![row.stat as StatKey] = { n: Number(row.n), x: Number(row.x) };
    }
  }
  return Object.fromEntries(wanted.map(id => {
    const playerTotals = totals.get(id)!;
    return [id, { hands: playerTotals.vpip?.n ?? 0, totals: playerTotals, classification: classifyPlayer(playerTotals, tableSize) }];
  }));
}

export function listShowdowns(db: DatabaseSync, playerId: string, options: { potType?: string; limit?: number } = {}): Omit<ShowdownHand, "playerId">[] {
  if (!ID_PATTERN.test(playerId)) return [];
  const limit = Math.min(MAX_SHOWDOWN_LIMIT, Math.max(1, Math.trunc(options.limit ?? 50)));
  const rows = db.prepare(`SELECT s.seat, s.position, s.cards, s.hand_class, s.pot_type, s.line_key, s.is_pf_aggressor, s.board, s.won
    FROM showdown_hands s JOIN hands h ON h.id = s.hand_id WHERE s.player_id = ? AND (? IS NULL OR s.pot_type = ?)
    ORDER BY h.played_at DESC LIMIT ?`).all(playerId, options.potType ?? null, options.potType ?? null, limit) as Record<string, string | number>[];
  return rows.map(row => ({
    seat: Number(row.seat), position: String(row.position), cards: String(row.cards), handClass: String(row.hand_class),
    potType: row.pot_type as ShowdownHand["potType"], lineKey: String(row.line_key), isPfAggressor: row.is_pf_aggressor === 1,
    board: String(row.board), won: row.won === 1,
  }));
}

/** Re-derives stat events and shown hands from stored records when the stat definitions changed. */
export function ensureDerivedCurrent(db: DatabaseSync) {
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'stats_version'").get() as { value: string } | undefined;
  if (Number(stored?.value) === STATS_VERSION) return;
  withTransaction(db, () => {
    db.exec("DELETE FROM player_stat_events; DELETE FROM showdown_hands;");
    const records = db.prepare("SELECT id, record_json FROM hands").all() as { id: string; record_json: string }[];
    for (const { id, record_json } of records) {
      // A record the current rules reject stays stored (it is the source of truth) but contributes no stats.
      try {
        writeDerived(db, parseHandRecord(JSON.parse(record_json)));
      } catch (error) {
        console.error(`Profile rebuild skipped hand ${id}:`, error);
      }
    }
    db.prepare("INSERT INTO meta(key, value) VALUES ('stats_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(STATS_VERSION));
  });
}
