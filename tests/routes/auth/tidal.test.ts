import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db/provider_tokens", () => ({
  persistTokens: vi.fn(),
  loadTokens: vi.fn(),
  markRevoked: vi.fn(),
}));

vi.mock("../../../src/db/oauth_state", () => ({
  storeOAuthState: vi.fn(),
  consumeOAuthState: vi.fn(),
  purgeExpiredOAuthState: vi.fn(),
}));

import { persistTokens } from "../../../src/db/provider_tokens";
import { storeOAuthState, consumeOAuthState } from "../../../src/db/oauth_state";

const mockPersistTokens = persistTokens as ReturnType<typeof vi.fn>;
const mockStoreOAuthState = storeOAuthState as ReturnType<typeof vi.fn>;
const mockConsumeOAuthState = consumeOAuthState as ReturnType<typeof vi.fn>;

const VALID_B64_KEY = "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=";

function makeEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: VALID_B64_KEY,
    SPOTIFY_CLIENT_ID: "spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    DATABASE_URL: env.DATABASE_URL ?? "postgresql://localhost/test",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
    SPOTIFY_REDIRECT_URI: "https://example.com/auth/spotify/callback",
    TIDAL_REDIRECT_URI: "https://example.com/auth/tidal/callback",
    ...overrides,
  };
}

async function mintJwt(): Promise<string> {
  const { SignJWT } = await import("jose");
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("spotify-roon-sync")
    .setSubject("owner")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("test-jwt-secret-32-bytes-long-ok!"));
}

async function doFetch(
  path: string,
  opts: { headers?: Record<string, string> } = {},
  testEnv = makeEnv()
): Promise<Response> {
  const { default: worker } = await import("../../../src/index");
  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, { headers: opts.headers ?? {} });
  const res = await worker.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPersistTokens.mockResolvedValue(undefined);
  mockStoreOAuthState.mockResolvedValue(undefined);
  mockConsumeOAuthState.mockResolvedValue(null);
});

// T-003-01: Initiate redirects to Tidal
describe("GET /auth/tidal — initiate (T-003-01)", () => {
  it("returns 302 to https://login.tidal.com/authorize", async () => {
    const token = await mintJwt();
    const res = await doFetch("/auth/tidal", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^https:\/\/login\.tidal\.com\/authorize\?/);
  });

  it("redirect URL contains required OAuth params", async () => {
    const token = await mintJwt();
    const res = await doFetch("/auth/tidal", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const location = res.headers.get("location") ?? "";
    const params = new URL(location).searchParams;

    expect(params.get("client_id")).toBe("tidal-client-id");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("state")).toBeTruthy();
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("scope")).toBeTruthy();
  });

  it("requires JWT — returns 401 without auth header", async () => {
    const res = await doFetch("/auth/tidal");
    expect(res.status).toBe(401);
  });
});

// T-003-03: Successful exchange persists tokens
describe("GET /auth/tidal/callback — success (T-003-03)", () => {
  it("returns 200 with status:connected,provider:tidal on valid callback", async () => {
    mockConsumeOAuthState.mockResolvedValueOnce({ codeVerifier: "test-verifier" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "AT",
            refresh_token: "RT",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const res = await doFetch("/auth/tidal/callback?state=valid-state&code=fakecode");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "connected", provider: "tidal" });

    expect(mockPersistTokens).toHaveBeenCalledOnce();
    const [, provider] = mockPersistTokens.mock.calls[0];
    expect(provider).toBe("tidal");

    vi.unstubAllGlobals();
  });
});

// T-003-11: Callback with invalid state returns 400
describe("GET /auth/tidal/callback — invalid state (T-003-11)", () => {
  it("returns 400 invalid_state when state not found", async () => {
    mockConsumeOAuthState.mockResolvedValueOnce(null);

    const res = await doFetch("/auth/tidal/callback?state=bogus&code=x");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_state" });
  });
});

// User denied
describe("GET /auth/tidal/callback — user denied", () => {
  it("returns 400 user_denied when error query param present", async () => {
    const res = await doFetch("/auth/tidal/callback?error=access_denied&state=S");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "user_denied" });
  });
});

// Token exchange failure
describe("GET /auth/tidal/callback — token exchange failure", () => {
  it("returns 400 token_exchange_failed when Tidal token endpoint errors", async () => {
    mockConsumeOAuthState.mockResolvedValueOnce({ codeVerifier: "verifier" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      )
    );

    const res = await doFetch("/auth/tidal/callback?state=S&code=bad-code");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "token_exchange_failed" });

    vi.unstubAllGlobals();
  });
});

// Missing code or state
describe("GET /auth/tidal/callback — missing params", () => {
  it("returns 400 when code is missing", async () => {
    const res = await doFetch("/auth/tidal/callback?state=S");
    expect(res.status).toBe(400);
  });

  it("returns 400 when state is missing", async () => {
    const res = await doFetch("/auth/tidal/callback?code=C");
    expect(res.status).toBe(400);
  });
});

// callback is unauthenticated (JWT not required)
describe("GET /auth/tidal/callback — no JWT needed (T-001-13)", () => {
  it("callback does not require Authorization header", async () => {
    mockConsumeOAuthState.mockResolvedValueOnce(null);
    const res = await doFetch("/auth/tidal/callback?state=S&code=x");
    expect(res.status).not.toBe(401);
  });
});
