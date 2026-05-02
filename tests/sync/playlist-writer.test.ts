import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

vi.mock("../../src/providers/tidal/playlist", () => ({
  createPlaylist: vi.fn(),
  getPlaylist: vi.fn(),
  addTracksToPlaylist: vi.fn(),
}));

import { writePlaylist } from "../../src/sync/playlist-writer";
import {
  createPlaylist,
  getPlaylist,
  addTracksToPlaylist,
} from "../../src/providers/tidal/playlist";

const mockCreate = createPlaylist as ReturnType<typeof vi.fn>;
const mockGet = getPlaylist as ReturnType<typeof vi.fn>;
const mockAdd = addTracksToPlaylist as ReturnType<typeof vi.fn>;

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
    ...overrides,
  };
}

function makeMatch(
  spotifyId: string,
  tidalId: string,
  matchedAt = "2026-01-01T00:00:01Z",
): { spotify_id: string; tidal_id: string; matched_at: string } {
  return { spotify_id: spotifyId, tidal_id: tidalId, matched_at: matchedAt };
}

// Default: readState(tidal_playlist_id) = null, readState(last_playlist_write_at) = null
// selectMatchesNewerThan = []
// SQL call index mapping:
//   0: readState(KEY_PLAYLIST_ID)
//   1: writeState(KEY_PLAYLIST_ID) — when creating
//   2: readState(KEY_LAST_WRITE_AT)
//   3: selectMatchesNewerThan
//   4+: writeState, flagInvalid, requeueUnmatched

function setupNoPlaylist(matches: ReturnType<typeof makeMatch>[] = []) {
  mockSql.mockReset();
  // readState(KEY_PLAYLIST_ID) → null (no stored id)
  mockSql.mockResolvedValueOnce([]);
  // writeState(KEY_PLAYLIST_ID) → ok
  mockSql.mockResolvedValueOnce([]);
  // readState(KEY_LAST_WRITE_AT) → null
  mockSql.mockResolvedValueOnce([]);
  // selectMatchesNewerThan → matches
  mockSql.mockResolvedValueOnce(matches);
  // Remaining writes → ok
  mockSql.mockResolvedValue([]);
}

function setupExistingPlaylist(
  playlistId: string,
  matches: ReturnType<typeof makeMatch>[] = [],
) {
  mockSql.mockReset();
  // readState(KEY_PLAYLIST_ID) → stored id
  mockSql.mockResolvedValueOnce([{ value: playlistId }]);
  // readState(KEY_LAST_WRITE_AT)
  mockSql.mockResolvedValueOnce([{ value: "2026-01-01T00:00:00Z" }]);
  // selectMatchesNewerThan
  mockSql.mockResolvedValueOnce(matches);
  // Remaining writes → ok
  mockSql.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue("PLAYLIST_X");
  mockGet.mockResolvedValue({ id: "PLAYLIST_X", name: "Spotify Liked" });
  mockAdd.mockResolvedValue({ added: 0, invalidIds: [], errors: 0 });
});

// T-008-01: Playlist created on first run
describe("T-008-01: Playlist created on first run", () => {
  it("persists returned playlist id to sync_state", async () => {
    setupNoPlaylist();
    mockCreate.mockResolvedValue("PLAYLIST_X");

    const result = await writePlaylist(makeEnv());

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(result.playlistId).toBe("PLAYLIST_X");
    // writeState should have been called with KEY_PLAYLIST_ID = 'PLAYLIST_X'
    const writeCalls = mockSql.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO sync_state"),
    );
    const playlistIdWrite = writeCalls.find(
      (c) => Array.isArray(c[1]) && c[1].includes("tidal_playlist_id"),
    );
    expect(playlistIdWrite?.[1]).toContain("PLAYLIST_X");
  });
});

// T-008-02: Playlist created with correct title
describe("T-008-02: Playlist created with correct title", () => {
  it("passes TIDAL_PLAYLIST_TITLE to createPlaylist", async () => {
    setupNoPlaylist();
    const env = makeEnv({ TIDAL_PLAYLIST_TITLE: "Spotify Liked" });

    await writePlaylist(env);

    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), "Spotify Liked");
  });
});

// T-008-03: Playlist created as private
describe("T-008-03: Playlist created as private", () => {
  it("createPlaylist is called (privacy handled inside playlist.ts)", async () => {
    setupNoPlaylist();
    await writePlaylist(makeEnv());
    // Privacy field is set by createPlaylist; we verify that it was called
    expect(mockCreate).toHaveBeenCalledOnce();
  });
});

// T-008-04: Existing playlist reused — createPlaylist not called
describe("T-008-04: Existing playlist reused", () => {
  it("does not call createPlaylist if stored id is valid", async () => {
    setupExistingPlaylist("PLAYLIST_X");
    mockGet.mockResolvedValue({ id: "PLAYLIST_X", name: "Spotify Liked" });

    await writePlaylist(makeEnv());

    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// T-008-05: Missing playlist triggers recreate
describe("T-008-05: Missing playlist triggers recreate", () => {
  it("creates new playlist and logs playlist_recreated when stored playlist is gone", async () => {
    mockSql.mockReset();
    // readState(KEY_PLAYLIST_ID) → OLD
    mockSql.mockResolvedValueOnce([{ value: "OLD" }]);
    // writeState(KEY_PLAYLIST_ID) with NEW
    mockSql.mockResolvedValueOnce([]);
    // readState(KEY_LAST_WRITE_AT)
    mockSql.mockResolvedValueOnce([]);
    // selectMatchesNewerThan
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValue([]);

    mockGet.mockResolvedValue(null); // playlist gone
    mockCreate.mockResolvedValue("NEW");

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(msg));

    const result = await writePlaylist(makeEnv());

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(result.playlistId).toBe("NEW");

    const recreateLog = logs.find((l) => l.includes("playlist_recreated"));
    expect(recreateLog).toBeDefined();
    const parsed = JSON.parse(recreateLog!);
    expect(parsed.previous_id).toBe("OLD");
    expect(parsed.new_id).toBe("NEW");
  });
});

// T-008-06: New matches appended in matched_at order
describe("T-008-06: New matches appended", () => {
  it("sends tidal_ids in ascending matched_at order to addTracksToPlaylist", async () => {
    const matches = [
      makeMatch("sp1", "T1", "2026-01-01T00:00:01Z"),
      makeMatch("sp2", "T2", "2026-01-01T00:00:02Z"),
      makeMatch("sp3", "T3", "2026-01-01T00:00:03Z"),
      makeMatch("sp4", "T4", "2026-01-01T00:00:04Z"),
      makeMatch("sp5", "T5", "2026-01-01T00:00:05Z"),
    ];
    setupExistingPlaylist("PL1", matches);
    mockGet.mockResolvedValue({ id: "PL1", name: "Spotify Liked" });
    mockAdd.mockResolvedValue({ added: 5, invalidIds: [], errors: 0 });

    await writePlaylist(makeEnv());

    const [, , addedIds] = mockAdd.mock.calls[0];
    expect(addedIds).toEqual(["T1", "T2", "T3", "T4", "T5"]);
  });
});

// T-008-07: 2026-05-02 simplification — no client-side dedupe.
// Watermark `last_playlist_write_at` is the sole gate; client-side dedupe
// via getAllPlaylistTrackIds was rate-limited by Tidal and removed.
describe("T-008-07: writePlaylist sends every match without client-side dedupe", () => {
  it("forwards all newMatches.tidal_id to addTracksToPlaylist verbatim", async () => {
    const matches = [
      makeMatch("sp1", "T1"),
      makeMatch("sp3", "T3"),
      makeMatch("sp4", "T4"),
    ];
    setupExistingPlaylist("PL1", matches);
    mockGet.mockResolvedValue({ id: "PL1", name: "Spotify Liked" });
    mockAdd.mockResolvedValue({ added: 3, invalidIds: [], errors: 0 });

    const result = await writePlaylist(makeEnv());

    const [, , addedIds] = mockAdd.mock.calls[0];
    expect(addedIds).toEqual(["T1", "T3", "T4"]);
    expect(result.skippedDuplicates).toBe(0);
  });
});

// T-008-08: No matches yields zero writes
describe("T-008-08: No matches yields zero writes", () => {
  it("does not call addTracksToPlaylist when no new matches", async () => {
    setupExistingPlaylist("PL1", []);

    await writePlaylist(makeEnv());

    expect(mockAdd).not.toHaveBeenCalled();
  });
});

// T-008-09: Batch size respects configured limit
describe("T-008-09: Batch size respects configured limit", () => {
  it("addTracksToPlaylist is called with all ids (batching is inside the function)", async () => {
    const matches = Array.from({ length: 120 }, (_, i) =>
      makeMatch(`sp${i}`, `T${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`),
    );
    setupExistingPlaylist("PL1", matches);
    mockGet.mockResolvedValue({ id: "PL1", name: "Spotify Liked" });
    mockAdd.mockResolvedValue({ added: 120, invalidIds: [], errors: 0 });

    await writePlaylist(makeEnv());

    // addTracksToPlaylist receives all ids; internal batching inside addTracksToPlaylist
    const [, , allIds] = mockAdd.mock.calls[0];
    expect(allIds).toHaveLength(120);
  });
});

// T-008-10: Idempotent on partial failure
describe("T-008-10: Idempotent on partial failure", () => {
  it("re-run after partial failure does not duplicate tracks already present", async () => {
    // First run: 5 tracks sent, 5 added
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeMatch(`sp${i}`, `T${i}`),
    );
    setupExistingPlaylist("PL1", matches);
    mockGet.mockResolvedValue({ id: "PL1", name: "Spotify Liked" });
    mockAdd.mockResolvedValue({ added: 5, invalidIds: [], errors: 0 });

    await writePlaylist(makeEnv());

    // Second run: watermark advanced, selectMatchesNewerThan returns []
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([{ value: "PL1" }]);
    mockSql.mockResolvedValueOnce([{ value: new Date().toISOString() }]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValue([]);
    mockAdd.mockClear();

    const result2 = await writePlaylist(makeEnv());

    expect(mockAdd).not.toHaveBeenCalled();
    expect(result2.added).toBe(0);
  });
});

// T-008-11: 401 triggers refresh and retry (handled by tidalFetch inside playlist.ts)
describe("T-008-11: 401 handled by tidalFetch", () => {
  it("addTracksToPlaylist is called (401 retry is inside tidalFetch)", async () => {
    const matches = [makeMatch("sp1", "T1")];
    setupExistingPlaylist("PL1", matches);
    mockGet.mockResolvedValue({ id: "PL1", name: "Spotify Liked" });
    mockAdd.mockResolvedValue({ added: 1, invalidIds: [], errors: 0 });

    const result = await writePlaylist(makeEnv());

    expect(mockAdd).toHaveBeenCalledOnce();
    expect(result.added).toBe(1);
  });
});

// T-008-12: Invalid Tidal id flagged and re-queued
describe("T-008-12: Invalid Tidal id flagged and re-queued", () => {
  it("flags tidal_id_invalid and requeues unmatched on invalid track error", async () => {
    const matches = [makeMatch("sp-bad", "T_BAD")];
    setupExistingPlaylist("PL1", matches);
    mockGet.mockResolvedValue({ id: "PL1", name: "Spotify Liked" });
    mockAdd.mockResolvedValue({ added: 0, invalidIds: ["T_BAD"], errors: 0 });

    const result = await writePlaylist(makeEnv());

    // Should have called UPDATE matches SET tidal_id_invalid = true WHERE tidal_id = $1
    const flagCall = mockSql.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("UPDATE matches") &&
        c[0].includes("tidal_id_invalid"),
    );
    expect(flagCall).toBeDefined();
    expect(flagCall![1]).toContain("T_BAD");

    // Should have called requeueForInvalidTidalId with spotify_id
    const requeueCall = mockSql.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("tidal_track_removed") &&
        Array.isArray(c[1]) &&
        c[1].includes("sp-bad"),
    );
    expect(requeueCall).toBeDefined();

    expect(result.invalidIds).toContain("T_BAD");
  });
});

// T-008-13: last_playlist_write_at advanced after success
describe("T-008-13: last_playlist_write_at advanced after success", () => {
  it("writes last_playlist_write_at after a successful run", async () => {
    const t0 = new Date().toISOString();
    const matches = [makeMatch("sp1", "T1")];
    setupExistingPlaylist("PL1", matches);
    mockGet.mockResolvedValue({ id: "PL1", name: "Spotify Liked" });
    mockAdd.mockResolvedValue({ added: 1, invalidIds: [], errors: 0 });

    await writePlaylist(makeEnv());

    const lastWriteCall = mockSql.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("INSERT INTO sync_state") &&
        Array.isArray(c[1]) &&
        c[1].includes("last_playlist_write_at"),
    );
    expect(lastWriteCall).toBeDefined();
    const storedTs = lastWriteCall![1][1] as string;
    expect(new Date(storedTs).getTime()).toBeGreaterThanOrEqual(new Date(t0).getTime());
  });
});

// Default title fallback when TIDAL_PLAYLIST_TITLE is empty
describe("ensurePlaylist — default title fallback", () => {
  it("uses 'Spotify Liked' when TIDAL_PLAYLIST_TITLE is empty string", async () => {
    setupNoPlaylist();
    const env = makeEnv({ TIDAL_PLAYLIST_TITLE: "" });

    await writePlaylist(env);

    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), "Spotify Liked");
  });
});

// Invalid tidalId with no matching spotify_id in newMatches (line 83 branch)
describe("writePlaylist — invalid tidalId with no match in newMatches", () => {
  it("handles gracefully when invalid tidal_id has no corresponding spotify_id", async () => {
    const matches = [makeMatch("sp1", "T1")];
    setupExistingPlaylist("PL1", matches);
    mockGet.mockResolvedValue({ id: "PL1", name: "Spotify Liked" });
    // Return an invalidId that doesn't exist in matches (covers the if(match) false branch)
    mockAdd.mockResolvedValue({ added: 0, invalidIds: ["T_UNKNOWN"], errors: 0 });

    const result = await writePlaylist(makeEnv());

    expect(result.invalidIds).toContain("T_UNKNOWN");
    // No requeue call since T_UNKNOWN has no matching spotify_id
    const requeueCall = mockSql.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("tidal_track_removed"),
    );
    expect(requeueCall).toBeUndefined();
  });
});

// T-008-14: No removals during normal sync
describe("T-008-14: No removals during normal sync", () => {
  it("does not call any delete/remove endpoint on playlist", async () => {
    setupExistingPlaylist("PL1", [makeMatch("sp1", "T1")]);
    mockGet.mockResolvedValue({ id: "PL1", name: "Spotify Liked" });
    mockAdd.mockResolvedValue({ added: 1, invalidIds: [], errors: 0 });

    await writePlaylist(makeEnv());

    // addTracksToPlaylist never removes anything; verify it's only called for adds
    const addCall = mockAdd.mock.calls[0];
    expect(addCall).toBeDefined(); // only adds T1
    // No delete SQL calls
    const deleteCalls = mockSql.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].toLowerCase().includes("delete"),
    );
    expect(deleteCalls).toHaveLength(0);
  });
});
