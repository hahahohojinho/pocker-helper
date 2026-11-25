/** Precomputed heads-up flop solutions: an index of scenarios and one file per canonical flop. */
export const INDEX_CONTRACT = "rangelab.flop_library_index.v1";
export const SOLUTION_CONTRACT = "rangelab.flop_solution.v1";
export const MAX_INDEX_CHARS = 300_000;
export const MAX_SOLUTION_CHARS = 400_000;
/** Strategy shares are stored in thousandths and sum to exactly this per combo. */
export const FREQUENCY_SCALE = 1000;
const MAX_SCENARIOS = 64;
const MAX_FLOPS = 1755;
const MAX_ACTIONS = 8;
const MAX_CHIPS = 10_000_000;
/** Flop decisions kept per board: the OOP root, IP after a check, and facing a bet of a stored size ("b1/2"). */
const NODE_KEY = /^(|x|b\d{1,4}\/\d{1,4}|x,b\d{1,4}\/\d{1,4})$/;
const MAX_NODES = 8;

export type Role = "oop" | "ip";
export type Fraction = [number, number];
export type ActionCategory = "fold" | "check" | "call" | "bet" | "raise";

export interface FlopScenario {
  id: string; label: string; oop: string; ip: string;
  /** Chips (1/100 BB) at the start of the flop, as in the solve request. */
  pot: number; stacks: [number, number];
  betSizes: Fraction[][]; maxRaises: number;
  oopRange: string; ipRange: string;
  flops: string[]; generatedAt: string;
  /** Fingerprint of the inputs above; every solution file must carry the same one. */
  specHash: string;
}
export interface FlopIndex { scenarios: FlopScenario[]; }

export interface FlopNode {
  player: Role;
  actions: { category: ActionCategory; label: string }[];
  /** Per combo of the acting player (in `combos[player]` order), one entry per action. */
  freq: number[]; ev: number[];
  /** Combo indexes the equilibrium never brings here; their `freq` is the best response by EV. */
  unreached: number[];
}
export interface FlopSolution {
  scenario: string; board: string;
  build: { iterations: number; exploitability: number; elapsedMs: number; specHash: string };
  combos: Record<Role, string[]>;
  nodes: Readonly<Record<string, FlopNode>>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SPEC_HASH = /^[0-9a-f]{16}$/;
const BOARD = /^([2-9TJQKA][cdhs]){3}$/;
const COMBO = /^([2-9TJQKA][cdhs]){2}$/;
const CATEGORIES = new Set<ActionCategory>(["fold", "check", "call", "bet", "raise"]);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isChips = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_CHIPS;
const isFraction = (value: unknown): value is Fraction => Array.isArray(value) && value.length === 2 && value.every(term => Number.isInteger(term) && term > 0 && term <= 1000);

function parseJson(text: string, limit: number, label: string): Record<string, unknown> {
  if (text.length > limit) throw new Error(`${label} is too large.`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON.`); }
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function parseScenario(raw: unknown, index: number): FlopScenario {
  const fail = (field: string) => new Error(`Flop library scenario ${index + 1}: invalid ${field}.`);
  if (!isRecord(raw)) throw fail("scenario");
  if (typeof raw.id !== "string" || !ID.test(raw.id)) throw fail("id");
  for (const field of ["label", "oop", "ip", "oopRange", "ipRange", "generatedAt"]) if (typeof raw[field] !== "string") throw fail(field);
  if (typeof raw.specHash !== "string" || !SPEC_HASH.test(raw.specHash)) throw fail("specHash");
  if (!isChips(raw.pot) || !Array.isArray(raw.stacks) || raw.stacks.length !== 2 || !raw.stacks.every(isChips)) throw fail("pot or stacks");
  const sizes = raw.betSizes;
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > 4 || !sizes.every(depth => Array.isArray(depth) && depth.length && depth.length <= 6 && depth.every(isFraction))) throw fail("betSizes");
  if (!Number.isInteger(raw.maxRaises) || (raw.maxRaises as number) < 1 || (raw.maxRaises as number) > 4) throw fail("maxRaises");
  const flops = raw.flops;
  if (!Array.isArray(flops) || flops.length > MAX_FLOPS || !flops.every(board => typeof board === "string" && BOARD.test(board)) || new Set(flops).size !== flops.length) throw fail("flops");
  return { ...(raw as unknown as FlopScenario), stacks: [...raw.stacks] as [number, number], betSizes: (sizes as Fraction[][]).map(depth => depth.map(([n, d]) => [n, d] as Fraction)), flops: [...flops] };
}

export function parseFlopIndex(text: string): FlopIndex {
  const value = parseJson(text, MAX_INDEX_CHARS, "Flop library index");
  if (value.contract !== INDEX_CONTRACT) throw new Error(`Flop library index contract must be ${INDEX_CONTRACT}.`);
  if (!Array.isArray(value.scenarios) || value.scenarios.length > MAX_SCENARIOS) throw new Error(`Flop library index needs at most ${MAX_SCENARIOS} scenarios.`);
  const scenarios = value.scenarios.map(parseScenario);
  if (new Set(scenarios.map(scenario => scenario.id)).size !== scenarios.length) throw new Error("Flop library scenario ids must be unique.");
  return { scenarios };
}

function parseCombos(raw: unknown, board: string): string[] {
  if (typeof raw !== "string" || raw.length % 4 !== 0 || raw.length > 1326 * 4) throw new Error("Flop solution combos are invalid.");
  const combos = raw.match(/.{4}/g) ?? [];
  const boardCards = new Set(board.match(/.{2}/g));
  for (const combo of combos) {
    const cards = [combo.slice(0, 2), combo.slice(2)];
    if (!COMBO.test(combo) || cards[0] === cards[1] || cards.some(card => boardCards.has(card))) throw new Error(`Flop solution combo ${combo} is invalid.`);
  }
  if (new Set(combos).size !== combos.length) throw new Error("Flop solution combos repeat.");
  return combos;
}

function parseNode(raw: unknown, key: string, combos: Record<Role, string[]>): FlopNode {
  const fail = (field: string) => new Error(`Flop solution node "${key}": invalid ${field}.`);
  if (!isRecord(raw) || (raw.player !== "oop" && raw.player !== "ip")) throw fail("player");
  const actions = raw.actions;
  if (!Array.isArray(actions) || !actions.length || actions.length > MAX_ACTIONS || !actions.every(action => isRecord(action) && CATEGORIES.has(action.category as ActionCategory) && typeof action.label === "string")) throw fail("actions");
  const player: Role = raw.player;
  const count = combos[player].length * actions.length;
  const { freq, ev, unreached } = raw;
  if (!Array.isArray(freq) || freq.length !== count || !freq.every(value => Number.isInteger(value) && value >= 0 && value <= FREQUENCY_SCALE)) throw fail("freq");
  for (let start = 0; start < count; start += actions.length)
    if ((freq as number[]).slice(start, start + actions.length).reduce((sum, value) => sum + value, 0) !== FREQUENCY_SCALE) throw fail("freq total");
  if (!Array.isArray(ev) || ev.length !== count || !ev.every(value => Number.isInteger(value) && Math.abs(value) <= 4 * MAX_CHIPS)) throw fail("ev");
  if (!Array.isArray(unreached) || !unreached.every(index => Number.isInteger(index) && index >= 0 && index < combos[player].length)) throw fail("unreached");
  return { player, actions: actions.map(action => ({ category: action.category, label: action.label })), freq: [...freq], ev: [...ev], unreached: [...unreached] } as FlopNode;
}

/** Validates a stored flop solution for the scenario and board it was requested for. */
export function parseFlopSolution(text: string, scenarioId: string, board: string): FlopSolution {
  const value = parseJson(text, MAX_SOLUTION_CHARS, "Flop solution");
  if (value.contract !== SOLUTION_CONTRACT) throw new Error(`Flop solution contract must be ${SOLUTION_CONTRACT}.`);
  if (value.scenario !== scenarioId || value.board !== board) throw new Error("Flop solution is for a different scenario or board.");
  const build = value.build;
  if (!isRecord(build) || !Number.isInteger(build.iterations) || ![build.exploitability, build.elapsedMs].every(item => typeof item === "number" && Number.isFinite(item) && item >= 0)) throw new Error("Flop solution build info is invalid.");
  if (typeof build.specHash !== "string" || !SPEC_HASH.test(build.specHash)) throw new Error("Flop solution build info is invalid.");
  if (!isRecord(value.combos) || !isRecord(value.nodes)) throw new Error("Flop solution needs combos and nodes.");
  const combos = { oop: parseCombos(value.combos.oop, board), ip: parseCombos(value.combos.ip, board) };
  const keys = Object.keys(value.nodes);
  const unknown = keys.find(key => !NODE_KEY.test(key));
  if (unknown !== undefined || keys.length > MAX_NODES) throw new Error(`Flop solution nodes are invalid${unknown === undefined ? "" : ` ("${unknown}")`}.`);
  const nodes = Object.fromEntries(Object.entries(value.nodes).map(([key, node]) => [key, parseNode(node, key, combos)]));
  return { scenario: scenarioId, board, build: { iterations: build.iterations as number, exploitability: build.exploitability as number, elapsedMs: build.elapsedMs as number, specHash: build.specHash }, combos, nodes };
}

export const isNodeKey = (value: string) => NODE_KEY.test(value);
export const isScenarioId = (value: string) => ID.test(value);
export const isFlopCode = (value: string) => BOARD.test(value);
