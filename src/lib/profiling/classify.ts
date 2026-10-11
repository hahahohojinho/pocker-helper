import type { ProfileTableSize } from "./hand-record";
import type { StatEvent, StatKey } from "./stats";

export type StatTotals = Partial<Record<StatKey, { n: number; x: number }>>;

export function sumEvents(events: Iterable<StatEvent>): StatTotals {
  const totals: StatTotals = {};
  for (const { stat, n, x } of events) {
    const current = totals[stat] ?? { n: 0, x: 0 };
    totals[stat] = { n: current.n + n, x: current.x + x };
  }
  return totals;
}

/** Beta-binomial posterior mean: the observed rate shrunk toward priorMean as if priorStrength hands agreed with it. */
export function posteriorMean(x: number, n: number, priorMean: number, priorStrength: number) {
  return (x + priorMean * priorStrength) / (n + priorStrength);
}

export type Tendency = "unknown" | "maniac" | "calling-station" | "nit" | "lag" | "tag" | "loose-passive" | "tight-passive";
export type TendencyTag = "limper" | "folds-to-iso" | "folds-to-3bet" | "overfolds-to-cbet" | "light-3bettor";

export interface Classification {
  tendency: Tendency;
  confidence: "none" | "tentative" | "confident";
  hands: number;
  /** Shrunk rates in percent; af is aggression actions per call (null without postflop actions). */
  vpip: number;
  pfr: number;
  threeBet: number;
  af: number | null;
  tags: TendencyTag[];
}

// Population priors are heuristics for typical online pools, to be recalibrated against recorded data.
const PRIORS: Record<ProfileTableSize, { vpip: number; pfr: number; threeBet: number }> = {
  6: { vpip: 0.25, pfr: 0.19, threeBet: 0.07 },
  8: { vpip: 0.21, pfr: 0.16, threeBet: 0.06 },
};
const PRIOR_STRENGTH = 20;
const MIN_HANDS = 20;
const CONFIDENT_HANDS = 100;
/** 8-max ranges are tighter, so VPIP thresholds scale down with the table. */
const VPIP_SCALE: Record<ProfileTableSize, number> = { 6: 1, 8: 0.85 };

const TAG_RULES: { tag: TendencyTag; stat: StatKey; atLeast: number; minN: number }[] = [
  { tag: "limper", stat: "limp", atLeast: 0.15, minN: 30 },
  { tag: "folds-to-iso", stat: "limp_fold_to_raise", atLeast: 0.6, minN: 10 },
  { tag: "folds-to-3bet", stat: "fold_to_three_bet", atLeast: 0.65, minN: 15 },
  { tag: "overfolds-to-cbet", stat: "fold_to_flop_cbet", atLeast: 0.6, minN: 15 },
  { tag: "light-3bettor", stat: "three_bet", atLeast: 0.1, minN: 40 },
];

function tendencyFor(vpip: number, pfr: number, af: number | null, scale: number): Tendency {
  const ratio = vpip > 0 ? pfr / vpip : 0;
  if ((vpip >= 45 * scale && pfr >= 30 * scale) || ((af ?? 0) >= 4 && vpip >= 35 * scale)) return "maniac";
  if (vpip >= 35 * scale && ratio < 0.4 && (af ?? 0) < 1.5) return "calling-station";
  if (vpip < 16 * scale) return "nit";
  if (vpip >= 28 * scale && ratio >= 0.65) return "lag";
  if (ratio >= 0.65) return "tag";
  return vpip >= 28 * scale ? "loose-passive" : "tight-passive";
}

export function classifyPlayer(totals: StatTotals, tableSize: ProfileTableSize): Classification {
  const prior = PRIORS[tableSize];
  const shrunk = (stat: StatKey, mean: number) => 100 * posteriorMean(totals[stat]?.x ?? 0, totals[stat]?.n ?? 0, mean, PRIOR_STRENGTH);
  const hands = totals.vpip?.n ?? 0;
  const aggression = totals.af_aggr?.x ?? 0, calls = totals.af_call?.x ?? 0;
  const af = aggression + calls === 0 ? null : calls === 0 ? aggression : aggression / calls;
  const vpip = shrunk("vpip", prior.vpip), pfr = shrunk("pfr", prior.pfr), threeBet = shrunk("three_bet", prior.threeBet);
  const tags = TAG_RULES.filter(rule => {
    const total = totals[rule.stat];
    return total !== undefined && total.n >= rule.minN && total.x / total.n >= rule.atLeast;
  }).map(rule => rule.tag);
  const confidence = hands < MIN_HANDS ? "none" : hands < CONFIDENT_HANDS ? "tentative" : "confident";
  const tendency = confidence === "none" ? "unknown" : tendencyFor(vpip, pfr, af, VPIP_SCALE[tableSize]);
  return { tendency, confidence, hands, vpip, pfr, threeBet, af, tags };
}
