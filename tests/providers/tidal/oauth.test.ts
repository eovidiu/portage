import { describe, it, expect, vi, beforeEach } from "vitest";
import { TIDAL_SCOPES } from "../../../src/providers/tidal/scopes";

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

import {
  initiateOAuth,
  exchangeCode,
  refreshTokens,
  needsRefresh,
  TidalReauthRequired,
} from "../../../src/providers/tidal/oauth";
import { persistTokens, loadTokens, markRevoked } from "../../../src/db/provider_tokens";
import { storeOAuthState, consumeOAuthState } from "../../../src/db/oauth_state";

const mockPersistTokens = persistTokens as ReturnType<typeof vi.fn>;
const mockLoadTokens = loadTokens as ReturnType<typeof vi.fn>;
const mockMarkRevoked = markRevoked as ReturnType<typeof vi.fn>;
const mockStoreOAuthState = storeOAuthState as ReturnType<typeof vi.fn>;
const mockConsumeOAuthState = consumeOAuthState as ReturnType<typeof vi.fn>;

function makeEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    TIDAL_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/tidal/callback",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    DATABASE_URL: "postgresql://localhost/test",
    SPOTIFY_CLIENT_ID: "spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
    SPOTIFY_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/spotify/callback",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPersistTokens.mockResolvedValue(undefined);
  mockLoadTokens.mockResolvedValue(null);
  mockMarkRevoked.mockResolvedValue(undefined);
  mockStoreOAuthState.mockResolvedValue(undefined);
  mockConsumeOAuthState.mockResolvedValue(null);
});

// T-003-01: Initiate redirects to Tidal with required params
describe("initiateOAuth — redirect URL (T-003-01)", () => {
  it("returns a URL starting with https://login.tidal.com/authorize", async () => {
    const env = makeEnv();
    const url = await initiateOAuth(env as never);
    expect(url).toMatch(/^https:\/\/login\.tidal\.com\/authorize\?/);
  });

  it("includes client_id in the redirect URL", async () => {
    const env = makeEnv();
    const url = await initiateOAuth(env as never);
    const params = new URL(url).searchParams;
    expect(params.get("client_id")).toBe("tidal-client-id");
  });

  it("includes redirect_uri in the redirect URL", async () => {
    const env = makeEnv();
    const url = await initiateOAuth(env as never);
    const params = new URL(url).searchParams;
    expect(params.get("redirect_uri")).toBe("https://portage.eovidiu.co.uk/auth/tidal/callback");
  });

  it("includes all configured scope strings", async () => {
    const env = makeEnv();
    const url = await initiateOAuth(env as never);
    const params = new URL(url).searchParams;
    const scope = params.get("scope") ?? "";
    for (const s of TIDAL_SCOPES.split(" ")) {
      expect(scope).toContain(s);
    }
  });

  it("includes response_type=code", async () => {
    const env = makeEnv();
    const url = await initiateOAuth(env as never);
    const params = new URL(url).searchParams;
    expect(params.get("response_type")).toBe("code");
  });

  it("includes state parameter", async () => {
    const env = makeEnv();
    const url = await initiateOAuth(env as never);
    const params = new URL(url).searchParams;
    expect(params.get("state")).toBeTruthy();
  });

  it("includes code_challenge parameter", async () => {
    const env = makeEnv();
    const url = await initiateOAuth(env as never);
    const params = new URL(url).searchParams;
    expect(params.get("code_challenge")).toBeTruthy();
  });

  it("includes code_challenge_method=S256", async () => {
    const env = makeEnv();
    const url = await initiateOAuth(env as never);
    const params = new URL(url).searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
  });

  it("calls storeOAuthState with state, codeVerifier, and expiresAt ~10min", async () => {
    const env = makeEnv();
    const before = Date.now();
    await initiateOAuth(env as never);
    const after = Date.now();

    expect(mockStoreOAuthState).toHaveBeenCalledOnce();
    const [, record] = mockStoreOAuthState.mock.calls[0];
    expect(record.state).toBeTruthy();
    expect(record.codeVerifier).toBeTruthy();
    const expiresMs = record.expiresAt.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 9 * 60 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + 10 * 60 * 1000 + 1000);
  });
});

// T-003-02: State entropy is at least 256 bits
describe("initiateOAuth — state entropy (T-003-02)", () => {
  it("generates state with at least 256 bits of entropy (hex string ≥ 64 chars)", async () => {
    const env = makeEnv();
    const states = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const url = await initiateOAuth(env as never);
      const state = new URL(url).searchParams.get("state")!;
      expect(state.length * 4).toBeGreaterThanOrEqual(256);
      states.add(state);
    }
    expect(states.size).toBe(10);
  });
});

// T-003-03: Successful exchange persists tokens
describe("exchangeCode — success (T-003-03)", () => {
  it("persists tokens when exchange succeeds", async () => {
    const env = makeEnv();
    mockConsumeOAuthState.mockResolvedValueOnce({ codeVerifier: "test-verifier" });

    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    await exchangeCode(env as never, "fakecode", "valid-state");

    expect(mockPersistTokens).toHaveBeenCalledOnce();
    const [, provider, at, rt, expiresAt] = mockPersistTokens.mock.calls[0];
    expect(provider).toBe("tidal");
    expect(at).toBe("AT");
    expect(rt).toBe("RT");
    const now = Date.now();
    expect(expiresAt.getTime()).toBeGreaterThan(now + 3500 * 1000);
    expect(expiresAt.getTime()).toBeLessThan(now + 3700 * 1000);

    vi.unstubAllGlobals();
  });

  it("calls consumeOAuthState with the given state", async () => {
    const env = makeEnv();
    mockConsumeOAuthState.mockResolvedValueOnce({ codeVerifier: "verifier123" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await exchangeCode(env as never, "code", "my-state");
    expect(mockConsumeOAuthState).toHaveBeenCalledWith(expect.anything(), "my-state");

    vi.unstubAllGlobals();
  });
});

// T-003-11: Callback with invalid state returns 400
describe("exchangeCode — invalid state (T-003-11)", () => {
  it("throws invalid_state when consumeOAuthState returns null", async () => {
    const env = makeEnv();
    mockConsumeOAuthState.mockResolvedValueOnce(null);

    await expect(exchangeCode(env as never, "code", "bogus")).rejects.toThrow("invalid_state");
  });
});

describe("exchangeCode — token exchange failure", () => {
  it("throws token_exchange_failed when Tidal returns non-OK", async () => {
    const env = makeEnv();
    mockConsumeOAuthState.mockResolvedValueOnce({ codeVerifier: "verifier" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      )
    );

    await expect(exchangeCode(env as never, "bad-code", "state")).rejects.toThrow(
      "token_exchange_failed"
    );

    vi.unstubAllGlobals();
  });
});

// T-003-05: Refresh occurs within 60s of expiry
describe("needsRefresh", () => {
  it("returns true when token expires in less than 60s", () => {
    const expiresAt = new Date(Date.now() + 30 * 1000);
    expect(needsRefresh(expiresAt)).toBe(true);
  });

  it("returns false when token expires in more than 60s", () => {
    const expiresAt = new Date(Date.now() + 120 * 1000);
    expect(needsRefresh(expiresAt)).toBe(false);
  });

  it("returns true when token expires in exactly 59s", () => {
    const expiresAt = new Date(Date.now() + 59 * 1000);
    expect(needsRefresh(expiresAt)).toBe(true);
  });
});

// T-003-06: Concurrent Tidal refresh is coalesced
describe("refreshTokens — coalescing (T-003-06)", () => {
  it("coalesces concurrent refresh calls into one HTTP request", async () => {
    const env = makeEnv();
    const activeTokens = {
      accessToken: "old-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      status: "active" as const,
    };
    mockLoadTokens.mockResolvedValue(activeTokens);

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              new Response(
                JSON.stringify({
                  access_token: "TIDALREFRESHED",
                  refresh_token: "new-rt",
                  expires_in: 3600,
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              )
            ),
          50
        )
      );
    });
    vi.stubGlobal("fetch", mockFetch);

    await Promise.all([
      refreshTokens(env as never),
      refreshTokens(env as never),
      refreshTokens(env as never),
      refreshTokens(env as never),
      refreshTokens(env as never),
    ]);

    expect(callCount).toBe(1);
    vi.unstubAllGlobals();
  });
});

// T-003-07: Refresh failure marks tokens revoked
describe("refreshTokens — failure marks revoked (T-003-07)", () => {
  it("marks tokens revoked when refresh endpoint returns 400", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValueOnce({
      accessToken: "old-token",
      refreshToken: "old-rt",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      status: "active" as const,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      )
    );

    await expect(refreshTokens(env as never)).rejects.toThrow(TidalReauthRequired);
    expect(mockMarkRevoked).toHaveBeenCalledWith(expect.anything(), "tidal");

    vi.unstubAllGlobals();
  });
});

// T-003-08: Refresh failure ends sync run with correct error
describe("refreshTokens — TidalReauthRequired error code (T-003-08)", () => {
  it("throws TidalReauthRequired with code tidal_reauth_required", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValueOnce({
      accessToken: "old-token",
      refreshToken: "old-rt",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      status: "active" as const,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      )
    );

    let caught: unknown;
    try {
      await refreshTokens(env as never);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TidalReauthRequired);
    expect((caught as TidalReauthRequired).code).toBe("tidal_reauth_required");

    vi.unstubAllGlobals();
  });
});

// refresh when no tokens throws TidalReauthRequired
describe("refreshTokens — no tokens (T-003-07 edge case)", () => {
  it("throws TidalReauthRequired when no tokens stored", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValueOnce(null);

    await expect(refreshTokens(env as never)).rejects.toThrow(TidalReauthRequired);
    expect(mockMarkRevoked).not.toHaveBeenCalled();
  });
});

// R8 rotated refresh token — persists new refresh token when returned
describe("refreshTokens — rotated refresh token (R8)", () => {
  it("persists the new refresh token if returned by Tidal", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValueOnce({
      accessToken: "old-at",
      refreshToken: "old-rt",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      status: "active" as const,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "new-at",
            refresh_token: "new-rt",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await refreshTokens(env as never);
    const [, , at, rt] = mockPersistTokens.mock.calls[0];
    expect(at).toBe("new-at");
    expect(rt).toBe("new-rt");

    vi.unstubAllGlobals();
  });

  it("falls back to old refresh token if Tidal does not return a new one", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValueOnce({
      accessToken: "old-at",
      refreshToken: "old-rt",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      status: "active" as const,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "new-at", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await refreshTokens(env as never);
    const [, , at, rt] = mockPersistTokens.mock.calls[0];
    expect(at).toBe("new-at");
    expect(rt).toBe("old-rt");

    vi.unstubAllGlobals();
  });
});
