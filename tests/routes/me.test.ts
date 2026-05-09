// T-020: GET /api/me route tests
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import type { Env } from "../../src/env";

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "spotify-client-secret",
    SPOTIFY_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/spotify/callback",
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    TIDAL_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/tidal/callback",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
  };
}

async function mintBearer(secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("spotify-roon-sync")
    .setSubject("owner")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

// ---- T-020-01: Authenticated browser user → 200 with email + kind:user ----
describe("GET /api/me — user principal (T-020-01)", () => {
  it("returns { email, kind:'user' } when CF Access middleware set a user principal", async () => {
    const { default: meRoute } = await import("../../src/routes/me");
    const app = new Hono<{ Bindings: Env }>();
    // Simulate cfAccessMiddleware having authenticated a browser user
    app.use("*", async (c, next) => {
      c.set("principal" as never, { kind: "user", email: "eovidiu@gmail.com" });
      await next();
    });
    app.route("/api", meRoute);

    const ctx = createExecutionContext();
    const req = new Request("https://worker.test/api/me");
    const res = await app.fetch(req, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ email: "eovidiu@gmail.com", kind: "user" });
  });
});

// ---- T-020-02: Service caller (Bearer JWT) → 200 with kind:service, no email ----
describe("GET /api/me — service principal (T-020-02)", () => {
  it("returns { kind:'service' } with no email field when authenticated via Bearer", async () => {
    const { default: meRoute } = await import("../../src/routes/me");
    const { jwtMiddleware } = await import("../../src/middleware/auth");
    const env = makeEnv();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", jwtMiddleware([]));
    app.route("/api", meRoute);

    const token = await mintBearer(env.JWT_SECRET);
    const ctx = createExecutionContext();
    const req = new Request("https://worker.test/api/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await app.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ kind: "service" });
    expect(body.email).toBeUndefined();
  });
});

// ---- T-020-03: Unauthenticated → 401 (middleware rejects before handler) ----
describe("GET /api/me — unauthenticated (T-020-03)", () => {
  it("returns 401 when neither CF Access nor Bearer present (jwtMiddleware rejects)", async () => {
    const { default: meRoute } = await import("../../src/routes/me");
    const { jwtMiddleware } = await import("../../src/middleware/auth");
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", jwtMiddleware([]));
    app.route("/api", meRoute);

    const ctx = createExecutionContext();
    const req = new Request("https://worker.test/api/me");
    const res = await app.fetch(req, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "missing_token" });
  });
});
