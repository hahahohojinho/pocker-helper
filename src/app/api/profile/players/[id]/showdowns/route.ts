import { getProfileDb } from "@/lib/server/profile-db";
import { handleProfileRequest, profileJson } from "@/lib/server/profile-http";
import { listShowdowns, ProfileInputError } from "@/lib/server/profile-repository-core";

export const runtime = "nodejs";
const POT_TYPES = new Set(["limped", "srp", "3bp", "4bp"]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleProfileRequest(request, db => {
    const query = new URL(request.url).searchParams;
    const potType = query.get("potType") ?? undefined;
    if (potType !== undefined && !POT_TYPES.has(potType)) throw new ProfileInputError("potType은 limped, srp, 3bp, 4bp 중 하나여야 합니다.");
    const limit = query.has("limit") ? Number(query.get("limit")) : undefined;
    if (limit !== undefined && !Number.isInteger(limit)) throw new ProfileInputError("limit은 정수여야 합니다.");
    return profileJson({ items: listShowdowns(db, id, { potType, limit }) });
  }, getProfileDb);
}
