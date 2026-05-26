import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SignJWT, decodeJwt } from "jose";
import { Hono } from "hono";

// 32-byte test secret (exactly 32 ASCII chars)
const TEST_SECRET = "test-jwt-secret-32-bytes-long-ok!";
const TEST_SECRET_BYTES = new TextEncoder().encode(TEST_SECRET);

// Different secret for signature mismatch tests
const OTHER_SECRET = "other-secret-32-bytes-long-ok!!!";
const OTHER_SECRET_BYTES = new TextEncoder().encode(OTHER_SECRET);

// base64("test-encryption-key-32bytes-long") = 32 bytes after decode
const VALID_B64_KEY = "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=";

function makeEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    JWT_SECRET: TEST_SECRET,
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

async function mintToken(
  overrides: {
    secret?: Uint8Array;
    iss?: string;
    sub?: string;
    exp?: string | number;
    extraClaims?: Record<string, unknown>;
  } = {}
): Promise<string> {
  const secret = overrides.secret ?? TEST_SECRET_BYTES;
  const builder = new SignJWT({ ...(overrides.extraClaims ?? {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(overrides.iss ?? "spotify-roon-sync")
    .setSubject(overrides.sub ?? "owner")
    .setIssuedAt();

  if (overrides.exp !== undefined) {
    builder.setExpirationTime(overrides.exp);
  } else {
    builder.setExpirationTime("1h");
  }

  return builder.sign(secret);
}

async function doFetch(
  path: string,
  headers: Record<string, string> = {},
  testEnv = makeEnv()
) {
  const { default: worker } = await import("../../src/index");
  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, { headers });
  const res = await worker.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ---- T-001-01: Bootstrap script rejects short secret ----
describe("mintBootstrapToken — short secret (T-001-01)", () => {
  it("throws with 'secret too short' when secret is < 32 bytes", async () => {
    const { mintBootstrapToken } = await import("../../scripts/mint-bootstrap-token");
    const shortSecret = "only16byteslong";
    await expect(mintBootstrapToken(shortSecret)).rejects.toThrow(/secret too short/i);
  });
});

// ---- T-001-02: Bootstrap script mints valid JWT ----
describe("mintBootstrapToken — valid JWT (T-001-02)", () => {
  it("mints a JWT with correct sub, iss, and exp ≈ iat+365d", async () => {
    const { mintBootstrapToken } = await import("../../scripts/mint-bootstrap-token");
    const token = await mintBootstrapToken(TEST_SECRET);
    const claims = decodeJwt(token);
    expect(claims.sub).toBe("owner");
    expect(claims.iss).toBe("spotify-roon-sync");
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    const diffDays = (claims.exp! - claims.iat!) / 86400;
    expect(Math.abs(diffDays - 365)).toBeLessThan(1);
  });
});

// ---- T-001-03: Missing Authorization header → 401 missing_token ----
describe("JWT middleware — missing token (T-001-03)", () => {
  it("returns 401 missing_token when no Authorization header", async () => {
    const res = await doFetch("/sync/status");
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "missing_token" });
  });
});

// ---- T-001-04: Malformed Authorization header → 401 malformed_token ----
describe("JWT middleware — malformed token (T-001-04)", () => {
  it("returns 401 malformed_token for non-Bearer scheme", async () => {
    const res = await doFetch("/sync/status", {
      Authorization: "NotBearer abc.def.ghi",
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "malformed_token" });
  });

  it("returns 401 malformed_token for Bearer with non-JWT payload", async () => {
    const res = await doFetch("/sync/status", {
      Authorization: "Bearer notajwt",
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "malformed_token" });
  });

  it("returns 401 for 'Bearer ' with no token (empty after prefix)", async () => {
    const res = await doFetch("/sync/status", { Authorization: "Bearer " });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    // Hono may trim trailing whitespace from headers, so "Bearer " becomes "Bearer"
    // which doesn't match the "Bearer " prefix check → malformed_token is acceptable
    expect(["missing_token", "malformed_token"]).toContain(body.error);
  });
});

// ---- T-001-05: Wrong-secret signature → 401 invalid_signature ----
describe("JWT middleware — signature mismatch (T-001-05)", () => {
  it("returns 401 invalid_signature for token signed with different secret", async () => {
    const token = await mintToken({ secret: OTHER_SECRET_BYTES });
    const res = await doFetch("/sync/status", { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_signature" });
  });
});

// ---- T-001-06: Expired token → 401 expired_token ----
describe("JWT middleware — expired token (T-001-06)", () => {
  it("returns 401 expired_token for token with exp in the past", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await mintToken({ exp: nowSec - 60 });
    const res = await doFetch("/sync/status", { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "expired_token" });
  });
});

// ---- T-001-07: Wrong issuer → 401 invalid_issuer ----
describe("JWT middleware — wrong issuer (T-001-07)", () => {
  it("returns 401 invalid_issuer for token with wrong iss", async () => {
    const token = await mintToken({ iss: "other-system" });
    const res = await doFetch("/sync/status", { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_issuer" });
  });
});

// ---- T-001-08: Wrong subject → 401 invalid_subject ----
describe("JWT middleware — wrong subject (T-001-08)", () => {
  it("returns 401 invalid_subject for token with sub=intruder", async () => {
    const token = await mintToken({ sub: "intruder" });
    const res = await doFetch("/sync/status", { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_subject" });
  });
});

// ---- T-001-09: Valid token reaches handler (ctx.subject = "owner") ----
describe("JWT middleware — valid token reaches handler (T-001-09)", () => {
  it("sets ctx.subject to 'owner' for valid token", async () => {
    // Test the middleware in isolation with a local Hono app to avoid
    // polluting src/index.ts with test-only routes.
    const { jwtMiddleware } = await import("../../src/middleware/auth");
    const app = new Hono();
    app.use("*", jwtMiddleware(["/healthz"]));
    app.get("/probe", (c) => c.json({ subject: c.get("subject" as never) }));

    const token = await mintToken();
    const req = new Request("https://worker.test/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.subject).toBe("owner");
  });
});

// ---- T-001-10: Latency metric (deferred) ----
// T-001-10: p95 JWT verification latency < 5ms. Requires wrangler dev.
// Deferred to Sprint 3 e2e QA harness per plan approval decision.

// ---- T-001-11: No token logging / canary ----
describe("JWT middleware — no token logging (T-001-11)", () => {
  it("does not log the JWT value or JWT_SECRET canary in any console channel", async () => {
    const canarySecret = "LEAKCANARY_SECRET_32BYTES_LONG!!!";
    const canarySecretBytes = new TextEncoder().encode(canarySecret);
    const token = await mintToken({
      secret: canarySecretBytes,
      extraClaims: { canary: "LEAKCANARY" },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const testEnv = makeEnv({ JWT_SECRET: canarySecret });

    for (let i = 0; i < 5; i++) {
      await doFetch("/sync/status", { Authorization: `Bearer ${token}` }, testEnv);
      await doFetch("/sync/status", {}, testEnv);
    }

    const allLogs = [
      ...logSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
    ]
      .map((v) => String(v))
      .join("\n");

    expect(allLogs).not.toContain("LEAKCANARY");
    expect(allLogs).not.toContain(canarySecret);

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ---- T-001-12: /healthz remains unauthenticated ----
describe("JWT middleware — /healthz bypasses auth (T-001-12)", () => {
  it("returns 200 for GET /healthz with no Authorization header", async () => {
    const res = await doFetch("/healthz");
    expect(res.status).toBe(200);
  });
});

// ---- T-001-13: OAuth callbacks remain unauthenticated ----
describe("JWT middleware — OAuth callbacks bypass auth (T-001-13)", () => {
  it("GET /auth/spotify/callback with no auth returns non-401", async () => {
    const res = await doFetch("/auth/spotify/callback?state=S&code=fakecode");
    expect(res.status).not.toBe(401);
  });

  it("GET /auth/tidal/callback with no auth returns non-401", async () => {
    const res = await doFetch("/auth/tidal/callback?state=S&code=fakecode");
    expect(res.status).not.toBe(401);
  });
});

// ---- T-001-14: Query-parameter token rejected ----
describe("JWT middleware — query-param token rejected (T-001-14)", () => {
  it("returns 401 when token is passed as query param instead of Authorization header", async () => {
    const token = await mintToken();
    const res = await doFetch(`/sync/status?token=${token}`);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "missing_token" });
  });
});

// ---- 401 response headers ----
describe("JWT middleware — 401 includes WWW-Authenticate header", () => {
  it("includes WWW-Authenticate: Bearer realm header on 401", async () => {
    const res = await doFetch("/sync/status");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain('Bearer realm="spotify-roon-sync"');
  });
});

// ---- secretsGuard misconfiguration tests ----
describe("secretsGuard — misconfigured secrets return 503", () => {
  beforeEach(async () => {
    const { resetSecretsCache } = await import("../../src/middleware/secrets");
    resetSecretsCache();
  });

  afterEach(async () => {
    const { resetSecretsCache } = await import("../../src/middleware/secrets");
    resetSecretsCache();
  });

  it("returns 503 misconfigured when JWT_SECRET is too short", async () => {
    const res = await doFetch("/sync/status", {}, makeEnv({ JWT_SECRET: "tooshort" }));
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "misconfigured" });
  });

  it("returns 503 misconfigured when TOKEN_ENCRYPTION_KEY is wrong length", async () => {
    const shortKey = btoa("only24byteskeyvalue!!!!"); // 23 bytes after decode
    const res = await doFetch(
      "/sync/status",
      {},
      makeEnv({ TOKEN_ENCRYPTION_KEY: shortKey })
    );
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "misconfigured" });
  });

  it("returns 503 misconfigured when TOKEN_ENCRYPTION_KEY is not valid base64", async () => {
    const res = await doFetch(
      "/sync/status",
      {},
      makeEnv({ TOKEN_ENCRYPTION_KEY: "!!not-base64!!" })
    );
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "misconfigured" });
  });

  it("passes /healthz through even when secrets are misconfigured", async () => {
    const res = await doFetch("/healthz", {}, makeEnv({ JWT_SECRET: "tooshort" }));
    expect(res.status).toBe(200);
  });
});
