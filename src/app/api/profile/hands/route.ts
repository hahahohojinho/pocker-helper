import { getProfileDb } from "@/lib/server/profile-db";
import { handleProfileRequest, profileJson, readProfileBody } from "@/lib/server/profile-http";
import { saveHand } from "@/lib/server/profile-repository-core";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleProfileRequest(request, async db => {
    const body = await readProfileBody(request);
    const result = saveHand(db, body.record);
    return profileJson(result, result.status === "created" ? 201 : 200);
  }, getProfileDb);
}
