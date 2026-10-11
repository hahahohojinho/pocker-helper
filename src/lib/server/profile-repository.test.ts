import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHand, srpToShowdown } from "../profiling/__fixtures__/hands";
import { openProfileDb, resolveProfileDbPath, SCHEMA_VERSION } from "./profile-db-core";
import {
  createPlayer, deleteHand, ensureDerivedCurrent, getPlayerStats, listPlayers, listShowdowns, ProfileConflictError, ProfileInputError, saveHand, updatePlayer,
} from "./profile-repository-core";

const hasSqlite = Boolean(process.getBuiltinModule?.("node:sqlite"));

describe.skipIf(!hasSqlite)("profile repository", () => {
  let directory: string;
  let file: string;
  let db: DatabaseSync;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "rangelab-profile-"));
    file = path.join(directory, "nested", "profile.sqlite");
    db = openProfileDb(file);
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** Creates players in seat order and returns a record of srpToShowdown with them seated. */
  function seatedShowdown(winners = [0]) {
    const names = ["btn", "sb", null, "utg", "hj", "co"];
    const players = names.map(name => name ? createPlayer(db, { name }).id : null);
    const record = srpToShowdown(winners);
    return { players, record: { ...record, seats: record.seats.map(seat => ({ ...seat, playerId: players[seat.seat] })) } };
  }

  it("creates the schema in WAL mode under a new folder", () => {
    expect(existsSync(file)).toBe(true);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  });

  it("manages players with unique, normalized names", () => {
    const player = createPlayer(db, { name: "  Fish   One ", note: "calls a lot" });
    expect(player.name).toBe("Fish One");
    expect(() => createPlayer(db, { name: "fish one" })).toThrow(ProfileConflictError);
    expect(() => createPlayer(db, { name: "" })).toThrow(ProfileInputError);
    expect(updatePlayer(db, player.id, { note: "3-bets light", archived: true })).toMatchObject({ note: "3-bets light", archived: true });
    expect(updatePlayer(db, "00000000-0000-4000-8000-000000000999", { note: "x" })).toBeNull();
  });

  it("saves a hand once and derives stats and shown hands", () => {
    const { players, record } = seatedShowdown();
    expect(saveHand(db, record)).toEqual({ status: "created" });
    expect(saveHand(db, JSON.parse(JSON.stringify(record)))).toEqual({ status: "duplicate" });
    expect(() => saveHand(db, { ...record, winners: [0, 5] })).toThrow(ProfileConflictError);
    const stats = getPlayerStats(db, [players[5]!, players[0]!], 6);
    expect(stats[players[5]!].totals).toMatchObject({ vpip: { n: 1, x: 1 }, flop_cbet: { n: 1, x: 1 } });
    expect(stats[players[0]!].totals).toMatchObject({ cold_call: { n: 1, x: 1 }, wsd: { n: 1, x: 1 } });
    expect(stats[players[0]!].classification.tendency).toBe("unknown");
    expect(listShowdowns(db, players[5]!)).toMatchObject([{ handClass: "AKs", lineKey: "pf=open|f=b|t=x|r=x", won: false }]);
    expect(listPlayers(db).find(player => player.id === players[3])?.hands).toBe(1);
  });

  it("rejects unfinished hands and unknown players without writing anything", () => {
    const { record } = seatedShowdown();
    expect(() => saveHand(db, { ...record, postflop: record.postflop.slice(0, 3) })).toThrow(/끝나지 않았습니다/);
    const stranger = { ...record, seats: record.seats.map(seat => seat.seat === 1 ? { ...seat, playerId: "00000000-0000-4000-8000-000000000999" } : seat) };
    expect(() => saveHand(db, stranger)).toThrow(/등록되지 않은/);
    expect((db.prepare("SELECT COUNT(*) AS count FROM hands").get() as { count: number }).count).toBe(0);
  });

  it("deletes a hand with its derived rows", () => {
    const { players, record } = seatedShowdown();
    saveHand(db, record);
    expect(deleteHand(db, record.id)).toBe(true);
    expect(deleteHand(db, record.id)).toBe(false);
    expect(getPlayerStats(db, [players[5]!], 6)[players[5]!].totals).toEqual({});
    expect(listShowdowns(db, players[5]!)).toEqual([]);
  });

  it("rebuilds derived rows when the stats version changes", () => {
    const { players, record } = seatedShowdown();
    saveHand(db, record);
    saveHand(db, makeHand({ id: "22222222-2222-4222-8222-222222222222", preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "fold"], [1, "fold"], [2, "fold"]], winners: [5], players }));
    const before = getPlayerStats(db, [players[5]!], 6);
    db.exec("UPDATE meta SET value = '0' WHERE key = 'stats_version'; DELETE FROM player_stat_events;");
    ensureDerivedCurrent(db);
    expect(getPlayerStats(db, [players[5]!], 6)).toEqual(before);
    expect(before[players[5]!].totals.vpip).toEqual({ n: 2, x: 2 });
  });

  it("reopens an existing database and lets two connections read while one writes", () => {
    const { record } = seatedShowdown();
    const other = openProfileDb(file);
    try {
      saveHand(db, record);
      expect((other.prepare("SELECT COUNT(*) AS count FROM hands").get() as { count: number }).count).toBe(1);
    } finally {
      other.close();
    }
  });

  it("caps stats lookups", () => {
    const ids = Array.from({ length: 9 }, (_, index) => `00000000-0000-4000-8000-00000000010${index}`);
    expect(() => getPlayerStats(db, ids, 6)).toThrow(ProfileInputError);
  });
});

describe("resolveProfileDbPath", () => {
  it("prefers RANGELAB_DB_PATH, then the per-user data folder", () => {
    expect(resolveProfileDbPath({ RANGELAB_DB_PATH: "x/db.sqlite" })).toBe(path.resolve("x/db.sqlite"));
    expect(resolveProfileDbPath({ LOCALAPPDATA: "C:\\Data" }, "win32")).toBe(path.join("C:\\Data", "RangeLab", "rangelab.sqlite"));
  });
  it("does not need the database to compute a path", () => {
    const spy = vi.spyOn(process, "getBuiltinModule");
    resolveProfileDbPath({});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
