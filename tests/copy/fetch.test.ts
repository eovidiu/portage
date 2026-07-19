import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";
import type { CopyJobRow } from "../../src/db/copy_jobs";

vi.mock("../../src/copy/spotify-source", () => ({ getSpotifyPlaylistItems: vi.fn() }));
vi.mock("../../src/providers/tidal/playlist-items", () => ({
  getPlaylistItems: vi.fn(),
  resolveArtistNames: vi.fn(),
}));
vi.mock("../../src/db/copy_job_tracks", () => ({ insertFetchedPage: vi.fn() }));
vi.mock("../../src/db/tracks", () => ({ upsertTracks: vi.fn() }));
vi.mock("@neondatabase/serverless", () => ({ neon: () => vi.fn() }));

import { runFetchPhaseStep } from "../../src/copy/fetch";
import { getSpotifyPlaylistItems } from "../../src/copy/spotify-source";
import { getPlaylistItems, resolveArtistNames } from "../../src/providers/tidal/playlist-items";
import { insertFetchedPage } from "../../src/db/copy_job_tracks";
import { upsertTracks } from "../../src/db/tracks";

const mockGetSpotifyPlaylistItems = vi.mocked(getSpotifyPlaylistItems);
const mockGetPlaylistItems = vi.mocked(getPlaylistItems);
const mockResolveArtistNames = vi.mocked(resolveArtistNames);
const mockInsertFetchedPage = vi.mocked(insertFetchedPage);
const mockUpsertTracks = vi.mocked(upsertTracks);

const mockEnv = { DATABASE_URL: "postgresql://test" } as Env;

function makeJob(overrides: Partial<CopyJobRow> = {}): CopyJobRow {
  return {
    job_id: "job-1",
    direction: "spotify_to_tidal",
    source_playlist_id: "src-1",
    source_name: "Src",
    dest_mode: "new",
    dest_playlist_id: null,
    dest_name: "Src",
    status: "fetching",
    error_code: null,
    fetch_cursor: null,
    dest_known_ids: null,
    total_tracks: null,
    fetched: 0,
    matched: 0,
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runFetchPhaseStep — spotify_to_tidal", () => {
  it("fetches one page, upserts source tracks into `tracks`, and persists the page", async () => {
    mockGetSpotifyPlaylistItems.mockResolvedValueOnce({
      items: [
        { id: "sp1", isrc: "USABC1234567", title: "Song", artist: "Artist", album: "Album", duration_ms: 200000 },
      ],
      hasMore: true,
      cursor: "next-url",
    });

    await runFetchPhaseStep(mockEnv, makeJob());

    expect(mockGetSpotifyPlaylistItems).toHaveBeenCalledWith(mockEnv, "src-1", null);
    expect(mockUpsertTracks).toHaveBeenCalledOnce();
    const upsertRows = mockUpsertTracks.mock.calls[0][1];
    expect(upsertRows).toEqual([
      expect.objectContaining({ spotify_id: "sp1", isrc: "USABC1234567", artist: "Artist", title: "Song" }),
    ]);

    expect(mockInsertFetchedPage).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      expect.objectContaining({
        tracks: [
          {
            source_track_id: "sp1",
            isrc: "USABC1234567",
            title: "Song",
            artist: "Artist",
            album: "Album",
            duration_ms: 200000,
          },
        ],
        positionStart: 0,
        cursor: "next-url",
        isLastPage: false,
      }),
    );
  });

  it("marks the last page with totalTracks when hasMore is false", async () => {
    mockGetSpotifyPlaylistItems.mockResolvedValueOnce({
      items: [
        { id: "sp2", isrc: null, title: "Song 2", artist: null, album: null, duration_ms: null },
      ],
      hasMore: false,
      cursor: null,
    });

    await runFetchPhaseStep(mockEnv, makeJob({ fetched: 3 }));

    expect(mockInsertFetchedPage).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      expect.objectContaining({ positionStart: 3, isLastPage: true, totalTracks: 4 }),
    );
  });

  it("resumes from the persisted fetch_cursor", async () => {
    mockGetSpotifyPlaylistItems.mockResolvedValueOnce({ items: [], hasMore: false, cursor: null });
    await runFetchPhaseStep(mockEnv, makeJob({ fetch_cursor: "resume-url" }));
    expect(mockGetSpotifyPlaylistItems).toHaveBeenCalledWith(mockEnv, "src-1", "resume-url");
  });

  it("skips the tracks upsert when the page is empty", async () => {
    mockGetSpotifyPlaylistItems.mockResolvedValueOnce({ items: [], hasMore: false, cursor: null });
    await runFetchPhaseStep(mockEnv, makeJob());
    expect(mockUpsertTracks).not.toHaveBeenCalled();
  });
});

describe("runFetchPhaseStep — tidal_to_spotify", () => {
  it("resolves artist names and does not upsert into the sync `tracks` table", async () => {
    mockGetPlaylistItems.mockResolvedValueOnce({
      items: [{ tidalId: "td1", isrc: "GBABC1234567", title: "Song", durationMs: 180000, artistIds: ["art-1"] }],
      hasMore: false,
      cursor: null,
    });
    mockResolveArtistNames.mockResolvedValueOnce(new Map([["art-1", "Tidal Artist"]]));

    await runFetchPhaseStep(mockEnv, makeJob({ direction: "tidal_to_spotify", source_playlist_id: "tidal-src" }));

    expect(mockGetPlaylistItems).toHaveBeenCalledWith(mockEnv, "tidal-src", null);
    expect(mockResolveArtistNames).toHaveBeenCalledWith(mockEnv, ["art-1"]);
    expect(mockUpsertTracks).not.toHaveBeenCalled();
    expect(mockInsertFetchedPage).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      expect.objectContaining({
        tracks: [
          {
            source_track_id: "td1",
            isrc: "GBABC1234567",
            title: "Song",
            artist: "Tidal Artist",
            album: null,
            duration_ms: 180000,
          },
        ],
      }),
    );
  });

  it("leaves artist null when no artist ids resolve to a name", async () => {
    mockGetPlaylistItems.mockResolvedValueOnce({
      items: [{ tidalId: "td2", isrc: null, title: "Song 2", durationMs: null, artistIds: [] }],
      hasMore: false,
      cursor: null,
    });
    mockResolveArtistNames.mockResolvedValueOnce(new Map());

    await runFetchPhaseStep(mockEnv, makeJob({ direction: "tidal_to_spotify" }));

    const [, , params] = mockInsertFetchedPage.mock.calls[0];
    expect(params.tracks[0].artist).toBeNull();
  });
});
