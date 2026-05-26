import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const REQUIRED_SECRETS = [
  "JWT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "TIDAL_CLIENT_ID",
  "TIDAL_CLIENT_SECRET",
  "DATABASE_URL",
] as const;

// Global mock for @neondatabase/serverless
let mockSql = vi.fn();

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => mockSql),
}));

function makeEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  const base: Record<string, string> = {
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5",
    SPOTIFY_CLIENT_ID: "spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    DATABASE_URL: env.DATABASE_URL ?? "postgresql://localhost/test",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
    SPOTIFY_REDIRECT_URI: "https://example.com/auth/spotify/callback",
    TIDAL_REDIRECT_URI: "https://example.com/auth/tidal/callback",
  };
  return { ...base, ...overrides };
}

async function doFetch(path: string, testEnv = makeEnv()) {
  const { default: worker } = await import("../../src/index");
  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`);
  const res = await worker.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => {
  mockSql = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

// T-014-01: GET /healthz returns 200 with {"status":"ok"}
describe("GET /healthz", () => {
  it("returns 200 with status ok (T-014-01)", async () => {
    const res = await doFetch("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  // T-014-02: does not query the database
  it("does not query the database (T-014-02)", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await doFetch("/healthz");
      expect(res.status).toBe(200);
    }
    expect(mockSql).not.toHaveBeenCalled();
  });

  // T-014-10: works when JWT_SECRET is an empty string
  it("returns 200 even when JWT_SECRET is empty (T-014-10)", async () => {
    const res = await doFetch("/healthz", makeEnv({ JWT_SECRET: "" }));
    expect(res.status).toBe(200);
  });
});

// T-014-04: GET /readyz returns 200 when all green
describe("GET /readyz - all green", () => {
  it("returns 200 with ready status and all checks green (T-014-04)", async () => {
    mockSql
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([
        { provider: "spotify", status: "active" },
        { provider: "tidal", status: "active" },
      ]);

    const res = await doFetch("/readyz");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ready");
    expect(body.database).toBe(true);
    const secrets = body.secrets as Record<string, boolean>;
    for (const key of REQUIRED_SECRETS) {
      expect(secrets[key]).toBe(true);
    }
    const tokens = body.tokens as Record<string, string>;
    expect(tokens.spotify).toBe("active");
    expect(tokens.tidal).toBe("active");
  });
});

// T-014-05: GET /readyz returns 503 when database down
describe("GET /readyz - database down", () => {
  it("returns 503 with database: false (T-014-05)", async () => {
    mockSql.mockRejectedValue(new Error("connection refused"));

    const res = await doFetch("/readyz");
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.database).toBe(false);
  });
});

// T-014-06: GET /readyz returns 503 when token revoked
describe("GET /readyz - token revoked", () => {
  it("returns 503 with tokens.spotify = revoked (T-014-06)", async () => {
    mockSql
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([
        { provider: "spotify", status: "revoked" },
        { provider: "tidal", status: "active" },
      ]);

    const res = await doFetch("/readyz");
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    const tokens = body.tokens as Record<string, string>;
    expect(tokens.spotify).toBe("revoked");
  });

  it("returns 503 with tokens.tidal = revoked (T-014-06 variant)", async () => {
    mockSql
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([
        { provider: "spotify", status: "active" },
        { provider: "tidal", status: "revoked" },
      ]);

    const res = await doFetch("/readyz");
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    const tokens = body.tokens as Record<string, string>;
    expect(tokens.tidal).toBe("revoked");
  });
});

// T-014-07: GET /readyz returns 503 when secret missing
describe("GET /readyz - secret missing", () => {
  it("returns 503 with secrets.JWT_SECRET = false when JWT_SECRET is empty (T-014-07)", async () => {
    mockSql
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([]);

    const res = await doFetch("/readyz", makeEnv({ JWT_SECRET: "" }));
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    const secrets = body.secrets as Record<string, boolean>;
    expect(secrets.JWT_SECRET).toBe(false);
  });
});

// T-014-08: response body contains no canary secret values
describe("GET /readyz - no secret values in response", () => {
  it("response body does not contain canary secret values (T-014-08)", async () => {
    const canaryJwt = "JWTCANARY_SECRET_VALUE";
    const canaryEk = "EKCANARY_SECRET_VALUE";
    const canaryDb = "postgresql://DBCANARY:password@host/db";

    mockSql
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([
        { provider: "spotify", status: "active" },
        { provider: "tidal", status: "active" },
      ]);

    const res = await doFetch("/readyz", makeEnv({
      JWT_SECRET: canaryJwt,
      TOKEN_ENCRYPTION_KEY: canaryEk,
      DATABASE_URL: canaryDb,
    }));

    const bodyText = await res.text();
    expect(bodyText).not.toContain(canaryJwt);
    expect(bodyText).not.toContain(canaryEk);
    expect(bodyText).not.toContain("DBCANARY");
  });
});

// T-014-09: DB query timeout — readyz enforces 2s DB timeout
describe("GET /readyz - DB timeout", () => {
  it("responds within 3 seconds even when DB hangs (T-014-09)", async () => {
    mockSql.mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000))
    );

    const start = Date.now();
    const res = await doFetch("/readyz");
    const elapsed = Date.now() - start;

    expect(res.status).toBe(503);
    expect(elapsed).toBeLessThan(3000);
  }, 5000);
});

// T-014-10: readyz still returns a defined response when JWT_SECRET is empty
describe("GET /readyz - JWT_SECRET misconfigured", () => {
  it("returns a defined response (200 or 503) when JWT_SECRET is empty (T-014-10)", async () => {
    mockSql
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([]);

    const res = await doFetch("/readyz", makeEnv({ JWT_SECRET: "" }));
    expect([200, 503]).toContain(res.status);
  });
});

// T-014: tokens with "missing" status (no rows) should return 200 — bootstrap state
describe("GET /readyz - missing tokens (bootstrap state)", () => {
  it("returns 200 when no provider_tokens rows exist (bootstrap/missing state)", async () => {
    mockSql
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([]); // no token rows

    const res = await doFetch("/readyz");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const tokens = body.tokens as Record<string, string>;
    expect(tokens.spotify).toBe("missing");
    expect(tokens.tidal).toBe("missing");
  });
});
