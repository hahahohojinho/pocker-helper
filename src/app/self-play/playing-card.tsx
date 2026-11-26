const SUIT_SYMBOLS: Record<string, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };

/** A face-up card ("Ah") or a face-down back when `hidden`. */
export default function PlayingCard({ code, hidden = false }: { code: string; hidden?: boolean }) {
  if (hidden) return <span className="sp-card back" aria-label="숨긴 카드" />;
  const suit = code[1];
  return <span className={`sp-card suit-${suit}`} aria-label={code}>{code[0]}<i>{SUIT_SYMBOLS[suit] ?? suit}</i></span>;
}
