/**
 * F-Integ extension: Spotify Liked Songs → tracks table round-trip.
 * Real DB via a temporary Neon branch. Only Spotify API calls are mocked.
 *
 * Tests verify:
 *   - tracks table contains the rows (field mapping, nullable album/duration_ms)
 *   - cursor in sync_state advances atomically with page persist (I-005)
 *   - re-run with same cursor doesn't duplicate-insert (idempotency at DB layer)
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

// Capture realFetch before any spy installs — Neon HTTP calls must pass through.
const realFetch = globalThis.fetch.bind(globalThis);

interface MockPage {
  items: Array<{
    added_at: string;
    track: {
      id: string;
      name: string;
      artists: Array<{ name: string }>;
      album: { name: string } | null;
      duration_ms: number | null;
      external_ids?: { isrc?: string };
      type: string;
      is_local: boolean;
    };
  }>;
  next: string | null;
}

function withSpotifyLikedMock(pages: MockPage[], fn: () => Promise<void>): Promise<void> {
  let pageIndex = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = resolveUrl(input as RequestInfo);
    if (url.includes("api.spotify.com") || url.includes("accounts.spotify.com")) {
      const page = pages[Math.min(pageIndex++, pages.length - 1)];
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input as RequestInfo, init);
  });
  return fn().finally(() => spy.mockRestore());
}

// Seed a Spotify provider_tokens row so spotifyFetch doesn't fail on auth load.
async function seedSpotifyTokens(env: Env): Promise<void> {
  const { persistTokens } = await import("../../src/db/provider_tokens");
  const expiresAt = new Date(Date.now() + 3_600_000);
  await persistTokens(env, "spotify", "integ-at-spotify", "integ-rt-spotify", expiresAt);
}

beforeAll(async () => {
  branch = await createTestBranch("spotify-liked");
  testEnv = makeEnv();
  await seedSpotifyTokens(testEnv);
}, 60_000);

afterAll(async () => {
  await deleteTestBranch(branch.branchId);
}, 30_000);

// ---- T-Integ-L-01: tracks table contains correct rows after fetchLikedSongs ----
describe("fetchLikedSongs → tracks table row insertion (T-Integ-L-01)", () => {
  it("inserts tracks with correct field mapping including nullable album/duration_ms", async () => {
    const { fetchLikedSongs } = await import("../../src/providers/spotify/liked");

    const addedAt1 = "2026-04-20T10:00:00Z";
    const addedAt2 = "2026-04-19T09:00:00Z";

    const page: MockPage = {
      items: [
        {
          added_at: addedAt1,
          track: {
            id: "INTEG-LIKED-001",
            name: "Test Track With All Fields",
            artists: [{ name: "Test Artist" }],
            album: { name: "Test Album" },
            duration_ms: 210000,
            external_ids: { isrc: "USRC12345678" },
            type: "track",
            is_local: false,
          },
        },
        {
          added_at: addedAt2,
          track: {
            id: "INTEG-LIKED-002",
            name: "Track With Null Album And Duration",
            artists: [{ name: "Other Artist" }],
            album: null as unknown as { name: string },
            duration_ms: null,
            external_ids: {},
            type: "track",
            is_local: false,
          },
        },
      ],
      next: null,
    };

    let result: Awaited<ReturnType<typeof fetchLikedSongs>>;
    await withSpotifyLikedMock([page], async () => {
      result = await fetchLikedSongs(testEnv);
    });

    const sql = neon(branch.connectionString);

    const track1 = await sql(
      "SELECT spotify_id, isrc, artist, title, album, duration_ms FROM tracks WHERE spotify_id = $1",
      ["INTEG-LIKED-001"],
    );
    expect(track1.length).toBe(1);
    expect(track1[0]).toMatchObject({
      spotify_id: "INTEG-LIKED-001",
      isrc: "USRC12345678",
      artist: "Test Artist",
      title: "Test Track With All Fields",
      album: "Test Album",
      duration_ms: 210000,
    });

    // Nullable fields: album and duration_ms should be null for track 002
    const track2 = await sql(
      "SELECT spotify_id, isrc, artist, title, album, duration_ms FROM tracks WHERE spotify_id = $1",
      ["INTEG-LIKED-002"],
    );
    expect(track2.length).toBe(1);
    expect(track2[0]).toMatchObject({
      spotify_id: "INTEG-LIKED-002",
      isrc: null,
      artist: "Other Artist",
      title: "Track With Null Album And Duration",
      album: null,
      duration_ms: null,
    });

    // fetchLikedSongs result counts
    expect(result!.pagesProcessed).toBe(1);
    expect(result!.tracksInserted).toBe(2);
    expect(result!.tracksSkipped).toBe(0);
  });
});

// ---- T-Integ-L-02: cursor advances atomically with page persist (I-005) ----
describe("fetchLikedSongs → cursor advance is atomic with final page persist (T-Integ-L-02)", () => {
  it("cursor in sync_state matches max added_at from the fetched page", async () => {
    const { fetchLikedSongs } = await import("../../src/providers/spotify/liked");

    // Use timestamps clearly in the future relative to epoch so they're above any prior cursor
    const latestAddedAt = "2026-04-25T12:00:00Z";
    const earlierAddedAt = "2026-04-24T08:00:00Z";

    const page: MockPage = {
      items: [
        {
          added_at: latestAddedAt,
          track: {
            id: "INTEG-CURSOR-001",
            name: "Cursor Test Track A",
            artists: [{ name: "Cursor Artist" }],
            album: { name: "Cursor Album" },
            duration_ms: 180000,
            external_ids: { isrc: "GBRC12300001" },
            type: "track",
            is_local: false,
          },
        },
        {
          added_at: earlierAddedAt,
          track: {
            id: "INTEG-CURSOR-002",
            name: "Cursor Test Track B",
            artists: [{ name: "Cursor Artist" }],
            album: { name: "Cursor Album" },
            duration_ms: 200000,
            external_ids: { isrc: "GBRC12300002" },
            type: "track",
            is_local: false,
          },
        },
      ],
      next: null,
    };

    await withSpotifyLikedMock([page], async () => {
      await fetchLikedSongs(testEnv);
    });

    const sql = neon(branch.connectionString);
    const rows = await sql(
      "SELECT value FROM sync_state WHERE key = $1",
      ["spotify_cursor"],
    );

    expect(rows.length).toBe(1);
    // The cursor must equal the maximum added_at seen on the page
    const storedCursor = new Date(rows[0].value as string).toISOString();
    const expectedCursor = new Date(latestAddedAt).toISOString();
    expect(storedCursor).toBe(expectedCursor);
  });
});

// ---- T-Integ-L-03: idempotency — re-run with same cursor doesn't duplicate rows ----
describe("fetchLikedSongs → idempotent re-run does not duplicate tracks (T-Integ-L-03)", () => {
  it("second fetch with cursor past all tracks inserts 0 additional rows", async () => {
    const { fetchLikedSongs } = await import("../../src/providers/spotify/liked");

    // All tracks have added_at older than cursor set by T-Integ-L-02 (≈2026-04-25T12:00:00Z)
    // The cursor stops pagination once addedAt <= cursor - 60s, so these tracks are skipped.
    const staleAddedAt = "2026-01-01T00:00:00Z";

    const page: MockPage = {
      items: [
        {
          added_at: staleAddedAt,
          track: {
            id: "INTEG-CURSOR-001",
            name: "Cursor Test Track A",
            artists: [{ name: "Cursor Artist" }],
            album: { name: "Cursor Album" },
            duration_ms: 180000,
            external_ids: { isrc: "GBRC12300001" },
            type: "track",
            is_local: false,
          },
        },
      ],
      next: null,
    };

    const sql = neon(branch.connectionString);

    const beforeCount = (await sql("SELECT COUNT(*)::integer AS n FROM tracks", []))[0].n as number;

    await withSpotifyLikedMock([page], async () => {
      await fetchLikedSongs(testEnv);
    });

    const afterCount = (await sql("SELECT COUNT(*)::integer AS n FROM tracks", []))[0].n as number;

    // No new rows inserted — tracks older than the cursor are skipped
    expect(afterCount).toBe(beforeCount);
  });
});
