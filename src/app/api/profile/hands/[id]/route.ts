import { getProfileDb } from "@/lib/server/profile-db";
import { handleProfileRequest, profileJson } from "@/lib/server/profile-http";
import { deleteHand } from "@/lib/server/profile-repository-core";

export const runtime = "nodejs";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleProfileRequest(request, db => deleteHand(db, id) ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : profileJson({ error: "핸드를 찾을 수 없습니다." }, 404), getProfileDb);
}
