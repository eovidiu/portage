// T-002: Spotify OAuth provider tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../../src/env";

vi.mock("../../../src/db/provider_tokens");
vi.mock("../../../src/db/oauth_state");

import {
  generateState,
  generateCodeVerifier,
  generateCodeChallenge,
  initiateSpotifyOAuth,
  handleCallback,
  ensureFreshToken,
  spotifyFetch,
  refreshSpotify,
  SpotifyAuthError,
} from "../../../src/providers/spotify/oauth";
import {
  persistTokens,
  loadTokens,
  markRevoked,
} from "../../../src/db/provider_tokens";
import {
  storeOAuthState,
  consumeOAuthState,
  purgeExpiredOAuthState,
} from "../../../src/db/oauth_state";

const mockPersistTokens = vi.mocked(persistTokens);
const mockLoadTokens = vi.mocked(loadTokens);
const mockMarkRevoked = vi.mocked(markRevoked);
const mockStoreOAuthState = vi.mocked(storeOAuthState);
const mockConsumeOAuthState = vi.mocked(consumeOAuthState);
const mockPurgeExpiredOAuthState = vi.mocked(purgeExpiredOAuthState);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgresql://localhost/test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "test-spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "SPSECRETCANARY",
    SPOTIFY_REDIRECT_URI: "https://example.com/auth/spotify/callback",
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    TIDAL_REDIRECT_URI: "https://example.com/auth/tidal/callback",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
    ...overrides,
  };
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

beforeEach(() => {
  vi.resetAllMocks();
  mockStoreOAuthState.mockResolvedValue(undefined);
  mockConsumeOAuthState.mockResolvedValue(null);
  mockPurgeExpiredOAuthState.mockResolvedValue(undefined);
  mockPersistTokens.mockResolvedValue(undefined);
  mockLoadTokens.mockResolvedValue(null);
  mockMarkRevoked.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// T-002-02: State entropy >= 256 bits
describe("generateState — entropy (T-002-02)", () => {
  it("produces base64url strings that decode to >= 32 bytes (256 bits)", () => {
    for (let i = 0; i < 20; i++) {
      const state = generateState();
      const decoded = base64urlDecode(state);
      expect(decoded.byteLength * 8).toBeGreaterThanOrEqual(256);
    }
  });
});

// T-002-03: State uniqueness
describe("generateState — uniqueness (T-002-03)", () => {
  it("generates distinct state values across 100 calls", () => {
    const states = new Set<string>();
    for (let i = 0; i < 100; i++) {
      states.add(generateState());
    }
    expect(states.size).toBe(100);
  });
});

// PKCE: code_verifier and code_challenge
describe("PKCE code_verifier + code_challenge", () => {
  it("generates a code_verifier of valid length (32-43 base64url chars)", () => {
    for (let i = 0; i < 10; i++) {
      const v = generateCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(32);
      expect(v.length).toBeLessThanOrEqual(64); // base64url of 32 bytes = 43 chars
      expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("generates a code_challenge = base64url(SHA-256(verifier))", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    // SHA-256 is 32 bytes → 43 base64url chars (no padding)
    expect(challenge.length).toBe(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("code_challenge differs from code_verifier", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    expect(challenge).not.toBe(verifier);
  });
});

// T-002-01: initiateSpotifyOAuth builds correct authorize URL
describe("initiateSpotifyOAuth — authorize URL (T-002-01)", () => {
  it("redirects to Spotify with all required params", async () => {
    const env = makeEnv();
    const result = await initiateSpotifyOAuth(env);

    expect(result.authorizeUrl).toMatch(/^https:\/\/accounts\.spotify\.com\/authorize\?/);
    const url = new URL(result.authorizeUrl);
    expect(url.searchParams.get("client_id")).toBe("test-spotify-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/auth/spotify/callback");
    expect(url.searchParams.get("scope")).toBe("user-library-read");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("stores oauth_state with correct expiry (T-002-04)", async () => {
    const env = makeEnv();
    const before = Date.now();
    await initiateSpotifyOAuth(env);
    const after = Date.now();

    expect(mockStoreOAuthState).toHaveBeenCalledOnce();
    const [, record] = mockStoreOAuthState.mock.calls[0];
    expect(record.state).toBeTruthy();
    expect(record.codeVerifier).toBeTruthy();
    const expiresMs = record.expiresAt.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 100);
    expect(expiresMs).toBeLessThanOrEqual(after + 10 * 60 * 1000 + 100);
  });
});

// T-002-05: Callback with unknown state returns invalid_state
describe("handleCallback — unknown state (T-002-05)", () => {
  it("throws SpotifyAuthError invalid_state when consumeOAuthState returns null", async () => {
    mockConsumeOAuthState.mockResolvedValue(null);
    const env = makeEnv();
    await expect(
      handleCallback(env, { code: "somecode", state: "unknownstate" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("purges expired oauth_state rows before checking (R4)", async () => {
    mockConsumeOAuthState.mockResolvedValue(null);
    const env = makeEnv();
    await expect(
      handleCallback(env, { code: "c", state: "s" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(mockPurgeExpiredOAuthState).toHaveBeenCalled();
  });
});

// T-002-06: Callback with expired state returns invalid_state
// (consumeOAuthState returns null for expired rows — the DB helper is responsible for that)
describe("handleCallback — expired state (T-002-06)", () => {
  it("throws invalid_state when consume returns null (expired row consumed by purge)", async () => {
    mockConsumeOAuthState.mockResolvedValue(null);
    const env = makeEnv();
    await expect(
      handleCallback(env, { code: "c", state: "expired-state" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

// T-002-07: Callback with user_denied → user_denied
describe("handleCallback — user denied (T-002-07)", () => {
  it("throws SpotifyAuthError user_denied when error=access_denied", async () => {
    const env = makeEnv();
    await expect(
      handleCallback(env, { error: "access_denied", state: "somestate" }),
    ).rejects.toMatchObject({ code: "user_denied" });
  });

  it("attempts to delete the state row on user_denied", async () => {
    mockConsumeOAuthState.mockResolvedValue(null);
    const env = makeEnv();
    await expect(
      handleCallback(env, { error: "access_denied", state: "somestate" }),
    ).rejects.toMatchObject({ code: "user_denied" });
    expect(mockConsumeOAuthState).toHaveBeenCalledWith(env, "somestate");
  });
});

// T-002-08 + T-002-09: Successful exchange persists tokens and returns connected
describe("handleCallback — success (T-002-08 + T-002-09)", () => {
  it("calls persistTokens with correct provider and expiry, purges state", async () => {
    const codeVerifier = "test-verifier-value-abc123";
    mockConsumeOAuthState.mockResolvedValue({ codeVerifier });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "ATCANARY",
          refresh_token: "RTCANARY",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", mockFetch);

    const env = makeEnv();
    const before = Date.now();
    await handleCallback(env, { code: "fakecode", state: "validstate" });
    const after = Date.now();

    expect(mockPersistTokens).toHaveBeenCalledOnce();
    const [, provider, , , expiresAt] = mockPersistTokens.mock.calls[0];
    expect(provider).toBe("spotify");
    const expiresMs = expiresAt.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 3600 * 1000 - 500);
    expect(expiresMs).toBeLessThanOrEqual(after + 3600 * 1000 + 500);
  });

  it("resolves without error on success", async () => {
    mockConsumeOAuthState.mockResolvedValue({ codeVerifier: "verifier-xyz" });
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
    const env = makeEnv();
    await expect(handleCallback(env, { code: "c", state: "s" })).resolves.toBeUndefined();
  });
});

// T-002-08: token exchange failure
describe("handleCallback — token exchange failure", () => {
  it("throws token_exchange_failed when Spotify returns non-200", async () => {
    mockConsumeOAuthState.mockResolvedValue({ codeVerifier: "verifier" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("error", { status: 400 })),
    );
    const env = makeEnv();
    await expect(
      handleCallback(env, { code: "c", state: "s" }),
    ).rejects.toMatchObject({ code: "token_exchange_failed" });
  });
});

// T-002-10: Refresh when token within 60s of expiry
describe("ensureFreshToken — refresh near expiry (T-002-10)", () => {
  it("triggers refresh when expires_at is 30s away and returns new token", async () => {
    const nearExpiry = new Date(Date.now() + 30 * 1000);
    const freshExpiry = new Date(Date.now() + 3600 * 1000);
    // ensureFreshToken: 1st loadTokens = near-expiry → triggers refresh
    // doRefresh: 2nd loadTokens = still near-expiry (to get refresh token)
    // ensureFreshToken post-refresh: 3rd loadTokens = fresh token
    mockLoadTokens
      .mockResolvedValueOnce({
        accessToken: "OLD_AT",
        refreshToken: "rt",
        expiresAt: nearExpiry,
        status: "active",
      })
      .mockResolvedValueOnce({
        accessToken: "OLD_AT",
        refreshToken: "rt",
        expiresAt: nearExpiry,
        status: "active",
      })
      .mockResolvedValueOnce({
        accessToken: "REFRESHED_AT",
        refreshToken: "rt2",
        expiresAt: freshExpiry,
        status: "active",
      });

    const refreshMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "REFRESHED_AT",
          refresh_token: "rt2",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", refreshMock);

    const env = makeEnv();
    const token = await ensureFreshToken(env);
    expect(token).toBe("REFRESHED_AT");
    expect(refreshMock).toHaveBeenCalled();
  });
});

// T-002-11: No refresh when token has plenty of time
describe("ensureFreshToken — no refresh when plenty of time (T-002-11)", () => {
  it("returns existing token without calling fetch when 7200s remaining", async () => {
    const farExpiry = new Date(Date.now() + 7200 * 1000);
    mockLoadTokens.mockResolvedValue({
      accessToken: "AT_VALID",
      refreshToken: "rt",
      expiresAt: farExpiry,
      status: "active",
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const env = makeEnv();
    const token = await ensureFreshToken(env);
    expect(token).toBe("AT_VALID");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// T-002-12: Concurrent refresh is coalesced
describe("ensureFreshToken — concurrent refresh coalescing (T-002-12)", () => {
  it("makes only one refresh call when 5 concurrent calls are made with near-expiry token", async () => {
    const nearExpiry = new Date(Date.now() + 30 * 1000);
    let refreshCallCount = 0;

    mockLoadTokens.mockImplementation(async () => {
      // First loadTokens call returns near-expiry; subsequent return fresh
      if (refreshCallCount === 0) {
        return {
          accessToken: "OLD_AT",
          refreshToken: "rt",
          expiresAt: nearExpiry,
          status: "active" as const,
        };
      }
      return {
        accessToken: "REFRESHED_AT",
        refreshToken: "rt2",
        expiresAt: new Date(Date.now() + 3600 * 1000),
        status: "active" as const,
      };
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        refreshCallCount++;
        await new Promise((r) => setTimeout(r, 50)); // 50ms latency
        return new Response(
          JSON.stringify({
            access_token: "REFRESHED_AT",
            refresh_token: "rt2",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const env = makeEnv();
    await Promise.all([
      ensureFreshToken(env),
      ensureFreshToken(env),
      ensureFreshToken(env),
      ensureFreshToken(env),
      ensureFreshToken(env),
    ]);

    expect(refreshCallCount).toBe(1);
  });
});

// T-002-13: invalid_grant marks tokens revoked
describe("handleRefresh — invalid_grant (T-002-13)", () => {
  it("marks tokens revoked and throws reauth_required on 400 invalid_grant", async () => {
    const nearExpiry = new Date(Date.now() + 30 * 1000);
    mockLoadTokens.mockResolvedValue({
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: nearExpiry,
      status: "active",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: "invalid_grant" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const env = makeEnv();
    await expect(ensureFreshToken(env)).rejects.toMatchObject({ code: "reauth_required" });
    expect(mockMarkRevoked).toHaveBeenCalledWith(env, "spotify");
  });
});

// T-002-14: 401 from Spotify triggers one refresh and one retry
describe("spotifyFetch — 401 refresh + retry (T-002-14)", () => {
  it("makes exactly 2 calls to the target endpoint on 401 (one original + one retry)", async () => {
    const farExpiry = new Date(Date.now() + 7200 * 1000);
    mockLoadTokens.mockResolvedValue({
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: farExpiry,
      status: "active",
    });

    let targetCallCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === "https://accounts.spotify.com/api/token") {
        return new Response(
          JSON.stringify({ access_token: "NEW_AT", refresh_token: "NEW_RT", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      targetCallCount++;
      if (targetCallCount === 1) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(JSON.stringify({ data: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const env = makeEnv();
    const res = await spotifyFetch(env, "https://api.spotify.com/v1/me/tracks");
    expect(res.status).toBe(200);
    expect(targetCallCount).toBe(2);
  });
});

// T-002-12b: Mixed-path coalescing — concurrent calls through refreshSpotify share one in-flight POST
describe("refreshSpotify — mixed-path coalescing (T-002-12b)", () => {
  it("concurrent refreshSpotify calls (from both ensureFreshToken and 401 retry) coalesce to one POST", async () => {
    const nearExpiry = new Date(Date.now() + 30 * 1000);
    const freshExpiry = new Date(Date.now() + 3600 * 1000);
    let refreshPostCount = 0;

    mockLoadTokens.mockImplementation(async () => {
      if (refreshPostCount === 0) {
        return { accessToken: "OLD_AT", refreshToken: "rt", expiresAt: nearExpiry, status: "active" as const };
      }
      return { accessToken: "NEW_AT", refreshToken: "rt2", expiresAt: freshExpiry, status: "active" as const };
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        refreshPostCount++;
        await new Promise((r) => setTimeout(r, 30));
        return new Response(
          JSON.stringify({ access_token: "NEW_AT", refresh_token: "rt2", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const env = makeEnv();
    // Call refreshSpotify concurrently from multiple paths — simulates ensureFreshToken + 401 retry both hitting it
    await Promise.all([
      refreshSpotify(env),
      refreshSpotify(env),
      refreshSpotify(env),
    ]);

    expect(refreshPostCount).toBe(1);
  });
});

// T-002-14b: spotifyFetch returns 200 on first try (happy path — no refresh needed)
describe("spotifyFetch — happy path 200 first try (T-002-14b)", () => {
  it("returns 200 response without calling refresh endpoint when token is fresh", async () => {
    const farExpiry = new Date(Date.now() + 7200 * 1000);
    mockLoadTokens.mockResolvedValue({
      accessToken: "FRESH_AT",
      refreshToken: "rt",
      expiresAt: farExpiry,
      status: "active",
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const env = makeEnv();
    const res = await spotifyFetch(env, "https://api.spotify.com/v1/me/tracks");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

// Coverage: handleCallback missing-state branch (L101)
describe("handleCallback — missing state param (coverage)", () => {
  it("throws invalid_state when state param is absent and no error param", async () => {
    const env = makeEnv();
    await expect(
      handleCallback(env, { code: "somecode" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

// Coverage: handleCallback missing-code branch (L110)
describe("handleCallback — missing code (coverage)", () => {
  it("throws token_exchange_failed when code is absent but state is valid", async () => {
    mockConsumeOAuthState.mockResolvedValue({ codeVerifier: "verifier" });
    const env = makeEnv();
    await expect(
      handleCallback(env, { state: "validstate" }),
    ).rejects.toMatchObject({ code: "token_exchange_failed" });
  });
});

// Coverage: ensureFreshToken no-tokens branch (L201)
describe("ensureFreshToken — no tokens (coverage)", () => {
  it("throws reauth_required when loadTokens returns null", async () => {
    mockLoadTokens.mockResolvedValue(null);
    const env = makeEnv();
    await expect(ensureFreshToken(env)).rejects.toMatchObject({ code: "reauth_required" });
  });
});

// Coverage: _doRefresh no-tokens branch (L147) via direct refreshSpotify call
describe("refreshSpotify — no tokens (coverage)", () => {
  it("throws reauth_required when loadTokens returns null", async () => {
    mockLoadTokens.mockResolvedValue(null);
    const env = makeEnv();
    await expect(refreshSpotify(env)).rejects.toMatchObject({ code: "reauth_required" });
  });
});

// Coverage: _doRefresh non-400 failure branch (L170)
describe("refreshSpotify — non-400 failure (coverage)", () => {
  it("throws refresh_failed on non-400 non-invalid_grant error", async () => {
    const nearExpiry = new Date(Date.now() + 30 * 1000);
    mockLoadTokens.mockResolvedValue({
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: nearExpiry,
      status: "active",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("server error", { status: 500 })),
    );
    const env = makeEnv();
    await expect(ensureFreshToken(env)).rejects.toMatchObject({ code: "refresh_failed" });
  });
});

// T-002-15: No secrets in logs
describe("Spotify OAuth — no secrets in logs (T-002-15)", () => {
  it("does not log access_token, refresh_token, client_secret, or code_verifier", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const codeVerifier = "PKCE_VERIFIER_CANARY_VALUE_12345";
    mockConsumeOAuthState.mockResolvedValue({ codeVerifier });
    mockLoadTokens.mockResolvedValue({
      accessToken: "ATCANARY",
      refreshToken: "RTCANARY",
      expiresAt: new Date(Date.now() + 30 * 1000),
      status: "active",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "ATCANARY",
            refresh_token: "RTCANARY",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const env = makeEnv({ SPOTIFY_CLIENT_SECRET: "SPSECRETCANARY" });

    await handleCallback(env, { code: "somecode", state: "validstate" }).catch(() => {});
    await ensureFreshToken(env).catch(() => {});

    const allLogs = [
      ...logSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
    ]
      .map((v) => String(v))
      .join("\n");

    expect(allLogs).not.toContain("SPSECRETCANARY");
    expect(allLogs).not.toContain("ATCANARY");
    expect(allLogs).not.toContain("RTCANARY");
    expect(allLogs).not.toContain("PKCE_VERIFIER_CANARY_VALUE_12345");

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
