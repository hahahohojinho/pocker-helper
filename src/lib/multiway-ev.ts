/** Which opponents continue against a bet, and how likely that combination is (independent decisions). */
export interface CallerSubset { readonly members: readonly number[]; readonly probability: number; }

/** Hero equity in percent against each exactly computed caller subset, and against every possible caller at once. */
export interface SubsetEquities { readonly byKey: ReadonlyMap<string, number>; readonly everyone: number | null; }

export interface SubsetPlan { readonly exact: CallerSubset[]; readonly rest: CallerSubset[]; readonly foldAll: number; }

/** Subsets are enumerated, so the opponent count must stay at table size. */
const MAX_OPPONENTS = 9;
const MAX_EXACT_SUBSETS = 8;
const EXACT_MASS = 0.98;

export const subsetKey = (members: readonly number[]) => members.join(",");

/** Every combination of responders that continue, with nonzero probability, most likely first. */
export function callerSubsets(outcomes: readonly { call: number; fold: number }[]): CallerSubset[] {
  if (outcomes.length > MAX_OPPONENTS) throw new RangeError(`At most ${MAX_OPPONENTS} opponents are supported.`);
  const subsets: CallerSubset[] = [];
  for (let mask = 0; mask < 1 << outcomes.length; mask++) {
    const members = outcomes.map((_, index) => index).filter(index => mask & (1 << index));
    const probability = outcomes.reduce((product, outcome, index) => product * (members.includes(index) ? outcome.call : outcome.fold), 1);
    if (probability > 0) subsets.push({ members, probability });
  }
  return subsets.sort((left, right) => right.probability - left.probability);
}

/**
 * Splits caller subsets into the likely ones that get their own equity (at most 8, until 98% of the probability is
 * covered) and the rest, which share one estimate against every possible caller. Everyone folding needs no equity.
 */
export function planSubsets(subsets: readonly CallerSubset[], options: { maxExact?: number; exactMass?: number } = {}): SubsetPlan {
  const maxExact = options.maxExact ?? MAX_EXACT_SUBSETS, exactMass = options.exactMass ?? EXACT_MASS;
  const foldAll = subsets.find(subset => !subset.members.length)?.probability ?? 0;
  const exact: CallerSubset[] = [], rest: CallerSubset[] = [];
  let covered = foldAll;
  for (const subset of subsets.filter(item => item.members.length)) {
    if (exact.length < maxExact && covered < exactMass) {
      exact.push(subset);
      covered += subset.probability;
    } else rest.push(subset);
  }
  return { exact, rest, foldAll };
}

/** Post-flop outcomes from fold probabilities: whoever does not fold calls. */
export const foldOutcomes = (folds: readonly number[]) => folds.map(fold => ({ call: 1 - fold, fold }));

/**
 * Default fold probability per opponent when nothing is known: each of the k players who can fold folds
 * alpha^(1/k), so everyone folds with the bettor's break-even rate alpha and a pure bluff breaks even for any
 * number of callers. An opponent who cannot fold (all in) gets 0. One opponent gets alpha, as heads-up.
 */
export function defaultMultiwayFolds(breakEven: number, foldable: readonly boolean[]): number[] {
  const count = foldable.filter(Boolean).length;
  return foldable.map(canFold => canFold && count ? breakEven ** (1 / count) : 0);
}

export interface MultiwayBetInput {
  /** Pot before the bet, the chips the hero adds, and what each caller adds to match it. */
  pot: number; heroRisk: number; villainCall: number;
  folds: readonly number[];
  /** Most each opponent can add beyond the current bet; a short caller returns the hero's uncalled excess. */
  callCaps?: readonly number[];
  /** What each opponent still owes to reach the current bet before calling the raise (0 once matched). */
  owed?: readonly number[];
  equities: SubsetEquities;
}

export interface MultiwayBetResult { ev: number; foldAll: number; expectedCallers: number; approximate: boolean; }

/**
 * EV of a bet or raise against independent opponents: the pot when everyone folds, otherwise for each subset of
 * callers the hero's equity against them in a pot that grows with every caller. Side pots are not separated.
 */
export function multiwayBetEv(input: MultiwayBetInput): MultiwayBetResult {
  for (const [name, values] of [["callCaps", input.callCaps], ["owed", input.owed]] as const)
    if (values && values.length !== input.folds.length) throw new RangeError(`${name} needs one value per opponent.`);
  const plan = planSubsets(callerSubsets(foldOutcomes(input.folds)));
  const callOf = (index: number) => Math.max(0, Math.min(input.villainCall, input.callCaps?.[index] ?? input.villainCall));
  const subsetEv = (subset: CallerSubset) => {
    const equity = input.equities.byKey.get(subsetKey(subset.members)) ?? input.equities.everyone;
    if (equity === null || equity === undefined) throw new Error(`No equity for callers ${subsetKey(subset.members)}.`);
    const calls = subset.members.map(callOf);
    const heroPut = input.heroRisk - (input.villainCall - Math.max(...calls));
    const owed = subset.members.reduce((sum, index) => sum + Math.max(0, input.owed?.[index] ?? 0), 0);
    const finalPot = input.pot + heroPut + owed + calls.reduce((sum, call) => sum + call, 0);
    return subset.probability * (equity / 100 * finalPot - heroPut);
  };
  const called = [...plan.exact, ...plan.rest];
  return {
    ev: plan.foldAll * input.pot + called.reduce((sum, subset) => sum + subsetEv(subset), 0),
    foldAll: plan.foldAll,
    expectedCallers: input.folds.reduce((sum, fold) => sum + 1 - fold, 0),
    approximate: plan.rest.length > 0,
  };
}
