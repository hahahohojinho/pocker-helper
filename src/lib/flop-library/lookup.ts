import type { WasmHistoryAction, WasmSolveRequest } from "../wasm-solver/request";
import { CHIPS_PER_BB } from "../wasm-solver/request";
import { canonicalFlop, mapCards } from "./canonical";
import { FREQUENCY_SCALE, type ActionCategory, type FlopIndex, type FlopScenario, type FlopSolution, type Fraction } from "./format";

export type FlopLibraryMiss = "not-flop" | "line" | "scenario" | "board" | "stale" | "node" | "hero";
/** Set when the library answers for a different effective stack (within STACK_TOLERANCE), in BB. */
export interface StackApproximation { libraryStack: number; requestedStack: number; }
export interface FlopLibraryMatch { scenario: FlopScenario; board: string; nodeKey: string; hero: string; stackApprox?: StackApproximation; }

/**
 * Cash stacks drift from the 100bb the library was solved for. Within 15% of the solved effective stack the stored
 * strategy is used and labelled as an approximation; beyond it the live solver answers.
 */
export const STACK_TOLERANCE = 0.15;
/**
 * Below this stack-to-pot ratio (on the shallower of the two stacks) the stored bet and raise sizes approach the
 * stack, so all-in collapses and missing raise nodes make a stored line invalid for another stack: exact stacks only.
 */
export const MIN_APPROX_SPR = 4;

/** Explains a miss in the UI; the live solver answers instead. */
export const MISS_LABELS: Record<FlopLibraryMiss, string> = {
  "not-flop": "플랍이 아님",
  line: "라이브러리에 없는 액션 라인",
  scenario: "레인지, 팟, 사이즈가 사전 계산과 다르거나 유효 스택이 15% 넘게 다름 (SPR 4 미만은 정확히 같아야 함)",
  board: "아직 계산하지 않은 플랍",
  stale: "이전 설정으로 계산된 파일 (라이브러리 재생성 필요)",
  node: "이 보드에 없는 노드",
  hero: "Hero 핸드가 저장된 레인지에 없음",
};

const sameFractions = (left: Fraction[][], right: Fraction[][]) => JSON.stringify(left) === JSON.stringify(right);

/** "" (OOP root), "x" (IP after a check), "b1/2" or "x,b1/2" (facing that bet); null for any other line. */
export function historyKey(history: readonly WasmHistoryAction[]): string | null {
  const steps = history.map(step => step.action === "check" ? "x" : step.action === "bet" ? `b${step.size[0]}/${step.size[1]}` : null);
  if (steps.some(step => step === null) || steps.length > 2) return null;
  const key = steps.join(",");
  return ["", "x"].includes(key) || /^(x,)?b\d+\/\d+$/.test(key) ? key : null;
}

/** Finds the stored scenario and canonical flop that answer exactly this solve request. */
export function matchFlopLibrary(index: FlopIndex, request: WasmSolveRequest): FlopLibraryMatch | { miss: FlopLibraryMiss } {
  if (request.board.length !== 6) return { miss: "not-flop" };
  const nodeKey = historyKey(request.history);
  if (nodeKey === null) return { miss: "line" };
  // The library solved the flop-only tree with the default all-in rule and no rake; any other game is not stored.
  if (request.betSizesByStreet || request.allinPotRatio !== undefined || request.rake) return { miss: "scenario" };
  const requestedStack = Math.min(...request.stacks);
  const stackGap = (item: FlopScenario) => Math.abs(requestedStack - Math.min(...item.stacks));
  const stackUsable = (item: FlopScenario) => {
    const solved = Math.min(...item.stacks);
    if (solved === requestedStack) return true;
    return stackGap(item) <= solved * STACK_TOLERANCE && Math.min(solved, requestedStack) / item.pot >= MIN_APPROX_SPR;
  };
  // The closest stack wins, so an exact scenario is never shadowed by an approximate one listed earlier.
  const scenario = index.scenarios
    .filter(item => item.pot === request.pot && stackUsable(item) && item.maxRaises === request.maxRaises
      && sameFractions(item.betSizes, request.betSizes) && item.oopRange === request.oopRange && item.ipRange === request.ipRange)
    .reduce<FlopScenario | undefined>((best, item) => !best || stackGap(item) < stackGap(best) ? item : best, undefined);
  if (!scenario) return { miss: "scenario" };
  const { board, suitMap } = canonicalFlop(request.board.match(/.{2}/g) ?? []);
  if (!scenario.flops.includes(board)) return { miss: "board" };
  // Only the effective stack shapes the game; a deeper stack behind it changes nothing.
  const exact = stackGap(scenario) === 0;
  const stackApprox = exact ? {} : { stackApprox: { libraryStack: Math.min(...scenario.stacks) / CHIPS_PER_BB, requestedStack: requestedStack / CHIPS_PER_BB } };
  return { scenario, board, nodeKey, hero: mapCards(request.hero.match(/.{2}/g) ?? [], suitMap).join(""), ...stackApprox };
}

interface Grouped { category: ActionCategory; frequency: number; weightedEv: number; bestEv: number; }
/** One stored action for Hero's combo, in the live solver's `details` shape (frequency 0-1, EV in BB). */
export interface LibraryDetail { action: ActionCategory; label: string; frequency: number; ev: number; }

function heroDetails(solution: FlopSolution, match: FlopLibraryMatch): { miss: FlopLibraryMiss } | { details: LibraryDetail[]; unreached: boolean } {
  const node = solution.nodes[match.nodeKey];
  if (!node) return { miss: "node" };
  const combos = solution.combos[node.player];
  const reversed = `${match.hero.slice(2)}${match.hero.slice(0, 2)}`;
  const comboIndex = combos.findIndex(combo => combo === match.hero || combo === reversed);
  if (comboIndex < 0) return { miss: "hero" };
  const details = node.actions.map((action, actionIndex) => {
    const offset = comboIndex * node.actions.length + actionIndex;
    return { action: action.category, label: action.label, frequency: node.freq[offset] / FREQUENCY_SCALE, ev: node.ev[offset] / CHIPS_PER_BB };
  });
  return { details, unreached: node.unreached.includes(comboIndex) };
}

function groupDetails(details: readonly LibraryDetail[]): Grouped[] {
  const groups = details.reduce((map, { action, frequency, ev }) => {
    const previous = map.get(action) ?? { category: action, frequency: 0, weightedEv: 0, bestEv: Number.NEGATIVE_INFINITY };
    return new Map([...map, [action, { ...previous, frequency: previous.frequency + frequency, weightedEv: previous.weightedEv + frequency * ev, bestEv: Math.max(previous.bestEv, ev) }]]);
  }, new Map<ActionCategory, Grouped>());
  return [...groups.values()];
}

/** Normalized solver JSON (as from a live solve) for Hero's combo, or the reason it cannot be answered. */
export function answerFromSolution(solution: FlopSolution, match: FlopLibraryMatch): string | { miss: FlopLibraryMiss } {
  // A file solved for an older manifest (other ranges or tree) must never answer for the current spec.
  if (solution.build.specHash !== match.scenario.specHash) return { miss: "stale" };
  const hero = heroDetails(solution, match);
  if ("miss" in hero) return hero;
  // A category the hand never takes has no frequency-weighted EV; its best concrete size is shown instead.
  const strategy = groupDetails(hero.details).map(group => ({ action: group.category, frequency: group.frequency, ev: group.frequency > 0 ? group.weightedEv / group.frequency : group.bestEv }));
  const best = strategy.reduce((top, item) => item.frequency > top.frequency ? item : top);
  return JSON.stringify({
    source: "flop-library", strategy, details: hero.details, best_action: best.action,
    exploitability: solution.build.exploitability, iterations: solution.build.iterations,
    scenario: match.scenario.label, generatedAt: match.scenario.generatedAt,
    ...(hero.unreached ? { note: "균형 전략에서 Hero 핸드는 이 라인에 도달하지 않습니다. 빈도 대신 EV가 가장 높은 액션을 표시합니다." } : {}),
  });
}
