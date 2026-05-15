// F-024 integration: GET /unmatched/:spotify_id/search
// Exercises the full R5 error taxonomy + R6 logging discipline.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/env";

vi.mock("../../src/providers/tidal/client");
vi.mock("../../src/db/tracks");

import { tidalFetch } from "../../src/providers/tidal/client";
import { trackExists } from "../../src/db/tracks";
import { TidalReauthRequired } from "../../src/providers/tidal/oauth";
import { _resetBuckets } from "../../src/middleware/rate-limit";

const mockTidalFetch = vi.mocked(tidalFetch);
const mockTrackExists = vi.mocked(trackExists);

const TIDAL_BEARER = "eyJSECRETjwtACCESStokenTHAT_must_never_leak";
const PRINCIPAL_EMAIL = "eovidiu@gmail.com";
const SPOTIFY_ID = "3n3Ppam7vgaVa1iaRUc9Lp";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "test-spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "test-spotify-client-secret",
    SPOTIFY_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/spotify/callback",
    TIDAL_CLIENT_ID: "tidal-client-id-canary",
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
  env: Env = makeEnv(),
) {
  const { default: unmatchedRoute } = await import("../../src/routes/unmatched");
  const { Hono } = await import("hono");
  const app = new Hono<{
    Bindings: Env;
    Variables: { principal?: { kind: "user"; email: string } };
  }>();
  // Mimic the cfAccessMiddleware contract: set principal so the rate limiter
  // sees a stable key. Routes inherit this set value via c.get("principal").
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

function searchBody(refs: Array<{ id: string }> = [{ id: "t1" }, { id: "t2" }]) {
  return {
    data: {
      id: "any",
      type: "searchResults",
      relationships: {
        tracks: { data: refs.map((r) => ({ id: r.id, type: "tracks" })) },
      },
    },
    included: [
      ...refs.map((r) => ({
        id: r.id,
        type: "tracks",
        attributes: { title: `Track ${r.id}`, duration: "PT3M30S", isrc: `US-${r.id}` },
        relationships: {
          artists: { data: [{ id: "a1", type: "artists" }] },
          albums: { data: [{ id: "alb1", type: "albums" }] },
        },
      })),
      { id: "a1", type: "artists", attributes: { name: "Metallica" } },
      { id: "alb1", type: "albums", attributes: { title: "...And Justice For All" } },
    ],
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let collectedLogs: string[];

beforeEach(() => {
  vi.resetAllMocks();
  _resetBuckets();
  mockTrackExists.mockResolvedValue(true);
  collectedLogs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
    collectedLogs.push(typeof msg === "string" ? msg : JSON.stringify(msg));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  vi.useRealTimers();
});

function searchLogLines(): Array<Record<string, unknown>> {
  return collectedLogs
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((obj): obj is Record<string, unknown> => obj?.event === "manual_search");
}

describe("F-024 R1: happy path", () => {
  it("returns 200 with the flat candidate shape and no confidence field", async () => {
    mockTidalFetch.mockResolvedValueOnce(jsonApi(searchBody()));

    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=Metallica+One`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      query: string;
      candidates: Array<Record<string, unknown>>;
      fetched_at: string;
    };
    expect(body.query).toBe("Metallica One");
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0]).toEqual({
      tidal_id: "t1",
      title: "Track t1",
      artists: ["Metallica"],
      album: "...And Justice For All",
      duration_ms: 3 * 60_000 + 30_000,
      isrc: "US-t1",
    });
    expect(body.candidates[0]).not.toHaveProperty("confidence");
    expect(body.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("slices results to the validated limit", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      jsonApi(searchBody([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }])),
    );

    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=anything&limit=2`);
    expect(res.status).toBe(200);
    const body = await res.json() as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(2);
  });

  it("returns 200 with empty candidates when Tidal returns no results", async () => {
    mockTidalFetch.mockResolvedValueOnce(jsonApi(searchBody([])));

    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=nonsense`);
    expect(res.status).toBe(200);
    const body = await res.json() as { candidates: unknown[] };
    expect(body.candidates).toEqual([]);
  });
});

describe("F-024 R2: input validation", () => {
  it("returns 400 invalid_query when q is missing", async () => {
    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_query");
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_query when q is 201 chars", async () => {
    const res = await doFetch(
      `/unmatched/${SPOTIFY_ID}/search?q=${"x".repeat(201)}`,
    );
    expect(res.status).toBe(400);
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_query when q contains a control char", async () => {
    const q = encodeURIComponent("Metallica\x07One");
    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=${q}`);
    expect(res.status).toBe(400);
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_limit when limit=26", async () => {
    const res = await doFetch(
      `/unmatched/${SPOTIFY_ID}/search?q=anything&limit=26`,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_limit");
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_limit when limit is non-integer", async () => {
    const res = await doFetch(
      `/unmatched/${SPOTIFY_ID}/search?q=anything&limit=abc`,
    );
    expect(res.status).toBe(400);
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });
});

describe("F-024 R5: 404 unknown_spotify_id", () => {
  it("returns 404 when the spotify_id does not exist in tracks", async () => {
    mockTrackExists.mockResolvedValueOnce(false);

    const res = await doFetch(`/unmatched/missing-id/search?q=anything`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unknown_spotify_id");
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });
});

describe("F-024 R4: rate limiting", () => {
  it("returns 429 with Retry-After on the 11th request from the same principal", async () => {
    // Use mockImplementation so a fresh Response is created per call —
    // mockResolvedValue would re-use a single Response whose body is
    // consumed on the first read.
    mockTidalFetch.mockImplementation(async () => jsonApi(searchBody()));

    for (let i = 0; i < 10; i++) {
      const ok = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=anything`);
      expect(ok.status).toBe(200);
    }
    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=anything`);
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("rate_limited");
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "0", 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

describe("F-024 R5: upstream error mapping", () => {
  it("returns 502 tidal_upstream_error when Tidal 503s twice", async () => {
    mockTidalFetch
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));

    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=anything`);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tidal_upstream_error");
  });

  it("returns 502 tidal_reauth_required when TidalReauthRequired is thrown", async () => {
    mockTidalFetch.mockRejectedValueOnce(new TidalReauthRequired());

    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=anything`);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tidal_reauth_required");
  });

  it("returns 502 tidal_upstream_error when Tidal 200 body is unparseable", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response("garbage that is not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=anything`);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tidal_upstream_error");
  });

  it("returns 504 tidal_timeout when the upstream call exceeds the 3s budget", async () => {
    // Hold tidalFetch open indefinitely; the handler's real setTimeout fires
    // after ~3s. Fake timers can't intercept setTimeout inside the worker
    // isolate, so we let wall-clock elapse and budget for it (≤3.5s per
    // spec R6 plus test slack).
    mockTidalFetch.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));

    const t0 = Date.now();
    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=anything`);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(504);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tidal_timeout");
    // R6: timeout enforced within 3.5s (500ms slack for scheduling).
    expect(elapsed).toBeLessThan(3_500);
  }, 5_000);
});

describe("F-024 R6: security — log discipline and token privacy", () => {
  it("emits exactly one manual_search log line per request", async () => {
    mockTidalFetch.mockResolvedValueOnce(jsonApi(searchBody()));

    await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=Metallica+One`);

    const lines = searchLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "manual_search",
      spotify_id: SPOTIFY_ID,
      q_len: "Metallica One".length,
      result_count: 2,
      tidal_status: 200,
    });
    expect(typeof lines[0].duration_ms).toBe("number");
  });

  it("does not write the raw query into the log line", async () => {
    mockTidalFetch.mockResolvedValueOnce(jsonApi(searchBody()));

    const rawQuery = "SecretBandName";
    await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=${rawQuery}`);

    for (const line of collectedLogs) {
      expect(line).not.toContain(rawQuery);
    }
  });

  it("does not write the principal email into the log line", async () => {
    mockTidalFetch.mockResolvedValueOnce(jsonApi(searchBody()));

    await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=anything`);
    for (const line of collectedLogs) {
      expect(line).not.toContain(PRINCIPAL_EMAIL);
    }
  });

  it("does not echo any JWT-shaped substring or Tidal client id in a 502 body", async () => {
    mockTidalFetch.mockRejectedValueOnce(new TidalReauthRequired());

    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search?q=anything`);
    const text = await res.text();
    expect(text).not.toContain("eyJ");
    expect(text).not.toContain(TIDAL_BEARER);
    expect(text).not.toContain("tidal-client-id-canary");
  });

  it("emits log on validation failure with q_len=0 and no upstream call", async () => {
    const res = await doFetch(`/unmatched/${SPOTIFY_ID}/search`);
    expect(res.status).toBe(400);
    const lines = searchLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "manual_search",
      q_len: 0,
      tidal_status: null,
    });
  });
});

describe("F-024 R1: full-app stack rejects anonymous", () => {
  it("returns 401 when no Authorization header reaches the full app", async () => {
    const { default: app } = await import("../../src/index");
    const ctx = createExecutionContext();
    const req = new Request(
      `https://worker.test/unmatched/${SPOTIFY_ID}/search?q=anything`,
      { headers: {} },
    );
    const res = await app.fetch(req, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
    // Handler should not have executed
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });
});
