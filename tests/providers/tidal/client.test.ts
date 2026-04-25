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

import { tidalFetch } from "../../../src/providers/tidal/client";
import { loadTokens, persistTokens, markRevoked } from "../../../src/db/provider_tokens";
import { TidalReauthRequired } from "../../../src/providers/tidal/oauth";

const mockLoadTokens = loadTokens as ReturnType<typeof vi.fn>;
const mockPersistTokens = persistTokens as ReturnType<typeof vi.fn>;
const mockMarkRevoked = markRevoked as ReturnType<typeof vi.fn>;

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

function activeTokens(expiresIn = 3600) {
  return {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    status: "active" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPersistTokens.mockResolvedValue(undefined);
  mockMarkRevoked.mockResolvedValue(undefined);
});

// T-003-04: Tidal API calls include required headers
describe("tidalFetch — required headers (T-003-04)", () => {
  it("includes Authorization: Bearer header", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValue(activeTokens());

    let capturedRequest: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: Request) => {
        capturedRequest = req;
        return Promise.resolve(
          new Response(JSON.stringify({}), { status: 200 })
        );
      })
    );

    await tidalFetch(env as never, "https://openapi.tidal.com/v2/artists/1");

    expect(capturedRequest?.headers.get("Authorization")).toBe(
      "Bearer valid-access-token"
    );
    vi.unstubAllGlobals();
  });

  it("includes accept: application/vnd.tidal.v1+json header", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValue(activeTokens());

    let capturedRequest: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: Request) => {
        capturedRequest = req;
        return Promise.resolve(new Response("{}", { status: 200 }));
      })
    );

    await tidalFetch(env as never, "https://openapi.tidal.com/v2/artists/1");
    expect(capturedRequest?.headers.get("accept")).toBe("application/vnd.tidal.v1+json");

    vi.unstubAllGlobals();
  });

  it("includes countryCode query parameter (T-003-04)", async () => {
    const env = makeEnv({ TIDAL_COUNTRY_CODE: "RO" });
    mockLoadTokens.mockResolvedValue(activeTokens());

    let capturedUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: Request) => {
        capturedUrl = req.url;
        return Promise.resolve(new Response("{}", { status: 200 }));
      })
    );

    await tidalFetch(env as never, "https://openapi.tidal.com/v2/artists/1");
    expect(capturedUrl).toContain("countryCode=RO");

    vi.unstubAllGlobals();
  });
});

// T-003-05: Refresh occurs within 60s of expiry
describe("tidalFetch — proactive refresh (T-003-05)", () => {
  it("refreshes token when expiry < 60s and uses new token in request", async () => {
    const env = makeEnv();

    const expiredTokens = {
      accessToken: "old-token",
      refreshToken: "old-rt",
      expiresAt: new Date(Date.now() + 30 * 1000),
      status: "active" as const,
    };

    const freshTokens = {
      accessToken: "TIDALREFRESHED",
      refreshToken: "new-rt",
      expiresAt: new Date(Date.now() + 3600 * 1000),
      status: "active" as const,
    };

    mockLoadTokens
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(freshTokens)
      .mockResolvedValueOnce(freshTokens);

    let capturedAuthHeader: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "TIDALREFRESHED",
              refresh_token: "new-rt",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
        .mockImplementation((req: Request) => {
          capturedAuthHeader = req.headers.get("Authorization") ?? undefined;
          return Promise.resolve(new Response("{}", { status: 200 }));
        })
    );

    await tidalFetch(env as never, "https://openapi.tidal.com/v2/search");

    expect(capturedAuthHeader).toBe("Bearer TIDALREFRESHED");
    vi.unstubAllGlobals();
  });
});

// T-003-09: Tidal 401 triggers one refresh and one retry
describe("tidalFetch — 401 retry (T-003-09)", () => {
  it("retries once on 401, total 2 calls to target endpoint", async () => {
    const env = makeEnv();

    const tokens = activeTokens(3600);
    const refreshedTokens = {
      ...tokens,
      accessToken: "refreshed-token",
    };

    mockLoadTokens
      .mockResolvedValueOnce(tokens)
      .mockResolvedValueOnce(refreshedTokens)
      .mockResolvedValueOnce(refreshedTokens);

    let targetCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: Request) => {
        if (req.url.includes("oauth2/token")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: "refreshed-token",
                refresh_token: "new-rt",
                expires_in: 3600,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        }
        targetCallCount++;
        if (targetCallCount === 1) {
          return Promise.resolve(new Response("{}", { status: 401 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      })
    );

    const res = await tidalFetch(env as never, "https://openapi.tidal.com/v2/search");
    expect(res.status).toBe(200);
    expect(targetCallCount).toBe(2);

    vi.unstubAllGlobals();
  });
});

// T-003-10: Unknown media type returns warning, not crash
describe("tidalFetch — v2 media type tolerance (T-003-10)", () => {
  it("logs warning and does not crash on application/vnd.tidal.v2+json response", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValue(activeTokens());

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/vnd.tidal.v2+json" },
        })
      )
    );

    const res = await tidalFetch(env as never, "https://openapi.tidal.com/v2/artists/1");

    expect(res.status).toBe(200);
    const warnCalls = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(warnCalls).toContain("vnd.tidal.v2");

    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

// No tokens → TidalReauthRequired
describe("tidalFetch — no tokens", () => {
  it("throws TidalReauthRequired when no tokens stored", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValue(null);

    await expect(
      tidalFetch(env as never, "https://openapi.tidal.com/v2/artists/1")
    ).rejects.toThrow(TidalReauthRequired);
  });

  it("throws TidalReauthRequired when tokens null after proactive refresh", async () => {
    const env = makeEnv();
    const expiredTokens = {
      accessToken: "old-token",
      refreshToken: "old-rt",
      expiresAt: new Date(Date.now() + 30 * 1000),
      status: "active" as const,
    };

    mockLoadTokens
      .mockResolvedValueOnce(expiredTokens)
      .mockResolvedValueOnce(null);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      tidalFetch(env as never, "https://openapi.tidal.com/v2/artists/1")
    ).rejects.toThrow(TidalReauthRequired);

    vi.unstubAllGlobals();
  });

  it("throws TidalReauthRequired when tokens null after 401 refresh", async () => {
    const env = makeEnv();
    const tokens = activeTokens(3600);

    mockLoadTokens
      .mockResolvedValueOnce(tokens)
      .mockResolvedValueOnce(tokens)
      .mockResolvedValueOnce(null);

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response("{}", { status: 401 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
    );

    await expect(
      tidalFetch(env as never, "https://openapi.tidal.com/v2/artists/1")
    ).rejects.toThrow(TidalReauthRequired);

    vi.unstubAllGlobals();
  });
});

describe("tidalFetch — POST Content-Type header", () => {
  it("sets Content-Type: application/vnd.tidal.v1+json for POST requests", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValue(activeTokens());

    let capturedRequest: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: Request) => {
        capturedRequest = req;
        return Promise.resolve(new Response("{}", { status: 200 }));
      })
    );

    await tidalFetch(env as never, "https://openapi.tidal.com/v2/playlists", {
      method: "POST",
      body: JSON.stringify({ name: "test" }),
    });

    expect(capturedRequest?.headers.get("Content-Type")).toBe("application/vnd.tidal.v1+json");
    vi.unstubAllGlobals();
  });

  it("does not set Content-Type for GET requests", async () => {
    const env = makeEnv();
    mockLoadTokens.mockResolvedValue(activeTokens());

    let capturedRequest: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((req: Request) => {
        capturedRequest = req;
        return Promise.resolve(new Response("{}", { status: 200 }));
      })
    );

    await tidalFetch(env as never, "https://openapi.tidal.com/v2/artists/1");

    expect(capturedRequest?.headers.get("Content-Type")).toBeNull();
    vi.unstubAllGlobals();
  });
});
