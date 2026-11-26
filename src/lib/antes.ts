import type { Position } from "./preflop";

/** "seat": every seat posts `amount`; "bb": the big blind posts `amount` for the whole table. Amounts are BB. */
export type AnteKind = "none" | "seat" | "bb";
export interface AnteSetting { kind: AnteKind; amount: number; }
export const NO_ANTE: AnteSetting = { kind: "none", amount: 0 };
/** Largest ante the inputs and hand records accept, in BB. */
export const MAX_ANTE_BB = 10;

export const hasAnte = (ante: AnteSetting) => ante.kind !== "none" && ante.amount > 0;

/** The blind each position posts before acting (the engine seeds the same amounts). */
const blindFor = (position: Position) => position === "SB" ? 0.5 : position === "BB" ? 1 : 0;
const cents = (bb: number) => Math.round(bb * 100) / 100;

export interface PostedAntes {
  /** Stacks the betting engine plays with: start stack minus the posted ante. */
  playStacks: number[];
  posted: number[];
  /** Total antes: dead money in the pot that no betting action matched. */
  deadMoney: number;
  /** Seats that cannot cover their ante and blind; all-in for less is not modelled, so the hand is refused. */
  shortSeats: number[];
}

/**
 * Antes are posted before the blinds and are dead money: they grow the pot but are not bets, so the call amount,
 * the current bet, and the minimum raise are unchanged; each seat simply plays the rest of its stack.
 */
export function postAntes(stacks: readonly number[], positions: readonly Position[], ante: AnteSetting): PostedAntes {
  const active = hasAnte(ante);
  const posted = positions.map(position => !active ? 0 : ante.kind === "seat" ? ante.amount : position === "BB" ? ante.amount : 0);
  const playStacks = positions.map((_, seat) => cents((stacks[seat] ?? 0) - posted[seat]));
  const shortSeats = positions.map((position, seat) => seat).filter(seat => posted[seat] > 0 && playStacks[seat] <= blindFor(positions[seat]));
  return { playStacks, posted, deadMoney: cents(posted.reduce((sum, amount) => sum + amount, 0)), shortSeats };
}
