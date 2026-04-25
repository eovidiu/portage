import type { Env } from "../../env";
import { persistTokens, loadTokens, markRevoked } from "../../db/provider_tokens";
import { storeOAuthState, consumeOAuthState } from "../../db/oauth_state";
import { TIDAL_SCOPES } from "./scopes";

const TIDAL_AUTHORIZE_URL = "https://login.tidal.com/authorize";
const TIDAL_TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";

export class TidalReauthRequired extends Error {
  readonly code = "tidal_reauth_required";
  constructor() {
    super("tidal_reauth_required");
    this.name = "TidalReauthRequired";
  }
}

async function generateState(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...verifierBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  const challenge = btoa(String.fromCharCode(...hashArray))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return { verifier, challenge };
}

export async function initiateOAuth(env: Env): Promise<string> {
  const state = await generateState();
  const { verifier, challenge } = await generatePkce();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await storeOAuthState(env, { state, codeVerifier: verifier, expiresAt });

  const params = new URLSearchParams({
    client_id: env.TIDAL_CLIENT_ID,
    redirect_uri: env.TIDAL_REDIRECT_URI,
    scope: TIDAL_SCOPES,
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return `${TIDAL_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCode(
  env: Env,
  code: string,
  state: string
): Promise<void> {
  const record = await consumeOAuthState(env, state);
  if (!record) {
    throw new Error("invalid_state");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: record.codeVerifier,
    client_id: env.TIDAL_CLIENT_ID,
    redirect_uri: env.TIDAL_REDIRECT_URI,
  });

  const credentials = btoa(`${env.TIDAL_CLIENT_ID}:${env.TIDAL_CLIENT_SECRET}`);
  const response = await fetch(
    new Request(TIDAL_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: body.toString(),
    })
  );

  if (!response.ok) {
    throw new Error("token_exchange_failed");
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await persistTokens(env, "tidal", data.access_token, data.refresh_token, expiresAt);
}

// Module-level coalescing map — one in-flight refresh per provider instance
const refreshInFlight = new Map<string, Promise<void>>();

export async function refreshTokens(env: Env): Promise<void> {
  const key = "tidal";
  const existing = refreshInFlight.get(key);
  if (existing) {
    return existing;
  }

  const promise = _doRefresh(env).finally(() => {
    refreshInFlight.delete(key);
  });
  refreshInFlight.set(key, promise);
  return promise;
}

async function _doRefresh(env: Env): Promise<void> {
  const tokens = await loadTokens(env, "tidal");
  if (!tokens) {
    throw new TidalReauthRequired();
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: env.TIDAL_CLIENT_ID,
  });

  const credentials = btoa(`${env.TIDAL_CLIENT_ID}:${env.TIDAL_CLIENT_SECRET}`);
  const response = await fetch(
    new Request(TIDAL_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: body.toString(),
    })
  );

  if (!response.ok) {
    await markRevoked(env, "tidal");
    throw new TidalReauthRequired();
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const newRefreshToken = data.refresh_token ?? tokens.refreshToken;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await persistTokens(env, "tidal", data.access_token, newRefreshToken, expiresAt);
}

export function needsRefresh(expiresAt: Date): boolean {
  return expiresAt.getTime() - Date.now() < 60 * 1000;
}
