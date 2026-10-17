// Precomputes heads-up flop solutions for the flop library, resuming from the files already written.
//
//   node scripts/build-flop-library.mjs [--scenarios id,id] [--budget-ms 10000] [--limit 50] [--redo-above 0.5]
//
// Reads the scenarios and flop classes from src/data/flop-library-manifest.json, solves each flop once with the native
// adapter (`--json-nodes`, uses every core), and writes public/data/flop-library/<scenario>/<board>.json plus an
// index.json listing finished flops. Flops are solved heaviest first, so a partial run covers the common boards.
// Valid files are skipped on re-run; `--redo-above` re-solves files whose exploitability exceeds that % of the pot.
// Needs a release adapter: cargo build --release in tools/dcfr-adapter. Runs at below-normal priority (inherited by
// the adapter processes), so live solves in the app keep their speed while it runs.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { constants as osConstants, setPriority } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const INDEX_CONTRACT = "rangelab.flop_library_index.v1";
const SOLUTION_CONTRACT = "rangelab.flop_solution.v1";
const FREQUENCY_SCALE = 1000;
/** Same limit as the app's parser (src/lib/flop-library/format.ts). */
const MAX_SOLUTION_CHARS = 400_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const INDEX_EVERY = 50;
export const DEFAULTS = Object.freeze({
  budgetMs: 10_000, iterations: 400, limit: Number.POSITIVE_INFINITY, redoAbove: Number.POSITIVE_INFINITY,
  manifest: join(root, "src", "data", "flop-library-manifest.json"),
  outDir: join(root, "public", "data", "flop-library"),
  logDir: join(root, "artifacts", "flop-library", "logs"),
  adapter: join(root, "tools", "dcfr-adapter", "target", "release", process.platform === "win32" ? "rangelab-dcfr-adapter.exe" : "rangelab-dcfr-adapter"),
});

const positiveNumber = (name, value, { integer = false, max = Number.POSITIVE_INFINITY } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max || (integer && !Number.isInteger(number))) throw new Error(`--${name} needs a positive ${integer ? "integer" : "number"}${Number.isFinite(max) ? ` up to ${max}` : ""}.`);
  return number;
};

export function parseArgs(argv) {
  const options = { ...DEFAULTS, scenarios: null };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    if (flag === "--scenarios") options.scenarios = value.split(",").filter(Boolean);
    else if (flag === "--budget-ms") options.budgetMs = positiveNumber("budget-ms", value, { integer: true, max: 120_000 });
    else if (flag === "--iterations") options.iterations = positiveNumber("iterations", value, { integer: true, max: 5000 });
    else if (flag === "--limit") options.limit = positiveNumber("limit", value, { integer: true });
    else if (flag === "--redo-above") options.redoAbove = positiveNumber("redo-above", value);
    else if (flag === "--adapter") options.adapter = resolve(value);
    else throw new Error(`Unknown option ${flag}.`);
  }
  return options;
}

const betKey = ([numerator, denominator]) => `b${numerator}/${denominator}`;

/** The stored decisions: OOP root, IP after a check, and facing the first bet size from either player. */
export function nodePlan(spec) {
  const size = spec.betSizes[0][0];
  const bet = { action: "bet", size };
  return [
    { key: "", steps: [] }, { key: "x", steps: [{ action: "check" }] },
    { key: betKey(size), steps: [bet] }, { key: `x,${betKey(size)}`, steps: [{ action: "check" }, bet] },
  ];
}

/**
 * Identifies everything a stored solution depends on. A regenerated manifest (new pack, open size, or tree) changes
 * it, so old files are re-solved and never listed for the new spec; the app also compares it.
 */
export function specHash(spec) {
  const inputs = [spec.oopRange, spec.ipRange, spec.pot, spec.stacks, spec.betSizes, spec.maxRaises, nodePlan(spec).map(node => node.key)];
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
}

export function buildNodesRequest(spec, board, options) {
  const { oopRange, ipRange, pot, stacks, betSizes, maxRaises } = spec;
  return {
    request: { board, oopRange, ipRange, pot, stacks, betSizes, maxRaises, iterations: options.iterations, timeBudgetMs: options.budgetMs },
    nodes: nodePlan(spec).map(node => node.steps),
  };
}

/** Shares -> integers summing to 1000 (largest remainder); a mix with no usable shares is split evenly. */
export function quantize(shares) {
  const clean = shares.map(share => Number.isFinite(share) && share > 0 ? share : 0);
  const total = clean.reduce((sum, share) => sum + share, 0);
  const scaled = total > 0 ? clean.map(share => share / total * FREQUENCY_SCALE) : clean.map(() => FREQUENCY_SCALE / clean.length);
  const floors = scaled.map(Math.floor);
  let missing = FREQUENCY_SCALE - floors.reduce((sum, value) => sum + value, 0);
  const order = scaled.map((value, index) => ({ index, remainder: value - floors[index] })).sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  const result = [...floors];
  for (const { index } of order) { if (missing <= 0) break; result[index] += 1; missing -= 1; }
  return result;
}

function toNode(node) {
  const width = node.actions.length;
  const freq = [];
  for (let start = 0; start < node.freq.length; start += width) freq.push(...quantize(node.freq.slice(start, start + width)));
  return { player: node.player, actions: node.actions, freq, ev: node.ev.map(value => Math.round(Number.isFinite(value) ? value : 0)), unreached: node.unreached };
}

/** The app's solution file for one flop, from the adapter's `--json-nodes` result. */
export function toSolutionFile(spec, board, result) {
  const plan = nodePlan(spec);
  if (!Array.isArray(result.nodes) || result.nodes.length !== plan.length) throw new Error("adapter returned a different number of nodes");
  const text = JSON.stringify({
    contract: SOLUTION_CONTRACT, scenario: spec.id, board,
    build: { iterations: result.iterations, exploitability: Math.round(result.exploitability * 1000) / 1000, elapsedMs: result.elapsedMs ?? 0, specHash: specHash(spec) },
    combos: result.combos,
    nodes: Object.fromEntries(plan.map((node, index) => [node.key, toNode(result.nodes[index])])),
  });
  if (text.length > MAX_SOLUTION_CHARS) throw new Error(`solution is ${text.length} characters (limit ${MAX_SOLUTION_CHARS})`);
  return text;
}

export function writeAtomic(path, text) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/** Exploitability of a valid stored solution for this exact spec and board, or null when it must be (re)solved. */
export function storedExploitability(path, spec, board) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const valid = value.contract === SOLUTION_CONTRACT && value.scenario === spec.id && value.board === board && value.build?.specHash === specHash(spec) && Number.isFinite(value.build?.exploitability);
    return valid ? value.build.exploitability : null;
  } catch {
    return null;
  }
}

/** Runs the adapter on one request; resolves with its result or rejects with the reported error. */
export function solveWithAdapter(adapter, payload, { spawnImpl = spawn, timeoutMs }) {
  return new Promise((resolveSolve, reject) => {
    const child = spawnImpl(adapter, ["--json-nodes"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let size = 0, stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`adapter timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) { child.kill(); reject(new Error("adapter output is too large")); } else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    // An adapter that exits before reading its input (e.g. a missing DLL) breaks the pipe; that fails this flop only.
    child.stdin.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`adapter exited with ${code}: ${stderr.trim()}`));
      try {
        const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (envelope.ok) resolveSolve(envelope.result); else reject(new Error(envelope.error));
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Stored exploitability per board for the spec's valid files; read once at start, then kept up to date. */
export function scanStored(spec, flops, outDir) {
  const entries = flops.map(board => [board, storedExploitability(join(outDir, spec.id, `${board}.json`), spec, board)]);
  return new Map(entries.filter(([, value]) => value !== null));
}

/** `storedBySpec` maps a scenario id to its stored boards; flops keep the manifest's heaviest-first order. */
export function writeIndex(specs, flops, storedBySpec, outDir) {
  mkdirSync(outDir, { recursive: true });
  const scenarios = specs.map(spec => ({ ...spec, specHash: specHash(spec), flops: flops.filter(board => storedBySpec.get(spec.id)?.has(board)) }));
  writeAtomic(join(outDir, "index.json"), JSON.stringify({ contract: INDEX_CONTRACT, scenarios }));
}

/**
 * Solves the scenario's flops that are missing or above `redoAbove`; failures are logged and skipped. A re-solve
 * replaces the stored file only when it converged further. `deps.stored` (board -> exploitability) is kept current.
 */
export async function runScenario(spec, flops, options, deps) {
  const directory = join(options.outDir, spec.id);
  mkdirSync(directory, { recursive: true });
  const { stored } = deps;
  const pending = flops.filter(board => !stored.has(board) || stored.get(board) > options.redoAbove).slice(0, options.limit);
  let solved = 0, failed = 0;
  for (const board of pending) {
    try {
      const result = await deps.solve(buildNodesRequest(spec, board, options));
      const previous = stored.get(board);
      const better = previous === undefined || result.exploitability < previous;
      if (better) {
        writeAtomic(join(directory, `${board}.json`), toSolutionFile(spec, board, result));
        stored.set(board, result.exploitability);
      }
      solved += 1;
      deps.log(`${spec.id} ${board} ${result.iterations} iter ${result.exploitability.toFixed(3)}% ${result.elapsedMs ?? "?"} ms${better ? "" : " (kept the better stored file)"}`);
    } catch (error) {
      failed += 1;
      deps.log(`${spec.id} ${board} failed: ${error.message}`);
    }
    if ((solved + failed) % INDEX_EVERY === 0) deps.onProgress();
  }
  deps.onProgress();
  return { solved, failed, pending: pending.length };
}

/**
 * Lowers this process's priority; children started afterwards inherit it (Windows below-normal class, POSIX nice).
 * Measured 2026-10-17: with the build at normal priority a 4.5 s 3-way river solve in the app got 5-8 iterations
 * (max best-response gain 8.6-18% of the pot); below normal it got 305-313 (0.01%).
 */
function yieldToLiveSolves() {
  try { setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch (error) { console.error(`Could not lower priority: ${error.message}`); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  yieldToLiveSolves();
  if (!existsSync(options.adapter)) throw new Error(`Adapter not found at ${options.adapter}; run cargo build --release in tools/dcfr-adapter.`);
  const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
  const specs = manifest.scenarios.filter(spec => !options.scenarios || options.scenarios.includes(spec.id));
  if (!specs.length) throw new Error("No scenario matches --scenarios.");
  const flops = manifest.flops.map(flop => flop.board);
  mkdirSync(options.logDir, { recursive: true });
  // Generous: tree building, the exploitability pass, and node export run after the solve budget.
  const timeoutMs = options.budgetMs * 4 + 120_000;
  const storedBySpec = new Map(manifest.scenarios.map(spec => [spec.id, scanStored(spec, flops, options.outDir)]));
  for (const spec of specs) {
    const logPath = join(options.logDir, `${spec.id}.log`);
    const log = line => { const stamped = `[${new Date().toISOString()}] ${line}`; appendFileSync(logPath, `${stamped}\n`); console.log(stamped); };
    const summary = await runScenario(spec, flops, options, {
      solve: payload => solveWithAdapter(options.adapter, payload, { timeoutMs }),
      log, stored: storedBySpec.get(spec.id),
      onProgress: () => writeIndex(manifest.scenarios, flops, storedBySpec, options.outDir),
    });
    log(`${spec.id} finished: ${summary.solved} solved, ${summary.failed} failed of ${summary.pending}`);
    if (summary.failed) process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
