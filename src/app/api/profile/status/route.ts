import { getProfileDb } from "@/lib/server/profile-db";
import { SCHEMA_VERSION } from "@/lib/server/profile-db-core";
import { handleProfileRequest, profileApiEnabled, profileJson } from "@/lib/server/profile-http";
import { STATS_VERSION } from "@/lib/profiling/stats";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!profileApiEnabled(process.env)) return profileJson({ enabled: false });
  return handleProfileRequest(request, () => profileJson({ enabled: true, schemaVersion: SCHEMA_VERSION, statsVersion: STATS_VERSION }), getProfileDb);
}
