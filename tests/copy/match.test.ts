import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";
import type { CopyJobRow } from "../../src/db/copy_jobs";
import type { CopyJobTrackRow } from "../../src/db/copy_job_tracks";

const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({ neon: () => mockSql }));

vi.mock("../../src/db/matches", () => ({ insertMatch: vi.fn() }));
vi.mock("../../src/db/copy_job_tracks", async () => {
  const actual = await vi.importActual("../../src/db/copy_job_tracks");
  return { ...actual, updateTrackMatch: vi.fn() };
});
vi.mock("../../src/providers/tidal/client", () => ({ tidalFetch: vi.fn() }));
vi.mock("../../src/match/tidal-search", () => ({ searchTidalCandidates: vi.fn() }));
vi.mock("../../src/providers/spotify/search", () => ({
  searchByIsrc: vi.fn(),
  searchByText: vi.fn(),
}));

import { runMatchPhaseStep } from "../../src/copy/match";
import { insertMatch } from "../../src/db/matches";
import { updateTrackMatch } from "../../src/db/copy_job_tracks";
import { tidalFetch } from "../../src/providers/tidal/client";
import { searchTidalCandidates } from "../../src/match/tidal-search";
import { searchByIsrc, searchByText } from "../../src/providers/spotify/search";

const mockInsertMatch = vi.mocked(insertMatch);
const mockUpdateTrackMatch = vi.mocked(updateTrackMatch);
const mockTidalFetch = vi.mocked(tidalFetch);
const mockSearchTidalCandidates = vi.mocked(searchTidalCandidates);
const mockSearchByIsrc = vi.mocked(searchByIsrc);
const mockSearchByText = vi.mocked(searchByText);

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
    status: "matching",
    error_code: null,
    fetch_cursor: null,
    dest_known_ids: null,
    total_tracks: 1,
    fetched: 1,
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

function makeTrack(overrides: Partial<CopyJobTrackRow> = {}): CopyJobTrackRow {
  return {
    job_id: "job-1",
    position: 0,
    source_track_id: "sp1",
    isrc: "USABC1234567",
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration_ms: 200000,
    state: "pending",
    match_method: null,
    confidence: null,
    dest_track_id: null,
    candidates: null,
    reason: null,
    updated_at: "2026-07-18T00:00:00Z",
    ...overrides,
  };
}

function tidalIsrcResponse(candidates: Array<{ id: string; artistName: string; durationIso: string }>) {
  return {
    data: candidates.map((c) => ({
      id: c.id,
      type: "tracks",
      attributes: { duration: c.durationIso },
      relationships: { artists: { data: [{ id: `art-${c.id}`, type: "artists" }] } },
    })),
    included: candidates.map((c) => ({
      id: `art-${c.id}`,
      type: "artists",
      attributes: { name: c.artistName },
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
});

describe("runMatchPhaseStep — pending fetch", () => {
  it("no-ops when there are no pending tracks", async () => {
    mockSql.mockResolvedValueOnce([]); // listPendingForMatch (real impl, mockSql used)
    await runMatchPhaseStep(mockEnv, makeJob(), 2, 2);
    expect(mockUpdateTrackMatch).not.toHaveBeenCalled();
  });
});

describe("spotify_to_tidal — cached match short-circuits (D4)", () => {
  it("marks matched/cached with no Tidal request when the spotify_id is already in matches", async () => {
    mockSql
      .mockResolvedValueOnce([makeTrack()]) // listPendingForMatch
      .mockResolvedValueOnce([{ spotify_id: "sp1", tidal_id: "td-cached", confidence: 0.95 }]); // cache lookup

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);

    expect(mockTidalFetch).not.toHaveBeenCalled();
    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      0,
      expect.objectContaining({
        state: "matched",
        match_method: "cached",
        dest_track_id: "td-cached",
        confidence: 0.95,
      }),
    );
  });
});

describe("spotify_to_tidal — ISRC match accepted", () => {
  it("writes back to matches and marks the row matched/isrc", async () => {
    mockSql
      .mockResolvedValueOnce([makeTrack()]) // listPendingForMatch
      .mockResolvedValueOnce([]); // cache lookup: no hits
    mockTidalFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => tidalIsrcResponse([{ id: "td-1", artistName: "Artist", durationIso: "PT3M20S" }]),
    } as Response);

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);

    expect(mockInsertMatch).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({ spotify_id: "sp1", tidal_id: "td-1", method: "isrc" }),
    );
    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      0,
      expect.objectContaining({ state: "matched", match_method: "isrc", dest_track_id: "td-1" }),
    );
  });

  it("falls through to fuzzy when the ISRC search has no agreeing candidate", async () => {
    mockSql
      .mockResolvedValueOnce([makeTrack()])
      .mockResolvedValueOnce([]);
    mockTidalFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => tidalIsrcResponse([{ id: "td-1", artistName: "Someone Else", durationIso: "PT3M20S" }]),
    } as Response);
    mockSearchTidalCandidates.mockResolvedValueOnce({
      candidates: [],
      retried: false,
      status: 200,
      bodyParseError: false,
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);

    expect(mockSearchTidalCandidates).toHaveBeenCalledOnce();
    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      0,
      expect.objectContaining({ state: "unmatched", reason: "no_candidates" }),
    );
  });
});

describe("spotify_to_tidal — fuzzy below threshold becomes unmatched with top-3 candidates", () => {
  it("persists candidates in the generic {id,title,artist,album,duration_ms} shape", async () => {
    mockSql
      .mockResolvedValueOnce([makeTrack({ isrc: null })]) // no isrc -> straight to fuzzy
      .mockResolvedValueOnce([]); // cache lookup
    mockSearchTidalCandidates.mockResolvedValueOnce({
      candidates: [
        {
          id: "td-low",
          title: "Totally Different Song",
          primaryArtist: "Nobody",
          artists: ["Nobody"],
          albumTitle: "X",
          durationMs: 999999,
          isrc: null,
        },
      ],
      retried: false,
      status: 200,
      bodyParseError: false,
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);

    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      0,
      expect.objectContaining({
        state: "unmatched",
        reason: "fuzzy_below_threshold",
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: "td-low", title: "Totally Different Song", artist: "Nobody" }),
        ]),
      }),
    );
  });
});

describe("tidal_to_spotify — reverse ISRC match accepted", () => {
  it("marks matched/isrc without writing to the sync matches cache", async () => {
    mockSql.mockResolvedValueOnce([makeTrack({ source_track_id: "td-src" })]); // listPendingForMatch
    mockSearchByIsrc.mockResolvedValueOnce({
      status: "matched",
      candidate: {
        id: "sp-1",
        title: "Song",
        primaryArtist: "Artist",
        artists: ["Artist"],
        albumTitle: "Album",
        durationMs: 200000,
        isrc: "USABC1234567",
      },
      confidence: 0.95,
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "tidal_to_spotify" }), 2, 2);

    expect(mockInsertMatch).not.toHaveBeenCalled();
    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      0,
      expect.objectContaining({ state: "matched", match_method: "isrc", dest_track_id: "sp-1" }),
    );
  });
});

describe("tidal_to_spotify — fuzzy below threshold becomes unmatched", () => {
  it("persists top-3 candidates and does not call insertMatch", async () => {
    mockSql.mockResolvedValueOnce([makeTrack({ source_track_id: "td-src", isrc: null })]);
    mockSearchByText.mockResolvedValueOnce({
      status: "ok",
      candidates: [
        {
          id: "sp-low",
          title: "Nope",
          primaryArtist: "Nobody",
          artists: ["Nobody"],
          albumTitle: "",
          durationMs: 1,
          isrc: null,
        },
      ],
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "tidal_to_spotify" }), 2, 2);

    expect(mockInsertMatch).not.toHaveBeenCalled();
    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      0,
      expect.objectContaining({ state: "unmatched", reason: "fuzzy_below_threshold" }),
    );
  });
});

describe("spotify_to_tidal — fuzzy match accepted (writes back to matches)", () => {
  it("marks matched/fuzzy and calls insertMatch when the top score clears the threshold", async () => {
    mockSql
      .mockResolvedValueOnce([makeTrack({ isrc: null })])
      .mockResolvedValueOnce([]); // cache lookup
    mockSearchTidalCandidates.mockResolvedValueOnce({
      candidates: [
        {
          id: "td-good",
          title: "Song",
          primaryArtist: "Artist",
          artists: ["Artist"],
          albumTitle: "Album",
          durationMs: 200000,
          isrc: null,
        },
      ],
      retried: false,
      status: 200,
      bodyParseError: false,
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);

    expect(mockInsertMatch).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({ tidal_id: "td-good", method: "fuzzy" }),
    );
    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      0,
      expect.objectContaining({ state: "matched", match_method: "fuzzy", dest_track_id: "td-good" }),
    );
  });
});

describe("spotify_to_tidal — rate_limited ends the tick early (B2)", () => {
  it("leaves the track pending and skips the fuzzy fallback on a 429 ISRC response", async () => {
    mockSql.mockResolvedValueOnce([makeTrack()]).mockResolvedValueOnce([]);
    mockTidalFetch.mockResolvedValueOnce({ ok: false, status: 429 } as Response);

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);

    expect(mockSearchTidalCandidates).not.toHaveBeenCalled();
    expect(mockUpdateTrackMatch).not.toHaveBeenCalled();
  });

  it("leaves the track pending on a 429 fuzzy response (no isrc)", async () => {
    mockSql.mockResolvedValueOnce([makeTrack({ isrc: null })]).mockResolvedValueOnce([]);
    mockSearchTidalCandidates.mockResolvedValueOnce({
      candidates: [],
      retried: true,
      status: 429,
      bodyParseError: false,
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);

    expect(mockUpdateTrackMatch).not.toHaveBeenCalled();
  });

  it("stops processing the fuzzy-only pool once an earlier track hits rate_limited", async () => {
    mockSql
      .mockResolvedValueOnce([
        makeTrack({ position: 0, source_track_id: "sp1", isrc: null }),
        makeTrack({ position: 1, source_track_id: "sp2", isrc: null }),
      ])
      .mockResolvedValueOnce([]); // cache lookup
    mockSearchTidalCandidates.mockResolvedValueOnce({
      candidates: [],
      retried: true,
      status: 429,
      bodyParseError: false,
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 0, 2);

    // Only track 1's fuzzy search runs; track 2 is left untouched this tick.
    expect(mockSearchTidalCandidates).toHaveBeenCalledOnce();
    expect(mockUpdateTrackMatch).not.toHaveBeenCalled();
  });
});

describe("tidal_to_spotify — rate_limited ends the tick early (B2)", () => {
  it("leaves the track pending when the ISRC search is rate_limited", async () => {
    mockSql.mockResolvedValueOnce([makeTrack({ source_track_id: "td-src" })]);
    mockSearchByIsrc.mockResolvedValueOnce({ status: "rate_limited" });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "tidal_to_spotify" }), 2, 2);

    expect(mockSearchByText).not.toHaveBeenCalled();
    expect(mockUpdateTrackMatch).not.toHaveBeenCalled();
  });

  it("leaves the track pending when the fuzzy text search is rate_limited", async () => {
    mockSql.mockResolvedValueOnce([makeTrack({ source_track_id: "td-src", isrc: null })]);
    mockSearchByText.mockResolvedValueOnce({ status: "rate_limited", candidates: [] });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "tidal_to_spotify" }), 2, 2);

    expect(mockUpdateTrackMatch).not.toHaveBeenCalled();
  });

  it("stops processing the fuzzy-only pool once an earlier track hits rate_limited", async () => {
    mockSql.mockResolvedValueOnce([
      makeTrack({ position: 0, source_track_id: "td1", isrc: null }),
      makeTrack({ position: 1, source_track_id: "td2", isrc: null }),
    ]);
    mockSearchByText.mockResolvedValueOnce({ status: "rate_limited", candidates: [] });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "tidal_to_spotify" }), 0, 2);

    // Only track 1's fuzzy search runs; track 2 is left untouched this tick.
    expect(mockSearchByText).toHaveBeenCalledOnce();
    expect(mockUpdateTrackMatch).not.toHaveBeenCalled();
  });
});

describe("spotify_to_tidal — ISRC search edge cases", () => {
  it("treats a non-ok response as no_match and falls through to fuzzy", async () => {
    mockSql.mockResolvedValueOnce([makeTrack()]).mockResolvedValueOnce([]);
    mockTidalFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    mockSearchTidalCandidates.mockResolvedValueOnce({
      candidates: [],
      retried: false,
      status: 200,
      bodyParseError: false,
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);
    expect(mockSearchTidalCandidates).toHaveBeenCalledOnce();
  });

  it("picks a duration-less candidate when neither side has a duration", async () => {
    mockSql
      .mockResolvedValueOnce([makeTrack({ duration_ms: null })])
      .mockResolvedValueOnce([]);
    mockTidalFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => tidalIsrcResponse([{ id: "td-nodur", artistName: "Artist", durationIso: "" }]),
    } as Response);

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);

    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      0,
      expect.objectContaining({ state: "matched", match_method: "isrc", dest_track_id: "td-nodur" }),
    );
  });

  it("treats a fuzzy search HTTP error as no candidates found", async () => {
    mockSql.mockResolvedValueOnce([makeTrack({ isrc: null })]).mockResolvedValueOnce([]);
    mockSearchTidalCandidates.mockResolvedValueOnce({
      candidates: [],
      retried: false,
      status: 500,
      bodyParseError: false,
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);

    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      0,
      expect.objectContaining({ state: "unmatched", reason: "no_candidates" }),
    );
  });
});

describe("fuzzy-only pool (tracks beyond isrcBudget skip straight to fuzzy)", () => {
  it("spotify_to_tidal: a second pending track with isrc goes to fuzzy when isrcBudget=1", async () => {
    mockSql
      .mockResolvedValueOnce([
        makeTrack({ position: 0, source_track_id: "sp1" }),
        makeTrack({ position: 1, source_track_id: "sp2" }),
      ])
      .mockResolvedValueOnce([]); // cache lookup
    mockTidalFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => tidalIsrcResponse([{ id: "td-1", artistName: "Artist", durationIso: "PT3M20S" }]),
    } as Response);
    mockSearchTidalCandidates.mockResolvedValueOnce({
      candidates: [],
      retried: false,
      status: 200,
      bodyParseError: false,
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 1, 1);

    // Track 2 never hits the ISRC endpoint (only 1 tidalFetch call total: track 1's ISRC lookup).
    expect(mockTidalFetch).toHaveBeenCalledOnce();
    expect(mockSearchTidalCandidates).toHaveBeenCalledOnce();
  });

  it("tidal_to_spotify: a second pending track skips ISRC search when isrcBudget=1", async () => {
    mockSql.mockResolvedValueOnce([
      makeTrack({ position: 0, source_track_id: "td1" }),
      makeTrack({ position: 1, source_track_id: "td2" }),
    ]);
    mockSearchByIsrc.mockResolvedValueOnce({ status: "no_match" });
    mockSearchByText.mockResolvedValue({ status: "ok", candidates: [] });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "tidal_to_spotify" }), 1, 1);

    expect(mockSearchByIsrc).toHaveBeenCalledOnce();
    expect(mockSearchByText).toHaveBeenCalledTimes(2);
  });
});

describe("ranking with multiple candidates", () => {
  it("sorts fuzzy candidates by descending score before applying the threshold", async () => {
    mockSql.mockResolvedValueOnce([makeTrack({ isrc: null })]).mockResolvedValueOnce([]);
    mockSearchTidalCandidates.mockResolvedValueOnce({
      candidates: [
        {
          id: "td-worse",
          title: "Some Other Song",
          primaryArtist: "Other",
          artists: ["Other"],
          albumTitle: "",
          durationMs: 1,
          isrc: null,
        },
        {
          id: "td-better",
          title: "Song",
          primaryArtist: "Artist",
          artists: ["Artist"],
          albumTitle: "Album",
          durationMs: 200000,
          isrc: null,
        },
      ],
      retried: false,
      status: 200,
      bodyParseError: false,
    });

    await runMatchPhaseStep(mockEnv, makeJob({ direction: "spotify_to_tidal" }), 2, 2);

    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      mockEnv,
      "job-1",
      0,
      expect.objectContaining({ state: "matched", dest_track_id: "td-better" }),
    );
  });
});

describe("budgets", () => {
  it("caps the pending-track fetch at isrcBudget + fuzzyBudget", async () => {
    mockSql.mockResolvedValueOnce([]);
    await runMatchPhaseStep(mockEnv, makeJob(), 2, 3);
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe(5);
  });
});
