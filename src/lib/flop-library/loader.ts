import { isFlopCode, isScenarioId, MAX_INDEX_CHARS, MAX_SOLUTION_CHARS, parseFlopIndex, parseFlopSolution, type FlopIndex, type FlopSolution } from "./format";

const BASE = "/data/flop-library";
/** A missing or broken file is not requested again for this long. */
const FAILED_LOAD_RETRY_MS = 60_000;
const MAX_CACHED_SOLUTIONS = 32;

type Fetch = typeof fetch;

/** Library files are generated locally and optional; every failure means "not available", never an error. */
async function fetchText(path: string, limit: number, fetchImpl: Fetch): Promise<string | null> {
  const response = await fetchImpl(path);
  if (!response.ok) return null;
  // A dev server or SPA fallback can answer a missing file with an HTML page.
  if ((response.headers.get("content-type") ?? "").includes("text/html")) return null;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  const text = await response.text();
  return text.length > limit ? null : text;
}

interface Loader<T> { load: (key: string, fetchImpl: Fetch) => Promise<T | null>; reset: () => void; }

/** Caches successful loads (oldest dropped past `capacity`) and suppresses retries of failed ones. */
function cachedLoader<T>(capacity: number, fetchOne: (key: string, fetchImpl: Fetch) => Promise<T | null>): Loader<T> {
  let loaded = new Map<string, Promise<T | null>>();
  let failures = new Map<string, number>();
  const forget = (key: string) => { loaded = new Map([...loaded].filter(([existing]) => existing !== key)); failures = new Map([...failures, [key, Date.now()]]); };
  return {
    load(key, fetchImpl) {
      const cached = loaded.get(key);
      if (cached) return cached;
      const failedAt = failures.get(key);
      if (failedAt !== undefined && Date.now() - failedAt < FAILED_LOAD_RETRY_MS) return Promise.resolve(null);
      const attempt = fetchOne(key, fetchImpl).catch(error => { console.warn(`Flop library file ${key} is unusable`, error); return null; }).then(value => { if (value === null) forget(key); return value; });
      const kept = [...loaded].slice(-(capacity - 1));
      loaded = new Map([...kept, [key, attempt]]);
      return attempt;
    },
    reset() { loaded = new Map(); failures = new Map(); },
  };
}

const indexLoader = cachedLoader<FlopIndex>(1, async (_key, fetchImpl) => {
  const text = await fetchText(`${BASE}/index.json`, MAX_INDEX_CHARS, fetchImpl);
  return text === null ? null : parseFlopIndex(text);
});

const solutionLoader = cachedLoader<FlopSolution>(MAX_CACHED_SOLUTIONS, async (key, fetchImpl) => {
  const [scenarioId, board] = key.split("/");
  const text = await fetchText(`${BASE}/${scenarioId}/${board}.json`, MAX_SOLUTION_CHARS, fetchImpl);
  return text === null ? null : parseFlopSolution(text, scenarioId, board);
});

/** The library index, or null when no library was generated on this machine. */
export function loadFlopIndex(fetchImpl: Fetch = fetch): Promise<FlopIndex | null> {
  return indexLoader.load("index", fetchImpl);
}

export function loadFlopSolution(scenarioId: string, board: string, fetchImpl: Fetch = fetch): Promise<FlopSolution | null> {
  // Both parts become a URL path, so anything but the expected shapes is refused before fetching.
  if (!isScenarioId(scenarioId) || !isFlopCode(board)) return Promise.resolve(null);
  return solutionLoader.load(`${scenarioId}/${board}`, fetchImpl);
}

/** Tests only: forgets cached and failed loads. */
export function resetFlopLibraryCache() {
  indexLoader.reset();
  solutionLoader.reset();
}
