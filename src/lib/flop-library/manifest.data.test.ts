import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installPreflopPack, parsePreflopPack } from "../preflop-packs";
import { buildManifest } from "./manifest";

// The library generator (scripts/build-flop-library.mjs) cannot import TypeScript, so it reads this committed
// manifest. Ranges come from the committed preflop packs; regenerate with UPDATE_FLOP_MANIFEST=1 after they change,
// then rebuild the library (old solutions stop matching the new ranges and are simply not used).
const manifestPath = path.join(process.cwd(), "src", "data", "flop-library-manifest.json");
const packPath = path.join(process.cwd(), "public", "data", "preflop", "6max-100bb.json");

describe.skipIf(!existsSync(packPath))("flop library manifest", () => {
  it("matches the ranges and spots the app derives today", () => {
    installPreflopPack(parsePreflopPack(readFileSync(packPath, "utf8")));
    const committed = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
    const current = buildManifest(committed?.scenarios?.[0]?.generatedAt ?? new Date().toISOString().slice(0, 10));
    if (process.env.UPDATE_FLOP_MANIFEST === "1") writeFileSync(manifestPath, `${JSON.stringify(current, null, 1)}\n`);
    else expect(current).toEqual(committed);
    const btn = current.scenarios.find(scenario => scenario.id === "6max-100bb-srp-btn-bb")!;
    expect(btn).toMatchObject({ oop: "BB", ip: "BTN", pot: 550, stacks: [9750, 9750] });
    expect(current.scenarios.find(scenario => scenario.id === "6max-100bb-srp-sb-bb")).toMatchObject({ oop: "SB", ip: "BB", pot: 700 });
    expect(current.flops).toHaveLength(1755);
  });
});
