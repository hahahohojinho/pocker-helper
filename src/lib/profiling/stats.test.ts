import { describe, expect, it } from "vitest";
import type { HandRecordV1 } from "./hand-record";
import { replayHandRecord } from "./hand-replay";
import { extractShowdownHands } from "./showdown-lines";
import { computeStatEvents, type StatEvent } from "./stats";
import { classifyPlayer, posteriorMean, sumEvents, type StatTotals } from "./classify";
import { makeHand, PLAYER, srpToShowdown } from "./__fixtures__/hands";

function replayed(record: HandRecordV1) {
  const result = replayHandRecord(record);
  if (!result.ok || !result.end.finished) throw new Error(`fixture is not a finished legal hand: ${JSON.stringify(result)}`);
  return result;
}
function events(record: HandRecordV1) {
  const { end, preflopState } = replayed(record);
  const bySeat = computeStatEvents(record, end, preflopState);
  return (seat: number) => Object.fromEntries((bySeat.get(seat) ?? []).map(({ stat, n, x }: StatEvent) => [stat, [n, x]]));
}

describe("computeStatEvents", () => {
  it("scores a single-raised pot that goes to showdown", () => {
    const seat = events(srpToShowdown());
    expect(seat(5)).toMatchObject({ vpip: [1, 1], pfr: [1, 1], limp: [1, 0], flop_cbet: [1, 1], af_aggr: [1, 1], saw_flop: [1, 1], wtsd: [1, 1], wsd: [1, 0] });
    expect(seat(0)).toMatchObject({ vpip: [1, 1], pfr: [1, 0], three_bet: [1, 0], cold_call: [1, 1], fold_to_flop_cbet: [1, 0], af_call: [1, 1], wsd: [1, 1] });
    expect(seat(1)).toMatchObject({ vpip: [1, 0], three_bet: [1, 0], cold_call: [1, 0] });
    expect(seat(3)).toEqual({ limp: [1, 0], vpip: [1, 0], pfr: [1, 0] });
  });
  it("gives a big blind walk no VPIP opportunity", () => {
    const seat = events(makeHand({ heroSeat: 0, preflop: [[3, "fold"], [4, "fold"], [5, "fold"], [0, "fold"], [1, "fold"]], winners: [2] }));
    expect(seat(2)).toEqual({});
  });
  it("tracks a limper who folds to an isolation raise", () => {
    const seat = events(makeHand({ preflop: [[3, "limp", 1], [4, "open", 4], [5, "fold"], [0, "fold"], [1, "fold"], [2, "fold"], [3, "fold"]], winners: [4] }));
    expect(seat(3)).toMatchObject({ limp: [1, 1], vpip: [1, 1], limp_fold_to_raise: [1, 1], limp_call_raise: [1, 0], limp_reraise: [1, 0], three_bet: [1, 0] });
    expect(seat(3).cold_call).toBeUndefined();
  });
  it("tracks folding to a 3-bet", () => {
    const seat = events(makeHand({ preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "3bet", 8], [1, "fold"], [2, "fold"], [5, "fold"]], winners: [0] }));
    expect(seat(5)).toMatchObject({ fold_to_three_bet: [1, 1], pfr: [1, 1] });
    expect(seat(0)).toMatchObject({ three_bet: [1, 1], pfr: [1, 1] });
  });
});

describe("extractShowdownHands", () => {
  it("records shown hands with their line and pot type", () => {
    const record = srpToShowdown();
    const { end, preflopState } = replayed(record);
    const shown = extractShowdownHands(record, end, preflopState);
    expect(shown.map(hand => [hand.playerId, hand.handClass, hand.lineKey, hand.potType, hand.isPfAggressor, hand.won])).toEqual([
      [PLAYER.a, "QQ", "pf=call|f=c|t=x|r=x", "srp", false, true],
      [PLAYER.e, "AKs", "pf=open|f=b|t=x|r=x", "srp", true, false],
    ]);
  });
});

describe("classifyPlayer", () => {
  const totals = (hands: number, vpip: number, pfr: number, extra: StatTotals = {}): StatTotals => ({ vpip: { n: hands, x: vpip }, pfr: { n: hands, x: pfr }, ...extra });
  it("shrinks small samples toward the prior", () => {
    expect(posteriorMean(5, 5, 0.25, 20)).toBeCloseTo(0.4);
    expect(classifyPlayer(totals(10, 10, 10), 6)).toMatchObject({ tendency: "unknown", confidence: "none" });
  });
  it("labels common profiles", () => {
    expect(classifyPlayer(totals(200, 20, 16), 6)).toMatchObject({ tendency: "nit", confidence: "confident" });
    expect(classifyPlayer(totals(200, 44, 36), 6).tendency).toBe("tag");
    expect(classifyPlayer(totals(200, 70, 56), 6).tendency).toBe("lag");
    expect(classifyPlayer(totals(200, 90, 20, { af_aggr: { n: 10, x: 10 }, af_call: { n: 30, x: 30 } }), 6).tendency).toBe("calling-station");
    expect(classifyPlayer(totals(200, 110, 80), 6).tendency).toBe("maniac");
    expect(classifyPlayer(totals(50, 15, 12), 6).confidence).toBe("tentative");
  });
  it("adds tags only with enough opportunities", () => {
    expect(classifyPlayer(totals(100, 30, 20, { limp_fold_to_raise: { n: 10, x: 7 } }), 6).tags).toEqual(["folds-to-iso"]);
    expect(classifyPlayer(totals(100, 30, 20, { limp_fold_to_raise: { n: 9, x: 9 } }), 6).tags).toEqual([]);
  });
  it("sums events", () => {
    expect(sumEvents([{ stat: "vpip", n: 1, x: 1 }, { stat: "vpip", n: 1, x: 0 }])).toEqual({ vpip: { n: 2, x: 1 } });
  });
});
