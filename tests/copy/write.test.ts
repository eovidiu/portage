import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";
import type { CopyJobRow } from "../../src/db/copy_jobs";
import type { CopyJobTrackRow } from "../../src/db/copy_job_tracks";

vi.mock("../../src/db/copy_job_tracks", () => ({
  listMatchedForWrite: vi.fn(),
  updateTracksState: vi.fn(),
}));
vi.mock("../../src/db/copy_jobs", () => ({ setDestPlaylist: vi.fn() }));
vi.mock("../../src/copy/dest-reader", () => ({ readDestTailIds: vi.fn() }));
vi.mock("../../src/providers/tidal/playlist", () => ({
  createPlaylist: vi.fn(),
  addTracksToPlaylist: vi.fn(),
}));
vi.mock("../../src/providers/spotify/playlist-write", () => ({
  createPlaylist: vi.fn(),
  addItems: vi.fn(),
}));

import { runWritePhaseStep } from "../../src/copy/write";
import { listMatchedForWrite, updateTracksState } from "../../src/db/copy_job_tracks";
import { setDestPlaylist } from "../../src/db/copy_jobs";
import { readDestTailIds } from "../../src/copy/dest-reader";
import * as tidalPlaylist from "../../src/providers/tidal/playlist";
import * as spotifyPlaylistWrite from "../../src/providers/spotify/playlist-write";

const mockListMatchedForWrite = vi.mocked(listMatchedForWrite);
const mockUpdateTracksState = vi.mocked(updateTracksState);
const mockSetDestPlaylist = vi.mocked(setDestPlaylist);
const mockReadDestTailIds = vi.mocked(readDestTailIds);
const mockTidalCreate = vi.mocked(tidalPlaylist.createPlaylist);
const mockTidalAdd = vi.mocked(tidalPlaylist.addTracksToPlaylist);
const mockSpotifyCreate = vi.mocked(spotifyPlaylistWrite.createPlaylist);
const mockSpotifyAdd = vi.mocked(spotifyPlaylistWrite.addItems);

const mockEnv = { DATABASE_URL: "postgresql://test" } as Env;

function makeJob(overrides: Partial<CopyJobRow> = {}): CopyJobRow {
  return {
    job_id: "job-1",
    direction: "spotify_to_tidal",
    source_playlist_id: "src-1",
    source_name: "Src",
    dest_mode: "new",
    dest_playlist_id: null,
    dest_name: "Dest Name",
    status: "writing",
    error_code: null,
    fetch_cursor: null,
    dest_known_ids: null,
    total_tracks: 1,
    fetched: 1,
    matched: 1,
    written: 0,
    unmatched: 0,
    created_at: "2026-07-18T00:00:00Z",
    updated_at: "2026-07-18T00:00:00Z",
    finished_at: null,
    ...overrides,
  };
}

function makeTrack(overrides: Partial<CopyJobTrackRow> = {}): CopyJobTrackRow {
  return {
    job_id: "job-1",
    position: 0,
    source_track_id: "sp1",
    isrc: null,
    title: "Song",
    artist: "Artist",
    album: null,
    duration_ms: null,
    state: "matched",
    match_method: "isrc",
    confidence: 0.95,
    dest_track_id: "td-1",
    candidates: null,
    reason: null,
    updated_at: "2026-07-18T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Destination created on first write", () => {
  it("creates the Tidal destination playlist before adding any tracks (spotify_to_tidal, new)", async () => {
    mockTidalCreate.mockResolvedValueOnce("tidal-dest-1");
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack()]);
    mockTidalAdd.mockResolvedValueOnce({ added: 1, invalidIds: [], errors: 0 });

    await runWritePhaseStep(mockEnv, makeJob());

    expect(mockTidalCreate).toHaveBeenCalledWith(mockEnv, "Dest Name");
    expect(mockSetDestPlaylist).toHaveBeenCalledWith(mockEnv, "job-1", "tidal-dest-1");
    expect(mockReadDestTailIds).not.toHaveBeenCalled(); // fresh destination — nothing to reconcile
    expect(mockTidalAdd).toHaveBeenCalledWith(mockEnv, "tidal-dest-1", ["td-1"]);
    expect(mockUpdateTracksState).toHaveBeenCalledWith(mockEnv, "job-1", [0], "written");
  });

  it("creates the Spotify destination playlist for tidal_to_spotify, new", async () => {
    mockSpotifyCreate.mockResolvedValueOnce("spotify-dest-1");
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ dest_track_id: "sp-dest-1" })]);
    mockSpotifyAdd.mockResolvedValueOnce({ added: 1, snapshotId: "snap", rateLimited: false });

    await runWritePhaseStep(mockEnv, makeJob({ direction: "tidal_to_spotify" }));

    expect(mockSpotifyCreate).toHaveBeenCalledWith(mockEnv, "Dest Name");
    expect(mockSpotifyAdd).toHaveBeenCalledWith(mockEnv, "spotify-dest-1", ["sp-dest-1"]);
  });
});

describe("Append skips already-present tracks", () => {
  it("marks a track skipped/already_present without calling the provider when its dest id is in dest_known_ids", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ dest_track_id: "already-there" })]);
    mockReadDestTailIds.mockResolvedValueOnce(new Set());

    await runWritePhaseStep(
      mockEnv,
      makeJob({ dest_mode: "append", dest_playlist_id: "existing-dest", dest_known_ids: ["already-there"] }),
    );

    expect(mockTidalAdd).not.toHaveBeenCalled();
    expect(mockUpdateTracksState).toHaveBeenCalledWith(mockEnv, "job-1", [0], "skipped", "already_present");
  });

  it("writes the remaining tracks that are not in dest_known_ids", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([
      makeTrack({ position: 0, dest_track_id: "already-there" }),
      makeTrack({ position: 1, dest_track_id: "new-track" }),
    ]);
    mockTidalAdd.mockResolvedValueOnce({ added: 1, invalidIds: [], errors: 0 });
    mockReadDestTailIds.mockResolvedValueOnce(new Set());

    await runWritePhaseStep(
      mockEnv,
      makeJob({ dest_mode: "append", dest_playlist_id: "existing-dest", dest_known_ids: ["already-there"] }),
    );

    expect(mockUpdateTracksState).toHaveBeenCalledWith(mockEnv, "job-1", [0], "skipped", "already_present");
    expect(mockTidalAdd).toHaveBeenCalledWith(mockEnv, "existing-dest", ["new-track"]);
    expect(mockUpdateTracksState).toHaveBeenCalledWith(mockEnv, "job-1", [1], "written");
  });
});

describe("Crash between write and flip does not duplicate (D7)", () => {
  it("reconciles rows whose dest_track_id already appears in the destination tail before writing the next batch", async () => {
    mockReadDestTailIds.mockResolvedValueOnce(new Set(["td-already-written"]));
    mockListMatchedForWrite.mockResolvedValueOnce([
      makeTrack({ position: 0, dest_track_id: "td-already-written" }),
      makeTrack({ position: 1, dest_track_id: "td-new" }),
    ]);
    mockTidalAdd.mockResolvedValueOnce({ added: 1, invalidIds: [], errors: 0 });

    // dest_playlist_id already set (not a fresh 'new' creation this tick) -> reconcile runs.
    await runWritePhaseStep(mockEnv, makeJob({ dest_playlist_id: "existing-dest" }));

    expect(mockReadDestTailIds).toHaveBeenCalledWith(mockEnv, "tidal", "existing-dest");
    expect(mockUpdateTracksState).toHaveBeenCalledWith(mockEnv, "job-1", [0], "written");
    expect(mockTidalAdd).toHaveBeenCalledWith(mockEnv, "existing-dest", ["td-new"]);
  });

  it("does not reconcile on the very first write tick when the destination was just created (fresh, empty)", async () => {
    mockTidalCreate.mockResolvedValueOnce("brand-new-dest");
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack()]);
    mockTidalAdd.mockResolvedValueOnce({ added: 1, invalidIds: [], errors: 0 });

    await runWritePhaseStep(mockEnv, makeJob());

    expect(mockReadDestTailIds).not.toHaveBeenCalled();
  });
});

describe("no-op when there is nothing to write", () => {
  it("does nothing when listMatchedForWrite returns no rows and dest already exists", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([]);
    await runWritePhaseStep(mockEnv, makeJob({ dest_playlist_id: "existing-dest" }));
    expect(mockTidalAdd).not.toHaveBeenCalled();
    expect(mockUpdateTracksState).not.toHaveBeenCalled();
  });
});
