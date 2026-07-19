import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import type { Env } from "../../../src/env";
import type { CopyJobRow } from "../../../src/db/copy_jobs";

vi.mock("../../../src/db/copy_jobs", () => ({
  createJob: vi.fn(),
  loadActiveJob: vi.fn(),
  getJob: vi.fn(),
  listJobs: vi.fn(),
  cancelJob: vi.fn(),
  recomputeCounters: vi.fn(),
  recomputeCountersForJobs: vi.fn(),
}));
vi.mock("../../../src/db/copy_job_tracks", () => ({ listTracksPage: vi.fn() }));
vi.mock("../../../src/db/provider_tokens", () => ({ hasSpotifyScopes: vi.fn() }));
vi.mock("../../../src/routes/copy/shared", () => ({
  findOwnPlaylist: vi.fn(),
  resolveSourceName: vi.fn(),
  directionFor: (p: string) => (p === "spotify" ? "spotify_to_tidal" : "tidal_to_spotify"),
  destProviderFor: (p: string) => (p === "spotify" ? "tidal" : "spotify"),
}));
vi.mock("../../../src/copy/dest-reader", () => ({ snapshotDestTracks: vi.fn() }));
vi.mock("../../../src/copy/notify", () => ({ notifyCopyJobTerminal: vi.fn() }));

import copyJobsRoute from "../../../src/routes/copy/jobs";
import {
  createJob,
  loadActiveJob,
  getJob,
  listJobs,
  cancelJob,
  recomputeCounters,
  recomputeCountersForJobs,
} from "../../../src/db/copy_jobs";
import { listTracksPage } from "../../../src/db/copy_job_tracks";
import { hasSpotifyScopes } from "../../../src/db/provider_tokens";
import { findOwnPlaylist, resolveSourceName } from "../../../src/routes/copy/shared";
import { snapshotDestTracks } from "../../../src/copy/dest-reader";
import { notifyCopyJobTerminal } from "../../../src/copy/notify";

const mockCreateJob = vi.mocked(createJob);
const mockLoadActiveJob = vi.mocked(loadActiveJob);
const mockGetJob = vi.mocked(getJob);
const mockListJobs = vi.mocked(listJobs);
const mockCancelJob = vi.mocked(cancelJob);
const mockRecomputeCounters = vi.mocked(recomputeCounters);
const mockRecomputeCountersForJobs = vi.mocked(recomputeCountersForJobs);
const mockListTracksPage = vi.mocked(listTracksPage);
const mockHasSpotifyScopes = vi.mocked(hasSpotifyScopes);
const mockFindOwnPlaylist = vi.mocked(findOwnPlaylist);
const mockResolveSourceName = vi.mocked(resolveSourceName);
const mockSnapshotDestTracks = vi.mocked(snapshotDestTracks);
const mockNotifyCopyJobTerminal = vi.mocked(notifyCopyJobTerminal);

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
    dest_playlist_id: null,
    dest_name: "Src",
    status: "queued",
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
  app.route("/api/copy", copyJobsRoute);

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
  mockHasSpotifyScopes.mockResolvedValue(true);
  mockRecomputeCountersForJobs.mockResolvedValue(new Map());
});

describe("POST /api/copy/jobs — new-playlist job (D9 scenario: New-playlist job created)", () => {
  it("creates a queued job with dest_name defaulted to the source name", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    mockResolveSourceName.mockResolvedValueOnce("My Source Playlist");
    mockCreateJob.mockResolvedValueOnce(makeJobRow({ job_id: "new-job-1" }));

    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: { source_provider: "spotify", source_playlist_id: "src-1", dest_mode: "new" },
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ job_id: "new-job-1" });
    expect(mockCreateJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        direction: "spotify_to_tidal",
        source_name: "My Source Playlist",
        dest_name: "My Source Playlist",
        dest_mode: "new",
      }),
    );
  });

  it("honors an explicit dest_name override even for dest_mode='new'", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    mockResolveSourceName.mockResolvedValueOnce("My Source Playlist");
    mockCreateJob.mockResolvedValueOnce(makeJobRow());

    await doFetch("/api/copy/jobs", {
      method: "POST",
      body: {
        source_provider: "spotify",
        source_playlist_id: "src-1",
        dest_mode: "new",
        dest_name: "Renamed By Operator",
      },
    });

    expect(mockCreateJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dest_name: "Renamed By Operator" }),
    );
  });
});

describe("POST /api/copy/jobs — append job (D9 scenario: Append job snapshots destination)", () => {
  it("validates ownership, snapshots dest_known_ids, and creates the job", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    mockResolveSourceName.mockResolvedValueOnce("Tidal Source");
    mockFindOwnPlaylist.mockResolvedValueOnce(true);
    mockSnapshotDestTracks.mockResolvedValueOnce({ ids: ["sp1", "sp2"], oversized: false });
    mockCreateJob.mockResolvedValueOnce(makeJobRow({ job_id: "append-job" }));

    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: {
        source_provider: "tidal",
        source_playlist_id: "tidal-src",
        dest_mode: "append",
        dest_playlist_id: "spotify-dest",
      },
    });

    expect(res.status).toBe(201);
    expect(mockCreateJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        direction: "tidal_to_spotify",
        dest_mode: "append",
        dest_playlist_id: "spotify-dest",
        dest_known_ids: ["sp1", "sp2"],
      }),
    );
  });

  it("returns 422 when dest_playlist_id is missing for append mode", async () => {
    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: { source_provider: "spotify", source_playlist_id: "src-1", dest_mode: "append" },
    });
    expect(res.status).toBe(422);
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it("returns 422 when the append destination is not owned by the operator", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    mockResolveSourceName.mockResolvedValueOnce("Src");
    mockFindOwnPlaylist.mockResolvedValueOnce(false);

    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: {
        source_provider: "spotify",
        source_playlist_id: "src-1",
        dest_mode: "append",
        dest_playlist_id: "not-mine",
      },
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "dest_not_owned" });
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it("returns 422 dest_too_large when the snapshot exceeds the cap (D3/D9 oversized scenario)", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    mockResolveSourceName.mockResolvedValueOnce("Src");
    mockFindOwnPlaylist.mockResolvedValueOnce(true);
    mockSnapshotDestTracks.mockResolvedValueOnce({ ids: [], oversized: true });

    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: {
        source_provider: "spotify",
        source_playlist_id: "src-1",
        dest_mode: "append",
        dest_playlist_id: "huge-dest",
      },
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "dest_too_large" });
    expect(mockCreateJob).not.toHaveBeenCalled();
  });
});

describe("POST /api/copy/jobs — validation and concurrency", () => {
  it("returns 422 for an invalid source_provider", async () => {
    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: { source_provider: "deezer", source_playlist_id: "x", dest_mode: "new" },
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 for an invalid dest_mode", async () => {
    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: { source_provider: "spotify", source_playlist_id: "x", dest_mode: "overwrite" },
    });
    expect(res.status).toBe(422);
  });

  it("returns 400 on unparseable JSON body", async () => {
    const { jwtMiddleware } = await import("../../../src/middleware/auth");
    const env = makeEnv();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", jwtMiddleware([]));
    app.route("/api/copy", copyJobsRoute);
    const ctx = createExecutionContext();
    const req = new Request("https://worker.test/api/copy/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await mintBearer(env.JWT_SECRET)}` },
      body: "not-json",
    });
    const res = await app.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("returns 409 job_already_active when a non-terminal job already exists (D9 scenario)", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(makeJobRow({ status: "matching" }));

    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: { source_provider: "spotify", source_playlist_id: "src-1", dest_mode: "new" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "job_already_active" });
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it("returns 409 spotify_reauth_required when the required Spotify scope is missing", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    mockHasSpotifyScopes.mockResolvedValueOnce(false);

    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: { source_provider: "spotify", source_playlist_id: "src-1", dest_mode: "new" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "spotify_reauth_required" });
  });

  it("returns 422 unknown_playlist when the source playlist can't be resolved", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    mockResolveSourceName.mockResolvedValueOnce(null);

    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: { source_provider: "tidal", source_playlist_id: "missing", dest_mode: "new" },
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "unknown_playlist" });
  });
});

describe("GET /api/copy/jobs — flat newest-first list", () => {
  it("returns 200 with jobs, defaulting limit to 20", async () => {
    mockListJobs.mockResolvedValueOnce([makeJobRow({ job_id: "j2" }), makeJobRow({ job_id: "j1" })]);
    const res = await doFetch("/api/copy/jobs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ job_id: string }> };
    expect(body.jobs.map((j) => j.job_id)).toEqual(["j2", "j1"]);
    expect(mockListJobs).toHaveBeenCalledWith(expect.anything(), 20);
  });

  it("honors an explicit limit query param", async () => {
    mockListJobs.mockResolvedValueOnce([]);
    await doFetch("/api/copy/jobs?limit=5");
    expect(mockListJobs).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it("freshens counters via recomputeCountersForJobs in exactly 2 DB queries total (S3)", async () => {
    mockListJobs.mockResolvedValueOnce([
      makeJobRow({ job_id: "j1", written: 0, matched: 3 }),
      makeJobRow({ job_id: "j2", written: 0, matched: 0 }),
    ]);
    mockRecomputeCountersForJobs.mockResolvedValueOnce(
      new Map([["j1", { fetched: 5, matched: 0, written: 5, unmatched: 0 }]]),
    );

    const res = await doFetch("/api/copy/jobs");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ job_id: string; written: number }> };
    // j1's stale written=0 is refreshed to the recomputed value.
    expect(body.jobs.find((j) => j.job_id === "j1")?.written).toBe(5);
    // j2 has no rows yet (absent from the map) — its own (zero) counters stand.
    expect(body.jobs.find((j) => j.job_id === "j2")?.written).toBe(0);
    expect(mockRecomputeCountersForJobs).toHaveBeenCalledWith(expect.anything(), ["j1", "j2"]);
    expect(mockListJobs).toHaveBeenCalledOnce();
    expect(mockRecomputeCountersForJobs).toHaveBeenCalledOnce();
  });
});

describe("GET /api/copy/jobs/:job_id — recomputed counters", () => {
  it("returns 200 with counters refreshed from copy_job_tracks", async () => {
    mockGetJob.mockResolvedValueOnce(makeJobRow({ matched: 1, written: 0 }));
    mockRecomputeCounters.mockResolvedValueOnce({ fetched: 5, matched: 0, written: 5, unmatched: 0 });

    const res = await doFetch("/api/copy/jobs/job-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: number };
    expect(body.written).toBe(5);
  });

  it("returns 404 for an unknown job_id", async () => {
    mockGetJob.mockResolvedValueOnce(null);
    const res = await doFetch("/api/copy/jobs/missing");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/copy/jobs/:job_id/tracks — state filter + paging (D9)", () => {
  it("returns 200 filtered to state=unmatched with candidates included", async () => {
    mockGetJob.mockResolvedValueOnce(makeJobRow());
    mockListTracksPage.mockResolvedValueOnce({
      tracks: [
        {
          job_id: "job-1",
          position: 0,
          source_track_id: "sp1",
          isrc: null,
          title: "T",
          artist: "A",
          album: null,
          duration_ms: null,
          state: "unmatched",
          match_method: null,
          confidence: null,
          dest_track_id: null,
          candidates: [{ id: "td-1", title: "T", artist: "A", album: null, duration_ms: null }],
          reason: "fuzzy_below_threshold",
          updated_at: "2026-07-18T00:00:00Z",
        },
      ],
      next_cursor: null,
    });

    const res = await doFetch("/api/copy/jobs/job-1/tracks?state=unmatched");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracks: Array<{ state: string; candidates: unknown[] }> };
    expect(body.tracks[0].state).toBe("unmatched");
    expect(body.tracks[0].candidates).toHaveLength(1);
    expect(mockListTracksPage).toHaveBeenCalledWith(
      expect.anything(),
      "job-1",
      expect.objectContaining({ state: "unmatched", limit: 50 }),
    );
  });

  it("returns 404 when the job does not exist", async () => {
    mockGetJob.mockResolvedValueOnce(null);
    const res = await doFetch("/api/copy/jobs/missing/tracks");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/copy/jobs/:job_id/cancel", () => {
  it("returns 200 and notifies on success", async () => {
    mockCancelJob.mockResolvedValueOnce("cancelled");
    mockGetJob.mockResolvedValueOnce(makeJobRow({ status: "cancelled", finished_at: "2026-07-18T00:05:00Z" }));

    const res = await doFetch("/api/copy/jobs/job-1/cancel", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "cancelled" });
    expect(mockNotifyCopyJobTerminal).toHaveBeenCalledOnce();
  });

  it("recomputes counters before notifying, so a stale written count isn't reported (N2)", async () => {
    mockCancelJob.mockResolvedValueOnce("cancelled");
    mockGetJob.mockResolvedValueOnce(
      makeJobRow({ status: "cancelled", finished_at: "2026-07-18T00:05:00Z", written: 0 }),
    );
    mockRecomputeCounters.mockResolvedValueOnce({ fetched: 5, matched: 0, written: 3, unmatched: 2 });

    await doFetch("/api/copy/jobs/job-1/cancel", { method: "POST", body: {} });

    expect(mockRecomputeCounters).toHaveBeenCalledWith(expect.anything(), "job-1");
    expect(mockNotifyCopyJobTerminal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ written: 3, unmatched: 2 }),
    );
  });

  it("returns 409 when the job is already terminal", async () => {
    mockCancelJob.mockResolvedValueOnce("already_terminal");
    const res = await doFetch("/api/copy/jobs/job-1/cancel", { method: "POST", body: {} });
    expect(res.status).toBe(409);
  });

  it("returns 404 when the job does not exist", async () => {
    mockCancelJob.mockResolvedValueOnce("not_found");
    const res = await doFetch("/api/copy/jobs/missing/cancel", { method: "POST", body: {} });
    expect(res.status).toBe(404);
  });
});

describe("unauthenticated", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await doFetch("/api/copy/jobs", { authed: false });
    expect(res.status).toBe(401);
    expect(mockListJobs).not.toHaveBeenCalled();
  });
});

describe("POST /api/copy/jobs — hardening", () => {
  it("maps a unique-violation race to 409 job_already_active", async () => {
    mockLoadActiveJob.mockResolvedValueOnce(null);
    mockResolveSourceName.mockResolvedValueOnce("My Source Playlist");
    mockCreateJob.mockResolvedValueOnce(null);
    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: { source_provider: "spotify", source_playlist_id: "src-1", dest_mode: "new" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "job_already_active" });
  });

  it("rejects an overlong source_playlist_id with 422", async () => {
    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: { source_provider: "spotify", source_playlist_id: "x".repeat(65), dest_mode: "new" },
    });
    expect(res.status).toBe(422);
    expect(mockLoadActiveJob).not.toHaveBeenCalled();
  });

  it("rejects an overlong dest_name with 422", async () => {
    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: {
        source_provider: "spotify",
        source_playlist_id: "src-1",
        dest_mode: "new",
        dest_name: "n".repeat(201),
      },
    });
    expect(res.status).toBe(422);
  });

  it("rejects an overlong dest_playlist_id with 422", async () => {
    const res = await doFetch("/api/copy/jobs", {
      method: "POST",
      body: {
        source_provider: "tidal",
        source_playlist_id: "src-1",
        dest_mode: "append",
        dest_playlist_id: "y".repeat(65),
      },
    });
    expect(res.status).toBe(422);
  });
});
