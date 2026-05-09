import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

vi.mock("@neondatabase/serverless", () => ({
  neon: () => vi.fn(),
}));

vi.mock("../../src/db/playlist_configs", () => ({
  getPlaylistConfig: vi.fn(),
  setTidalPlaylistId: vi.fn(),
}));

vi.mock("../../src/db/playlist_membership", () => ({
  selectUnsyncedMatchesForPlaylist: vi.fn(),
  markMembershipSynced: vi.fn(),
}));

vi.mock("../../src/providers/tidal/playlist", () => ({
  createPlaylist: vi.fn(),
  getPlaylist: vi.fn(),
  addTracksToPlaylist: vi.fn(),
}));

vi.mock("../../src/db/matches", () => ({
  selectMatchesNewerThan: vi.fn(),
  flagInvalidTidalId: vi.fn(),
}));

vi.mock("../../src/db/unmatched", () => ({
  requeueForInvalidTidalId: vi.fn(),
}));

vi.mock("../../src/db/sync_state", () => ({
  readState: vi.fn(),
  writeState: vi.fn(),
}));

import { writePlaylist } from "../../src/sync/playlist-writer";
import {
  getPlaylistConfig,
  setTidalPlaylistId,
} from "../../src/db/playlist_configs";
import {
  selectUnsyncedMatchesForPlaylist,
  markMembershipSynced,
} from "../../src/db/playlist_membership";
import {
  createPlaylist,
  getPlaylist,
  addTracksToPlaylist,
} from "../../src/providers/tidal/playlist";
import { flagInvalidTidalId } from "../../src/db/matches";
import { requeueForInvalidTidalId } from "../../src/db/unmatched";
import { writeState } from "../../src/db/sync_state";

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

function makeUnsyncedMatch(
  spotifyTrackId: string,
  tidalId: string,
): { spotify_track_id: string; tidal_id: string } {
  return { spotify_track_id: spotifyTrackId, tidal_id: tidalId };
}

function makeConfig(
  spotifyPlaylistId: string,
  overrides: {
    spotify_name?: string;
    tidal_playlist_id?: string | null;
  } = {},
) {
  return {
    spotify_playlist_id: spotifyPlaylistId,
    spotify_name: overrides.spotify_name ?? "Spotify Liked",
    tidal_playlist_id: overrides.tidal_playlist_id ?? null,
    created_at: "2026-01-01T00:00:00Z",
    last_synced_at: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createPlaylist).mockResolvedValue("PLAYLIST_X");
  vi.mocked(getPlaylist).mockResolvedValue({ id: "PLAYLIST_X", name: "Spotify Liked" });
  vi.mocked(addTracksToPlaylist).mockResolvedValue({ added: 0, invalidIds: [], errors: 0 });
  vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue([]);
  vi.mocked(markMembershipSynced).mockResolvedValue(undefined);
  vi.mocked(setTidalPlaylistId).mockResolvedValue(undefined);
  vi.mocked(flagInvalidTidalId).mockResolvedValue(undefined);
  vi.mocked(requeueForInvalidTidalId).mockResolvedValue(undefined);
  vi.mocked(writeState).mockResolvedValue(undefined);
  vi.mocked(getPlaylistConfig).mockResolvedValue(
    makeConfig("__liked__", { tidal_playlist_id: "tidal-known" }),
  );
});

// T-018-01: writePlaylist(env, '__liked__', knownTidalId) writes unsynced matches
describe("T-018-01: writePlaylist writes unsynced matches with known tidal id", () => {
  it("calls addTracksToPlaylist with playlist id and tidal ids, marks synced", async () => {
    const matches = [
      makeUnsyncedMatch("t1", "td1"),
      makeUnsyncedMatch("t2", "td2"),
      makeUnsyncedMatch("t3", "td3"),
    ];
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue(matches);
    vi.mocked(addTracksToPlaylist).mockResolvedValue({ added: 3, errors: 0, invalidIds: [] });

    const result = await writePlaylist(makeEnv(), "__liked__", "tidal-known");

    expect(addTracksToPlaylist).toHaveBeenCalledWith(
      expect.anything(),
      "tidal-known",
      ["td1", "td2", "td3"],
    );
    expect(markMembershipSynced).toHaveBeenCalledWith(
      expect.anything(),
      "__liked__",
      ["t1", "t2", "t3"],
      expect.any(String),
    );
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(setTidalPlaylistId).not.toHaveBeenCalled();
    expect(result.added).toBe(3);
    expect(result.errors).toBe(0);
    expect(result.invalidIds).toEqual([]);
  });
});

// T-018-02: writePlaylist with empty unsynced matches short-circuits
describe("T-018-02: writePlaylist short-circuits on empty unsynced matches", () => {
  it("does not call addTracksToPlaylist or markMembershipSynced", async () => {
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue([]);

    const result = await writePlaylist(makeEnv(), "__liked__", "tidal-known");

    expect(addTracksToPlaylist).not.toHaveBeenCalled();
    expect(markMembershipSynced).not.toHaveBeenCalled();
    expect(result.added).toBe(0);
  });
});

// T-018-03: writePlaylist auto-creates Tidal playlist when tidalPlaylistId is null
describe("T-018-03: writePlaylist auto-creates Tidal playlist when config tidal_playlist_id is null", () => {
  it("calls createPlaylist with spotify_name and persists the new id", async () => {
    vi.mocked(getPlaylistConfig).mockResolvedValue(
      makeConfig("abc123", { spotify_name: "Workout", tidal_playlist_id: null }),
    );
    vi.mocked(createPlaylist).mockResolvedValue("tidal-new");
    vi.mocked(getPlaylist).mockResolvedValue({ id: "tidal-new", name: "Workout" });
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue([]);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(msg));

    await writePlaylist(makeEnv(), "abc123", null);

    expect(createPlaylist).toHaveBeenCalledWith(expect.anything(), "Workout");
    expect(setTidalPlaylistId).toHaveBeenCalledWith(
      expect.anything(),
      "abc123",
      "tidal-new",
    );
    const createdLog = logs.find((l) => l.includes("playlist_created_for_config"));
    expect(createdLog).toBeDefined();
    const parsed = JSON.parse(createdLog!);
    expect(parsed.event).toBe("playlist_created_for_config");
    expect(parsed.spotify_playlist_id).toBe("abc123");
    expect(parsed.tidal_playlist_id).toBe("tidal-new");
    expect(parsed.name).toBe("Workout");
  });
});

// T-018-04: writePlaylist looks up tidal_playlist_id from playlist_configs when caller passes null
describe("T-018-04: writePlaylist looks up existing tidal id from playlist_configs", () => {
  it("uses tidal_existing from config without calling createPlaylist", async () => {
    vi.mocked(getPlaylistConfig).mockResolvedValue(
      makeConfig("abc123", { tidal_playlist_id: "tidal-existing", spotify_name: "Workout" }),
    );
    vi.mocked(getPlaylist).mockResolvedValue({ id: "tidal-existing", name: "Workout" });
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue([
      makeUnsyncedMatch("t1", "td1"),
    ]);
    vi.mocked(addTracksToPlaylist).mockResolvedValue({ added: 1, errors: 0, invalidIds: [] });

    await writePlaylist(makeEnv(), "abc123", null);

    expect(createPlaylist).not.toHaveBeenCalled();
    expect(addTracksToPlaylist).toHaveBeenCalledWith(
      expect.anything(),
      "tidal-existing",
      ["td1"],
    );
  });
});

// T-018-05: writePlaylist marks synced only for non-invalid Tidal ids
describe("T-018-05: writePlaylist marks synced only for tracks with valid tidal ids", () => {
  it("excludes invalid-tidal-id tracks from markMembershipSynced", async () => {
    const matches = [
      makeUnsyncedMatch("t1", "td1"),
      makeUnsyncedMatch("t2", "td2-bad"),
      makeUnsyncedMatch("t3", "td3"),
    ];
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue(matches);
    vi.mocked(addTracksToPlaylist).mockResolvedValue({
      added: 2,
      errors: 1,
      invalidIds: ["td2-bad"],
    });

    await writePlaylist(makeEnv(), "__liked__", "tidal-known");

    expect(markMembershipSynced).toHaveBeenCalledWith(
      expect.anything(),
      "__liked__",
      ["t1", "t3"],
      expect.any(String),
    );
    expect(flagInvalidTidalId).toHaveBeenCalledWith(expect.anything(), "td2-bad");
    expect(requeueForInvalidTidalId).toHaveBeenCalledWith(expect.anything(), "t2");
  });
});

// T-018-06: writePlaylist does NOT touch sync_state.last_playlist_write_at
describe("T-018-06: writePlaylist does not write legacy last_playlist_write_at", () => {
  it("never calls writeState with key last_playlist_write_at", async () => {
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue([
      makeUnsyncedMatch("t1", "td1"),
    ]);
    vi.mocked(addTracksToPlaylist).mockResolvedValue({ added: 1, errors: 0, invalidIds: [] });

    await writePlaylist(makeEnv(), "__liked__", "tidal-known");

    const calls = vi.mocked(writeState).mock.calls;
    const legacyWrite = calls.find(
      (c) => c[1] === "last_playlist_write_at",
    );
    expect(legacyWrite).toBeUndefined();
  });
});

// T-018-07: writePlaylist recreates Tidal playlist when getPlaylist returns null
describe("T-018-07: writePlaylist recreates Tidal playlist when getPlaylist returns null", () => {
  it("creates new playlist, persists id, logs playlist_recreated", async () => {
    vi.mocked(getPlaylistConfig).mockResolvedValue(
      makeConfig("__liked__", { tidal_playlist_id: "tidal-stale", spotify_name: "Spotify Liked" }),
    );
    vi.mocked(getPlaylist).mockResolvedValue(null);
    vi.mocked(createPlaylist).mockResolvedValue("tidal-fresh");
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue([]);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(msg));

    await writePlaylist(makeEnv(), "__liked__", null);

    expect(createPlaylist).toHaveBeenCalled();
    expect(setTidalPlaylistId).toHaveBeenCalledWith(
      expect.anything(),
      "__liked__",
      "tidal-fresh",
    );
    const recreatedLog = logs.find((l) => l.includes("playlist_recreated"));
    expect(recreatedLog).toBeDefined();
    const parsed = JSON.parse(recreatedLog!);
    expect(parsed.previous_id).toBe("tidal-stale");
    expect(parsed.new_id).toBe("tidal-fresh");
  });
});

// T-018-08: writePlaylist with all-invalid result does not mark anything synced
describe("T-018-08: writePlaylist does not call markMembershipSynced when all tracks invalid", () => {
  it("skips markMembershipSynced when all tidal ids are invalid", async () => {
    const matches = [
      makeUnsyncedMatch("t1", "td1"),
      makeUnsyncedMatch("t2", "td2"),
    ];
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue(matches);
    vi.mocked(addTracksToPlaylist).mockResolvedValue({
      added: 0,
      errors: 0,
      invalidIds: ["td1", "td2"],
    });

    await writePlaylist(makeEnv(), "__liked__", "tidal-known");

    expect(markMembershipSynced).not.toHaveBeenCalled();
    expect(flagInvalidTidalId).toHaveBeenCalledWith(expect.anything(), "td1");
    expect(flagInvalidTidalId).toHaveBeenCalledWith(expect.anything(), "td2");
  });
});

// T-018-09: writePlaylist returns backward-compatible PlaylistWriteResult shape
describe("T-018-09: writePlaylist returns backward-compatible PlaylistWriteResult", () => {
  it("result has all required fields and skippedDuplicates is 0", async () => {
    const matches = [
      makeUnsyncedMatch("t1", "td1"),
      makeUnsyncedMatch("t2", "td2"),
      makeUnsyncedMatch("t3", "td3"),
    ];
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue(matches);
    vi.mocked(addTracksToPlaylist).mockResolvedValue({ added: 3, errors: 0, invalidIds: [] });

    const result = await writePlaylist(makeEnv(), "__liked__", "tidal-known");

    expect(result).toHaveProperty("playlistId", "tidal-known");
    expect(result).toHaveProperty("added", 3);
    expect(result).toHaveProperty("skippedDuplicates", 0);
    expect(result).toHaveProperty("invalidIds");
    expect(result).toHaveProperty("errors", 0);
    expect(Object.keys(result).sort()).toEqual(
      ["added", "errors", "invalidIds", "playlistId", "skippedDuplicates"].sort(),
    );
  });
});

// T-018-10: writePlaylist legacy single-argument call site works during transition
describe("T-018-10: writePlaylist legacy single-argument call site works", () => {
  it("uses tidal_playlist_id from playlist_configs for __liked__ when called with no args", async () => {
    vi.mocked(getPlaylistConfig).mockResolvedValue(
      makeConfig("__liked__", { tidal_playlist_id: "tidal-known", spotify_name: "Spotify Liked" }),
    );
    vi.mocked(getPlaylist).mockResolvedValue({ id: "tidal-known", name: "Spotify Liked" });
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue([
      makeUnsyncedMatch("t1", "td1"),
    ]);
    vi.mocked(addTracksToPlaylist).mockResolvedValue({ added: 1, errors: 0, invalidIds: [] });

    const result = await writePlaylist(makeEnv());

    expect(addTracksToPlaylist).toHaveBeenCalledWith(expect.anything(), "tidal-known", ["td1"]);
    expect(markMembershipSynced).toHaveBeenCalledWith(
      expect.anything(),
      "__liked__",
      ["t1"],
      expect.any(String),
    );
    expect(result.added).toBe(1);
  });
});

// T-018-11: emits playlist_write_completed log line with spotify_playlist_id
describe("T-018-11: writePlaylist emits playlist_write_completed log", () => {
  it("logs playlist_write_completed event with all required fields", async () => {
    const matches = [
      makeUnsyncedMatch("t1", "td1"),
      makeUnsyncedMatch("t2", "td2"),
      makeUnsyncedMatch("t3", "td3"),
    ];
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue(matches);
    vi.mocked(addTracksToPlaylist).mockResolvedValue({ added: 3, errors: 0, invalidIds: [] });
    vi.mocked(getPlaylistConfig).mockResolvedValue(
      makeConfig("abc123", { tidal_playlist_id: "tidal-known", spotify_name: "Test" }),
    );
    vi.mocked(getPlaylist).mockResolvedValue({ id: "tidal-known", name: "Test" });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(msg));

    await writePlaylist(makeEnv(), "abc123", "tidal-known");

    const completedLog = logs.find((l) => l.includes("playlist_write_completed"));
    expect(completedLog).toBeDefined();
    const parsed = JSON.parse(completedLog!);
    expect(parsed.event).toBe("playlist_write_completed");
    expect(parsed.spotify_playlist_id).toBe("abc123");
    expect(parsed.tidal_playlist_id).toBe("tidal-known");
    expect(parsed.added).toBe(3);
  });
});

// Coverage branch: caller passes non-null tidal id that no longer exists in Tidal
describe("writePlaylist — caller-supplied tidal id is stale (getPlaylist returns null)", () => {
  it("recreates playlist and logs playlist_recreated when caller-supplied id is gone", async () => {
    vi.mocked(getPlaylist).mockResolvedValue(null);
    vi.mocked(getPlaylistConfig).mockResolvedValue(
      makeConfig("__liked__", { tidal_playlist_id: "tidal-stale", spotify_name: "Spotify Liked" }),
    );
    vi.mocked(createPlaylist).mockResolvedValue("tidal-fresh");
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue([]);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(msg));

    const result = await writePlaylist(makeEnv(), "__liked__", "tidal-stale");

    expect(createPlaylist).toHaveBeenCalled();
    expect(setTidalPlaylistId).toHaveBeenCalledWith(
      expect.anything(),
      "__liked__",
      "tidal-fresh",
    );
    const recreatedLog = logs.find((l) => l.includes("playlist_recreated"));
    expect(recreatedLog).toBeDefined();
    const parsed = JSON.parse(recreatedLog!);
    expect(parsed.previous_id).toBe("tidal-stale");
    expect(parsed.new_id).toBe("tidal-fresh");
    expect(result.playlistId).toBe("tidal-fresh");
  });

  it("falls back to spotifyPlaylistId as name when config row is absent for stale caller id", async () => {
    vi.mocked(getPlaylist).mockResolvedValue(null);
    vi.mocked(getPlaylistConfig).mockResolvedValue(null);
    vi.mocked(createPlaylist).mockResolvedValue("tidal-fresh");
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue([]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await writePlaylist(makeEnv(), "orphan-id", "tidal-stale");

    expect(createPlaylist).toHaveBeenCalledWith(expect.anything(), "orphan-id");
  });
});

// Coverage branch: invalid tidal id in result has no corresponding unsynced match row
describe("writePlaylist — invalid tidal id with no matching unsynced row", () => {
  it("flags the invalid id but skips requeueForInvalidTidalId when no match found", async () => {
    vi.mocked(selectUnsyncedMatchesForPlaylist).mockResolvedValue([
      makeUnsyncedMatch("t1", "td1"),
    ]);
    // Return an invalidId that doesn't appear in the unsynced matches
    vi.mocked(addTracksToPlaylist).mockResolvedValue({
      added: 0,
      errors: 0,
      invalidIds: ["td-orphan"],
    });

    await writePlaylist(makeEnv(), "__liked__", "tidal-known");

    expect(flagInvalidTidalId).toHaveBeenCalledWith(expect.anything(), "td-orphan");
    expect(requeueForInvalidTidalId).not.toHaveBeenCalled();
  });
});

// Coverage branch: getPlaylistConfig returns null (unknown playlist id)
describe("writePlaylist — getPlaylistConfig returns null (unknown spotify playlist id)", () => {
  it("throws when playlist config row is missing", async () => {
    vi.mocked(getPlaylistConfig).mockResolvedValue(null);

    await expect(writePlaylist(makeEnv(), "unknown-id", null)).rejects.toThrow(
      "[F-018] No playlist_configs row for spotify_playlist_id=unknown-id",
    );
  });
});
