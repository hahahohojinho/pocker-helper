import { PlayerAction, PlayerActionType } from "./game-state";
import { Position } from "./preflop";

export interface ValidationResult {
  valid: boolean;
  message: string;
  minimumAmount?: number;
}

export interface BettingState {
  raiseCount: number;
  currentBet: number;
  lastRaiseSize: number;
  foldedSeats: Set<number>;
  contributions: Map<number, number>;
  pot: number;
  allInSeats: Set<number>;
  lastFullRaiseIndex: number;
}

const preflopOrder: Position[] = ["UTG", "UTG+1", "MP", "HJ", "CO", "BTN", "SB", "BB"];
export type StackProfile = number | readonly number[];
const stackFor = (profile:StackProfile,seat:number) => typeof profile === "number" ? profile : (profile[seat] ?? Number.POSITIVE_INFINITY);

export function positionOrder(positions: Position[]) {
  return [...positions].sort((a, b) => preflopOrder.indexOf(a) - preflopOrder.indexOf(b));
}

export function deriveBettingState(actions: PlayerAction[], positions: Position[], effectiveStack:StackProfile = Number.POSITIVE_INFINITY): BettingState {
  const state: BettingState = {
    raiseCount: 0,
    currentBet: 1,
    lastRaiseSize: 1,
    foldedSeats: new Set(),
    contributions: new Map(),
    pot: 1.5,
    allInSeats: new Set(),
    lastFullRaiseIndex: -1,
  };
  positions.forEach((position, seat) => {
    if (position === "SB") state.contributions.set(seat, 0.5);
    if (position === "BB") state.contributions.set(seat, 1);
  });
  for (const [index, action] of actions.entries()) {
    if (action.type === "fold") {
      state.foldedSeats.add(action.seat);
      continue;
    }
    state.contributions.set(action.seat, action.amount);
    if (action.amount >= stackFor(effectiveStack,action.seat)) state.allInSeats.add(action.seat);
    if (["open", "3bet", "4bet", "5bet"].includes(action.type)) {
      const increment = action.amount - state.currentBet;
      if (increment >= state.lastRaiseSize) {
        state.lastRaiseSize = increment;
        state.lastFullRaiseIndex = index;
      }
      state.currentBet = action.amount;
      state.raiseCount += 1;
    }
  }
  state.pot = [...state.contributions.values()].reduce((sum, value) => sum + value, 0);
  return state;
}

export function bettingAmounts(actions: PlayerAction[], positions: Position[], seat: number, effectiveStack:StackProfile) {
  const state = deriveBettingState(actions, positions, effectiveStack);
  const seatStack=stackFor(effectiveStack,seat);
  const committed = state.contributions.get(seat) ?? 0;
  const toCall = Math.max(0, state.currentBet - committed);
  const minimumRaiseTo = state.currentBet + state.lastRaiseSize;
  return {
    pot: state.pot,
    committed,
    toCall: Math.min(toCall, Math.max(0, seatStack - committed)),
    currentBet: state.currentBet,
    minimumRaiseTo,
    remainingStack: Math.max(0, seatStack - committed),
  };
}

export function availableActions(actions: PlayerAction[], positions: Position[], seat: number, effectiveStack:StackProfile = Number.POSITIVE_INFINITY): PlayerActionType[] {
  const state = deriveBettingState(actions, positions, effectiveStack);
  if (state.foldedSeats.has(seat) || state.allInSeats.has(seat)) return [];
  if (state.raiseCount === 0) {
    const contribution = state.contributions.get(seat) ?? 0;
    return contribution === state.currentBet ? ["check", "open"] : ["fold", "limp", "open"];
  }
  const seatLastAction = actions.findLastIndex(action => action.seat === seat);
  const actionNotReopened = seatLastAction >= state.lastFullRaiseIndex && actions.slice(seatLastAction + 1).some(action => ["open", "3bet", "4bet", "5bet"].includes(action.type));
  if (state.raiseCount === 1) return actionNotReopened ? ["fold", "call"] : ["fold", "call", "3bet"];
  if (state.raiseCount === 2) return actionNotReopened ? ["fold", "call"] : ["fold", "call", "4bet"];
  if (state.raiseCount === 3) return actionNotReopened ? ["fold", "call"] : ["fold", "call", "5bet"];
  return ["fold", "call"];
}

export function validatePreflopAction(input: {
  actions: PlayerAction[];
  positions: Position[];
  seat: number;
  type: PlayerActionType;
  amount: number;
  effectiveStack: number;
  stacks?: readonly number[];
}): ValidationResult {
  const { actions, positions, seat, type, amount, effectiveStack } = input;
  const profile=input.stacks??effectiveStack;
  const state = deriveBettingState(actions, positions, profile);
  if (state.foldedSeats.has(seat)) return { valid: false, message: "이미 Fold한 플레이어는 다시 액션할 수 없습니다." };
  if (!availableActions(actions, positions, seat, profile).includes(type)) {
    const stage = state.raiseCount === 0 ? "오픈 전" : state.raiseCount === 1 ? "오픈 이후" : "3-bet 이후";
    return { valid: false, message: `${stage}에는 ${type} 액션을 사용할 수 없습니다.` };
  }
  if (type === "fold") return { valid: true, message: "Fold" };
  if (type === "check") {
    const contribution = state.contributions.get(seat) ?? 0;
    return contribution === state.currentBet
      ? { valid: true, message: "Check" }
      : { valid: false, message: `${state.currentBet - contribution}BB를 콜해야 하므로 Check할 수 없습니다.` };
  }
  const expectedCall = state.currentBet;
  if (type === "limp" && amount !== 1) return { valid: false, message: "Limp의 총 투입 금액은 1BB여야 합니다.", minimumAmount: 1 };
  if (type === "call" && amount !== expectedCall && !(amount === effectiveStack && effectiveStack < expectedCall)) return { valid: false, message: `Call은 총 ${Math.min(expectedCall, effectiveStack)}BB를 맞춰야 합니다.`, minimumAmount: Math.min(expectedCall, effectiveStack) };
  if (amount > effectiveStack) return { valid: false, message: `유효 스택 ${effectiveStack}BB를 초과할 수 없습니다.` };
  if (["open", "3bet", "4bet", "5bet"].includes(type)) {
    const minimum = state.currentBet + state.lastRaiseSize;
    const isShortAllIn = amount === effectiveStack && amount > state.currentBet;
    if (amount < minimum && !isShortAllIn) return { valid: false, message: `최소 레이즈 총액은 ${minimum}BB입니다.`, minimumAmount: minimum };
  }
  return { valid: true, message: "유효한 액션입니다." };
}

export function isBettingRoundComplete(actions: PlayerAction[], positions: Position[], effectiveStack:StackProfile = Number.POSITIVE_INFINITY) {
  if (!actions.length) return false;
  const state = deriveBettingState(actions, positions, effectiveStack);
  const activeSeats = positions.map((_, seat) => seat).filter(seat => !state.foldedSeats.has(seat));
  if (activeSeats.length <= 1) return true;
  const lastRaiseIndex = actions.findLastIndex(action => ["open", "3bet", "4bet", "5bet"].includes(action.type));
  const boundary = Math.max(0, lastRaiseIndex);
  return activeSeats.every(seat => {
    const acted = actions.some((action, index) => index >= boundary && action.seat === seat && action.type !== "fold");
    const matched = (state.contributions.get(seat) ?? 0) === state.currentBet || state.allInSeats.has(seat);
    return acted && matched;
  });
}

export function nextPosition(actions: PlayerAction[], positions: Position[], effectiveStack:StackProfile = Number.POSITIVE_INFINITY): Position | null {
  if (isBettingRoundComplete(actions, positions, effectiveStack)) return null;
  const ordered = positionOrder(positions);
  if (!actions.length) return ordered[0];
  const lastIndex = ordered.indexOf(actions.at(-1)!.position);
  const state = deriveBettingState(actions, positions, effectiveStack);
  for (let offset = 1; offset <= ordered.length; offset++) {
    const candidate = ordered[(lastIndex + offset) % ordered.length];
    const seat = positions.indexOf(candidate);
    if (!state.foldedSeats.has(seat) && !state.allInSeats.has(seat)) return candidate;
  }
  return null;
}
