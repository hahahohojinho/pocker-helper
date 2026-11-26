import { seededRandom } from "../equity";

const RANKS = "23456789TJQKA";
const SUITS = "cdhs";
/** Five board cards are dealt up front; the street decides how many are shown. */
export const BOARD_CARDS = 5;

/** A fresh 32-bit seed from the platform RNG (also available on plain-http LAN pages, unlike randomUUID). */
export function createSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/** "2c" .. "As": the 52 card codes in a fixed order. */
export function orderedDeck(): string[] {
  return [...RANKS].flatMap(rank => [...SUITS].map(suit => `${rank}${suit}`));
}

/** Fisher-Yates with the same seeded generator as the equity sampler, so a seed always deals the same hand. */
export function shuffleDeck(seed: number): string[] {
  const random = seededRandom(seed);
  const deck = orderedDeck();
  for (let index = deck.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}

export interface Deal {
  /** Indexed by table slot; null for an empty slot. */
  holeCards: ([string, string] | null)[];
  board: string[];
}

/** Two cards to each occupied slot (in slot order), then the five board cards. */
export function dealHand(seed: number, occupied: readonly boolean[]): Deal {
  const deck = shuffleDeck(seed);
  let next = 0;
  const draw = () => deck[next++];
  const holeCards = occupied.map(isOccupied => isOccupied ? [draw(), draw()] as [string, string] : null);
  const board = Array.from({ length: BOARD_CARDS }, draw);
  return { holeCards, board };
}
