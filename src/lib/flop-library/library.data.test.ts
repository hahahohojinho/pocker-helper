import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFlopIndex } from "./format";

// The library is generated locally (gitignored); when present, the app must be able to load its index.
const indexPath = path.join(process.cwd(), "public", "data", "flop-library", "index.json");
const manifestPath = path.join(process.cwd(), "src", "data", "flop-library-manifest.json");

describe.skipIf(!existsSync(indexPath))("generated flop library index", () => {
  it("parses within the loader's limits and lists every manifest scenario", () => {
    const index = parseFlopIndex(readFileSync(indexPath, "utf8"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { scenarios: { id: string }[] };
    expect(index.scenarios.map(scenario => scenario.id).sort()).toEqual(manifest.scenarios.map(scenario => scenario.id).sort());
  });
});
