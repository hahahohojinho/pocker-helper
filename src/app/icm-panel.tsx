"use client";

import { useState } from "react";
import { icmEquity, MAX_ICM_PLAYERS, parsePayouts } from "@/lib/icm/icm";
import type { Position } from "@/lib/preflop";

/**
 * Tournament prize equity (ICM, Malmuth-Harville) of the stacks at this table. Only the seats here are counted, so
 * for a final table or a sit-and-go; for a larger field the result ignores the other tables.
 */
export default function IcmPanel({ positions, stacks, heroSeat }: { positions: readonly Position[]; stacks: readonly number[]; heroSeat: number }) {
  const [payoutText, setPayoutText] = useState("50,30,20");
  const payouts = parsePayouts(payoutText);
  const seats = positions.map((position, seat) => ({ position, seat, stack: stacks[seat] ?? 0 }));
  let equity: number[] | null = null;
  let error = "";
  if (!payouts) error = "상금 구조를 쉼표로 입력하세요 (예: 50,30,20).";
  else if (seats.length > MAX_ICM_PLAYERS) error = `ICM은 ${MAX_ICM_PLAYERS}명까지 계산합니다.`;
  else {
    try { equity = icmEquity(seats.map(item => item.stack), payouts); } catch (caught) { error = caught instanceof Error ? caught.message : "ICM 계산 실패"; }
  }
  // Only the prizes these seats can reach (the first n places) count, so the column sums to 100%.
  const pool = equity ? equity.reduce((sum, value) => sum + value, 0) : 0;
  const chips = seats.reduce((sum, item) => sum + item.stack, 0);
  return <details className="icm-panel">
    <summary>토너먼트 ICM ($EV)</summary>
    <label>상금 구조<input value={payoutText} maxLength={80} onChange={event => setPayoutText(event.target.value)} /></label>
    {error ? <small className="profile-message">{error}</small> : equity && <table>
      <thead><tr><th>좌석</th><th>스택</th><th>칩 비율</th><th>ICM</th></tr></thead>
      <tbody>{seats.map((item, index) => <tr key={item.seat} className={item.seat === heroSeat ? "icm-hero" : undefined}>
        <td>{item.position}{item.seat === heroSeat ? " · Hero" : ""}</td><td>{item.stack}BB</td>
        <td>{chips > 0 ? (item.stack / chips * 100).toFixed(1) : "0.0"}%</td><td>{pool > 0 ? (equity![index] / pool * 100).toFixed(1) : "0.0"}%</td>
      </tr>)}</tbody>
    </table>}
    <small>이 테이블의 좌석만 계산합니다 (파이널 테이블, SNG 기준). 칩 비율보다 ICM이 낮으면 칩을 잃는 위험이 더 큽니다.</small>
  </details>;
}
