import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import type { Env } from "../../../src/env";
import type { CopyJobRow } from "../../../src/db/copy_jobs";
import { _resetBuckets } from "../../../src/middleware/rate-limit";

vi.mock("../../../src/db/copy_jobs", () => ({ getJob: vi.fn() }));
vi.mock("../../../src/db/copy_job_tracks", () => ({ getTrack: vi.fn(), updateTrackMatch: vi.fn() }));
vi.mock("../../../src/match/tidal-search", () => ({ searchTidalCandidates: vi.fn() }));
vi.mock("../../../src/providers/spotify/search", () => ({ searchByText: vi.fn() }));
vi.mock("../../../src/providers/tidal/client", () => ({ tidalFetch: vi.fn() }));
vi.mock("../../../src/providers/spotify/oauth", () => ({ spotifyFetch: vi.fn() }));
vi.mock("../../../src/providers/tidal/playlist", () => ({ addTracksToPlaylist: vi.fn() }));
vi.mock("../../../src/providers/spotify/playlist-write", () => ({ addItems: vi.fn() }));

import copyManualRoute from "../../../src/routes/copy/manual";
import { getJob } from "../../../src/db/copy_jobs";
import { getTrack, updateTrackMatch } from "../../../src/db/copy_job_tracks";
import { searchTidalCandidates } from "../../../src/match/tidal-search";
import { searchByText } from "../../../src/providers/spotify/search";
import { tidalFetch } from "../../../src/providers/tidal/client";
import { spotifyFetch } from "../../../src/providers/spotify/oauth";
import { addTracksToPlaylist } from "../../../src/providers/tidal/playlist";
import { addItems } from "../../../src/providers/spotify/playlist-write";

const mockGetJob = vi.mocked(getJob);
const mockGetTrack = vi.mocked(getTrack);
const mockUpdateTrackMatch = vi.mocked(updateTrackMatch);
const mockSearchTidalCandidates = vi.mocked(searchTidalCandidates);
const mockSearchByText = vi.mocked(searchByText);
const mockTidalFetch = vi.mocked(tidalFetch);
const mockSpotifyFetch = vi.mocked(spotifyFetch);
const mockAddTracksToPlaylist = vi.mocked(addTracksToPlaylist);
const mockAddItems = vi.mocked(addItems);

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "",
    SPOTIFY_CLIENT_SECRET: "",
    SPOTIFY_REDIRECT_URI: "",
    TIDAL_CLIENT_ID: "",
    TIDAL_CLIENT_SECRET: "",
    TIDAL_REDIRECT_URI: "",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
  };
}

function makeJobRow(overrides: Partial<CopyJobRow> = {}): CopyJobRow {
  return {
    job_id: "job-1",
    direction: "spotify_to_tidal",
    source_playlist_id: "src-1",
    source_name: "Src",
    dest_mode: "new",
    dest_playlist_id: "dest-1",
    dest_name: "Src",
    status: "completed_with_unmatched",
    error_code: null,
    fetch_cursor: null,
    dest_known_ids: null,
    total_tracks: 1,
    fetched: 1,
    matched: 0,
    written: 0,
    unmatched: 1,
    created_at: "2026-07-18T00:00:00Z",
    updated_at: "2026-07-18T00:00:00Z",
    finished_at: "2026-07-18T01:00:00Z",
    ...overrides,
  };
}

function makeTrackRow() {
  return {
    job_id: "job-1",
    position: 0,
    source_track_id: "sp1",
    isrc: null,
    title: "Song",
    artist: "Artist",
    album: null,
    duration_ms: null,
    state: "unmatched" as const,
    match_method: null,
    confidence: null,
    dest_track_id: null,
    candidates: null,
    reason: "fuzzy_below_threshold",
    updated_at: "2026-07-18T00:00:00Z",
  };
}

async function mintBearer(secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("spotify-roon-sync")
    .setSubject("owner")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

async function doFetch(
  path: string,
  opts: { method?: string; body?: unknown; authed?: boolean } = {},
): Promise<Response> {
  const { jwtMiddleware } = await import("../../../src/middleware/auth");
  const env = makeEnv();
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", jwtMiddleware([]));
  app.route("/api/copy", copyManualRoute);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authed !== false) {
    headers["Authorization"] = `Bearer ${await mintBearer(env.JWT_SECRET)}`;
  }

  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await app.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetBuckets();
});

describe("GET /api/copy/search", () => {
  it("returns candidates from Tidal in the generic shape", async () => {
    mockSearchTidalCandidates.mockResolvedValueOnce({
      candidates: [
        { id: "td-1", title: "T", primaryArtist: "A", artists: ["A"], albumTitle: "Al", durationMs: 1000, isrc: null },
      ],
      retried: false,
      status: 200,
      bodyParseError: false,
    });

    const res = await doFetch("/api/copy/search?provider=tidal&q=foo");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      candidates: [{ id: "td-1", title: "T", artist: "A", album: "Al", duration_ms: 1000 }],
    });
  });

  it("returns candidates from Spotify in the generic shape", async () => {
    mockSearchByText.mockResolvedValueOnce({
      status: "ok",
      candidates: [
        { id: "sp-1", title: "T", primaryArtist: "A", artists: ["A"], albumTitle: "Al", durationMs: 2000, isrc: null },
      ],
    });

    const res = await doFetch("/api/copy/search?provider=spotify&q=foo");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      candidates: [{ id: "sp-1", title: "T", artist: "A", album: "Al", duration_ms: 2000 }],
    });
  });

  it("returns 422 for an invalid provider", async () => {
    const res = await doFetch("/api/copy/search?provider=deezer&q=foo");
    expect(res.status).toBe(422);
  });

  it("returns 422 for a missing query", async () => {
    const res = await doFetch("/api/copy/search?provider=tidal");
    expect(res.status).toBe(422);
  });

  it("rate-limits repeated requests from the same principal", async () => {
    mockSearchTidalCandidates.mockResolvedValue({
      candidates: [],
      retried: false,
      status: 200,
      bodyParseError: false,
    });
    for (let i = 0; i < 10; i++) {
      const res = await doFetch("/api/copy/search?provider=tidal&q=foo");
      expect(res.status).toBe(200);
    }
    const res = await doFetch("/api/copy/search?provider=tidal&q=foo");
    expect(res.status).toBe(429);
  });
});

describe("POST /api/copy/jobs/:job_id/tracks/:position/match (D9 scenarios)", () => {
  it("validates the id, appends it, and marks the row written/manual", async () => {
    mockGetJob.mockResolvedValueOnce(makeJobRow());
    mockGetTrack.mockResolvedValueOnce(makeTrackRow());
    mockTidalFetch.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    mockAddTracksToPlaylist.mockResolvedValueOnce({ added: 1, invalidIds: [], errors: 0 });

    const res = await doFetch("/api/copy/jobs/job-1/tracks/0/match", {
      method: "POST",
      body: { dest_track_id: "td-new" },
    });

    expect(res.status).toBe(200);
    expect(mockAddTracksToPlaylist).toHaveBeenCalledWith(expect.anything(), "dest-1", ["td-new"]);
    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      expect.anything(),
      "job-1",
      0,
      expect.objectContaining({ state: "written", match_method: "manual", dest_track_id: "td-new" }),
    );
  });

  it("returns 422 and leaves the row unmatched when the destination id doesn't resolve", async () => {
    mockGetJob.mockResolvedValueOnce(makeJobRow());
    mockGetTrack.mockResolvedValueOnce(makeTrackRow());
    mockTidalFetch.mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    const res = await doFetch("/api/copy/jobs/job-1/tracks/0/match", {
      method: "POST",
      body: { dest_track_id: "bad-id" },
    });

    expect(res.status).toBe(422);
    expect(mockAddTracksToPlaylist).not.toHaveBeenCalled();
    expect(mockUpdateTrackMatch).not.toHaveBeenCalled();
  });

  it("validates against Spotify for a tidal_to_spotify job", async () => {
    mockGetJob.mockResolvedValueOnce(makeJobRow({ direction: "tidal_to_spotify" }));
    mockGetTrack.mockResolvedValueOnce(makeTrackRow());
    mockSpotifyFetch.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    mockAddItems.mockResolvedValueOnce({ added: 1, snapshotId: "s", rateLimited: false });

    const res = await doFetch("/api/copy/jobs/job-1/tracks/0/match", {
      method: "POST",
      body: { dest_track_id: "sp-new" },
    });

    expect(res.status).toBe(200);
    expect(mockAddItems).toHaveBeenCalledWith(expect.anything(), "dest-1", ["sp-new"]);
  });

  it("returns 404 when the job does not exist", async () => {
    mockGetJob.mockResolvedValueOnce(null);
    const res = await doFetch("/api/copy/jobs/missing/tracks/0/match", {
      method: "POST",
      body: { dest_track_id: "x" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the job is not terminal", async () => {
    mockGetJob.mockResolvedValueOnce(makeJobRow({ status: "matching" }));
    const res = await doFetch("/api/copy/jobs/job-1/tracks/0/match", {
      method: "POST",
      body: { dest_track_id: "x" },
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 when the track position does not exist", async () => {
    mockGetJob.mockResolvedValueOnce(makeJobRow());
    mockGetTrack.mockResolvedValueOnce(null);
    const res = await doFetch("/api/copy/jobs/job-1/tracks/99/match", {
      method: "POST",
      body: { dest_track_id: "x" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when dest_track_id is missing from the body", async () => {
    mockGetJob.mockResolvedValueOnce(makeJobRow());
    mockGetTrack.mockResolvedValueOnce(makeTrackRow());
    const res = await doFetch("/api/copy/jobs/job-1/tracks/0/match", { method: "POST", body: {} });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/copy/jobs/:job_id/tracks/:position/skip", () => {
  it("marks the row skipped", async () => {
    mockGetJob.mockResolvedValueOnce(makeJobRow());
    mockGetTrack.mockResolvedValueOnce(makeTrackRow());

    const res = await doFetch("/api/copy/jobs/job-1/tracks/0/skip", { method: "POST", body: {} });

    expect(res.status).toBe(200);
    expect(mockUpdateTrackMatch).toHaveBeenCalledWith(
      expect.anything(),
      "job-1",
      0,
      expect.objectContaining({ state: "skipped" }),
    );
  });

  it("returns 404 for an unknown job", async () => {
    mockGetJob.mockResolvedValueOnce(null);
    const res = await doFetch("/api/copy/jobs/missing/tracks/0/skip", { method: "POST", body: {} });
    expect(res.status).toBe(404);
  });
});

describe("unauthenticated", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await doFetch("/api/copy/search?provider=tidal&q=foo", { authed: false });
    expect(res.status).toBe(401);
    expect(mockSearchTidalCandidates).not.toHaveBeenCalled();
  });
});
