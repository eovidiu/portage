// F-029 sync-notifications — runSync wiring tests. All orchestrator
// dependencies are mocked (same surface as orchestrator.test.ts), but the
// notify module is REAL with a stubbed global fetch, so these tests prove the
// actual notification wiring rather than mock-call bookkeeping.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";

const mockSql = vi.fn();
const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};
const mockPool = {
  connect: vi.fn(),
  end: vi.fn(),
};
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
  Pool: vi.fn().mockImplementation(() => mockPool),
}));

vi.mock("../../src/db/sync_runs", () => ({
  insertRun: vi.fn(),
  updateRun: vi.fn(),
  markAbandonedRuns: vi.fn(),
}));

vi.mock("../../src/providers/spotify/liked", () => ({
  fetchLikedSongs: vi.fn(),
}));

vi.mock("../../src/match/isrc", () => ({
  matchByIsrc: vi.fn(),
}));

vi.mock("../../src/match/fuzzy", () => ({
  matchByFuzzy: vi.fn(),
}));

vi.mock("../../src/sync/playlist-writer", () => ({
  writePlaylist: vi.fn(),
}));

vi.mock("../../src/sync/playlist-config-seeder", () => ({
  seedPlaylistConfigs: vi.fn(),
}));

vi.mock("../../src/db/playlist_configs", () => ({
  listPlaylistConfigs: vi.fn(),
  listEnabledPlaylistConfigs: vi.fn(),
  markSynced: vi.fn(),
}));

vi.mock("../../src/providers/spotify/playlists", () => ({
  fetchPlaylistTracks: vi.fn(),
  fetchSpotifyPlaylistName: vi.fn(),
}));

import { runSync } from "../../src/sync/orchestrator";
import { Pool } from "@neondatabase/serverless";
import { insertRun, updateRun, markAbandonedRuns } from "../../src/db/sync_runs";
import { fetchLikedSongs } from "../../src/providers/spotify/liked";
import { matchByIsrc } from "../../src/match/isrc";
import { matchByFuzzy } from "../../src/match/fuzzy";
import { writePlaylist } from "../../src/sync/playlist-writer";
import { seedPlaylistConfigs } from "../../src/sync/playlist-config-seeder";
import {
  listEnabledPlaylistConfigs,
  markSynced,
} from "../../src/db/playlist_configs";

const PoolCtor = Pool as unknown as ReturnType<typeof vi.fn>;
const mockInsertRun = vi.mocked(insertRun);
const mockUpdateRun = vi.mocked(updateRun);
const mockMarkAbandoned = vi.mocked(markAbandonedRuns);
const mockFetchLikedSongs = vi.mocked(fetchLikedSongs);
const mockMatchByIsrc = vi.mocked(matchByIsrc);
const mockMatchByFuzzy = vi.mocked(matchByFuzzy);
const mockWritePlaylist = vi.mocked(writePlaylist);
const mockSeedPlaylistConfigs = vi.mocked(seedPlaylistConfigs);
const mockListEnabledPlaylistConfigs = vi.mocked(listEnabledPlaylistConfigs);
const mockMarkSynced = vi.mocked(markSynced);

const mockFetch = vi.fn();

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-secret",
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Array(32).fill(0x42))),
    SPOTIFY_CLIENT_ID: "",
    SPOTIFY_CLIENT_SECRET: "",
    SPOTIFY_REDIRECT_URI: "",
    TIDAL_CLIENT_ID: "",
    TIDAL_CLIENT_SECRET: "",
    TIDAL_REDIRECT_URI: "",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
    NTFY_TOPIC: "portage-test-topic",
    ...overrides,
  } as Env;
}

function setupSuccessfulRun() {
  mockClient.query
    .mockResolvedValueOnce({ rows: [{ acquired: true }] })
    .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
  mockMarkAbandoned.mockResolvedValue(0);
  mockInsertRun.mockResolvedValue({ run_id: "run-001" });
  mockUpdateRun.mockResolvedValue(undefined);
  mockSeedPlaylistConfigs.mockResolvedValue(undefined);
  mockListEnabledPlaylistConfigs.mockResolvedValue([
    {
      spotify_playlist_id: "__liked__",
      spotify_name: "Spotify Liked",
      tidal_playlist_id: "tidal-liked-001",
      created_at: "2026-05-01T00:00:00Z",
      last_synced_at: null,
      enabled: true,
    },
  ]);
  mockMarkSynced.mockResolvedValue(undefined);
  mockFetchLikedSongs.mockResolvedValue({
    pagesProcessed: 1,
    tracksInserted: 5,
    tracksSkipped: 0,
  });
  mockMatchByIsrc.mockResolvedValue({ matched: 3, skipped: 0, errors: [] });
  mockMatchByFuzzy.mockResolvedValue({ matched: 1, unmatched: 1, errors: [] });
  mockWritePlaylist.mockResolvedValue({
    playlistId: "playlist-1",
    added: 4,
    skippedDuplicates: 0,
    invalidIds: [],
    errors: 0,
  });
}

function ntfyCalls(): Array<[string, RequestInit]> {
  return mockFetch.mock.calls as Array<[string, RequestInit]>;
}

beforeEach(() => {
  vi.resetAllMocks();
  PoolCtor.mockImplementation(() => mockPool);
  mockPool.connect.mockResolvedValue(mockClient);
  mockPool.end.mockResolvedValue(undefined);
  mockSql.mockResolvedValue([]);
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockImplementation(async () => new Response("{}", { status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runSync notification wiring (F-029)", () => {
  it("publishes one succeeded notification after a clean run", async () => {
    setupSuccessfulRun();
    const result = await runSync(makeEnv());
    expect(result.outcome).toBe("succeeded");
    expect(ntfyCalls()).toHaveLength(1);
    const [url, init] = ntfyCalls()[0];
    expect(url).toBe("https://ntfy.sh/portage-test-topic");
    const headers = init.headers as Record<string, string>;
    expect(headers["Title"]).toBe("Portage sync succeeded");
    expect(String(init.body)).toContain("run-001");
  });

  it("publishes nothing when NTFY_TOPIC is unset", async () => {
    setupSuccessfulRun();
    const result = await runSync(makeEnv({ NTFY_TOPIC: undefined }));
    expect(result.outcome).toBe("succeeded");
    expect(ntfyCalls()).toHaveLength(0);
  });

  it("publishes nothing for skipped_locked", async () => {
    mockMarkAbandoned.mockResolvedValue(0);
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
    const result = await runSync(makeEnv());
    expect(result.outcome).toBe("skipped_locked");
    expect(ntfyCalls()).toHaveLength(0);
  });

  it("publishes the abandoned-sweep alert before the outcome notification", async () => {
    setupSuccessfulRun();
    mockMarkAbandoned.mockResolvedValue(2);
    await runSync(makeEnv());
    expect(ntfyCalls()).toHaveLength(2);
    const sweepHeaders = ntfyCalls()[0][1].headers as Record<string, string>;
    expect(sweepHeaders["Tags"]).toBe("ghost");
    expect(sweepHeaders["Title"]).toContain("2");
    const outcomeHeaders = ntfyCalls()[1][1].headers as Record<string, string>;
    expect(outcomeHeaders["Title"]).toBe("Portage sync succeeded");
  });

  it("attempts a crash notification and rethrows when the pre-lock section throws", async () => {
    mockMarkAbandoned.mockRejectedValue(new Error("neon unreachable"));
    await expect(runSync(makeEnv())).rejects.toThrow("neon unreachable");
    expect(ntfyCalls()).toHaveLength(1);
    const headers = ntfyCalls()[0][1].headers as Record<string, string>;
    expect(headers["Title"]).toBe("Portage sync failed");
    expect(String(ntfyCalls()[0][1].body)).toContain("neon unreachable");
  });

  it("a rejected publish does not alter the run result", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setupSuccessfulRun();
    mockFetch.mockRejectedValue(new Error("ntfy down"));
    const result = await runSync(makeEnv());
    expect(result).toMatchObject({
      outcome: "succeeded",
      run_id: "run-001",
      tracks_seen: 5,
      matched_isrc: 3,
      matched_fuzzy: 1,
      unmatched: 1,
      errors: 0,
    });
  });
});
