import type { Env } from "../../env";
import { loadTokens } from "../../db/provider_tokens";
import { refreshTokens, needsRefresh, TidalReauthRequired } from "./oauth";

// Verified: 2026-05-02 against tidal-api-oas.json — every /v2 operation
// returns application/vnd.api+json (JSON:API standard). The legacy
// vnd.tidal.v1+json was sent by every client request previously and Tidal
// responded 406 to /v2 endpoints, surfacing as 100% match-stage errors on
// first prod sync.
const TIDAL_JSONAPI_ACCEPT = "application/vnd.api+json";

// F-015: per-invocation token cache. Each loadTokens call is a Neon HTTP
// subrequest; with 5+5 match-stage calls plus playlist writes, the unbounded
// version was burning ~12 subrequests on token reloads alone. The cache lives
// at module scope (warm-isolate persistence) and is invalidated when needsRefresh
// fires; refreshTokens then reloads + re-caches.
let cachedTokens: { accessToken: string; refreshToken: string; expiresAt: Date } | null = null;

async function getCachedTokens(env: Env) {
  if (cachedTokens && !needsRefresh(cachedTokens.expiresAt)) {
    return cachedTokens;
  }
  const tokens = await loadTokens(env, "tidal");
  if (!tokens) {
    cachedTokens = null;
    throw new TidalReauthRequired();
  }
  if (needsRefresh(tokens.expiresAt)) {
    await refreshTokens(env);
    const fresh = await loadTokens(env, "tidal");
    if (!fresh) {
      cachedTokens = null;
      throw new TidalReauthRequired();
    }
    cachedTokens = fresh;
    return fresh;
  }
  cachedTokens = tokens;
  return tokens;
}

/** Internal: invalidate the cache so the next call refetches. Test helper. */
export function _resetTidalTokenCache(): void {
  cachedTokens = null;
}

export async function tidalFetch(
  env: Env,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const tokens = await getCachedTokens(env);

  const countryCode = env.TIDAL_COUNTRY_CODE || "RO";
  const url = new URL(path);
  url.searchParams.set("countryCode", countryCode);

  const response = await _tidalRequest(url.toString(), tokens.accessToken, options);

  if (response.status === 401) {
    cachedTokens = null;
    await refreshTokens(env);
    const fresh = await loadTokens(env, "tidal");
    if (!fresh) {
      throw new TidalReauthRequired();
    }
    cachedTokens = fresh;
    return _tidalRequest(url.toString(), fresh.accessToken, options);
  }

  return response;
}

async function _tidalRequest(
  url: string,
  accessToken: string,
  options: RequestInit
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("accept", TIDAL_JSONAPI_ACCEPT);
  if (options.method && options.method !== "GET" && options.method !== "HEAD") {
    headers.set("Content-Type", TIDAL_JSONAPI_ACCEPT);
  }

  const request = new Request(url, { ...options, headers });
  return fetch(request);
}
