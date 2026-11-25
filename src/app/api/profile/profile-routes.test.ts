import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { srpToShowdown } from "@/lib/profiling/__fixtures__/hands";

vi.mock("server-only", () => ({}));

const hasSqlite = Boolean(process.getBuiltinModule?.("node:sqlite"));
const origin = "http://localhost:3000";

function request(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { host: "localhost:3000", origin, "sec-fetch-site": "same-origin", ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers };
  return new Request(`${origin}${url}`, { method, headers, body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!hasSqlite)("profile API routes", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "rangelab-routes-"));
    vi.stubEnv("RANGELAB_DB_PATH", path.join(directory, "profile.sqlite"));
  });
  afterAll(() => {
    const state = globalThis as { __rangelabProfileDb?: { close(): void } };
    state.__rangelabProfileDb?.close();
    delete state.__rangelabProfileDb;
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates players, saves a hand, and serves stats and shown hands", async () => {
    const players = await import("./players/route");
    const hands = await import("./hands/route");
    const stats = await import("./stats/route");
    const showdowns = await import("./players/[id]/showdowns/route");
    const status = await import("./status/route");
    expect(await (await status.GET(request("/api/profile/status"))).json()).toMatchObject({ enabled: true });
    const ids: Record<number, string> = {};
    for (const seat of [0, 1, 3, 4, 5]) {
      const response = await players.POST(request("/api/profile/players", { method: "POST", body: { name: `seat ${seat}` } }));
      expect(response.status).toBe(201);
      ids[seat] = (await response.json()).player.id;
    }
    const record = srpToShowdown();
    const seated = { ...record, seats: record.seats.map(seat => ({ ...seat, playerId: ids[seat.seat] ?? null })) };
    expect((await hands.POST(request("/api/profile/hands", { method: "POST", body: { record: seated } }))).status).toBe(201);
    expect((await hands.POST(request("/api/profile/hands", { method: "POST", body: { record: seated } }))).status).toBe(200);
    const statsBody = await (await stats.GET(request(`/api/profile/stats?tableSize=6&ids=${ids[5]},${ids[0]}`))).json();
    expect(statsBody.stats[ids[5]].totals.flop_cbet).toEqual({ n: 1, x: 1 });
    const shown = await (await showdowns.GET(request(`/api/profile/players/${ids[0]}/showdowns?potType=srp`), params(ids[0]))).json();
    expect(shown.items).toMatchObject([{ handClass: "QQ", won: true }]);
    const list = await (await players.GET(request("/api/profile/players"))).json();
    expect(list.players).toHaveLength(5);
  });

  it("maps bad input to 400, conflicts to 409, and missing items to 404", async () => {
    const players = await import("./players/route");
    const player = await import("./players/[id]/route");
    const handById = await import("./hands/[id]/route");
    expect((await players.POST(request("/api/profile/players", { method: "POST", body: { name: "" } }))).status).toBe(400);
    expect((await players.POST(request("/api/profile/players", { method: "POST", body: "{" }))).status).toBe(400);
    await players.POST(request("/api/profile/players", { method: "POST", body: { name: "dup" } }));
    expect((await players.POST(request("/api/profile/players", { method: "POST", body: { name: "DUP" } }))).status).toBe(409);
    const missing = "00000000-0000-4000-8000-000000000999";
    expect((await player.PATCH(request(`/api/profile/players/${missing}`, { method: "PATCH", body: { note: "x" } }), params(missing))).status).toBe(404);
    expect((await handById.DELETE(request(`/api/profile/hands/${missing}`, { method: "DELETE" }), params(missing))).status).toBe(404);
  });

  it("refuses cross-site, non-local, oversized, and non-JSON requests", async () => {
    const players = await import("./players/route");
    const hands = await import("./hands/route");
    expect((await players.POST(request("/api/profile/players", { method: "POST", body: { name: "x" }, headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect((await players.GET(request("/api/profile/players", { headers: { host: "evil.example:3000", origin: "http://evil.example:3000" } }))).status).toBe(403);
    expect((await players.POST(request("/api/profile/players", { method: "POST", body: { name: "x" }, headers: { "content-type": "text/plain" } }))).status).toBe(403);
    expect((await hands.POST(request("/api/profile/hands", { method: "POST", body: { record: "x".repeat(70_000) } }))).status).toBe(413);
  });

  it("is off in production unless enabled", async () => {
    const players = await import("./players/route");
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect((await players.GET(request("/api/profile/players"))).status).toBe(403);
      vi.stubEnv("ALLOW_LOCAL_PROFILE_API", "1");
      expect((await players.GET(request("/api/profile/players"))).status).toBe(200);
    } finally {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("ALLOW_LOCAL_PROFILE_API", "");
    }
  });
});
