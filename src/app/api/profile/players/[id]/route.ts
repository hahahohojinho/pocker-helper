import { getProfileDb } from "@/lib/server/profile-db";
import { handleProfileRequest, profileJson, readProfileBody } from "@/lib/server/profile-http";
import { updatePlayer } from "@/lib/server/profile-repository-core";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleProfileRequest(request, async db => {
    const body = await readProfileBody(request);
    const player = updatePlayer(db, id, { name: body.name, note: body.note, archived: body.archived });
    return player ? profileJson({ player }) : profileJson({ error: "플레이어를 찾을 수 없습니다." }, 404);
  }, getProfileDb);
}
