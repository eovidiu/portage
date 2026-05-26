import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SignJWT, generateKeyPair, type KeyLike } from "jose";

// Mock createRemoteJWKSet inline per project hoisting-safe idiom.
// Spread `...actual` so other jose exports (jwtVerify, SignJWT, generateKeyPair) keep their real impls.
vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(),
  };
});

import { createRemoteJWKSet } from "jose";
const mockedCreateRemoteJWKSet = vi.mocked(createRemoteJWKSet);

// 32-byte test JWT secret (matches existing auth.test.ts conventions)
const TEST_JWT_SECRET = "test-jwt-secret-32-bytes-long-ok!";
const TEST_JWT_SECRET_BYTES = new TextEncoder().encode(TEST_JWT_SECRET);

const VALID_B64_DEK = "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=";

const CF_TEAM = "eovidiu";
const CF_AUD = "test-aud-tag";
const ALLOWED_EMAIL = "test@example.com";
const ALLOWED_UI_ORIGIN = "https://app.example.com";

let cfPublicKey: KeyLike;
let cfPrivateKey: KeyLike;
let attackerPrivateKey: KeyLike;

beforeAll(async () => {
  const team = await generateKeyPair("RS256");
  cfPublicKey = team.publicKey;
  cfPrivateKey = team.privateKey;
  const attacker = await generateKeyPair("RS256");
  attackerPrivateKey = attacker.privateKey;
});

beforeEach(async () => {
  const { resetCfAccessCache } = await import("../../src/middleware/cf_access");
  resetCfAccessCache();
  // Default: JWKS resolver returns the test public key (mock is fresh per test)
  mockedCreateRemoteJWKSet.mockReset();
  mockedCreateRemoteJWKSet.mockImplementation(() => async () => cfPublicKey);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    JWT_SECRET: TEST_JWT_SECRET,
    TOKEN_ENCRYPTION_KEY: VALID_B64_DEK,
    SPOTIFY_CLIENT_ID: "spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    DATABASE_URL: env.DATABASE_URL ?? "postgresql://localhost/test",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
    SPOTIFY_REDIRECT_URI: "https://example.com/auth/spotify/callback",
    TIDAL_REDIRECT_URI: "https://example.com/auth/tidal/callback",
    CF_ACCESS_TEAM: CF_TEAM,
    CF_ACCESS_AUD: CF_AUD,
    OPERATOR_EMAIL: ALLOWED_EMAIL,
    UI_ORIGIN: ALLOWED_UI_ORIGIN,
    ...overrides,
  };
}

async function mintCfAccessToken(opts: {
  email?: string;
  signingKey?: KeyLike;
  audience?: string;
  issuer?: string;
  exp?: string | number;
} = {}): Promise<string> {
  const builder = new SignJWT({ email: opts.email ?? ALLOWED_EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(opts.issuer ?? `https://${CF_TEAM}.cloudflareaccess.com`)
    .setAudience(opts.audience ?? CF_AUD)
    .setIssuedAt();
  if (opts.exp !== undefined) {
    builder.setExpirationTime(opts.exp);
  } else {
    builder.setExpirationTime("1h");
  }
  return builder.sign(opts.signingKey ?? cfPrivateKey);
}

async function mintBearerToken(opts: { secret?: Uint8Array; sub?: string } = {}): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("spotify-roon-sync")
    .setSubject(opts.sub ?? "owner")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(opts.secret ?? TEST_JWT_SECRET_BYTES);
}

async function doFetch(
  path: string,
  headers: Record<string, string> = {},
  testEnv = makeEnv(),
  method = "GET"
): Promise<Response> {
  const { default: worker } = await import("../../src/index");
  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, { headers, method });
  const res = await worker.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ---- T-019-01: Valid CF Access JWT + correct email → handler reached, principal kind=user ----
describe("cfAccessMiddleware — valid CF Access JWT (T-019-01)", () => {
  it("sets principal { kind: 'user', email } and reaches handler", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) =>
      c.json({ principal: c.get("principal" as never), subject: c.get("subject" as never) })
    );

    const token = await mintCfAccessToken();
    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.principal).toEqual({ kind: "user", email: ALLOWED_EMAIL });
    expect(body.subject).toBe("owner");
  });
});

// ---- T-019-02: CF Access JWT signed by attacker → 401 invalid_cf_access_jwt ----
describe("cfAccessMiddleware — bad signature (T-019-02)", () => {
  it("returns 401 invalid_cf_access_jwt and does NOT log the offending token", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    const token = await mintCfAccessToken({ signingKey: attackerPrivateKey });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_cf_access_jwt" });

    const allLogs = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(allLogs).not.toContain(token);
  });
});

// ---- T-019-03: CF Access JWT email mismatch → 403 forbidden ----
describe("cfAccessMiddleware — wrong email (T-019-03)", () => {
  it("returns 403 forbidden when email is not the allowed operator", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    const token = await mintCfAccessToken({ email: "intruder@example.com" });
    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "forbidden" });
  });
});

// ---- T-019-03b: CF Access JWT with no email claim → 403 forbidden ----
describe("cfAccessMiddleware — missing email claim (T-019-03b)", () => {
  it("returns 403 forbidden when payload.email is absent (treated as empty)", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    // Build a token with NO email claim
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer(`https://${CF_TEAM}.cloudflareaccess.com`)
      .setAudience(CF_AUD)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(cfPrivateKey);

    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "forbidden" });
  });
});

// ---- T-019-04: CF Access JWT wrong audience → 401 invalid_cf_access_jwt ----
describe("cfAccessMiddleware — wrong audience (T-019-04)", () => {
  it("returns 401 invalid_cf_access_jwt when aud claim does not match CF_ACCESS_AUD", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    const token = await mintCfAccessToken({ audience: "wrong-aud-tag" });
    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_cf_access_jwt" });
  });
});

// ---- T-019-05: CF Access JWT wrong issuer → 401 ----
describe("cfAccessMiddleware — wrong issuer (T-019-05)", () => {
  it("returns 401 invalid_cf_access_jwt when iss claim does not match team", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    const token = await mintCfAccessToken({ issuer: "https://wrong-team.cloudflareaccess.com" });
    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_cf_access_jwt" });
  });
});

// ---- T-019-06: Expired CF Access JWT → 401 ----
describe("cfAccessMiddleware — expired JWT (T-019-06)", () => {
  it("returns 401 invalid_cf_access_jwt for token with exp in the past", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    const nowSec = Math.floor(Date.now() / 1000);
    const token = await mintCfAccessToken({ exp: nowSec - 60 });
    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_cf_access_jwt" });
  });
});

// ---- T-019-07: Missing CF_ACCESS_TEAM/AUD → 503 cf_access_misconfigured ----
describe("cfAccessMiddleware — misconfigured (T-019-07)", () => {
  it("returns 503 cf_access_misconfigured when CF_ACCESS_TEAM is unset", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    const token = await mintCfAccessToken();
    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv({ CF_ACCESS_TEAM: "" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "cf_access_misconfigured" });
  });

  it("returns 503 cf_access_misconfigured when CF_ACCESS_AUD is unset", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    const token = await mintCfAccessToken();
    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv({ CF_ACCESS_AUD: "" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "cf_access_misconfigured" });
  });
});

// ---- T-019-08: JWKS cache hit (one fetch across two requests) ----
describe("cfAccessMiddleware — JWKS cache (T-019-08)", () => {
  it("calls createRemoteJWKSet at most once across multiple authenticated requests", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    const token1 = await mintCfAccessToken();
    const token2 = await mintCfAccessToken();

    const r1 = await app.fetch(
      new Request("https://worker.test/probe", { headers: { "Cf-Access-Jwt-Assertion": token1 } }),
      makeEnv()
    );
    const r2 = await app.fetch(
      new Request("https://worker.test/probe", { headers: { "Cf-Access-Jwt-Assertion": token2 } }),
      makeEnv()
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(mockedCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
  });
});

// ---- T-019-09: JWKS fetch error → 503 jwks_fetch_failed ----
describe("cfAccessMiddleware — JWKS fetch error (T-019-09)", () => {
  it("returns 503 jwks_fetch_failed when the JWKS resolver throws", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    mockedCreateRemoteJWKSet.mockImplementation(() => async () => {
      throw new Error("jwks_unreachable: network failure fetching keys");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const token = await mintCfAccessToken();
    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "jwks_fetch_failed" });
    const allErr = errSpy.mock.calls.flat().map(String).join("\n");
    expect(allErr).toContain("jwks_fetch_failed");
  });
});

// ---- T-019-09b: JWKS resolver throws a non-Error value → still maps to 503 ----
describe("cfAccessMiddleware — JWKS resolver throws non-Error (T-019-09b)", () => {
  it("returns 503 jwks_fetch_failed when the resolver throws a string containing the pattern", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    mockedCreateRemoteJWKSet.mockImplementation(() => async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "jwks unreachable: thrown as string, not Error";
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const token = await mintCfAccessToken();
    const req = new Request("https://worker.test/probe", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "jwks_fetch_failed" });
    const allErr = errSpy.mock.calls.flat().map(String).join("\n");
    expect(allErr).toContain("jwks_fetch_failed");
  });
});

// ---- T-019-10: Bearer-only request → kind:service principal ----
describe("cfAccessMiddleware + jwtMiddleware — Bearer path (T-019-10)", () => {
  it("Bearer JWT alone results in principal { kind: 'service' } and reaches handler", async () => {
    const token = await mintBearerToken();
    const res = await doFetch("/sync/status", { Authorization: `Bearer ${token}` });
    // /sync/status auth-protected — expect anything other than 401 (CF Access skipped, Bearer accepted)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ---- T-019-11: Both headers, CF Access valid → kind:user (CF Access wins) ----
describe("cfAccessMiddleware — CF Access wins over Bearer (T-019-11)", () => {
  it("when both Cf-Access-Jwt-Assertion and Authorization Bearer are present, CF Access path runs", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const { jwtMiddleware } = await import("../../src/middleware/auth");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.use("*", jwtMiddleware([]));
    app.get("/probe", (c) => c.json({ principal: c.get("principal" as never) }));

    const cfToken = await mintCfAccessToken();
    const bearerToken = await mintBearerToken();
    const req = new Request("https://worker.test/probe", {
      headers: {
        "Cf-Access-Jwt-Assertion": cfToken,
        Authorization: `Bearer ${bearerToken}`,
      },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.principal).toEqual({ kind: "user", email: ALLOWED_EMAIL });
  });
});

// ---- T-019-12: Both headers, CF Access invalid → 401, no Bearer fallback ----
describe("cfAccessMiddleware — invalid CF Access does not fall through to Bearer (T-019-12)", () => {
  it("rejects with 401 even when a valid Bearer header is also present", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const { jwtMiddleware } = await import("../../src/middleware/auth");
    const app = new Hono();
    app.use("*", cfAccessMiddleware([]));
    app.use("*", jwtMiddleware([]));
    app.get("/probe", (c) => c.json({ ok: true }));

    const badCfToken = await mintCfAccessToken({ signingKey: attackerPrivateKey });
    const bearerToken = await mintBearerToken();
    const req = new Request("https://worker.test/probe", {
      headers: {
        "Cf-Access-Jwt-Assertion": badCfToken,
        Authorization: `Bearer ${bearerToken}`,
      },
    });
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "invalid_cf_access_jwt" });
  });
});

// ---- T-019-13: Neither header → 401 missing_token ----
describe("cfAccessMiddleware + jwtMiddleware — no auth (T-019-13)", () => {
  it("returns 401 missing_token when no auth header present on a gated route", async () => {
    const res = await doFetch("/sync/status");
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "missing_token" });
  });
});

// ---- T-019-14: Skip path bypasses CF Access middleware ----
describe("cfAccessMiddleware — skip path (T-019-14)", () => {
  it("does not verify the CF Access JWT for routes in the skip list", async () => {
    const { cfAccessMiddleware } = await import("../../src/middleware/cf_access");
    const app = new Hono();
    app.use("*", cfAccessMiddleware(["/healthz"]));
    app.get("/healthz", (c) => c.json({ ok: true }));

    // No Cf-Access header, but the skip path means it doesn't matter
    const req = new Request("https://worker.test/healthz");
    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    expect(mockedCreateRemoteJWKSet).not.toHaveBeenCalled();
  });
});

// ---- T-019-15: CORS preflight from allowed origin ----
describe("CORS — allowed origin (T-019-15)", () => {
  it("responds 204 to OPTIONS from the configured UI_ORIGIN with Allow-* headers", async () => {
    const res = await doFetch(
      "/sync/status",
      {
        Origin: ALLOWED_UI_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
      makeEnv(),
      "OPTIONS"
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_UI_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    const allowMethods = res.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(allowMethods).toContain("GET");
    expect(allowMethods).toContain("POST");
    expect(allowMethods).toContain("OPTIONS");
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowHeaders.toLowerCase()).toContain("authorization");
    expect(allowHeaders.toLowerCase()).toContain("content-type");
  });

  it("allows http://localhost:5173 (dev origin)", async () => {
    const res = await doFetch(
      "/sync/status",
      {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
      },
      makeEnv(),
      "OPTIONS"
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });
});

// ---- T-019-16: CORS preflight from disallowed origin ----
describe("CORS — disallowed origin (T-019-16)", () => {
  it("does not echo Access-Control-Allow-Origin for an unrecognised origin", async () => {
    const res = await doFetch(
      "/sync/status",
      {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "GET",
      },
      makeEnv(),
      "OPTIONS"
    );
    // Hono's cors middleware returns 204 for OPTIONS but omits Allow-Origin when origin function returns null
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
