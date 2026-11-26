"use client";

import { useState } from "react";
import type { PlayerActionType } from "@/lib/game-state";
import type { PostflopActionType } from "@/lib/postflop-machine";
import type { HandTurn, SelfPlayHand } from "@/lib/self-play/hand-state";
import { postflopCallAmount, postflopPresets, preflopRaisePresets, type SizePreset } from "@/lib/self-play/sizing";

export type ActionType = PlayerActionType | PostflopActionType;
type ActiveTurn = Exclude<HandTurn, { kind: "over" }>;

export const ACTION_LABELS: Record<ActionType, string> = {
  fold: "Fold", check: "Check", limp: "Limp", open: "Open", call: "Call", "3bet": "3-bet", "4bet": "4-bet", "5bet": "5-bet", bet: "Bet", raise: "Raise",
};
const RAISE_TYPES: readonly ActionType[] = ["open", "3bet", "4bet", "5bet", "bet", "raise"];
const BLINDS = new Set(["SB", "BB"]);
/** Custom amounts are kept in whole cents, like every other amount the engines see. */
const customAmount = (text: string) => { const value = Number(text); return text.trim() !== "" && Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null; };

/** The single amount a non-raise action puts in (total for the round). */
function fixedAmount(turn: ActiveTurn, type: ActionType): number {
  if (turn.kind === "preflop") {
    if (type === "limp") return 1;
    if (type === "call") return Math.min(turn.amounts.currentBet, turn.amounts.committed + turn.amounts.remainingStack);
    return 0;
  }
  return type === "call" ? postflopCallAmount(turn.context, turn.seat) : 0;
}

function sizePresets(hand: SelfPlayHand, turn: ActiveTurn, type: ActionType): SizePreset[] {
  if (turn.kind === "preflop") return preflopRaisePresets(type as PlayerActionType, hand.preflop, turn.amounts, BLINDS.has(turn.position));
  return type === "bet" || type === "raise" ? postflopPresets(type, turn.context, turn.seat) : [];
}

/** Action buttons for the seat to act: one button per fixed action, size presets plus a custom amount per raise. */
export default function SelfPlayDock({ hand, turn, onAct }: { hand: SelfPlayHand; turn: ActiveTurn; onAct: (type: ActionType, amount: number) => void }) {
  const [custom, setCustom] = useState("");
  const allowed = turn.allowed as ActionType[];
  const fixed = allowed.filter(type => !RAISE_TYPES.includes(type));
  // A raise needs chips above the current bet; a shorter stack can only call all-in.
  const raiseStack = turn.kind === "preflop" ? turn.amounts.committed + turn.amounts.remainingStack : (turn.context.remainingAtStart[turn.seat] ?? 0);
  const currentBet = turn.kind === "preflop" ? turn.amounts.currentBet : turn.context.currentBet;
  const raises = allowed.filter(type => RAISE_TYPES.includes(type) && raiseStack > currentBet);
  return <div className="sp-actions">
    <div className="action-buttons">
      {fixed.map(type => {
        const amount = fixedAmount(turn, type);
        return <button key={type} type="button" onClick={() => onAct(type, amount)}>{ACTION_LABELS[type]}{amount > 0 ? ` ${amount}` : ""}</button>;
      })}
    </div>
    {raises.map(type => <div key={type} className="sp-raise-row">
      <b>{ACTION_LABELS[type]}</b>
      {sizePresets(hand, turn, type).map(preset => <button key={preset.label} type="button" onClick={() => onAct(type, preset.amount)}>{preset.label} <small>{preset.amount}</small></button>)}
      <span className="sp-custom">
        <input type="number" min="0.01" step="0.01" value={custom} placeholder="총액 BB" onChange={event => setCustom(event.target.value)} />
        <button type="button" disabled={customAmount(custom) === null} onClick={() => { const amount = customAmount(custom); if (amount !== null) onAct(type, amount); }}>적용</button>
      </span>
    </div>)}
  </div>;
}
