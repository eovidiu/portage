// T-013: Captures API route tests
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";

// Mock DB helpers
vi.mock("../../src/db/captures");
vi.mock("../../src/providers/spotify/oauth");
vi.mock("../../src/db/tracks");

// neon mock for resolveMatchStatus and ensureTrackExists helpers inside the route
const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

import { insertCapture, findRecentCapture, listCaptures } from "../../src/db/captures";
import { spotifyFetch } from "../../src/providers/spotify/oauth";
import { upsertTracks } from "../../src/db/tracks";

const mockInsertCapture = vi.mocked(insertCapture);
const mockFindRecentCapture = vi.mocked(findRecentCapture);
const mockListCaptures = vi.mocked(listCaptures);
const mockSpotifyFetch = vi.mocked(spotifyFetch);
const mockUpsertTracks = vi.mocked(upsertTracks);

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

const VALID_SPOTIFY_ID = "3n3Ppam7vgaVa1iaRUc9Lp";

async function doFetch(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    authHeader?: string | null;
    env?: Env;
  } = {},
) {
  const { default: capturesRoute } = await import("../../src/routes/captures");
  const { Hono } = await import("hono");
  const { jwtMiddleware } = await import("../../src/middleware/auth");

  const app = new Hono<{ Bindings: Env }>();
  app.use("*", jwtMiddleware([]));
  app.route("/", capturesRoute);

  const testEnv = options.env ?? makeEnv();
  const ctx = createExecutionContext();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.authHeader !== null) {
    // Generate a valid JWT for testing
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(testEnv.JWT_SECRET);
    const token =
      options.authHeader ??
      (await new SignJWT({ sub: "owner" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("spotify-roon-sync")
        .setExpirationTime("1h")
        .sign(secret));
    headers["Authorization"] = `Bearer ${token}`;
  }

  const req = new Request(`https://worker.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const res = await app.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function makeCapture(overrides = {}) {
  return {
    capture_id: "9c2b0000-0000-0000-0000-000000000001",
    spotify_id: VALID_SPOTIFY_ID,
    captured_at: "2026-04-25T14:32:00Z",
    location_lat: 44.4268,
    location_lng: 26.1025,
    source: "siri",
    context_note: "saw cover in coffee shop",
    ...overrides,
  };
}

function makeSpotifyTrackResponse(id = VALID_SPOTIFY_ID) {
  return {
    id,
    name: "Test Track",
    artists: [{ name: "Test Artist" }],
    album: { name: "Test Album" },
    duration_ms: 210000,
    external_ids: { isrc: "USUM71703862" },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: track exists in DB (non-empty array = found)
  mockSql.mockResolvedValue([{ spotify_id: VALID_SPOTIFY_ID }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// T-013-01: POST /captures requires JWT
describe("T-013-01: POST /captures requires JWT", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri" },
      authHeader: null,
    });
    expect(res.status).toBe(401);
  });
});

// T-013-02: Valid capture creates row
describe("T-013-02: Valid capture creates row", () => {
  it("returns 201 with the new capture row", async () => {
    mockFindRecentCapture.mockResolvedValueOnce(null);
    mockInsertCapture.mockResolvedValueOnce(makeCapture());
    mockUpsertTracks.mockResolvedValueOnce(0);

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri" },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.capture_id).toBe("9c2b0000-0000-0000-0000-000000000001");
    expect(body.spotify_id).toBe(VALID_SPOTIFY_ID);
    expect(body.match_status).toBe("pending");
  });
});

// T-013-03: Missing spotify_id returns 400
describe("T-013-03: Missing spotify_id returns 400", () => {
  it("returns 400 with error=missing_spotify_id", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { source: "manual" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("missing_spotify_id");
  });
});

// T-013-04: Malformed spotify_id returns 400
describe("T-013-04: Malformed spotify_id returns 400", () => {
  it("returns 400 for invalid spotify_id format", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: "not-a-real-id", source: "manual" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_spotify_id");
  });

  it("returns 400 for spotify_id that is too short", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: "abc123", source: "manual" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for spotify_id with special chars", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: "3n3Ppam7vgaVa1iaRUc9L!", source: "manual" },
    });
    expect(res.status).toBe(400);
  });
});

// T-013-05: Invalid source returns 400
describe("T-013-05: Invalid source returns 400", () => {
  it("returns 400 for unknown source value", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "telepathy" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_source");
  });

  it("returns 400 when source is missing", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID },
    });
    expect(res.status).toBe(400);
  });
});

// T-013-06: Out-of-range latitude returns 400
describe("T-013-06: Out-of-range latitude returns 400", () => {
  it("returns 400 for lat=91.0", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "manual", location_lat: 91.0, location_lng: 0.0 },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_location_lat");
  });

  it("returns 400 for lat=-91.0", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "manual", location_lat: -91.0, location_lng: 0.0 },
    });
    expect(res.status).toBe(400);
  });
});

// T-013-07: Out-of-range longitude returns 400
describe("T-013-07: Out-of-range longitude returns 400", () => {
  it("returns 400 for lng=200.0", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "manual", location_lat: 0.0, location_lng: 200.0 },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_location_lng");
  });

  it("returns 400 for lng=-181.0", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "manual", location_lat: 0.0, location_lng: -181.0 },
    });
    expect(res.status).toBe(400);
  });
});

// T-013-08: context_note over 500 chars returns 400
describe("T-013-08: context_note over 500 chars returns 400", () => {
  it("returns 400 for context_note of 501 chars", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: {
        spotify_id: VALID_SPOTIFY_ID,
        source: "manual",
        context_note: "a".repeat(501),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("context_note_too_long");
  });

  it("accepts context_note of exactly 500 chars", async () => {
    mockFindRecentCapture.mockResolvedValueOnce(null);
    mockInsertCapture.mockResolvedValueOnce(makeCapture({ context_note: "a".repeat(500) }));
    mockUpsertTracks.mockResolvedValueOnce(0);

    const res = await doFetch("/captures", {
      method: "POST",
      body: {
        spotify_id: VALID_SPOTIFY_ID,
        source: "manual",
        context_note: "a".repeat(500),
      },
    });
    expect(res.status).toBe(201);
  });
});

// T-013-09: Unknown spotify_id triggers Spotify fetch
describe("T-013-09: Unknown spotify_id triggers Spotify fetch", () => {
  it("fetches from Spotify and inserts track when not in DB", async () => {
    // First call: track not in DB
    mockSql.mockResolvedValueOnce([]);
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(makeSpotifyTrackResponse()), { status: 200 }),
    );
    mockUpsertTracks.mockResolvedValueOnce(1);
    mockFindRecentCapture.mockResolvedValueOnce(null);
    mockInsertCapture.mockResolvedValueOnce(makeCapture());

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri" },
    });
    expect(res.status).toBe(201);
    expect(mockSpotifyFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(VALID_SPOTIFY_ID),
    );
    expect(mockUpsertTracks).toHaveBeenCalled();
  });
});

// T-013-10: Spotify fetch failure returns 400
describe("T-013-10: Spotify fetch failure returns 400", () => {
  it("returns 400 with error=spotify_track_not_found when Spotify returns 404", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { status: 404, message: "Not found" } }), { status: 404 }),
    );
    mockFindRecentCapture.mockResolvedValueOnce(null);

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "manual" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("spotify_track_not_found");
  });
});

// T-013-11: Capture does not trigger sync run
describe("T-013-11: Capture does not trigger sync run", () => {
  it("POST /captures does not invoke the orchestrator", async () => {
    mockFindRecentCapture.mockResolvedValueOnce(null);
    mockInsertCapture.mockResolvedValueOnce(makeCapture());
    mockUpsertTracks.mockResolvedValueOnce(0);

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri" },
    });
    expect(res.status).toBe(201);
    // Orchestrator (runSync) is NOT imported or invoked by this route — structural test.
    // If runSync were called, it would throw (unmocked). The 201 proves it wasn't called.
  });
});

// T-013-12: Duplicate within 60s returns 200 with same capture_id
describe("T-013-12: Duplicate within 60s returns 200 with same capture_id", () => {
  it("returns 200 with the existing capture on duplicate POST", async () => {
    const existing = makeCapture();
    mockFindRecentCapture.mockResolvedValueOnce(existing);
    // resolveMatchStatus uses neon directly
    mockSql.mockResolvedValueOnce([{ match_status: "pending" }]);

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.capture_id).toBe(existing.capture_id);
    expect(mockInsertCapture).not.toHaveBeenCalled();
  });
});

// T-013-14: GET /captures returns match_status correctly
describe("T-013-14: GET /captures returns match_status correctly", () => {
  it("returns items with match_status values matched/unmatched/pending", async () => {
    mockListCaptures.mockResolvedValueOnce([
      { ...makeCapture({ capture_id: "id-1" }), match_status: "matched", tidal_id: "12345" },
      { ...makeCapture({ capture_id: "id-2" }), match_status: "unmatched", tidal_id: null },
      { ...makeCapture({ capture_id: "id-3" }), match_status: "pending", tidal_id: null },
    ]);

    const res = await doFetch("/captures?limit=50");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(3);
    expect(body.items[0].match_status).toBe("matched");
    expect(body.items[0].tidal_id).toBe("12345");
    expect(body.items[1].match_status).toBe("unmatched");
    expect(body.items[2].match_status).toBe("pending");
  });
});

// T-013-15: captured_at defaults to now() if omitted
describe("T-013-15: captured_at defaults to now() if omitted", () => {
  it("sets captured_at to approximately now when not provided", async () => {
    const t0 = Date.now();
    let capturedAt: string | undefined;

    mockFindRecentCapture.mockResolvedValueOnce(null);
    mockInsertCapture.mockImplementationOnce(async (_env, params) => {
      capturedAt = params.captured_at;
      return makeCapture({ captured_at: params.captured_at });
    });
    mockUpsertTracks.mockResolvedValueOnce(0);

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "manual" },
    });
    expect(res.status).toBe(201);

    const elapsed = (new Date(capturedAt!).getTime() - t0) / 1000;
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThanOrEqual(5);
  });
});

// GET /captures returns 401 without JWT
describe("T-013-01 (GET): GET /captures requires JWT", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await doFetch("/captures", { authHeader: null });
    expect(res.status).toBe(401);
  });
});

// GET /captures with valid JWT returns 200
describe("T-013: GET /captures — valid JWT returns 200", () => {
  it("returns 200 with items array", async () => {
    mockListCaptures.mockResolvedValueOnce([]);

    const res = await doFetch("/captures");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Array.isArray(body.items)).toBe(true);
  });
});

// GET /captures DB error returns 503
describe("T-013: GET /captures — DB error returns 503", () => {
  it("returns 503 when DB throws", async () => {
    mockListCaptures.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await doFetch("/captures");
    expect(res.status).toBe(503);
  });
});

// POST /captures FK violation on insert returns 400
describe("T-013: POST /captures — FK violation on insert returns 400", () => {
  it("returns 400 when insert throws PG 23503 error", async () => {
    mockFindRecentCapture.mockResolvedValueOnce(null);
    const fkError = new Error("FK violation") as Error & { code: string };
    fkError.code = "23503";
    mockInsertCapture.mockRejectedValueOnce(fkError);

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("track_not_found");
  });
});

// Spotify returns 401 → 503 spotify_reauth_required
describe("T-013: Spotify 401 returns 503 reauth required", () => {
  it("returns 503 with error=spotify_reauth_required when Spotify returns 401", async () => {
    mockSql.mockResolvedValueOnce([]); // track not found in DB
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { status: 401, message: "Unauthorized" } }), { status: 401 }),
    );
    mockFindRecentCapture.mockResolvedValueOnce(null);

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "manual" },
    });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("spotify_reauth_required");
  });
});

// Spotify returns non-404 error → 503 service_unavailable
describe("T-013: Spotify generic error returns 503", () => {
  it("returns 503 when Spotify returns 500", async () => {
    mockSql.mockResolvedValueOnce([]); // track not found in DB
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );
    mockFindRecentCapture.mockResolvedValueOnce(null);

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "manual" },
    });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("service_unavailable");
  });
});

// insertCapture throws a non-FK error → 503
describe("T-013: POST /captures — generic DB error on insert returns 503", () => {
  it("returns 503 when insertCapture throws non-FK error", async () => {
    mockFindRecentCapture.mockResolvedValueOnce(null);
    mockInsertCapture.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri" },
    });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("service_unavailable");
  });
});

// Invalid JSON body returns 400
describe("T-013: POST /captures — invalid JSON returns 400", () => {
  it("returns 400 for malformed JSON", async () => {
    const { default: capturesRoute } = await import("../../src/routes/captures");
    const { Hono } = await import("hono");
    const { jwtMiddleware } = await import("../../src/middleware/auth");
    const { SignJWT } = await import("jose");

    const testEnv = makeEnv();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", jwtMiddleware([]));
    app.route("/", capturesRoute);

    const secret = new TextEncoder().encode(testEnv.JWT_SECRET);
    const token = await new SignJWT({ sub: "owner" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("spotify-roon-sync")
      .setExpirationTime("1h")
      .sign(secret);

    const ctx = createExecutionContext();
    const req = new Request("https://worker.test/captures", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "not-json{",
    });
    const res = await app.fetch(req, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});

// Valid captured_at is accepted and used
describe("T-013: POST /captures — valid captured_at is used", () => {
  it("accepts and uses a valid ISO 8601 captured_at", async () => {
    mockFindRecentCapture.mockResolvedValueOnce(null);
    const expectedAt = "2026-04-25T14:32:00.000Z";
    mockInsertCapture.mockImplementationOnce(async (_env, params) => {
      return makeCapture({ captured_at: params.captured_at });
    });
    mockUpsertTracks.mockResolvedValueOnce(0);

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri", captured_at: "2026-04-25T14:32:00Z" },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    // The captured_at in the mock response uses what was passed
    expect(mockInsertCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ captured_at: expectedAt }),
    );
  });
});

// Invalid captured_at returns 400
describe("T-013: POST /captures — invalid captured_at returns 400", () => {
  it("returns 400 when captured_at is not a valid timestamp", async () => {
    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri", captured_at: "not-a-date" },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_captured_at");
  });
});

// findRecentCapture throws → 503
describe("T-013: POST /captures — findRecentCapture DB error returns 503", () => {
  it("returns 503 when findRecentCapture throws", async () => {
    mockFindRecentCapture.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri" },
    });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("service_unavailable");
  });
});

// GET /captures — limit=0 uses default (rawLimit < 1 branch, line 27)
describe("T-013: GET /captures — limit=0 falls back to default", () => {
  it("uses default limit when limit=0 is passed", async () => {
    mockListCaptures.mockResolvedValueOnce([]);

    const res = await doFetch("/captures?limit=0");
    expect(res.status).toBe(200);
    expect(mockListCaptures).toHaveBeenCalledWith(
      expect.anything(),
      50, // DEFAULT_LIMIT
      undefined,
      undefined,
    );
  });

  it("uses default limit when limit=-1 is passed", async () => {
    mockListCaptures.mockResolvedValueOnce([]);

    const res = await doFetch("/captures?limit=-1");
    expect(res.status).toBe(200);
    expect(mockListCaptures).toHaveBeenCalledWith(
      expect.anything(),
      50,
      undefined,
      undefined,
    );
  });
});

// T-013-09: Spotify fetch with missing optional fields (covers lines 202-206)
describe("T-013-09: ensureTrackExists — Spotify response with missing optional fields", () => {
  it("handles missing external_ids, artists[0], album, duration_ms gracefully", async () => {
    mockSql.mockResolvedValueOnce([]); // track not in DB
    // Spotify response with all optional fields absent
    const sparseTrack = {
      id: VALID_SPOTIFY_ID,
      name: "Sparse Track",
      artists: [],          // no artists → artists[0]?.name = undefined
      album: { name: null }, // null album name → album?.name = null
      duration_ms: null,    // null duration
      // external_ids absent → external_ids?.isrc = undefined
    };
    mockSpotifyFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(sparseTrack), { status: 200 }),
    );
    mockUpsertTracks.mockResolvedValueOnce(1);
    mockFindRecentCapture.mockResolvedValueOnce(null);
    mockInsertCapture.mockResolvedValueOnce(makeCapture());

    const res = await doFetch("/captures", {
      method: "POST",
      body: { spotify_id: VALID_SPOTIFY_ID, source: "siri" },
    });
    expect(res.status).toBe(201);
    expect(mockUpsertTracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          isrc: null,
          artist: "",
          album: null,
          duration_ms: null,
        }),
      ]),
    );
  });
});

// Valid boundary: lat=90 and lng=180 are accepted
describe("T-013: boundary coordinates accepted", () => {
  it("accepts lat=90, lng=180 (boundary)", async () => {
    mockFindRecentCapture.mockResolvedValueOnce(null);
    mockInsertCapture.mockResolvedValueOnce(makeCapture({ location_lat: 90, location_lng: 180 }));
    mockUpsertTracks.mockResolvedValueOnce(0);

    const res = await doFetch("/captures", {
      method: "POST",
      body: {
        spotify_id: VALID_SPOTIFY_ID,
        source: "manual",
        location_lat: 90,
        location_lng: 180,
      },
    });
    expect(res.status).toBe(201);
  });
});
