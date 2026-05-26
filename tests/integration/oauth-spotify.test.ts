/**
 * F-Integ: Spotify OAuth → F-004b integration tests.
 * Real DB round-trip via a temporary Neon branch. Only outbound fetch to Spotify is mocked.
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

// Canary token values — identifiable bytes that exercise encryption
const INTEG_AT = `INTEG-AT-CANARY-SPOTIFY-${crypto.randomUUID().slice(0, 8)}`;
const INTEG_RT = `INTEG-RT-CANARY-SPOTIFY-${crypto.randomUUID().slice(0, 8)}`;
const INTEG_AT2 = `INTEG-AT-CANARY-SPOTIFY-REFRESH-${crypto.randomUUID().slice(0, 8)}`;
const INTEG_RT2 = `INTEG-RT-CANARY-SPOTIFY-REFRESH-${crypto.randomUUID().slice(0, 8)}`;

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

// Resolve fetch URL from any RequestInfo type
function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

// Intercept only Spotify API calls; all others (including Neon HTTP) pass through.
// Using vi.spyOn on globalThis.fetch without this passthrough would corrupt Neon
// query responses since @neondatabase/serverless also uses global fetch.
const realFetch = globalThis.fetch.bind(globalThis);

interface MockResponse { body: unknown; status?: number }

function withSpotifyMock(
  responses: MockResponse[],
  fn: () => Promise<void>
): Promise<void> {
  let callIndex = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = resolveUrl(input as RequestInfo);
    if (url.includes("accounts.spotify.com") || url.includes("api.spotify.com")) {
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
  branch = await createTestBranch("spotify");
  testEnv = makeEnv();
}, 60_000);

afterAll(async () => {
  await deleteTestBranch(branch.branchId);
}, 30_000);

// ---- T-Integ-S-01: Initiate flow writes oauth_state row ----
describe("Spotify OAuth initiate → oauth_state written (T-Integ-S-01)", () => {
  it("initiateSpotifyOAuth stores state + code_verifier in oauth_state table", async () => {
    const { initiateSpotifyOAuth } = await import("../../src/providers/spotify/oauth");
    const result = await initiateSpotifyOAuth(testEnv);

    expect(result.state).toBeTruthy();
    expect(result.codeVerifier).toBeTruthy();
    expect(result.authorizeUrl).toMatch(/accounts\.spotify\.com\/authorize/);

    const sql = neon(branch.connectionString);
    const rows = await sql(
      "SELECT state, code_verifier FROM oauth_state WHERE state = $1",
      [result.state]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].code_verifier).toBe(result.codeVerifier);
  });
});

// ---- T-Integ-S-02: Callback success → provider_tokens row written, decrypts to canary ----
describe("Spotify OAuth callback → provider_tokens persisted and decryptable (T-Integ-S-02)", () => {
  it("handleCallback persists tokens; SELECT + decrypt returns canary access_token", async () => {
    const { initiateSpotifyOAuth, handleCallback } = await import("../../src/providers/spotify/oauth");
    const { decryptToken } = await import("../../src/crypto");

    const { state, codeVerifier } = await initiateSpotifyOAuth(testEnv);

    let capturedBody = "";
    await withSpotifyMock(
      [{ body: { access_token: INTEG_AT, refresh_token: INTEG_RT, expires_in: 3600, token_type: "Bearer" } }],
      async () => {
        // Wrap inner mock to capture the request body
        const currentImpl = vi.mocked(globalThis.fetch).getMockImplementation()!;
        vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
          const url = resolveUrl(input as RequestInfo);
          if (url.includes("accounts.spotify.com/api/token")) {
            capturedBody = (init?.body as string) ?? "";
          }
          return currentImpl(input as RequestInfo, init);
        });
        await handleCallback(testEnv, { code: "integ-auth-code", state });
      }
    );

    // Verify PKCE code_verifier was passed to Spotify
    const reqParams = new URLSearchParams(capturedBody);
    expect(reqParams.get("code_verifier")).toBe(codeVerifier);

    const sql = neon(branch.connectionString);
    const rows = await sql(
      `SELECT access_token_ciphertext, access_token_iv,
              refresh_token_ciphertext, refresh_token_iv, status
       FROM provider_tokens WHERE provider = 'spotify'`
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

// ---- T-Integ-S-03: State consumption is one-shot ----
describe("Spotify OAuth callback → state is one-shot (T-Integ-S-03)", () => {
  it("second callback with same state throws invalid_state", async () => {
    const { initiateSpotifyOAuth, handleCallback, SpotifyAuthError } = await import(
      "../../src/providers/spotify/oauth"
    );

    const { state } = await initiateSpotifyOAuth(testEnv);

    await withSpotifyMock(
      [{ body: { access_token: `INTEG-AT-ONESHOT-${crypto.randomUUID().slice(0, 8)}`, refresh_token: `INTEG-RT-ONESHOT-${crypto.randomUUID().slice(0, 8)}`, expires_in: 3600, token_type: "Bearer" } }],
      async () => {
        // First callback succeeds
        await handleCallback(testEnv, { code: "code-first", state });

        // Second callback with the same state must fail
        await expect(
          handleCallback(testEnv, { code: "code-second", state })
        ).rejects.toSatisfy(
          (e: unknown) => e instanceof SpotifyAuthError && e.code === "invalid_state"
        );
      }
    );
  });
});

// ---- T-Integ-S-04: Refresh round-trip → provider_tokens updated with new ciphertext ----
describe("Spotify OAuth refresh → provider_tokens updated (T-Integ-S-04)", () => {
  it("refreshSpotify updates provider_tokens; new ciphertext decrypts to refreshed canary", async () => {
    const { persistTokens, loadTokens } = await import("../../src/db/provider_tokens");
    const { refreshSpotify } = await import("../../src/providers/spotify/oauth");
    const { decryptToken } = await import("../../src/crypto");

    // Seed with near-expiry tokens (30s from now)
    const nearExpiry = new Date(Date.now() + 30_000);
    await persistTokens(testEnv, "spotify", INTEG_AT, INTEG_RT, nearExpiry);

    await withSpotifyMock(
      [{ body: { access_token: INTEG_AT2, refresh_token: INTEG_RT2, expires_in: 3600 } }],
      async () => {
        await refreshSpotify(testEnv);
      }
    );

    const tokens = await loadTokens(testEnv, "spotify");
    expect(tokens).not.toBeNull();
    expect(tokens!.accessToken).toBe(INTEG_AT2);
    expect(tokens!.refreshToken).toBe(INTEG_RT2);
    expect(tokens!.status).toBe("active");

    // Belt-and-braces: verify via direct DB + decrypt
    const sql = neon(branch.connectionString);
    const rows = await sql(
      "SELECT access_token_ciphertext, access_token_iv FROM provider_tokens WHERE provider = 'spotify'"
    );
    const at = await decryptToken(
      new Uint8Array(rows[0].access_token_ciphertext as Buffer),
      new Uint8Array(rows[0].access_token_iv as Buffer),
      TOKEN_ENCRYPTION_KEY
    );
    expect(at).toBe(INTEG_AT2);
  });
});
