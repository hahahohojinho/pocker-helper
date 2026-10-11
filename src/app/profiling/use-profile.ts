"use client";

import { useCallback, useEffect, useState } from "react";
import type { HandRecordV1, ProfileTableSize } from "@/lib/profiling/hand-record";
import type { Classification, StatTotals } from "@/lib/profiling/classify";

export interface ProfilePlayer { id: string; name: string; note: string; archived: boolean; hands: number; }
export interface ProfileStats { hands: number; totals: StatTotals; classification: Classification; }

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `요청이 실패했습니다 (HTTP ${response.status}).`);
  return body as T;
}

export const saveHandRecord = (record: HandRecordV1) =>
  requestJson<{ status: "created" | "duplicate" }>("/api/profile/hands", { method: "POST", body: JSON.stringify({ record }) });

/**
 * Opponent profiles from the local database: whether it is available, the player list, and stats for the seated
 * players. `revision` refetches stats after a hand is saved.
 */
export function useProfile(tableSize: ProfileTableSize | null, seatedIds: readonly (string | null)[], revision: number) {
  const [enabled, setEnabled] = useState(false);
  const [players, setPlayers] = useState<ProfilePlayer[]>([]);
  const [stats, setStats] = useState<Record<string, ProfileStats>>({});
  const [error, setError] = useState("");
  const idsKey = [...new Set(seatedIds.filter((id): id is string => id !== null))].sort().join(",");

  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ enabled: boolean }>("/api/profile/status", { signal: controller.signal })
      .then(status => {
        setEnabled(status.enabled);
        return status.enabled ? requestJson<{ players: ProfilePlayer[] }>("/api/profile/players", { signal: controller.signal }) : null;
      })
      .then(list => { if (list) setPlayers(list.players); })
      .catch(reason => { if (!controller.signal.aborted) { setEnabled(false); setError(reason instanceof Error ? reason.message : String(reason)); } });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    if (!enabled || !tableSize || !idsKey) return;
    const controller = new AbortController();
    requestJson<{ stats: Record<string, ProfileStats> }>(`/api/profile/stats?tableSize=${tableSize}&ids=${encodeURIComponent(idsKey)}`, { signal: controller.signal })
      .then(body => setStats(body.stats))
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [enabled, tableSize, idsKey, revision]);

  const createPlayer = useCallback(async (name: string) => {
    const { player } = await requestJson<{ player: ProfilePlayer }>("/api/profile/players", { method: "POST", body: JSON.stringify({ name }) });
    setPlayers(current => [...current, player].sort((left, right) => left.name.localeCompare(right.name)));
    return player;
  }, []);

  return { enabled, players, stats, error, createPlayer };
}
