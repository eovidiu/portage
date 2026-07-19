import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";
import type { CopyJobRow } from "../../src/db/copy_jobs";
import type { CopyJobTrackRow } from "../../src/db/copy_job_tracks";

vi.mock("../../src/db/copy_job_tracks", () => ({
  listMatchedForWrite: vi.fn(),
  updateTracksState: vi.fn(),
}));
vi.mock("../../src/db/copy_jobs", () => ({
  setDestPlaylist: vi.fn(),
  setWriteBatchPositions: vi.fn(),
  resolveWriteBatch: vi.fn(),
}));
vi.mock("../../src/copy/dest-reader", () => ({ readDestItemCount: vi.fn() }));
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
import { setDestPlaylist, setWriteBatchPositions, resolveWriteBatch } from "../../src/db/copy_jobs";
import { readDestItemCount } from "../../src/copy/dest-reader";
import * as tidalPlaylist from "../../src/providers/tidal/playlist";
import * as spotifyPlaylistWrite from "../../src/providers/spotify/playlist-write";

const mockListMatchedForWrite = vi.mocked(listMatchedForWrite);
const mockUpdateTracksState = vi.mocked(updateTracksState);
const mockSetDestPlaylist = vi.mocked(setDestPlaylist);
const mockSetWriteBatchPositions = vi.mocked(setWriteBatchPositions);
const mockResolveWriteBatch = vi.mocked(resolveWriteBatch);
const mockReadDestItemCount = vi.mocked(readDestItemCount);
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
    write_batch_positions: null,
    consecutive_errors: 0,
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
  it("creates the Tidal destination playlist, marks the batch in-flight, then adds and resolves (spotify_to_tidal, new)", async () => {
    mockTidalCreate.mockResolvedValueOnce("tidal-dest-1");
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack()]);
    mockTidalAdd.mockResolvedValueOnce({ added: 1, invalidIds: [], errors: 0 });

    await runWritePhaseStep(mockEnv, makeJob());

    expect(mockTidalCreate).toHaveBeenCalledWith(mockEnv, "Dest Name");
    expect(mockSetDestPlaylist).toHaveBeenCalledWith(mockEnv, "job-1", "tidal-dest-1");
    expect(mockReadDestItemCount).not.toHaveBeenCalled(); // fresh batch — no marker to reconcile
    expect(mockSetWriteBatchPositions).toHaveBeenCalledWith(mockEnv, "job-1", [0]);
    expect(mockTidalAdd).toHaveBeenCalledWith(mockEnv, "tidal-dest-1", ["td-1"]);
    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [0], []);
  });

  it("creates the Spotify destination playlist for tidal_to_spotify, new", async () => {
    mockSpotifyCreate.mockResolvedValueOnce("spotify-dest-1");
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ dest_track_id: "sp-dest-1" })]);
    mockSpotifyAdd.mockResolvedValueOnce({ added: 1, snapshotId: "snap", rateLimited: false });

    await runWritePhaseStep(mockEnv, makeJob({ direction: "tidal_to_spotify" }));

    expect(mockSpotifyCreate).toHaveBeenCalledWith(mockEnv, "Dest Name");
    expect(mockSpotifyAdd).toHaveBeenCalledWith(mockEnv, "spotify-dest-1", ["sp-dest-1"]);
    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [0], []);
  });
});

describe("Append skips already-present tracks", () => {
  it("marks a track skipped/already_present without calling the provider when its dest id is in dest_known_ids", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ dest_track_id: "already-there" })]);

    await runWritePhaseStep(
      mockEnv,
      makeJob({ dest_mode: "append", dest_playlist_id: "existing-dest", dest_known_ids: ["already-there"] }),
    );

    expect(mockTidalAdd).not.toHaveBeenCalled();
    expect(mockUpdateTracksState).toHaveBeenCalledWith(mockEnv, "job-1", [0], "skipped", "already_present");
    expect(mockSetWriteBatchPositions).not.toHaveBeenCalled();
  });

  it("writes the remaining tracks that are not in dest_known_ids", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([
      makeTrack({ position: 0, dest_track_id: "already-there" }),
      makeTrack({ position: 1, dest_track_id: "new-track" }),
    ]);
    mockTidalAdd.mockResolvedValueOnce({ added: 1, invalidIds: [], errors: 0 });

    await runWritePhaseStep(
      mockEnv,
      makeJob({ dest_mode: "append", dest_playlist_id: "existing-dest", dest_known_ids: ["already-there"] }),
    );

    expect(mockUpdateTracksState).toHaveBeenCalledWith(mockEnv, "job-1", [0], "skipped", "already_present");
    expect(mockTidalAdd).toHaveBeenCalledWith(mockEnv, "existing-dest", ["new-track"]);
    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [1], []);
  });
});

describe("B1: count-based crash reconcile (real logic, multi-page-safe)", () => {
  it("re-adds the batch when the destination count shows it never landed", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([
      makeTrack({ position: 5, dest_track_id: "td-5" }),
      makeTrack({ position: 6, dest_track_id: "td-6" }),
    ]);
    mockReadDestItemCount.mockResolvedValueOnce(10); // == expectedPreWrite (append base 10 + written 0)
    mockTidalAdd.mockResolvedValueOnce({ added: 2, invalidIds: [], errors: 0 });

    const job = makeJob({
      dest_mode: "append",
      dest_playlist_id: "existing-dest",
      dest_known_ids: Array.from({ length: 10 }, (_, i) => `known-${i}`),
      written: 0,
      write_batch_positions: [5, 6],
    });

    await runWritePhaseStep(mockEnv, job);

    expect(mockReadDestItemCount).toHaveBeenCalledWith(mockEnv, "tidal", "existing-dest");
    expect(mockTidalAdd).toHaveBeenCalledWith(mockEnv, "existing-dest", ["td-5", "td-6"]);
    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [5, 6], []);
  });

  it("flips to written without re-adding when the destination count shows the batch already landed", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([
      makeTrack({ position: 5, dest_track_id: "td-5" }),
      makeTrack({ position: 6, dest_track_id: "td-6" }),
    ]);
    mockReadDestItemCount.mockResolvedValueOnce(12); // == expectedPreWrite(10) + batchSize(2)

    const job = makeJob({
      dest_mode: "append",
      dest_playlist_id: "existing-dest",
      dest_known_ids: Array.from({ length: 10 }, (_, i) => `known-${i}`),
      written: 0,
      write_batch_positions: [5, 6],
    });

    await runWritePhaseStep(mockEnv, job);

    expect(mockTidalAdd).not.toHaveBeenCalled();
    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [5, 6], []);
  });

  it("uses job.written (not dest_known_ids alone) as part of the pre-write baseline for a 'new' destination", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ position: 3, dest_track_id: "td-3" })]);
    mockReadDestItemCount.mockResolvedValueOnce(4); // written(4) + 0 base for 'new' == pre-write

    const job = makeJob({
      dest_mode: "new",
      dest_playlist_id: "existing-dest",
      written: 4,
      write_batch_positions: [3],
    });
    mockTidalAdd.mockResolvedValueOnce({ added: 1, invalidIds: [], errors: 0 });

    await runWritePhaseStep(mockEnv, job);

    expect(mockTidalAdd).toHaveBeenCalledOnce(); // never landed -> retried
    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [3], []);
  });

  it("conservatively flips without re-adding on an unexpected count (documented fallback)", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ position: 0, dest_track_id: "td-0" })]);
    mockReadDestItemCount.mockResolvedValueOnce(999); // neither pre-write nor pre-write+1
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const job = makeJob({ dest_playlist_id: "existing-dest", written: 0, write_batch_positions: [0] });
    await runWritePhaseStep(mockEnv, job);

    expect(mockTidalAdd).not.toHaveBeenCalled();
    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [0], []);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("copy_write_reconcile_unexpected_count"));
    logSpy.mockRestore();
  });

  it("ignores a stale marker referring to a different (already-resolved) batch and writes the new one fresh", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ position: 9, dest_track_id: "td-9" })]);
    mockTidalAdd.mockResolvedValueOnce({ added: 1, invalidIds: [], errors: 0 });

    // Marker refers to positions [0,1], which are no longer 'matched' (already
    // resolved) — the current selection is [9], a fresh, unrelated batch.
    const job = makeJob({ dest_playlist_id: "existing-dest", write_batch_positions: [0, 1] });
    await runWritePhaseStep(mockEnv, job);

    expect(mockReadDestItemCount).not.toHaveBeenCalled();
    expect(mockSetWriteBatchPositions).toHaveBeenCalledWith(mockEnv, "job-1", [9]);
    expect(mockTidalAdd).toHaveBeenCalledWith(mockEnv, "existing-dest", ["td-9"]);
  });

  it("clears a stale marker when every candidate this tick is an append-dedup skip (toWrite empty)", async () => {
    // candidates.length > 0 (so we get past the fetch), but every one of them
    // is already known (append dedup) -> toWrite ends up empty.
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ position: 2, dest_track_id: "already-there" })]);
    const job = makeJob({
      dest_mode: "append",
      dest_playlist_id: "existing-dest",
      dest_known_ids: ["already-there"],
      write_batch_positions: [0, 1],
    });

    await runWritePhaseStep(mockEnv, job);

    expect(mockUpdateTracksState).toHaveBeenCalledWith(mockEnv, "job-1", [2], "skipped", "already_present");
    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [], []);
    expect(mockReadDestItemCount).not.toHaveBeenCalled();
  });
});

describe("S1: write results are consumed, not assumed", () => {
  it("flips invalid ids to write_failed and the rest to written (Tidal partial invalid)", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([
      makeTrack({ position: 0, dest_track_id: "td-good" }),
      makeTrack({ position: 1, dest_track_id: "td-bad" }),
    ]);
    mockTidalAdd.mockResolvedValueOnce({ added: 1, invalidIds: ["td-bad"], errors: 0 });

    await runWritePhaseStep(mockEnv, makeJob({ dest_playlist_id: "existing-dest" }));

    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [0], [1]);
  });

  it("leaves all non-invalid rows 'matched' (no flip) when the Tidal batch errors out", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ position: 0, dest_track_id: "td-0" })]);
    mockTidalAdd.mockResolvedValueOnce({ added: 0, invalidIds: [], errors: 1 });

    await runWritePhaseStep(mockEnv, makeJob({ dest_playlist_id: "existing-dest" }));

    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [], []);
  });

  it("leaves the row 'matched' (no flip) when the Spotify add is rate-limited/aborted", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ position: 0, dest_track_id: "sp-0" })]);
    mockSpotifyAdd.mockResolvedValueOnce({ added: 0, snapshotId: null, rateLimited: true });

    await runWritePhaseStep(
      mockEnv,
      makeJob({ direction: "tidal_to_spotify", dest_playlist_id: "existing-dest" }),
    );

    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [], []);
  });

  it("flips to written when the Spotify add succeeds", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([makeTrack({ position: 0, dest_track_id: "sp-0" })]);
    mockSpotifyAdd.mockResolvedValueOnce({ added: 1, snapshotId: "s", rateLimited: false });

    await runWritePhaseStep(
      mockEnv,
      makeJob({ direction: "tidal_to_spotify", dest_playlist_id: "existing-dest" }),
    );

    expect(mockResolveWriteBatch).toHaveBeenCalledWith(mockEnv, "job-1", [0], []);
  });
});

describe("no-op when there is nothing to write", () => {
  it("does nothing when listMatchedForWrite returns no rows and dest already exists", async () => {
    mockListMatchedForWrite.mockResolvedValueOnce([]);
    await runWritePhaseStep(mockEnv, makeJob({ dest_playlist_id: "existing-dest" }));
    expect(mockTidalAdd).not.toHaveBeenCalled();
    expect(mockUpdateTracksState).not.toHaveBeenCalled();
    expect(mockResolveWriteBatch).not.toHaveBeenCalled();
  });
});
