import type { Env } from "../../env";
import { loadTokens } from "../../db/provider_tokens";
import { refreshTokens, needsRefresh, TidalReauthRequired } from "./oauth";

// Verified: 2026-05-02 against tidal-api-oas.json — every /v2 operation
// returns application/vnd.api+json (JSON:API standard). The legacy
// vnd.tidal.v1+json was sent by every client request previously and Tidal
// responded 406 to /v2 endpoints, surfacing as 100% match-stage errors on
// first prod sync.
const TIDAL_JSONAPI_ACCEPT = "application/vnd.api+json";

export async function tidalFetch(
  env: Env,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  let tokens = await loadTokens(env, "tidal");
  if (!tokens) {
    throw new TidalReauthRequired();
  }

  if (needsRefresh(tokens.expiresAt)) {
    await refreshTokens(env);
    tokens = await loadTokens(env, "tidal");
    if (!tokens) {
      throw new TidalReauthRequired();
    }
  }

  const countryCode = env.TIDAL_COUNTRY_CODE || "RO";
  const url = new URL(path);
  url.searchParams.set("countryCode", countryCode);

  const response = await _tidalRequest(url.toString(), tokens.accessToken, options);

  if (response.status === 401) {
    await refreshTokens(env);
    tokens = await loadTokens(env, "tidal");
    if (!tokens) {
      throw new TidalReauthRequired();
    }
    return _tidalRequest(url.toString(), tokens.accessToken, options);
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
