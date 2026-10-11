import type { Classification, Tendency, TendencyTag } from "@/lib/profiling/classify";

export const tendencyLabels: Record<Tendency, string> = {
  unknown: "표본 부족", maniac: "매니악", "calling-station": "콜링 스테이션", nit: "니트", lag: "LAG", tag: "TAG",
  "loose-passive": "루즈 패시브", "tight-passive": "타이트 패시브",
};

export const tagLabels: Record<TendencyTag, string> = {
  limper: "림퍼", "folds-to-iso": "아이소에 폴드", "folds-to-3bet": "3벳에 폴드", "overfolds-to-cbet": "c-bet에 과폴드", "light-3bettor": "라이트 3벳",
};

/** "LAG(잠정) 34/27/9 · 58h": tendency, shrunk VPIP/PFR/3-bet, and hands played. */
export function tendencySummary(classification: Classification) {
  const label = tendencyLabels[classification.tendency] + (classification.confidence === "tentative" ? "(잠정)" : "");
  if (classification.confidence === "none") return `${label} · ${classification.hands}h`;
  return `${label} ${Math.round(classification.vpip)}/${Math.round(classification.pfr)}/${Math.round(classification.threeBet)} · ${classification.hands}h`;
}
