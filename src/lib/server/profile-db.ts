import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { openProfileDb, resolveProfileDbPath } from "./profile-db-core";
import { ensureDerivedCurrent } from "./profile-repository-core";

// Kept on globalThis so dev-mode module re-evaluation reuses the open connection instead of leaking new ones.
const state = globalThis as typeof globalThis & { __rangelabProfileDb?: DatabaseSync };

/** Opens the profile database on first use (never at import, so `next build` does not touch it). */
export function getProfileDb(): DatabaseSync {
  if (!state.__rangelabProfileDb) {
    const db = openProfileDb(resolveProfileDbPath(process.env));
    try {
      ensureDerivedCurrent(db);
    } catch (error) {
      db.close();
      throw error;
    }
    state.__rangelabProfileDb = db;
  }
  return state.__rangelabProfileDb;
}
