import type { Metadata } from "next";
import SelfPlayTable from "./self-play-table";

export const metadata: Metadata = { title: "RangeLab · 셀프 플레이" };

export default function SelfPlayPage() {
  return <SelfPlayTable />;
}
