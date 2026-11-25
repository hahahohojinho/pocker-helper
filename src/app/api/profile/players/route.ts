import { getProfileDb } from "@/lib/server/profile-db";
import { handleProfileRequest, profileJson, readProfileBody } from "@/lib/server/profile-http";
import { createPlayer, listPlayers } from "@/lib/server/profile-repository-core";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleProfileRequest(request, db => profileJson({ players: listPlayers(db) }), getProfileDb);
}

export async function POST(request: Request) {
  return handleProfileRequest(request, async db => {
    const body = await readProfileBody(request);
    return profileJson({ player: createPlayer(db, { name: body.name, note: body.note }) }, 201);
  }, getProfileDb);
}
