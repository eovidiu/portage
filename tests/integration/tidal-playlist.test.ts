/**
 * F-Integ extension: Tidal playlist write → matches dedupe round-trip.
 * Real DB via a temporary Neon branch. Only Tidal API calls are mocked.
 *
 * Tests verify:
 *   - dedupe correctly skips already-present tracks
 *   - batch-appends new tracks
 *   - does NOT duplicate any existing playlist entry
 *   - watermark advances
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

// Existing Tidal IDs in the playlist (pre-seeded as already present)
const ALREADY_IN_PLAYLIST = ["TIDAL-EXISTING-001", "TIDAL-EXISTING-002"];
// New Tidal IDs that are matched but not yet in the playlist
const NEW_TIDAL_IDS = ["TIDAL-NEW-001", "TIDAL-NEW-002", "TIDAL-NEW-003"];

const PLAYLIST_ID = "integ-playlist-12345";

interface TidalMockConfig {
  existingTrackIds: string[];
  addedTrackIds: string[];
  playlistExists?: boolean;
}

function withTidalMock(config: TidalMockConfig, fn: () => Promise<void>): Promise<void> {
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = resolveUrl(input as RequestInfo);
    // When tidalFetch passes a Request object, method lives on the Request, not in init
    const inputMethod = input instanceof Request ? input.method : undefined;
    const method = (inputMethod ?? init?.method ?? "GET").toUpperCase();

    if (!url.includes("openapi.tidal.com") && !url.includes("auth.tidal.com") && !url.includes("login.tidal.com")) {
      return realFetch(input as RequestInfo, init);
    }

    // POST /v2/playlists — create playlist
    if (method === "POST" && url.includes("/v2/playlists") && !url.includes("/relationships/items")) {
      return new Response(
        JSON.stringify({ data: { id: PLAYLIST_ID, attributes: { title: "Spotify Liked" } } }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }

    // GET /v2/playlists/:id — fetch existing playlist
    if (method === "GET" && url.includes(`/v2/playlists/${PLAYLIST_ID}`) && !url.includes("/relationships/items")) {
      if (config.playlistExists === false) {
        return new Response(null, { status: 404 });
      }
      return new Response(
        JSON.stringify({ data: { id: PLAYLIST_ID, attributes: { title: "Spotify Liked" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // GET /v2/playlists/:id/relationships/items — get current playlist tracks
    if (method === "GET" && url.includes(`/v2/playlists/${PLAYLIST_ID}/relationships/items`)) {
      const items = config.existingTrackIds.map((id) => ({ id }));
      return new Response(
        JSON.stringify({ data: items, included: items, meta: {}, links: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // POST /v2/playlists/:id/relationships/items — add tracks
    if (method === "POST" && url.includes(`/v2/playlists/${PLAYLIST_ID}/relationships/items`)) {
      // Record which IDs were added by parsing the request body.
      // tidalFetch passes a Request object; body lives on the Request, not in init.
      let body: { data: Array<{ id: string }> } = { data: [] };
      try {
        const rawBody = input instanceof Request
          ? await (input as Request).text()
          : (init?.body as string | undefined);
        if (rawBody && typeof rawBody === "string") body = JSON.parse(rawBody) as typeof body;
      } catch { /* ignore */ }
      const batchIds = body.data.map((d) => d.id);
      config.addedTrackIds.push(...batchIds);
      return new Response(null, { status: 207 });
    }

    return new Response(JSON.stringify({ error: `Unhandled Tidal URL: ${url}` }), { status: 404 });
  });

  return fn().finally(() => spy.mockRestore());
}

async function seedTrackAndMatch(
  env: Env,
  spotifyId: string,
  tidalId: string,
  matchedAt: string,
): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  // Insert track first (matches FK references tracks)
  await sql(
    `INSERT INTO tracks (spotify_id, isrc, artist, title, spotify_added_at)
     VALUES ($1, NULL, 'Integ Artist', 'Integ Track', now())
     ON CONFLICT (spotify_id) DO NOTHING`,
    [spotifyId],
  );
  // Insert match row
  await sql(
    `INSERT INTO matches (spotify_id, tidal_id, method, confidence, matched_at)
     VALUES ($1, $2, 'isrc', 0.95, $3::timestamptz)
     ON CONFLICT (spotify_id) DO NOTHING`,
    [spotifyId, tidalId, matchedAt],
  );
}

async function seedTidalTokens(env: Env): Promise<void> {
  const { persistTokens } = await import("../../src/db/provider_tokens");
  const expiresAt = new Date(Date.now() + 3_600_000);
  await persistTokens(env, "tidal", "integ-at-tidal", "integ-rt-tidal", expiresAt);
}

beforeAll(async () => {
  branch = await createTestBranch("tidal-playlist");
  testEnv = makeEnv();
  await seedTidalTokens(testEnv);
}, 60_000);

afterAll(async () => {
  await deleteTestBranch(branch.branchId);
}, 30_000);

// ---- T-Integ-P-01: dedupe skips already-present tracks, appends new ones ----
describe("writePlaylist → dedupe and batch append (T-Integ-P-01)", () => {
  it("skips already-present tidal_ids and appends only new ones without duplication", async () => {
    // Seed matches: some tidal_ids are already in the playlist, some are new
    // matchedAt must be before the last_playlist_write_at watermark check (cold start = epoch)
    const baseTime = "2026-04-20T00:00:00Z";
    await seedTrackAndMatch(testEnv, "SP-EXISTING-001", ALREADY_IN_PLAYLIST[0], baseTime);
    await seedTrackAndMatch(testEnv, "SP-EXISTING-002", ALREADY_IN_PLAYLIST[1], baseTime);
    await seedTrackAndMatch(testEnv, "SP-NEW-001", NEW_TIDAL_IDS[0], baseTime);
    await seedTrackAndMatch(testEnv, "SP-NEW-002", NEW_TIDAL_IDS[1], baseTime);
    await seedTrackAndMatch(testEnv, "SP-NEW-003", NEW_TIDAL_IDS[2], baseTime);

    const config: TidalMockConfig = {
      existingTrackIds: [...ALREADY_IN_PLAYLIST],
      addedTrackIds: [],
      playlistExists: false, // triggers playlist create on first run
    };

    const { writePlaylist } = await import("../../src/sync/playlist-writer");

    let writeResult: Awaited<ReturnType<typeof writePlaylist>>;
    await withTidalMock(config, async () => {
      writeResult = await writePlaylist(testEnv);
    });

    // Verify dedupe: only new tracks should have been sent to Tidal
    const addedSet = new Set(config.addedTrackIds);
    for (const existingId of ALREADY_IN_PLAYLIST) {
      expect(addedSet.has(existingId), `${existingId} should NOT have been added (already in playlist)`).toBe(false);
    }
    for (const newId of NEW_TIDAL_IDS) {
      expect(addedSet.has(newId), `${newId} should have been added`).toBe(true);
    }

    // No duplicates: each new ID appears exactly once in the addedTrackIds list
    for (const newId of NEW_TIDAL_IDS) {
      const occurrences = config.addedTrackIds.filter((id) => id === newId).length;
      expect(occurrences).toBe(1);
    }

    // writePlaylist result
    expect(writeResult!.added).toBe(NEW_TIDAL_IDS.length);
    expect(writeResult!.skippedDuplicates).toBe(ALREADY_IN_PLAYLIST.length);
    expect(writeResult!.invalidIds).toHaveLength(0);
    expect(writeResult!.errors).toBe(0);
  });
});

// ---- T-Integ-P-02: watermark advances after successful write ----
describe("writePlaylist → watermark advanced in sync_state (T-Integ-P-02)", () => {
  it("last_playlist_write_at is set after a successful write run", async () => {
    const sql = neon(branch.connectionString);

    const beforeTs = Date.now();

    const config: TidalMockConfig = {
      existingTrackIds: [...ALREADY_IN_PLAYLIST, ...NEW_TIDAL_IDS], // all tracks already present
      addedTrackIds: [],
      playlistExists: true,
    };

    const { writePlaylist } = await import("../../src/sync/playlist-writer");
    await withTidalMock(config, async () => {
      await writePlaylist(testEnv);
    });

    const rows = await sql(
      "SELECT value FROM sync_state WHERE key = $1",
      ["last_playlist_write_at"],
    );
    expect(rows.length).toBe(1);
    const watermarkMs = new Date(rows[0].value as string).getTime();
    expect(watermarkMs).toBeGreaterThanOrEqual(beforeTs - 1000); // allow 1s clock skew
  });
});

// ---- T-Integ-P-03: second write run with no new matches makes zero Tidal API writes ----
describe("writePlaylist → no new matches = no playlist writes (T-Integ-P-03)", () => {
  it("second run after watermark advance skips all already-written matches", async () => {
    const config: TidalMockConfig = {
      existingTrackIds: [...ALREADY_IN_PLAYLIST, ...NEW_TIDAL_IDS],
      addedTrackIds: [],
      playlistExists: true,
    };

    const { writePlaylist } = await import("../../src/sync/playlist-writer");
    let result: Awaited<ReturnType<typeof writePlaylist>>;
    await withTidalMock(config, async () => {
      result = await writePlaylist(testEnv);
    });

    // No tracks should have been sent to Tidal
    expect(config.addedTrackIds).toHaveLength(0);
    expect(result!.added).toBe(0);
    expect(result!.skippedDuplicates).toBe(0);
  });
});
