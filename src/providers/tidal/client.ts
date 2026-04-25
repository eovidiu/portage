import type { Env } from "../../env";
import { loadTokens } from "../../db/provider_tokens";
import { refreshTokens, needsRefresh, TidalReauthRequired } from "./oauth";

const TIDAL_V1_ACCEPT = "application/vnd.tidal.v1+json";
const TIDAL_V2_ACCEPT = "application/vnd.tidal.v2+json";

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
  headers.set("accept", TIDAL_V1_ACCEPT);
  if (options.method && options.method !== "GET" && options.method !== "HEAD") {
    headers.set("Content-Type", TIDAL_V1_ACCEPT);
  }

  const request = new Request(url, { ...options, headers });
  const response = await fetch(request);

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes(TIDAL_V2_ACCEPT.split(";")[0])) {
    console.warn(`Tidal returned vnd.tidal.v2+json from ${url}; parsing as v1 best-effort`);
  }

  return response;
}
