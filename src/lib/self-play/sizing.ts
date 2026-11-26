import type { PlayerAction, PlayerActionType } from "../game-state";
import type { bettingAmounts } from "../preflop-machine";
import type { PostflopContext } from "../postflop-hand-state";

export interface SizePreset { label: string; amount: number; }

const cents = (bb: number) => Math.round(bb * 100) / 100;
const halves = (bb: number) => Math.round(bb * 2) / 2;
const RAISE_TYPES: readonly PlayerActionType[] = ["open", "3bet", "4bet", "5bet"];
/** Postflop bet sizes offered as buttons, in fractions of the pot. */
export const BET_FRACTIONS = [0.33, 0.5, 0.75, 1, 1.5] as const;

/** Distinct presets clamped to [minimum, stack]; the stack itself is always the last one (all-in). */
function presets(entries: SizePreset[], minimum: number, stack: number): SizePreset[] {
  const clamped = entries.map(entry => ({ ...entry, amount: Math.min(stack, Math.max(minimum, entry.amount)) }));
  const unique = clamped.filter((entry, index) => entry.amount < stack && clamped.findIndex(other => other.amount === entry.amount) === index);
  return [...unique, { label: "All-in", amount: stack }];
}

/** Total-to amounts for a preflop raise: min, the usual size, pot, all-in. */
export function preflopRaisePresets(type: PlayerActionType, actions: readonly PlayerAction[], amounts: ReturnType<typeof bettingAmounts>, isBlind: boolean): SizePreset[] {
  if (!RAISE_TYPES.includes(type)) return [];
  const stack = cents(amounts.committed + amounts.remainingStack);
  const limpers = actions.filter(action => action.type === "limp").length;
  const usual = type === "open" ? (limpers ? 3.5 + limpers : isBlind ? 3 : 2.5)
    : type === "3bet" ? amounts.currentBet * (isBlind ? 4 : 3)
      : type === "4bet" ? amounts.currentBet * 2.25
        : stack;
  const pot = amounts.currentBet + amounts.pot + amounts.toCall;
  return presets([
    { label: "Min", amount: amounts.minimumRaiseTo },
    { label: "기본", amount: halves(usual) },
    { label: "Pot", amount: halves(pot) },
  ], amounts.minimumRaiseTo, stack);
}

/** Street-total amounts for a postflop bet (pot fractions) or raise (min, 3x, pot), plus all-in. */
export function postflopPresets(type: "bet" | "raise", context: PostflopContext, seat: number): SizePreset[] {
  const stack = context.remainingAtStart[seat] ?? 0;
  if (type === "bet") {
    return presets(BET_FRACTIONS.map(fraction => ({ label: `${Math.round(fraction * 100)}%`, amount: cents(context.pot * fraction) })), 0.01, stack);
  }
  const committed = context.contributions.get(seat) ?? 0;
  const toCall = context.currentBet - committed;
  const minimum = context.currentBet + context.lastFullRaiseSize;
  return presets([
    { label: "Min", amount: cents(minimum) },
    { label: "3x", amount: cents(context.currentBet * 3) },
    { label: "Pot", amount: cents(context.currentBet + context.pot + toCall) },
  ], minimum, stack);
}

/** The amount a call puts in (street or preflop total), capped by the stack. */
export function postflopCallAmount(context: PostflopContext, seat: number) {
  return Math.min(context.currentBet, context.remainingAtStart[seat] ?? 0);
}
