// F-002: Spotify OAuth — PKCE, token exchange, refresh with coalescing (R7)
import type { Env } from "../../env";
import { persistTokens, loadTokens, markRevoked } from "../../db/provider_tokens";
import { storeOAuthState, consumeOAuthState, purgeExpiredOAuthState } from "../../db/oauth_state";
import { SPOTIFY_SCOPES } from "./scopes";

export class SpotifyAuthError extends Error {
  constructor(
    public readonly code: "invalid_state" | "user_denied" | "token_exchange_failed" | "refresh_failed" | "reauth_required",
    message: string,
  ) {
    super(message);
    this.name = "SpotifyAuthError";
  }
}

// R7: module-level coalescing — one refresh in flight per provider
const refreshInFlight = new Map<string, Promise<void>>();

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const USER_AGENT = "spotify-roon-sync/1.0"; // R10
const REFRESH_THRESHOLD_S = 60; // R6: refresh if < 60s remaining

function base64url(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

// R3: 256-bit state from CSPRNG
export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

// PKCE: code_verifier = 32–43 base64url chars; challenge = base64url(SHA-256(verifier))
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await sha256(verifier);
  return base64url(digest);
}

export interface InitiateResult {
  authorizeUrl: string;
  state: string;
  codeVerifier: string;
}

export async function initiateSpotifyOAuth(env: Env): Promise<InitiateResult> {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await storeOAuthState(env, { state, codeVerifier, expiresAt });

  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    redirect_uri: env.SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    authorizeUrl: `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`,
    state,
    codeVerifier,
  };
}

export async function handleCallback(
  env: Env,
  params: { code?: string; state?: string; error?: string },
): Promise<void> {
  // R4: purge expired rows on every callback invocation
  await purgeExpiredOAuthState(env);

  if (params.error === "access_denied") {
    // delete the state row if it exists, ignore failure
    if (params.state) {
      await consumeOAuthState(env, params.state).catch(() => null);
    }
    throw new SpotifyAuthError("user_denied", "User denied Spotify authorization");
  }

  if (!params.state) {
    throw new SpotifyAuthError("invalid_state", "Missing state parameter");
  }

  const stored = await consumeOAuthState(env, params.state);
  if (!stored) {
    throw new SpotifyAuthError("invalid_state", "Unknown or expired state");
  }

  if (!params.code) {
    throw new SpotifyAuthError("token_exchange_failed", "Missing code parameter");
  }

  const tokenResponse = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: env.SPOTIFY_REDIRECT_URI,
      client_id: env.SPOTIFY_CLIENT_ID,
      client_secret: env.SPOTIFY_CLIENT_SECRET,
      code_verifier: stored.codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    throw new SpotifyAuthError("token_exchange_failed", `Spotify token exchange failed: ${tokenResponse.status}`);
  }

  const data = await tokenResponse.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await persistTokens(
    env,
    "spotify",
    data.access_token,
    data.refresh_token,
    expiresAt,
    data.scope ?? null,
  );
}

async function _doRefresh(env: Env): Promise<void> {
  const tokens = await loadTokens(env, "spotify");
  if (!tokens) {
    throw new SpotifyAuthError("reauth_required", "No Spotify tokens found");
  }

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: env.SPOTIFY_CLIENT_ID,
      client_secret: env.SPOTIFY_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 400 && errorData.error === "invalid_grant") {
      await markRevoked(env, "spotify");
      throw new SpotifyAuthError("reauth_required", "Spotify refresh token revoked (invalid_grant)");
    }
    throw new SpotifyAuthError("refresh_failed", `Spotify refresh failed: ${response.status}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  const newRefreshToken = data.refresh_token ?? tokens.refreshToken; // R8
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  // F-030 D8: Spotify omits `scope` on refresh when unchanged (RFC 6749 5.1);
  // fall back to the previously stored grant instead of overwriting with null.
  const scopes = data.scope ?? tokens.scopes ?? null;
  await persistTokens(env, "spotify", data.access_token, newRefreshToken, expiresAt, scopes);
}

// R7: coalesced refresh — checks Map first, reuses in-flight promise if present
export function refreshSpotify(env: Env): Promise<void> {
  const existing = refreshInFlight.get("spotify");
  if (existing) {
    return existing;
  }
  const promise = _doRefresh(env).finally(() => {
    refreshInFlight.delete("spotify");
  });
  refreshInFlight.set("spotify", promise);
  return promise;
}

// R6 + R7: proactive refresh with coalescing
export async function ensureFreshToken(env: Env): Promise<string> {
  const tokens = await loadTokens(env, "spotify");
  if (!tokens) {
    throw new SpotifyAuthError("reauth_required", "No Spotify tokens found");
  }

  const secondsRemaining = (tokens.expiresAt.getTime() - Date.now()) / 1000;

  if (secondsRemaining > REFRESH_THRESHOLD_S) {
    return tokens.accessToken;
  }

  await refreshSpotify(env);

  const refreshed = await loadTokens(env, "spotify");
  return refreshed!.accessToken;
}

// R10 + R11: make an authorized Spotify API request with 401-retry-once
export async function spotifyFetch(
  env: Env,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await ensureFreshToken(env);

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("User-Agent", USER_AGENT);

  const response = await fetch(url, { ...init, headers });

  if (response.status === 401) {
    // R11: refresh once (coalesced) and retry once
    await refreshSpotify(env);

    const retryToken = await loadTokens(env, "spotify");
    const retryHeaders = new Headers(init.headers);
    retryHeaders.set("Authorization", `Bearer ${retryToken!.accessToken}`);
    retryHeaders.set("User-Agent", USER_AGENT);
    return fetch(url, { ...init, headers: retryHeaders });
  }

  return response;
}
