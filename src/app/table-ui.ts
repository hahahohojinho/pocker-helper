import type { PackApproximation } from "@/lib/strategy-data";

/** Seat centres on the oval table, in percent of the scene, by slot (slot 0 = BTN at the bottom). */
export const seatCoordinates: Record<6 | 8, { left: number; top: number }[]> = {
  6:[{left:50,top:92},{left:12,top:72},{left:12,top:24},{left:50,top:4},{left:88,top:24},{left:88,top:72}],
  8:[{left:50,top:94},{left:18,top:87},{left:5,top:52},{left:18,top:15},{left:50,top:4},{left:82,top:15},{left:95,top:52},{left:82,top:87}],
};

/** " · APPROX STACK: ..." note for a preflop answer taken from another stack or size. */
export function approximationNote(approx:PackApproximation){
  const parts=[approx.stack&&`APPROX STACK: ${approx.packStack}BB 팩으로 ${approx.requestedStack}BB 대체`,approx.size&&`APPROX SIZE: ${approx.packSize}BB 사이즈로 ${approx.requestedSize}BB 대체`].filter(Boolean);
  return ` · ${parts.join(" · ")}`;
}
