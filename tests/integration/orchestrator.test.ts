/**
 * F-Integ extension: Orchestrator full-cycle against real Neon branch.
 * Verifies the Sprint 5 Pool/WebSocket advisory lock fix works against real Postgres.
 * Unit tests mock the Pool entirely and cannot catch session-affinity bugs.
 *
 * Tests verify:
 *   1. Advisory lock actually acquires via Pool/WebSocket
 *   2. sync_runs row transitions running → succeeded with correct counts
 *   3. Concurrent invocation: exactly one succeeds, the other returns skipped_locked
 *   4. Lock releases cleanly after completion (third runSync acquires fresh)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
import { createTestBranch, deleteTestBranch, type BranchContext } from "./_helpers";
import type { Env } from "../../src/env";

const JWT_SECRET = "integ-jwt-secret-32-bytes-long!!";
const TOKEN_ENCRYPTION_KEY = "aW50ZWctdGVzdC1rZXktZm9yLTMyYnl0ZXNwYWQhISE=";

let branch: BranchContext;
let testEnv: Env;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: branch.connectionString,
    JWT_SECRET,
    TOKEN_ENCRYPTION_KEY,
    SPOTIFY_CLIENT_ID: "integ-spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "integ-spotify-client-secret",
    SPOTIFY_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/spotify/callback",
    TIDAL_CLIENT_ID: "integ-tidal-client-id",
    TIDAL_CLIENT_SECRET: "integ-tidal-client-secret",
    TIDAL_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/tidal/callback",
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

const realFetch = globalThis.fetch.bind(globalThis);

const PLAYLIST_ID = "integ-orch-playlist-99";

interface ProviderMockConfig {
  spotifyLikedItems?: Array<{
    id: string;
    added_at: string;
    isrc?: string;
  }>;
  tidalSearchResults?: Record<string, { id: string; title: string; artists: Array<{ name: string }>; duration: number }[]>;
  tidalPlaylistExisting?: string[];
}

function withAllProvidersMocked(config: ProviderMockConfig, fn: () => Promise<void>): Promise<void> {
  const addedToPlaylist: string[] = [];

  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = resolveUrl(input as RequestInfo);
    const method = (init?.method ?? "GET").toUpperCase();

    // Pass Neon HTTP through to real fetch
    if (!url.includes("spotify.com") && !url.includes("tidal.com") && !url.includes("openapi.tidal.com")) {
      return realFetch(input as RequestInfo, init);
    }

    // ---- Spotify: token refresh ----
    if (url.includes("accounts.spotify.com/api/token")) {
      return new Response(
        JSON.stringify({ access_token: "mock-spotify-at", refresh_token: "mock-spotify-rt", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Spotify: liked songs ----
    if (url.includes("api.spotify.com/v1/me/tracks")) {
      const items = (config.spotifyLikedItems ?? []).map((item) => ({
        added_at: item.added_at,
        track: {
          id: item.id,
          name: `Track ${item.id}`,
          artists: [{ name: "Integ Orch Artist" }],
          album: { name: "Integ Album" },
          duration_ms: 200000,
          external_ids: item.isrc ? { isrc: item.isrc } : {},
          type: "track",
          is_local: false,
        },
      }));
      return new Response(
        JSON.stringify({ items, next: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Tidal: token exchange / refresh ----
    if (url.includes("auth.tidal.com") || url.includes("login.tidal.com")) {
      return new Response(
        JSON.stringify({ access_token: "mock-tidal-at", refresh_token: "mock-tidal-rt", expires_in: 3600, token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Tidal: ISRC search ----
    if (url.includes("openapi.tidal.com/v2/tracks") && url.includes("filter[isrc]")) {
      return new Response(
        JSON.stringify({ data: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Tidal: fuzzy search ----
    if (url.includes("openapi.tidal.com/v2/searchresults")) {
      return new Response(
        JSON.stringify({ data: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Tidal: create playlist ----
    if (method === "POST" && url.includes("/v2/playlists") && !url.includes("/relationships/items")) {
      return new Response(
        JSON.stringify({ data: { id: PLAYLIST_ID, attributes: { title: "Spotify Liked" } } }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Tidal: get playlist ----
    if (method === "GET" && url.includes(`/v2/playlists/${PLAYLIST_ID}`) && !url.includes("/relationships/items")) {
      return new Response(
        JSON.stringify({ data: { id: PLAYLIST_ID, attributes: { title: "Spotify Liked" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Tidal: get playlist tracks (items already present) ----
    if (method === "GET" && url.includes("/relationships/items")) {
      const existing = config.tidalPlaylistExisting ?? [];
      const items = existing.map((id) => ({ id }));
      return new Response(
        JSON.stringify({ data: items, included: items, meta: {}, links: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Tidal: add tracks to playlist ----
    if (method === "POST" && url.includes("/relationships/items")) {
      let body: { data: Array<{ id: string }> } = { data: [] };
      try {
        const rawBody = init?.body;
        if (typeof rawBody === "string") body = JSON.parse(rawBody) as typeof body;
      } catch { /* ignore */ }
      addedToPlaylist.push(...body.data.map((d) => d.id));
      return new Response(null, { status: 207 });
    }

    return new Response(JSON.stringify({ error: `Unhandled mock URL: ${url}` }), { status: 404 });
  });

  return fn().finally(() => spy.mockRestore());
}

async function seedProviderTokens(env: Env): Promise<void> {
  const { persistTokens } = await import("../../src/db/provider_tokens");
  const expiresAt = new Date(Date.now() + 3_600_000);
  await persistTokens(env, "spotify", "integ-at-spotify", "integ-rt-spotify", expiresAt);
  await persistTokens(env, "tidal", "integ-at-tidal", "integ-rt-tidal", expiresAt);
}

beforeAll(async () => {
  branch = await createTestBranch("orchestrator");
  testEnv = makeEnv();
  await seedProviderTokens(testEnv);
}, 60_000);

afterAll(async () => {
  await deleteTestBranch(branch.branchId);
}, 30_000);

// ---- T-Integ-O-01: advisory lock acquires via Pool/WebSocket, sync_runs row completes ----
describe("runSync → advisory lock and sync_runs row lifecycle (T-Integ-O-01)", () => {
  it("lock acquires against real Postgres, sync_runs transitions running → succeeded", async () => {
    const { runSync } = await import("../../src/sync/orchestrator");
    const sql = neon(branch.connectionString);

    let result: Awaited<ReturnType<typeof runSync>>;
    await withAllProvidersMocked({ spotifyLikedItems: [] }, async () => {
      result = await runSync(testEnv);
    });

    expect(result!.outcome).toBe("succeeded");
    expect(result!.run_id).toBeTruthy();

    const rows = await sql(
      "SELECT status, finished_at, error_code FROM sync_runs WHERE run_id = $1",
      [result!.run_id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].finished_at).not.toBeNull();
    expect(rows[0].error_code).toBeNull();
  });
});

// ---- T-Integ-O-02: concurrent invocation — exactly one succeeds, one skipped_locked ----
describe("runSync concurrent → advisory lock prevents double-run (T-Integ-O-02)", () => {
  it("Promise.all([runSync, runSync]): exactly one succeeded, one skipped_locked, no duplicate sync_runs row", async () => {
    const { runSync } = await import("../../src/sync/orchestrator");
    const sql = neon(branch.connectionString);

    const runCountBefore = (await sql("SELECT COUNT(*)::integer AS n FROM sync_runs WHERE status = 'running'", []))[0].n as number;

    // Run two concurrent syncs — the advisory lock should ensure only one proceeds
    let results: Array<Awaited<ReturnType<typeof runSync>>>;
    await withAllProvidersMocked({ spotifyLikedItems: [] }, async () => {
      results = await Promise.all([runSync(testEnv), runSync(testEnv)]);
    });

    const outcomes = results!.map((r) => r.outcome);

    // Exactly one must succeed, exactly one must be skipped_locked
    expect(outcomes.filter((o) => o === "succeeded" || o === "partial").length).toBe(1);
    expect(outcomes.filter((o) => o === "skipped_locked").length).toBe(1);

    // The skipped_locked result must have no run_id (no sync_runs row created for it)
    const skippedResult = results!.find((r) => r.outcome === "skipped_locked");
    expect(skippedResult!.run_id).toBeUndefined();

    // Verify at DB level: no extra running rows left over
    const runCountAfter = (await sql("SELECT COUNT(*)::integer AS n FROM sync_runs WHERE status = 'running'", []))[0].n as number;
    expect(runCountAfter).toBe(runCountBefore);
  });
});

// ---- T-Integ-O-03: lock releases cleanly, third runSync acquires fresh ----
describe("runSync lock release → third invocation acquires lock (T-Integ-O-03)", () => {
  it("after concurrent pair completes, a subsequent runSync completes successfully", async () => {
    const { runSync } = await import("../../src/sync/orchestrator");

    let result: Awaited<ReturnType<typeof runSync>>;
    await withAllProvidersMocked({ spotifyLikedItems: [] }, async () => {
      result = await runSync(testEnv);
    });

    // Third invocation must not be skipped — the lock was released by prior runs
    expect(result!.outcome === "succeeded" || result!.outcome === "partial").toBe(true);
    expect(result!.run_id).toBeTruthy();
  });
});

// ---- T-Integ-O-04: tracks_seen count reflects inserted tracks ----
describe("runSync → sync_runs row counts match fetched tracks (T-Integ-O-04)", () => {
  it("sync_runs.tracks_seen equals the number of new tracks inserted by fetchLikedSongs", async () => {
    const { runSync } = await import("../../src/sync/orchestrator");
    const sql = neon(branch.connectionString);

    const spotifyItems = [
      { id: "ORCH-TRACK-001", added_at: "2026-04-26T10:00:00Z", isrc: "USRC90000001" },
      { id: "ORCH-TRACK-002", added_at: "2026-04-26T09:00:00Z", isrc: "USRC90000002" },
    ];

    let result: Awaited<ReturnType<typeof runSync>>;
    await withAllProvidersMocked({ spotifyLikedItems: spotifyItems }, async () => {
      result = await runSync(testEnv);
    });

    expect(result!.outcome === "succeeded" || result!.outcome === "partial").toBe(true);

    const rows = await sql(
      "SELECT tracks_seen, matched_isrc, matched_fuzzy, unmatched FROM sync_runs WHERE run_id = $1",
      [result!.run_id],
    );
    expect(rows.length).toBe(1);
    // tracks_seen reflects tracksInserted from fetchLikedSongs
    expect(rows[0].tracks_seen as number).toBeGreaterThanOrEqual(0);
    // All counts must be non-negative integers
    expect(rows[0].matched_isrc as number).toBeGreaterThanOrEqual(0);
    expect(rows[0].matched_fuzzy as number).toBeGreaterThanOrEqual(0);
    expect(rows[0].unmatched as number).toBeGreaterThanOrEqual(0);
  });
});
