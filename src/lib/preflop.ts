export type Position = "UTG" | "UTG+1" | "MP" | "HJ" | "CO" | "BTN" | "SB" | "BB";
export type Action = "Fold" | "Call" | "3-bet";

export interface PreflopSpot {
  heroPosition: Position;
  villainPosition: Position;
  hand: string;
  openSize: number;
  effectiveStack: number;
}

export interface Recommendation {
  primary: Action;
  frequencies: Record<Action, number>;
  confidence: "높음" | "보통" | "낮음";
  summary: string;
  assumptions: string[];
}

const ranks = "AKQJT98765432";

function normalizeHand(raw: string) {
  const compact = raw.toUpperCase().replace(/[^AKQJT2-9SO]/g, "");
  if (compact.length < 2) return "";
  const first = compact[0];
  const second = compact[1];
  if (!ranks.includes(first) || !ranks.includes(second)) return "";
  if (first === second) return `${first}${second}`;
  const [high, low] = ranks.indexOf(first) < ranks.indexOf(second)
    ? [first, second]
    : [second, first];
  return `${high}${low}${compact[2] === "O" ? "o" : "s"}`;
}

function handStrength(hand: string) {
  if (!hand) return 0;
  const a = ranks.indexOf(hand[0]);
  const b = ranks.indexOf(hand[1]);
  const pair = hand[0] === hand[1];
  const suited = hand.endsWith("s");
  const gap = Math.abs(a - b);
  let score = (13 - a) * 3 + (13 - b) * 1.4;
  if (pair) score += 27 - a * 1.4;
  if (suited) score += 4.5;
  if (!pair && gap <= 2) score += 3 - gap;
  if (hand[0] === "A") score += 3;
  return score;
}

const positionIndex: Record<Position, number> = {
  UTG: 0, "UTG+1": 1, MP: 2, HJ: 3, CO: 4, BTN: 5, SB: 6, BB: 7,
};

export function recommendPreflop(spot: PreflopSpot): Recommendation {
  const hand = normalizeHand(spot.hand);
  const strength = handStrength(hand);
  const openerWidth = positionIndex[spot.villainPosition] * 2.2;
  const positionBonus = positionIndex[spot.heroPosition] >= positionIndex[spot.villainPosition] ? 2 : -1;
  const sizePenalty = Math.max(0, spot.openSize - 2.5) * 2.4;
  const shortStackBonus = spot.effectiveStack <= 40 ? 2 : 0;
  const adjusted = strength + openerWidth + positionBonus - sizePenalty + shortStackBonus;

  let frequencies: Record<Action, number>;
  if (adjusted >= 63) frequencies = { Fold: 2, Call: 18, "3-bet": 80 };
  else if (adjusted >= 52) frequencies = { Fold: 8, Call: 47, "3-bet": 45 };
  else if (adjusted >= 43) frequencies = { Fold: 22, Call: 63, "3-bet": 15 };
  else if (adjusted >= 36) frequencies = { Fold: 57, Call: 38, "3-bet": 5 };
  else frequencies = { Fold: 91, Call: 8, "3-bet": 1 };

  const primary = Object.entries(frequencies).sort((a, b) => b[1] - a[1])[0][0] as Action;
  const confidence = !hand ? "낮음" : Math.max(...Object.values(frequencies)) >= 75 ? "높음" : "보통";

  return {
    primary,
    frequencies,
    confidence,
    summary: hand
      ? `${spot.villainPosition}의 ${spot.openSize}BB 오픈을 상대로 ${hand}는 ${primary} 비중이 가장 높습니다.`
      : "핸드를 AA, AKo, AQs 같은 형식으로 입력해 주세요.",
    assumptions: [
      "6-max NLHE 캐시게임의 일반적인 오픈 레인지",
      "앤티가 없고 앞선 콜러가 없는 상황",
      "현재 결과는 교육용 휴리스틱이며 솔버 출력이 아님",
    ],
  };
}
