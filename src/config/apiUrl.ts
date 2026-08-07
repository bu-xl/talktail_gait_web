/** Shared API URL helpers — keep base `/api` (e.g. https://gait.o-r.kr/api), avoid `/api/api/`. */

/** Trim trailing slashes only. Keeps a trailing `/api` required by reverse-proxy domains. */
export function normalizeApiBase(apiBaseUrl: string): string {
  return String(apiBaseUrl || "")
    .trim()
    .replace(/\/+$/, "");
}

function baseEndsWithApi(base: string): boolean {
  return /\/api$/i.test(base);
}

/** If base is `…/api` and path is `/api/…`, drop the path's `/api` prefix once. */
function pathForBase(base: string, path: string): string {
  let p = path.startsWith("/") ? path : `/${path}`;
  if (baseEndsWithApi(base) && /^\/api(\/|$)/i.test(p)) {
    p = p.replace(/^\/api/i, "") || "/";
    if (!p.startsWith("/")) p = `/${p}`;
  }
  return p;
}

/**
 * Join API base with a path.
 * - base `https://gait.o-r.kr/api` + `/api/results/dates`
 *   → `https://gait.o-r.kr/api/results/dates`
 * - base `http://host:3000` + `/api/results/dates`
 *   → `http://host:3000/api/results/dates`
 */
export function joinApiUrl(apiBaseUrl: string, path: string): string {
  const base = normalizeApiBase(apiBaseUrl);
  if (!path) return base || "/";
  if (/^https?:\/\//i.test(path)) return path;
  const p = pathForBase(base, path);
  const joined = base ? `${base}${p}` : p;
  return joined.replace(/\/api\/api\//gi, "/api/");
}
