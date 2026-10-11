import { getProfileDb } from "@/lib/server/profile-db";
import { handleProfileRequest, profileJson } from "@/lib/server/profile-http";
import { getPlayerStats, ProfileInputError } from "@/lib/server/profile-repository-core";

export const runtime = "nodejs";

/** GET /api/profile/stats?ids=a,b&tableSize=6 */
export async function GET(request: Request) {
  return handleProfileRequest(request, db => {
    const query = new URL(request.url).searchParams;
    const tableSize = Number(query.get("tableSize"));
    if (tableSize !== 6 && tableSize !== 8) throw new ProfileInputError("tableSize는 6 또는 8이어야 합니다.");
    const ids = (query.get("ids") ?? "").split(",").filter(Boolean);
    return profileJson({ stats: getPlayerStats(db, ids, tableSize) });
  }, getProfileDb);
}
