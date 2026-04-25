// T-002: Spotify OAuth route tests
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/db/provider_tokens");
vi.mock("../../../src/db/oauth_state");
vi.mock("../../../src/providers/spotify/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/providers/spotify/oauth")>();
  return { ...actual };
});

import { storeOAuthState, consumeOAuthState, purgeExpiredOAuthState } from "../../../src/db/oauth_state";
import { persistTokens } from "../../../src/db/provider_tokens";
import * as spotifyOAuth from "../../../src/providers/spotify/oauth";

const mockStoreOAuthState = vi.mocked(storeOAuthState);
const mockConsumeOAuthState = vi.mocked(consumeOAuthState);
const mockPurgeExpiredOAuthState = vi.mocked(purgeExpiredOAuthState);
const mockPersistTokens = vi.mocked(persistTokens);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgresql://localhost/test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "test-spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "test-spotify-client-secret",
    SPOTIFY_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/spotify/callback",
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    TIDAL_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/tidal/callback",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
    ...overrides,
  };
}

async function doFetch(
  path: string,
  options: RequestInit = {},
  testEnv: Env = makeEnv(),
) {
  const { default: spotifyAuthRoutes } = await import("../../../src/routes/auth/spotify");
  const { Hono } = await import("hono");
  const app = new Hono<{ Bindings: Env }>();
  app.route("/auth", spotifyAuthRoutes);

  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, options);
  const res = await app.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockStoreOAuthState.mockResolvedValue(undefined);
  mockConsumeOAuthState.mockResolvedValue(null);
  mockPurgeExpiredOAuthState.mockResolvedValue(undefined);
  mockPersistTokens.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// T-002-01: GET /auth/spotify redirects to Spotify with all required params
describe("GET /auth/spotify — initiate (T-002-01)", () => {
  it("returns 302 with Location pointing to Spotify authorize URL", async () => {
    const res = await doFetch("/auth/spotify");
    expect(res.status).toBe(302);
    const location = res.headers.get("Location");
    expect(location).toBeTruthy();
    expect(location).toMatch(/^https:\/\/accounts\.spotify\.com\/authorize\?/);
  });

  it("Location URL contains all required OAuth params", async () => {
    const res = await doFetch("/auth/spotify");
    const location = res.headers.get("Location")!;
    const url = new URL(location);

    expect(url.searchParams.get("client_id")).toBe("test-spotify-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://portage.eovidiu.co.uk/auth/spotify/callback",
    );
    expect(url.searchParams.get("scope")).toBe("user-library-read");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("stores oauth_state on initiate (T-002-04)", async () => {
    await doFetch("/auth/spotify");
    expect(mockStoreOAuthState).toHaveBeenCalledOnce();
    const [, record] = mockStoreOAuthState.mock.calls[0];
    expect(record.state).toBeTruthy();
    expect(record.codeVerifier).toBeTruthy();
    expect(record.expiresAt).toBeInstanceOf(Date);
  });

  it("state in redirect URL matches stored state", async () => {
    const res = await doFetch("/auth/spotify");
    const location = res.headers.get("Location")!;
    const urlState = new URL(location).searchParams.get("state");
    const storedState = mockStoreOAuthState.mock.calls[0][1].state;
    expect(urlState).toBe(storedState);
  });
});

// T-002-05: Callback with unknown state → 400 invalid_state
describe("GET /auth/spotify/callback — unknown state (T-002-05)", () => {
  it("returns 400 with error=invalid_state", async () => {
    mockConsumeOAuthState.mockResolvedValue(null);
    const res = await doFetch("/auth/spotify/callback?state=unknown&code=anything");
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_state" });
  });
});

// T-002-06: Callback with expired state → 400 invalid_state
describe("GET /auth/spotify/callback — expired state (T-002-06)", () => {
  it("returns 400 with error=invalid_state when state row not found (purged as expired)", async () => {
    mockConsumeOAuthState.mockResolvedValue(null);
    const res = await doFetch("/auth/spotify/callback?state=expired-state&code=c");
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_state" });
  });

  it("purges expired oauth_state rows on every callback invocation (R4)", async () => {
    mockConsumeOAuthState.mockResolvedValue(null);
    await doFetch("/auth/spotify/callback?state=s&code=c");
    expect(mockPurgeExpiredOAuthState).toHaveBeenCalled();
  });
});

// T-002-07: Callback with user_denied → 400 user_denied
describe("GET /auth/spotify/callback — user denied (T-002-07)", () => {
  it("returns 400 with error=user_denied for access_denied", async () => {
    const res = await doFetch(
      "/auth/spotify/callback?state=somestate&error=access_denied",
    );
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "user_denied" });
  });
});

// T-002-09: Successful callback → 200 connected
describe("GET /auth/spotify/callback — success (T-002-09)", () => {
  it("returns 200 with {status:connected, provider:spotify}", async () => {
    mockConsumeOAuthState.mockResolvedValue({ codeVerifier: "verifier-value" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "at",
            refresh_token: "rt",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const res = await doFetch("/auth/spotify/callback?state=validstate&code=fakecode");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ status: "connected", provider: "spotify" });
  });
});

// Token exchange failure → 400 token_exchange_failed
describe("GET /auth/spotify/callback — token exchange failure", () => {
  it("returns 400 with error=token_exchange_failed when Spotify returns error", async () => {
    mockConsumeOAuthState.mockResolvedValue({ codeVerifier: "verifier" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })),
    );

    const res = await doFetch("/auth/spotify/callback?state=s&code=c");
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "token_exchange_failed" });
  });

  it("returns 400 token_exchange_failed for unexpected (non-SpotifyAuthError) throws (coverage L24)", async () => {
    vi.spyOn(spotifyOAuth, "handleCallback").mockRejectedValue(new Error("unexpected"));

    const res = await doFetch("/auth/spotify/callback?state=s&code=c");
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "token_exchange_failed" });
  });
});
