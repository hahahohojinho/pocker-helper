/** Hosts a local-only API answers on; anything else (e.g. a rebinding attacker's domain) is refused. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostname(host: string) {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1).toLowerCase() : host.split(":")[0].toLowerCase();
}

/**
 * True for loopback hosts and for names listed in RANGELAB_ALLOWED_HOSTS (comma separated, e.g. a LAN address).
 * Comparing Origin with Host alone does not stop DNS rebinding, where both carry the attacker's domain.
 */
export function isAllowedLocalHost(host: string | null, env: Record<string, string | undefined>) {
  if (!host) return false;
  const name = hostname(host);
  const extra = (env.RANGELAB_ALLOWED_HOSTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  return LOOPBACK_HOSTS.has(name) || extra.includes(name);
}

/**
 * Same-origin check for a local API. Writes must be JSON (a cross-site page can POST text/plain without a CORS
 * preflight) and must not come from another site.
 */
export function isTrustedLocalRequest(headers: Headers, options: { requireJson: boolean }) {
  if (options.requireJson && (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() !== "application/json") return false;
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === headers.get("host");
  } catch {
    return false;
  }
}

/** Reads a request body, stopping as soon as it exceeds maxBytes instead of buffering it whole. */
export async function readLimitedBody(request: Request, maxBytes: number, tooLarge: () => Error) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
