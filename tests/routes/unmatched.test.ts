// T-012: Unmatched queue endpoint tests
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";

vi.mock("../../src/db/unmatched");
vi.mock("../../src/providers/tidal/client");

import { listPending, markMatched, markSkipped } from "../../src/db/unmatched";
import { tidalFetch } from "../../src/providers/tidal/client";

const mockListPending = vi.mocked(listPending);
const mockMarkMatched = vi.mocked(markMatched);
const mockMarkSkipped = vi.mocked(markSkipped);
const mockTidalFetch = vi.mocked(tidalFetch);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "test-spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "test-spotify-client-secret",
    SPOTIFY_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/spotify/callback",
    TIDAL_CLIENT_ID: "tidal-client-id",
    TIDAL_CLIENT_SECRET: "tidal-client-secret",
    TIDAL_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/tidal/callback",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
    ...overrides,
  };
}

async function doFetch(
  path: string,
  options: RequestInit = {},
  testEnv: Env = makeEnv(),
) {
  const { default: unmatchedRoute } = await import("../../src/routes/unmatched");
  const { Hono } = await import("hono");
  const app = new Hono<{ Bindings: Env }>();
  app.route("/unmatched", unmatchedRoute);

  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, options);
  const res = await app.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function makePendingRow(overrides = {}) {
  return {
    spotify_id: "3n3Ppam7vgaVa1iaRUc9Lp",
    spotify_artist: "Mr. Mister",
    spotify_title: "Kyrie",
    spotify_album: "Welcome to the Real World",
    isrc: "USRC18551064",
    reason: "fuzzy_below_threshold",
    attempts: 2,
    last_attempt_at: "2026-04-25T07:23:42.118Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// T-012-01: GET /unmatched requires JWT — tested via full app middleware
// The sub-router itself does not enforce JWT — it relies on src/index.ts middleware.
// We test here that an unauthenticated request to the full app returns 401.
describe("T-012-01: GET /unmatched — requires JWT", () => {
  it("returns 401 when Authorization header is absent (full app stack)", async () => {
    const { default: app } = await import("../../src/index");
    const ctx = createExecutionContext();
    const req = new Request("https://worker.test/unmatched", {
      headers: {},
    });
    const res = await app.fetch(req, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});

// T-012-02: GET /unmatched returns only pending rows
describe("T-012-02: GET /unmatched — returns pending rows only", () => {
  it("returns items array with only pending rows", async () => {
    mockListPending.mockResolvedValueOnce([
      makePendingRow({ spotify_id: "A" }),
      makePendingRow({ spotify_id: "B" }),
      makePendingRow({ spotify_id: "C" }),
    ]);

    const res = await doFetch("/unmatched?limit=20");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[] };
    expect(body.items).toHaveLength(3);
  });
});

// T-012-03: GET /unmatched orders by last_attempt_at DESC (ordering done at DB level)
describe("T-012-03: GET /unmatched — ordered by last_attempt_at DESC", () => {
  it("returns items in the order provided by listPending (DB orders DESC)", async () => {
    const rows = [
      makePendingRow({ spotify_id: "T3", last_attempt_at: "2026-04-25T09:00:00Z" }),
      makePendingRow({ spotify_id: "T2", last_attempt_at: "2026-04-25T08:00:00Z" }),
      makePendingRow({ spotify_id: "T1", last_attempt_at: "2026-04-25T07:00:00Z" }),
    ];
    mockListPending.mockResolvedValueOnce(rows);

    const res = await doFetch("/unmatched");
    const body = await res.json() as { items: Array<{ spotify_id: string }> };
    expect(body.items[0].spotify_id).toBe("T3");
    expect(body.items[2].spotify_id).toBe("T1");
  });
});

// T-012-04: Each item includes candidates (up to 5, passed through from DB)
describe("T-012-04: GET /unmatched — includes candidates", () => {
  it("includes candidates array on each item", async () => {
    const candidates = [
      { tidal_id: "1", title: "Kyrie", artist: "Mr. Mister", album: "Album", duration_ms: 263000, score: 0.83 },
    ];
    mockListPending.mockResolvedValueOnce([
      { ...makePendingRow(), candidates },
    ]);

    const res = await doFetch("/unmatched");
    const body = await res.json() as { items: Array<{ candidates: unknown[] }> };
    expect(body.items[0].candidates).toHaveLength(1);
  });
});

// T-012-05: Limit cap enforced at 100
describe("T-012-05: GET /unmatched — limit cap at 100", () => {
  it("passes limit=100 to listPending when limit=500 is requested", async () => {
    mockListPending.mockResolvedValueOnce([]);

    await doFetch("/unmatched?limit=500");
    expect(mockListPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("passes limit=20 as default when no limit param provided", async () => {
    mockListPending.mockResolvedValueOnce([]);

    await doFetch("/unmatched");
    expect(mockListPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 20 }),
    );
  });

  it("uses default limit when limit=0 is provided", async () => {
    mockListPending.mockResolvedValueOnce([]);

    await doFetch("/unmatched?limit=0");
    expect(mockListPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 20 }),
    );
  });

  it("uses default limit when limit=abc is provided", async () => {
    mockListPending.mockResolvedValueOnce([]);

    await doFetch("/unmatched?limit=abc");
    expect(mockListPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 20 }),
    );
  });
});

// T-012-06: Candidate fetch timeout returns partial response with candidates=[]
// Since candidates are included in the DB result (no live Tidal call), we verify
// the route handles a missing candidates field gracefully.
describe("T-012-06: GET /unmatched — items without candidates return candidates=[]", () => {
  it("returns candidates=[] for items with no candidates field", async () => {
    mockListPending.mockResolvedValueOnce([makePendingRow()]);

    const res = await doFetch("/unmatched");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ candidates: unknown[] }> };
    expect(body.items[0].candidates).toEqual([]);
  });
});

// T-012-13: GET /unmatched includes server-side total (true pending count)
describe("T-012-13: GET /unmatched — includes total from getUnmatchedCount", () => {
  it("returns total in response body so the UI can show a count beyond limit", async () => {
    mockListPending.mockResolvedValueOnce([makePendingRow()]);
    const { getUnmatchedCountByEnv } = await import("../../src/db/unmatched");
    vi.mocked(getUnmatchedCountByEnv).mockResolvedValueOnce(137);

    const res = await doFetch("/unmatched");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; total: number };
    expect(body.total).toBe(137);
    expect(body.items).toHaveLength(1);
  });
});

// T-012-07: POST /unmatched/:spotify_id/match writes matches row
describe("T-012-07: POST /unmatched/:spotify_id/match — success", () => {
  it("returns 200 with match row when Tidal track is found", async () => {
    const tidalTrackResponse = { id: "TX", title: "Kyrie", artists: [{ name: "Mr. Mister" }] };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(tidalTrackResponse), { status: 200 }),
    );
    mockMarkMatched.mockResolvedValueOnce({
      spotify_id: "X",
      tidal_id: "TX",
      method: "manual" as const,
      confidence: 1.0,
      matched_at: "2026-04-25T08:00:00Z",
    });

    const res = await doFetch("/unmatched/X/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tidal_id: "TX" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.spotify_id).toBe("X");
    expect(body.tidal_id).toBe("TX");
    expect(body.method).toBe("manual");
    expect(body.confidence).toBe(1.0);
  });
});

// T-012-08: POST /unmatched/:spotify_id/match validates Tidal id existence (404 → 400)
describe("T-012-08: POST /unmatched/:spotify_id/match — Tidal 404", () => {
  it("returns 400 with tidal_track_not_found when Tidal returns 404", async () => {
    mockTidalFetch.mockResolvedValueOnce(new Response("{}", { status: 404 }));

    const res = await doFetch("/unmatched/X/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tidal_id: "NOPE" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tidal_track_not_found");
    expect(mockMarkMatched).not.toHaveBeenCalled();
  });
});

// T-012-09: POST /unmatched/:spotify_id/match validates request body schema
describe("T-012-09: POST /unmatched/:spotify_id/match — missing tidal_id", () => {
  it("returns 400 when tidal_id is missing", async () => {
    const res = await doFetch("/unmatched/X/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when tidal_id is not a string", async () => {
    const res = await doFetch("/unmatched/X/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tidal_id: 12345 }),
    });
    expect(res.status).toBe(400);
  });
});

// T-012-10: Match transition is atomic (transaction rollback on markMatched error)
describe("T-012-10: POST /unmatched/:spotify_id/match — atomic transition", () => {
  it("returns 503 and no match written when markMatched throws", async () => {
    const tidalTrackResponse = { id: "TX", title: "Kyrie", artists: [{ name: "Mr. Mister" }] };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(tidalTrackResponse), { status: 200 }),
    );
    mockMarkMatched.mockRejectedValueOnce(new Error("transaction aborted"));

    const res = await doFetch("/unmatched/X/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tidal_id: "TX" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("service_unavailable");
  });
});

// T-012-11: POST /unmatched/:spotify_id/skip transitions to skipped
describe("T-012-11: POST /unmatched/:spotify_id/skip — transitions to skipped", () => {
  it("returns 200 with status=skipped", async () => {
    mockMarkSkipped.mockResolvedValueOnce({
      spotify_id: "X",
      status: "skipped" as const,
    });

    const res = await doFetch("/unmatched/X/skip", { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { spotify_id: string; status: string };
    expect(body.spotify_id).toBe("X");
    expect(body.status).toBe("skipped");
  });
});

// T-012-12: Skip is idempotent
describe("T-012-12: POST /unmatched/:spotify_id/skip — idempotent", () => {
  it("returns 200 even if already skipped", async () => {
    mockMarkSkipped.mockResolvedValueOnce({
      spotify_id: "X",
      status: "skipped" as const,
    });

    const res = await doFetch("/unmatched/X/skip", { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("skipped");
  });
});

// T-012: DB error on GET /unmatched returns 503
describe("T-012: GET /unmatched — DB error returns 503", () => {
  it("returns 503 when listPending throws", async () => {
    mockListPending.mockRejectedValueOnce(new Error("connection refused"));

    const res = await doFetch("/unmatched");
    expect(res.status).toBe(503);
  });
});

// T-012: Tidal 5xx on match returns 503
describe("T-012: POST /unmatched/:spotify_id/match — Tidal 5xx returns 503", () => {
  it("returns 503 when Tidal returns 500", async () => {
    mockTidalFetch.mockResolvedValueOnce(new Response("{}", { status: 500 }));

    const res = await doFetch("/unmatched/X/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tidal_id: "TX" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tidal_unavailable");
  });
});

// T-012: Invalid JSON body returns 400
describe("T-012: POST /unmatched/:spotify_id/match — invalid JSON body", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await doFetch("/unmatched/X/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

// T-012: tidalFetch throws (network error) returns 503
describe("T-012: POST /unmatched/:spotify_id/match — tidalFetch network error", () => {
  it("returns 503 when tidalFetch throws", async () => {
    mockTidalFetch.mockRejectedValueOnce(new Error("network error"));

    const res = await doFetch("/unmatched/X/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tidal_id: "TX" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tidal_unavailable");
  });
});

// T-012: markSkipped throws returns 503
describe("T-012: POST /unmatched/:spotify_id/skip — DB error returns 503", () => {
  it("returns 503 when markSkipped throws", async () => {
    mockMarkSkipped.mockRejectedValueOnce(new Error("db error"));

    const res = await doFetch("/unmatched/X/skip", { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("service_unavailable");
  });
});

// ---------------------------------------------------------------------------
// CSRF defense: Content-Type guard on /skip (UI-PHASE-7 M-1)
// ---------------------------------------------------------------------------
describe("POST /unmatched/:spotify_id/skip — Content-Type guard (CSRF defense)", () => {
  it("returns 415 when Content-Type header is missing", async () => {
    const res = await doFetch("/unmatched/X/skip", { method: "POST" });
    expect(res.status).toBe(415);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("content_type_required");
    expect(mockMarkSkipped).not.toHaveBeenCalled();
  });

  it("returns 415 when Content-Type is application/x-www-form-urlencoded (cross-origin form POST)", async () => {
    const res = await doFetch("/unmatched/X/skip", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "foo=bar",
    });
    expect(res.status).toBe(415);
    expect(mockMarkSkipped).not.toHaveBeenCalled();
  });
});
