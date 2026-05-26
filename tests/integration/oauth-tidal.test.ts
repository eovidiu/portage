/**
 * F-Integ: Tidal OAuth → F-004b integration tests.
 * Real DB round-trip via a temporary Neon branch. Only outbound fetch to Tidal is mocked.
 * Tests verify: oauth_state written/consumed, provider_tokens row written and decryptable,
 * one-shot state consumption, and refresh token update.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
import { createTestBranch, deleteTestBranch, type BranchContext } from "./_helpers";
import type { Env } from "../../src/env";

// ---- test secrets (generated inline, never committed) ----
const JWT_SECRET = "integ-jwt-secret-32-bytes-long!!";
// 32 bytes after base64 decode — used as TOKEN_ENCRYPTION_KEY
const TOKEN_ENCRYPTION_KEY = "aW50ZWctdGVzdC1rZXktZm9yLTMyYnl0ZXNwYWQhISE="; // base64("integ-test-key-for-32bytespad!!!")

// Canary token values
const INTEG_AT = `INTEG-AT-CANARY-TIDAL-${crypto.randomUUID().slice(0, 8)}`;
const INTEG_RT = `INTEG-RT-CANARY-TIDAL-${crypto.randomUUID().slice(0, 8)}`;
const INTEG_AT2 = `INTEG-AT-CANARY-TIDAL-REFRESH-${crypto.randomUUID().slice(0, 8)}`;
const INTEG_RT2 = `INTEG-RT-CANARY-TIDAL-REFRESH-${crypto.randomUUID().slice(0, 8)}`;

let branch: BranchContext;
let testEnv: Env;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: branch.connectionString,
    JWT_SECRET,
    TOKEN_ENCRYPTION_KEY,
    SPOTIFY_CLIENT_ID: "integ-spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "integ-spotify-client-secret",
    SPOTIFY_REDIRECT_URI: "https://example.com/auth/spotify/callback",
    TIDAL_CLIENT_ID: "integ-tidal-client-id",
    TIDAL_CLIENT_SECRET: "integ-tidal-client-secret",
    TIDAL_REDIRECT_URI: "https://example.com/auth/tidal/callback",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
    ...overrides,
  };
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

// Intercept only Tidal API calls; pass all others (including Neon HTTP) through.
const realFetch = globalThis.fetch.bind(globalThis);

interface MockResponse { body: unknown; status?: number }

function withTidalMock(
  responses: MockResponse[],
  fn: () => Promise<void>
): Promise<void> {
  let callIndex = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = resolveUrl(input as RequestInfo);
    if (url.includes("auth.tidal.com") || url.includes("login.tidal.com") || url.includes("openapi.tidal.com")) {
      const resp = responses[Math.min(callIndex++, responses.length - 1)];
      return new Response(
        JSON.stringify(resp.body),
        { status: resp.status ?? 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return realFetch(input as RequestInfo, init);
  });
  return fn().finally(() => spy.mockRestore());
}

beforeAll(async () => {
  branch = await createTestBranch("tidal");
  testEnv = makeEnv();
}, 60_000);

afterAll(async () => {
  await deleteTestBranch(branch.branchId);
}, 30_000);

// ---- T-Integ-T-01: Initiate flow writes oauth_state row ----
describe("Tidal OAuth initiate → oauth_state written (T-Integ-T-01)", () => {
  it("initiateOAuth stores state + code_verifier in oauth_state table", async () => {
    const { initiateOAuth } = await import("../../src/providers/tidal/oauth");
    const authorizeUrl = await initiateOAuth(testEnv);

    expect(authorizeUrl).toMatch(/login\.tidal\.com\/authorize/);
    const params = new URL(authorizeUrl).searchParams;
    const state = params.get("state")!;
    expect(state).toBeTruthy();

    const sql = neon(branch.connectionString);
    const rows = await sql(
      "SELECT state, code_verifier FROM oauth_state WHERE state = $1",
      [state]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].code_verifier).toBeTruthy();
  });
});

// ---- T-Integ-T-02: Callback success → provider_tokens row written, decrypts to canary ----
describe("Tidal OAuth callback → provider_tokens persisted and decryptable (T-Integ-T-02)", () => {
  it("exchangeCode persists tokens; SELECT + decrypt returns canary access_token", async () => {
    const { initiateOAuth, exchangeCode } = await import("../../src/providers/tidal/oauth");
    const { decryptToken } = await import("../../src/crypto");

    const authorizeUrl = await initiateOAuth(testEnv);
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    await withTidalMock(
      [{ body: { access_token: INTEG_AT, refresh_token: INTEG_RT, expires_in: 3600, token_type: "Bearer" } }],
      async () => {
        await exchangeCode(testEnv, "integ-tidal-auth-code", state);
      }
    );

    const sql = neon(branch.connectionString);
    const rows = await sql(
      `SELECT access_token_ciphertext, access_token_iv,
              refresh_token_ciphertext, refresh_token_iv, status
       FROM provider_tokens WHERE provider = 'tidal'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("active");

    const atCt = new Uint8Array(rows[0].access_token_ciphertext as Buffer);
    const atIv = new Uint8Array(rows[0].access_token_iv as Buffer);
    const rtCt = new Uint8Array(rows[0].refresh_token_ciphertext as Buffer);
    const rtIv = new Uint8Array(rows[0].refresh_token_iv as Buffer);

    const plainAT = await decryptToken(atCt, atIv, TOKEN_ENCRYPTION_KEY);
    const plainRT = await decryptToken(rtCt, rtIv, TOKEN_ENCRYPTION_KEY);

    expect(plainAT).toBe(INTEG_AT);
    expect(plainRT).toBe(INTEG_RT);

    // Canary: ciphertext bytes must not contain the plaintext
    expect(Buffer.from(atCt).toString()).not.toContain(INTEG_AT);
    expect(Buffer.from(rtCt).toString()).not.toContain(INTEG_RT);

    // State row consumed (one-shot)
    const stateRows = await sql("SELECT state FROM oauth_state WHERE state = $1", [state]);
    expect(stateRows.length).toBe(0);
  });
});

// ---- T-Integ-T-03: State consumption is one-shot ----
describe("Tidal OAuth callback → state is one-shot (T-Integ-T-03)", () => {
  it("second callback with same state throws invalid_state", async () => {
    const { initiateOAuth, exchangeCode } = await import("../../src/providers/tidal/oauth");

    const authorizeUrl = await initiateOAuth(testEnv);
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    await withTidalMock(
      [{ body: { access_token: `INTEG-AT-ONESHOT-TIDAL-${crypto.randomUUID().slice(0, 8)}`, refresh_token: `INTEG-RT-ONESHOT-TIDAL-${crypto.randomUUID().slice(0, 8)}`, expires_in: 3600 } }],
      async () => {
        // First callback succeeds
        await exchangeCode(testEnv, "code-first", state);

        // Second callback with the same state must fail with invalid_state
        await expect(
          exchangeCode(testEnv, "code-second", state)
        ).rejects.toSatisfy(
          (e: unknown) => e instanceof Error && e.message === "invalid_state"
        );
      }
    );
  });
});

// ---- T-Integ-T-04: Refresh round-trip → provider_tokens updated with new ciphertext ----
describe("Tidal OAuth refresh → provider_tokens updated (T-Integ-T-04)", () => {
  it("refreshTokens updates provider_tokens; new ciphertext decrypts to refreshed canary", async () => {
    const { persistTokens, loadTokens } = await import("../../src/db/provider_tokens");
    const { refreshTokens } = await import("../../src/providers/tidal/oauth");
    const { decryptToken } = await import("../../src/crypto");

    // Seed with near-expiry tokens (30s from now)
    const nearExpiry = new Date(Date.now() + 30_000);
    await persistTokens(testEnv, "tidal", INTEG_AT, INTEG_RT, nearExpiry);

    await withTidalMock(
      [{ body: { access_token: INTEG_AT2, refresh_token: INTEG_RT2, expires_in: 3600 } }],
      async () => {
        await refreshTokens(testEnv);
      }
    );

    const tokens = await loadTokens(testEnv, "tidal");
    expect(tokens).not.toBeNull();
    expect(tokens!.accessToken).toBe(INTEG_AT2);
    expect(tokens!.refreshToken).toBe(INTEG_RT2);
    expect(tokens!.status).toBe("active");

    // Belt-and-braces: verify via direct DB + decrypt
    const sql = neon(branch.connectionString);
    const rows = await sql(
      "SELECT access_token_ciphertext, access_token_iv FROM provider_tokens WHERE provider = 'tidal'"
    );
    const at = await decryptToken(
      new Uint8Array(rows[0].access_token_ciphertext as Buffer),
      new Uint8Array(rows[0].access_token_iv as Buffer),
      TOKEN_ENCRYPTION_KEY
    );
    expect(at).toBe(INTEG_AT2);
  });
});
