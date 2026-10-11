/** Flop suit isomorphism: boards that differ only by a renaming of suits have the same solution. */
const RANKS = "23456789TJQKA";
const SUITS = ["c", "d", "h", "s"] as const;
const CARD = /^[2-9TJQKA][cdhs]$/;

type Suit = (typeof SUITS)[number];
export type SuitMap = Readonly<Record<Suit, Suit>>;

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
}

const SUIT_MAPS: readonly SuitMap[] = permutations(SUITS).map(order => Object.fromEntries(SUITS.map((suit, index) => [suit, order[index]])) as SuitMap);

const normalize = (card: string) => `${card[0].toUpperCase()}${card.slice(1).toLowerCase()}`;
const byRankThenSuit = (left: string, right: string) => RANKS.indexOf(right[0]) - RANKS.indexOf(left[0]) || left[1].localeCompare(right[1]);

/** Renames each card's suit; ranks are unchanged. */
export function mapCards(cards: readonly string[], suitMap: SuitMap): string[] {
  return cards.map(card => {
    const code = normalize(card);
    return `${code[0]}${suitMap[code[1] as Suit]}`;
  });
}

/**
 * The class representative of a flop: of the 24 suit renamings, the one whose high-to-low card string sorts first,
 * plus the renaming that produces it (apply it to hero cards before looking up a stored solution).
 */
export function canonicalFlop(board: readonly string[]): { board: string; suitMap: SuitMap } {
  const cards = board.map(normalize);
  if (cards.length !== 3 || !cards.every(card => CARD.test(card)) || new Set(cards).size !== 3) throw new Error("A flop needs three distinct cards like Ks7d2c.");
  let best: { board: string; suitMap: SuitMap } | null = null;
  for (const suitMap of SUIT_MAPS) {
    const candidate = mapCards(cards, suitMap).sort(byRankThenSuit).join("");
    if (!best || candidate < best.board) best = { board: candidate, suitMap };
  }
  return best!;
}

/** Every flop class with the number of raw flops (unordered card sets) it stands for; heaviest first. */
export function enumerateCanonicalFlops(): readonly { board: string; weight: number }[] {
  const deck = [...RANKS].flatMap(rank => SUITS.map(suit => `${rank}${suit}`));
  const weights = new Map<string, number>();
  for (let first = 0; first < deck.length; first++)
    for (let second = first + 1; second < deck.length; second++)
      for (let third = second + 1; third < deck.length; third++) {
        const { board } = canonicalFlop([deck[first], deck[second], deck[third]]);
        weights.set(board, (weights.get(board) ?? 0) + 1);
      }
  return [...weights].map(([board, weight]) => ({ board, weight })).sort((left, right) => right.weight - left.weight || left.board.localeCompare(right.board));
}
