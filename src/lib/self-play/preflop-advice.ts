import { preflopEffectiveStack, recommendFromHistory, type PlayerActionType } from "../game-state";
import { comboToClass } from "../profiling/hand-record";
import { SLOT_POSITIONS, type SelfPlayHand } from "./hand-state";

export type PreflopAdvice = ReturnType<typeof recommendFromHistory> & { hand: string; effectiveStack: number };
/** The recommendation's three buckets: fold, the passive line (limp/call/check), the aggressive line (any raise). */
export type PreflopBucket = "Fold" | "Call" | "3-bet";

/**
 * Pack (or fallback) strategy for the seat to act, from its own two cards and the action so far. Other seats' cards
 * are not an input: the advice must be what a player in that seat could know.
 */
export function preflopAdvice(hand: SelfPlayHand, seat: number, holeCards: readonly [string, string]): PreflopAdvice | null {
  const handClass = comboToClass(holeCards[0], holeCards[1]);
  if (!handClass) return null;
  const effectiveStack = preflopEffectiveStack(hand.startStacks, seat, hand.preflop);
  const recommendation = recommendFromHistory({ heroPosition: SLOT_POSITIONS[seat], hand: handClass, effectiveStack, actions: hand.preflop, tableSize: 6 });
  return { ...recommendation, hand: handClass, effectiveStack };
}

export function preflopBucket(type: PlayerActionType): PreflopBucket {
  if (type === "fold") return "Fold";
  return type === "check" || type === "limp" || type === "call" ? "Call" : "3-bet";
}

export interface PreflopGrade {
  bucket: PreflopBucket;
  /** How often the strategy takes the chosen line, 0-1. */
  frequency: number;
  best: PreflopBucket;
  bestFrequency: number;
  /** "good": the strategy's main line or played at least 25%; "mixed": played sometimes; "mistake": almost never. */
  verdict: "good" | "mixed" | "mistake";
}

const MAIN_LINE = 0.25;
const RARE_LINE = 0.05;

/** Frequency-based grade: preflop packs carry frequencies, not EVs, so there is no EV loss to report. */
export function gradePreflop(advice: PreflopAdvice, type: PlayerActionType): PreflopGrade {
  const bucket = preflopBucket(type);
  // Recommendation frequencies are whole percentages.
  const share = (bucketName: PreflopBucket) => (advice.frequencies[bucketName] ?? 0) / 100;
  const frequency = share(bucket);
  const best = (Object.keys(advice.frequencies) as PreflopBucket[]).sort((left, right) => share(right) - share(left))[0];
  const bestFrequency = share(best);
  const verdict = bucket === best || frequency >= MAIN_LINE ? "good" : frequency >= RARE_LINE ? "mixed" : "mistake";
  return { bucket, frequency, best, bestFrequency, verdict };
}
