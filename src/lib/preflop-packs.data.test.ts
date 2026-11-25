import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePreflopPack, type PreflopPack } from "./preflop-packs";

// Sanity checks for the committed solver packs: they must load in the app and look like poker.
const directory = path.join(process.cwd(), "public", "data", "preflop");
const files = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".json")).sort() : [];
const combos = (hand: string) => hand.length === 2 ? 6 : hand.endsWith("s") ? 4 : 12;
/** Percent of the 1326 combos that raise (aggressive) in a spot. */
function raiseWidth(pack: PreflopPack, spot: PreflopPack["spots"][number]) {
  return pack.hands.reduce((sum, hand, index) => sum + combos(hand) * (1000 - spot.mix[index][0] - spot.mix[index][1]), 0) / 1326 / 10;
}
const rfiOrder = { 6: ["UTG", "HJ", "CO", "BTN"], 8: ["UTG", "UTG+1", "MP", "HJ", "CO", "BTN"] } as const;

describe.skipIf(files.length === 0)("committed preflop packs", () => {
  it.each(files)("%s parses and is sane", file => {
    const text = readFileSync(path.join(directory, file), "utf8");
    const pack = parsePreflopPack(text);
    expect(file).toBe(`${pack.tableSize}max-${pack.stack}bb.json`);
    const aa = pack.hands.indexOf("AA");
    // MCCFR leaves rarely reached nodes noisy; reached spots must never fold aces.
    const aaFolds = pack.spots.filter(spot => spot.reach >= 0.01 && spot.mix[aa][0] > 10);
    expect(aaFolds.map(spot => `${spot.position} ${spot.scenario} ${spot.aggressorPosition ?? ""}`)).toEqual([]);
    const rfi = Object.fromEntries(pack.spots.filter(spot => spot.scenario === "unopened").map(spot => [spot.position, raiseWidth(pack, spot)]));
    const widths = rfiOrder[pack.tableSize].map(position => rfi[position]);
    widths.forEach((width, index) => { if (index > 0) expect(width).toBeGreaterThanOrEqual(widths[index - 1] - 1); });
    const trash = pack.hands.indexOf("72o");
    expect(pack.spots.find(spot => spot.scenario === "unopened" && spot.position === "UTG")!.mix[trash][0]).toBeGreaterThan(950);
  });
});
