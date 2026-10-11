import { NextResponse } from "next/server";
import type { DatabaseSync } from "node:sqlite";
import { isAllowedLocalHost, isTrustedLocalRequest, readLimitedBody } from "../local-api-guard";
import { ProfileUnavailableError } from "./profile-db-core";
import { ProfileConflictError, ProfileInputError } from "./profile-repository-core";

/** A hand record with 200 actions is about 30KB. */
export const MAX_PROFILE_BODY_BYTES = 64 * 1024;
class BodyTooLargeError extends Error {}

const noStore = { "cache-control": "no-store" };
export const profileJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

export function profileApiEnabled(env: Record<string, string | undefined>) {
  return env.NODE_ENV !== "production" || Boolean(env.ALLOW_LOCAL_PROFILE_API);
}

export async function readProfileBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readLimitedBody(request, MAX_PROFILE_BODY_BYTES, () => new BodyTooLargeError(`요청 본문은 ${MAX_PROFILE_BODY_BYTES}바이트 이하여야 합니다.`));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProfileInputError("요청 본문이 올바른 JSON이 아닙니다.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProfileInputError("요청 본문은 JSON 객체여야 합니다.");
  return value as Record<string, unknown>;
}

/**
 * Runs a profile API handler behind the local-only guards and maps failures to status codes. Details of
 * unexpected errors are logged on the server and never sent to the client.
 */
export async function handleProfileRequest(request: Request, handler: (db: DatabaseSync) => Promise<Response> | Response, openDb: () => DatabaseSync) {
  if (!profileApiEnabled(process.env)) return profileJson({ error: "프로덕션에서는 ALLOW_LOCAL_PROFILE_API를 설정해야 합니다." }, 403);
  if (!isAllowedLocalHost(request.headers.get("host"), process.env)) return profileJson({ error: "로컬 주소에서만 사용할 수 있습니다." }, 403);
  const writes = request.method !== "GET" && request.method !== "HEAD";
  if (!isTrustedLocalRequest(request.headers, { requireJson: writes && request.method !== "DELETE" })) return profileJson({ error: "같은 출처의 JSON 요청만 허용합니다." }, 403);
  try {
    return await handler(openDb());
  } catch (error) {
    if (error instanceof ProfileInputError) return profileJson({ error: error.message }, 400);
    if (error instanceof ProfileConflictError) return profileJson({ error: error.message }, 409);
    if (error instanceof BodyTooLargeError) return profileJson({ error: error.message }, 413);
    console.error("Profile API failed:", error);
    if (error instanceof ProfileUnavailableError) return profileJson({ error: "상대 기록 DB를 사용할 수 없습니다. 서버 로그를 확인하세요." }, 503);
    return profileJson({ error: "상대 기록 처리 중 오류가 발생했습니다." }, 500);
  }
}
