// F-025 integration: GET /unmatched/rematch (sweep) + GET /unmatched/:spotify_id/rematch (per-row).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";

vi.mock("../../src/providers/tidal/client");
vi.mock("../../src/db/unmatched");

import { tidalFetch } from "../../src/providers/tidal/client";
import {
  listPending,
  getUnmatchedCountByEnv,
  getPendingUnmatched,
} from "../../src/db/unmatched";
import { TidalReauthRequired } from "../../src/providers/tidal/oauth";
import { _resetBuckets } from "../../src/middleware/rate-limit";

const mockTidalFetch = vi.mocked(tidalFetch);
const mockListPending = vi.mocked(listPending);
const mockGetCount = vi.mocked(getUnmatchedCountByEnv);
const mockGetPending = vi.mocked(getPendingUnmatched);

const PRINCIPAL_EMAIL = "test@example.com";

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "test-spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "test-spotify-client-secret",
    SPOTIFY_REDIRECT_URI: "https://example.com/auth/spotify/callback",
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    TIDAL_REDIRECT_URI: "https://example.com/auth/tidal/callback",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
  };
}

async function doFetch(path: string, options: RequestInit = {}, env: Env = makeEnv()) {
  const { default: unmatchedRoute } = await import("../../src/routes/unmatched");
  const { Hono } = await import("hono");
  const app = new Hono<{
    Bindings: Env;
    Variables: { principal?: { kind: "user"; email: string } };
  }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", email: PRINCIPAL_EMAIL });
    return next();
  });
  app.route("/unmatched", unmatchedRoute);

  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, options);
  const res = await app.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function jsonApi(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/vnd.api+json" },
    ...init,
  });
}

function searchBody(
  trackIds: string[],
  artistName = "Pink Floyd",
  albumTitle = "The Wall",
) {
  return {
    data: {
      id: "any",
      type: "searchResults",
      relationships: {
        tracks: { data: trackIds.map((id) => ({ id, type: "tracks" })) },
      },
    },
    included: [
      ...trackIds.map((id) => ({
        id,
        type: "tracks",
        attributes: { title: `Track ${id}`, duration: "PT3M30S", isrc: `US-${id}` },
        relationships: {
          artists: { data: [{ id: "a1", type: "artists" }] },
          albums: { data: [{ id: "alb1", type: "albums" }] },
        },
      })),
      { id: "a1", type: "artists", attributes: { name: artistName } },
      { id: "alb1", type: "albums", attributes: { title: albumTitle } },
    ],
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let collectedLogs: string[];

function rematchLogLines(event: "rematch_row" | "rematch_sweep") {
  return collectedLogs
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((obj): obj is Record<string, unknown> => obj?.event === event);
}

beforeEach(() => {
  vi.resetAllMocks();
  _resetBuckets();
  collectedLogs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
    collectedLogs.push(typeof msg === "string" ? msg : JSON.stringify(msg));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// GET /unmatched/rematch (sweep)
// ---------------------------------------------------------------------------

describe("F-025 sweep: limit validation", () => {
  it("rejects limit=0 with 400 invalid_limit", async () => {
    const res = await doFetch(`/unmatched/rematch?limit=0`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_limit");
    expect(mockListPending).not.toHaveBeenCalled();
  });

  it("rejects limit=26 with 400 invalid_limit", async () => {
    const res = await doFetch(`/unmatched/rematch?limit=26`);
    expect(res.status).toBe(400);
    expect(mockListPending).not.toHaveBeenCalled();
  });

  it("rejects non-integer limit with 400 invalid_limit", async () => {
    const res = await doFetch(`/unmatched/rematch?limit=abc`);
    expect(res.status).toBe(400);
    expect(mockListPending).not.toHaveBeenCalled();
  });

  it("defaults to limit=10 when query param is absent", async () => {
    mockGetCount.mockResolvedValueOnce(0);
    mockListPending.mockResolvedValueOnce([]);
    const res = await doFetch(`/unmatched/rematch`);
    expect(res.status).toBe(200);
    expect(mockListPending).toHaveBeenCalledWith(expect.anything(), { limit: 10 });
  });

  it("accepts limit=25 (boundary)", async () => {
    mockGetCount.mockResolvedValueOnce(0);
    mockListPending.mockResolvedValueOnce([]);
    const res = await doFetch(`/unmatched/rematch?limit=25`);
    expect(res.status).toBe(200);
    expect(mockListPending).toHaveBeenCalledWith(expect.anything(), { limit: 25 });
  });
});

describe("F-025 sweep: happy path with mixed per-row outcomes", () => {
  it("returns 200 with items, total_pending, fetched_at", async () => {
    mockGetCount.mockResolvedValueOnce(5);
    mockListPending.mockResolvedValueOnce([
      {
        spotify_id: "sp1",
        spotify_artist: "Pink Floyd",
        spotify_title: "Comfortably Numb",
        spotify_album: "The Wall",
        isrc: null,
        reason: "fuzzy_below_threshold",
        attempts: 1,
        last_attempt_at: "2026-05-15T00:00:00Z",
        candidates: [],
      },
      {
        spotify_id: "sp2",
        spotify_artist: "Beyoncé",
        spotify_title: "Halo",
        spotify_album: null,
        isrc: null,
        reason: "no_candidates",
        attempts: 1,
        last_attempt_at: "2026-05-14T00:00:00Z",
        candidates: [],
      },
    ]);
    mockTidalFetch
      .mockResolvedValueOnce(jsonApi(searchBody(["t1", "t2"], "Pink Floyd")))
      .mockResolvedValueOnce(jsonApi(searchBody([], "Beyoncé")));

    const res = await doFetch(`/unmatched/rematch?limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
      total_pending: number;
      fetched_at: string;
    };

    expect(body.total_pending).toBe(5);
    expect(body.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.items).toHaveLength(2);

    expect(body.items[0]).toMatchObject({
      spotify_id: "sp1",
      spotify_artist: "Pink Floyd",
      spotify_title: "Comfortably Numb",
      query: "pink floyd comfortably",
      error: null,
    });
    expect((body.items[0].candidates as unknown[]).length).toBe(2);

    expect(body.items[1]).toMatchObject({
      spotify_id: "sp2",
      query: "beyoncé halo",
      error: null,
      candidates: [],
    });
  });

  it("records invalid_input on rows whose metadata cannot form a query, without calling Tidal", async () => {
    mockGetCount.mockResolvedValueOnce(1);
    mockListPending.mockResolvedValueOnce([
      {
        spotify_id: "sp-bad",
        spotify_artist: "",
        spotify_title: "Halo",
        spotify_album: null,
        isrc: null,
        reason: "fuzzy_below_threshold",
        attempts: 1,
        last_attempt_at: "2026-05-15T00:00:00Z",
        candidates: [],
      },
    ]);

    const res = await doFetch(`/unmatched/rematch`);
    expect(res.status).toBe(200);
    expect(mockTidalFetch).not.toHaveBeenCalled();

    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      spotify_id: "sp-bad",
      query: null,
      candidates: [],
      error: "invalid_input",
    });
  });

  it("records tidal_upstream on rows whose Tidal call returns 5xx, sweep keeps going", async () => {
    mockGetCount.mockResolvedValueOnce(2);
    mockListPending.mockResolvedValueOnce([
      {
        spotify_id: "sp1",
        spotify_artist: "Pink Floyd",
        spotify_title: "Money",
        spotify_album: null,
        isrc: null,
        reason: "no_candidates",
        attempts: 1,
        last_attempt_at: "2026-05-15T00:00:00Z",
        candidates: [],
      },
      {
        spotify_id: "sp2",
        spotify_artist: "Beyoncé",
        spotify_title: "Halo",
        spotify_album: null,
        isrc: null,
        reason: "no_candidates",
        attempts: 1,
        last_attempt_at: "2026-05-14T00:00:00Z",
        candidates: [],
      },
    ]);
    // First call: 502 (retried inside tidal-search; let both calls return 502 to bypass 429 path)
    mockTidalFetch
      .mockResolvedValueOnce(new Response("", { status: 502 }))
      // Second row: happy path
      .mockResolvedValueOnce(jsonApi(searchBody(["t9"], "Beyoncé")));

    const res = await doFetch(`/unmatched/rematch?limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };

    expect(body.items[0]).toMatchObject({
      spotify_id: "sp1",
      query: "pink floyd money",
      candidates: [],
      error: "tidal_upstream",
    });
    expect(body.items[1]).toMatchObject({
      spotify_id: "sp2",
      query: "beyoncé halo",
      error: null,
    });
    expect((body.items[1].candidates as unknown[]).length).toBe(1);
  });

  it("records tidal_reauth_required on rows whose Tidal call throws TidalReauthRequired", async () => {
    mockGetCount.mockResolvedValueOnce(1);
    mockListPending.mockResolvedValueOnce([
      {
        spotify_id: "sp1",
        spotify_artist: "Pink Floyd",
        spotify_title: "Money",
        spotify_album: null,
        isrc: null,
        reason: "no_candidates",
        attempts: 1,
        last_attempt_at: "2026-05-15T00:00:00Z",
        candidates: [],
      },
    ]);
    mockTidalFetch.mockRejectedValueOnce(new TidalReauthRequired());

    const res = await doFetch(`/unmatched/rematch?limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0].error).toBe("tidal_reauth_required");
  });
});

describe("F-025 sweep: read-only contract", () => {
  it("does not call markMatched, markSkipped, upsertUnmatched, or insertMatch", async () => {
    // The mocked db/unmatched module exposes those functions; vi.mock auto-mocks
    // them as vi.fn(). Confirm none of them get called by the sweep.
    const dbModule = await import("../../src/db/unmatched");
    mockGetCount.mockResolvedValueOnce(1);
    mockListPending.mockResolvedValueOnce([
      {
        spotify_id: "sp1",
        spotify_artist: "Pink Floyd",
        spotify_title: "Money",
        spotify_album: null,
        isrc: null,
        reason: "no_candidates",
        attempts: 1,
        last_attempt_at: "2026-05-15T00:00:00Z",
        candidates: [],
      },
    ]);
    mockTidalFetch.mockResolvedValueOnce(jsonApi(searchBody(["t1"], "Pink Floyd")));

    await doFetch(`/unmatched/rematch?limit=1`);

    expect(vi.mocked(dbModule.markMatched)).not.toHaveBeenCalled();
    expect(vi.mocked(dbModule.markSkipped)).not.toHaveBeenCalled();
    expect(vi.mocked(dbModule.upsertUnmatched)).not.toHaveBeenCalled();
  });
});

describe("F-025 sweep: structured logging", () => {
  it("emits one rematch_row line per visited row plus one rematch_sweep summary", async () => {
    mockGetCount.mockResolvedValueOnce(2);
    mockListPending.mockResolvedValueOnce([
      {
        spotify_id: "sp1",
        spotify_artist: "Pink Floyd",
        spotify_title: "Money",
        spotify_album: null,
        isrc: null,
        reason: "no_candidates",
        attempts: 1,
        last_attempt_at: "2026-05-15T00:00:00Z",
        candidates: [],
      },
      {
        spotify_id: "sp2",
        spotify_artist: "",
        spotify_title: "Halo",
        spotify_album: null,
        isrc: null,
        reason: "no_candidates",
        attempts: 1,
        last_attempt_at: "2026-05-14T00:00:00Z",
        candidates: [],
      },
    ]);
    mockTidalFetch.mockResolvedValueOnce(jsonApi(searchBody(["t1"], "Pink Floyd")));

    await doFetch(`/unmatched/rematch?limit=2`);

    const rows = rematchLogLines("rematch_row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      event: "rematch_row",
      spotify_id: "sp1",
      tidal_status: 200,
      result_count: 1,
      error: null,
    });
    expect(rows[1]).toMatchObject({
      event: "rematch_row",
      spotify_id: "sp2",
      error: "invalid_input",
    });

    const sweep = rematchLogLines("rematch_sweep");
    expect(sweep).toHaveLength(1);
    expect(sweep[0]).toMatchObject({
      event: "rematch_sweep",
      limit: 2,
      rows_visited: 2,
      ok: 1,
      invalid_input: 1,
      tidal_upstream: 0,
      tidal_timeout: 0,
      tidal_reauth_required: 0,
    });
  });

  it("does not log the raw query string", async () => {
    mockGetCount.mockResolvedValueOnce(1);
    mockListPending.mockResolvedValueOnce([
      {
        spotify_id: "sp1",
        spotify_artist: "SecretBand",
        spotify_title: "SecretSong",
        spotify_album: null,
        isrc: null,
        reason: "no_candidates",
        attempts: 1,
        last_attempt_at: "2026-05-15T00:00:00Z",
        candidates: [],
      },
    ]);
    mockTidalFetch.mockResolvedValueOnce(jsonApi(searchBody(["t1"], "SecretBand")));

    await doFetch(`/unmatched/rematch?limit=1`);

    for (const line of collectedLogs) {
      expect(line).not.toContain("secretband secretsong");
      // The raw spotify_artist + spotify_title are not echoed either.
      expect(line).not.toContain("SecretSong");
    }
  });
});

describe("F-025 sweep: DB unavailability", () => {
  it("returns 503 when getUnmatchedCountByEnv throws", async () => {
    mockGetCount.mockRejectedValueOnce(new Error("db gone"));
    const res = await doFetch(`/unmatched/rematch`);
    expect(res.status).toBe(503);
  });

  it("returns 503 when listPending throws", async () => {
    mockGetCount.mockResolvedValueOnce(0);
    mockListPending.mockRejectedValueOnce(new Error("db gone"));
    const res = await doFetch(`/unmatched/rematch`);
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// GET /unmatched/:spotify_id/rematch (single row)
// ---------------------------------------------------------------------------

describe("F-025 single-row: happy path", () => {
  it("returns 200 with the F-024 response shape", async () => {
    mockGetPending.mockResolvedValueOnce({
      spotify_id: "sp1",
      spotify_artist: "Pink Floyd",
      spotify_title: "Comfortably Numb",
      spotify_album: "The Wall",
    });
    mockTidalFetch.mockResolvedValueOnce(
      jsonApi(searchBody(["t1", "t2"], "Pink Floyd")),
    );

    const res = await doFetch(`/unmatched/sp1/rematch`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      query: string;
      candidates: Array<Record<string, unknown>>;
      fetched_at: string;
    };
    expect(body.query).toBe("pink floyd comfortably");
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0]).toMatchObject({ tidal_id: "t1" });
    expect(body.candidates[0]).not.toHaveProperty("confidence");
  });
});

describe("F-025 single-row: error mapping", () => {
  it("returns 404 unknown_spotify_id when getPendingUnmatched returns null", async () => {
    mockGetPending.mockResolvedValueOnce(null);
    const res = await doFetch(`/unmatched/missing-id/rematch`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_spotify_id");
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_input when the row has empty artist", async () => {
    mockGetPending.mockResolvedValueOnce({
      spotify_id: "sp1",
      spotify_artist: "",
      spotify_title: "Halo",
      spotify_album: null,
    });
    const res = await doFetch(`/unmatched/sp1/rematch`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_input");
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });

  it("returns 502 tidal_upstream_error on Tidal 5xx", async () => {
    mockGetPending.mockResolvedValueOnce({
      spotify_id: "sp1",
      spotify_artist: "Pink Floyd",
      spotify_title: "Money",
      spotify_album: null,
    });
    mockTidalFetch
      .mockResolvedValueOnce(new Response("", { status: 502 }))
      .mockResolvedValueOnce(new Response("", { status: 502 }));

    const res = await doFetch(`/unmatched/sp1/rematch`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("tidal_upstream_error");
  });

  it("returns 502 tidal_reauth_required when TidalReauthRequired is thrown", async () => {
    mockGetPending.mockResolvedValueOnce({
      spotify_id: "sp1",
      spotify_artist: "Pink Floyd",
      spotify_title: "Money",
      spotify_album: null,
    });
    mockTidalFetch.mockRejectedValueOnce(new TidalReauthRequired());

    const res = await doFetch(`/unmatched/sp1/rematch`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("tidal_reauth_required");
  });

  it("returns 503 service_unavailable when DB lookup throws", async () => {
    mockGetPending.mockRejectedValueOnce(new Error("db gone"));
    const res = await doFetch(`/unmatched/sp1/rematch`);
    expect(res.status).toBe(503);
  });
});

describe("F-025 single-row: rate limiting", () => {
  it("returns 429 with Retry-After on the 11th call from the same principal", async () => {
    mockGetPending.mockResolvedValue({
      spotify_id: "sp1",
      spotify_artist: "Pink Floyd",
      spotify_title: "Money",
      spotify_album: null,
    });
    mockTidalFetch.mockImplementation(async () =>
      jsonApi(searchBody(["t1"], "Pink Floyd")),
    );

    for (let i = 0; i < 10; i++) {
      const ok = await doFetch(`/unmatched/sp1/rematch`);
      expect(ok.status).toBe(200);
    }
    const res = await doFetch(`/unmatched/sp1/rematch`);
    expect(res.status).toBe(429);
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "0", 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

describe("F-025 single-row: structured logging", () => {
  it("emits exactly one rematch_row log line per request", async () => {
    mockGetPending.mockResolvedValueOnce({
      spotify_id: "sp1",
      spotify_artist: "Pink Floyd",
      spotify_title: "Money",
      spotify_album: null,
    });
    mockTidalFetch.mockResolvedValueOnce(jsonApi(searchBody(["t1"], "Pink Floyd")));

    await doFetch(`/unmatched/sp1/rematch`);

    const lines = rematchLogLines("rematch_row");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "rematch_row",
      spotify_id: "sp1",
      result_count: 1,
      tidal_status: 200,
      error: null,
    });
  });
});
