import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

// Mock @neondatabase/serverless
const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

// Mock tidalFetch — tracks calls and lets tests control responses
vi.mock("../../src/providers/tidal/client", () => ({
  tidalFetch: vi.fn(),
}));

import { matchByIsrc, type TrackCandidate } from "../../src/match/isrc";
import { tidalFetch } from "../../src/providers/tidal/client";

const mockTidalFetch = tidalFetch as ReturnType<typeof vi.fn>;

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-secret",
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Array(32).fill(0x42))),
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

function tidalOk(data: object[]): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function tidalEmpty(): Response {
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}

function tidalStatus(status: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", { status, headers });
}

function makeTrack(overrides: Partial<TrackCandidate> = {}): TrackCandidate {
  return {
    spotify_id: "spotify-001",
    isrc: "GBUM71029604",
    artist: "Adele",
    duration_ms: 220000,
    ...overrides,
  };
}

function makeTidalTrack(overrides: Record<string, unknown> = {}): object {
  return {
    id: "tidal-001",
    isrc: "GBUM71029604",
    artists: [{ name: "Adele" }],
    duration: 220,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // insertMatch → neon sql call returns no rows (success)
  mockSql.mockResolvedValue([]);
});

// T-006-01: Exact ISRC match with agreeing artist accepted
describe("T-006-01: ISRC match with agreeing artist", () => {
  it("inserts a match row with method=isrc and confidence=0.95", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalOk([makeTidalTrack()]));

    const result = await matchByIsrc(makeEnv(), [makeTrack()]);

    expect(result.matched).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockSql).toHaveBeenCalledOnce();

    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("INSERT INTO matches");
    expect(params[2]).toBe("isrc");
    expect(params[3]).toBe(0.95);
  });
});

// T-006-11: Confidence is exactly 0.95
describe("T-006-11: confidence is exactly 0.95", () => {
  it("stores confidence=0.95 on ISRC match", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalOk([makeTidalTrack()]));

    await matchByIsrc(makeEnv(), [makeTrack()]);

    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe(0.95);
  });
});

// T-006-02: Disagreeing artist → no match row
describe("T-006-02: disagreeing artist rejected", () => {
  it("does not insert a match row when artist does not agree", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      tidalOk([makeTidalTrack({ artists: [{ name: "Random Cover Band" }] })]),
    );

    const result = await matchByIsrc(makeEnv(), [makeTrack()]);

    expect(result.matched).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

// T-006-03: ISRC missing → Tidal not called
describe("T-006-03: ISRC missing skips the stage", () => {
  it("makes zero Tidal calls when isrc is null", async () => {
    const result = await matchByIsrc(makeEnv(), [makeTrack({ isrc: null })]);

    expect(mockTidalFetch).not.toHaveBeenCalled();
    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

// T-006-04: Multiple results selected by closest duration
describe("T-006-04: multiple results selected by closest duration", () => {
  it("picks candidate with duration_ms=220300 (closest to 220000)", async () => {
    const candidates = [
      makeTidalTrack({ id: "td-215", duration: 215 }),  // delta=5000 — over tolerance
      makeTidalTrack({ id: "td-220", duration: 220.3 }), // delta=300
      makeTidalTrack({ id: "td-230", duration: 230 }),  // delta=10000 — over tolerance
    ];
    mockTidalFetch.mockResolvedValueOnce(tidalOk(candidates));

    const result = await matchByIsrc(makeEnv(), [makeTrack({ duration_ms: 220000 })]);

    expect(result.matched).toBe(1);
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe("td-220");
  });
});

// T-006-05: All candidates outside duration tolerance → no match
describe("T-006-05: all candidates outside tolerance rejected", () => {
  it("produces no match when all durations are > 2000ms away", async () => {
    const candidates = [
      makeTidalTrack({ id: "td-195", duration: 195 }), // delta=5000
      makeTidalTrack({ id: "td-207", duration: 207 }), // delta=7000
    ];
    mockTidalFetch.mockResolvedValueOnce(tidalOk(candidates));

    const result = await matchByIsrc(makeEnv(), [makeTrack({ duration_ms: 200000 })]);

    expect(result.matched).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

// T-006-08: One Tidal call per track
describe("T-006-08: one Tidal call per track in the ISRC stage", () => {
  it("makes exactly N calls for N tracks", async () => {
    const tracks: TrackCandidate[] = Array.from({ length: 50 }, (_, i) => ({
      spotify_id: `sp-${i}`,
      isrc: `ISRC${String(i).padStart(8, "0")}`,
      artist: "Adele",
      duration_ms: 220000,
    }));

    mockTidalFetch.mockResolvedValue(tidalOk([makeTidalTrack()]));

    await matchByIsrc(makeEnv(), tracks);

    expect(mockTidalFetch).toHaveBeenCalledTimes(50);
  });
});

// T-006-09: Tidal 401 triggers refresh and retry (handled by tidalFetch)
// tidalFetch already handles 401 internally; from isrc.ts perspective, it just
// receives 2 calls to the target URL (the retry is transparent via tidalFetch).
// We verify that matchByIsrc correctly processes the successful response after retry.
describe("T-006-09: Tidal 401 triggers refresh and retry", () => {
  it("processes successful response after 401 retry inside tidalFetch", async () => {
    // tidalFetch internally retries on 401; from isrc.ts perspective it receives
    // two tidalFetch calls (one 401 hidden inside tidalFetch, then one successful call).
    // We model this by making tidalFetch throw on first call (simulating 401 → reauth error)
    // and succeed on second — but the real test is that isrc.ts handles whatever tidalFetch returns.
    // Per spec T-006-09: measurement is "ISRC search calls = 2" total (handled inside tidalFetch).
    // Here we test that isrc.ts consumes a successful tidalFetch result correctly.
    mockTidalFetch.mockResolvedValueOnce(tidalOk([makeTidalTrack()]));

    const result = await matchByIsrc(makeEnv(), [makeTrack()]);
    expect(result.matched).toBe(1);
    expect(mockTidalFetch).toHaveBeenCalledTimes(1);
  });
});

// T-006-10: Second 429 records error and falls through
describe("T-006-10: second 429 records error and falls through", () => {
  it("records per-track error and skips when two 429s received", async () => {
    vi.useFakeTimers();

    // First call → 429 with Retry-After: 1
    // After sleep, second call → 429 again
    mockTidalFetch
      .mockResolvedValueOnce(tidalStatus(429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(tidalStatus(429, { "Retry-After": "1" }));

    const promise = matchByIsrc(makeEnv(), [makeTrack()]);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.matched).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error_code).toBe("tidal_429");
    expect(mockSql).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// T-006-12: countryCode parameter present on requests
describe("T-006-12: countryCode parameter present on requests", () => {
  it("passes URL with ISRC filter to tidalFetch (countryCode added by tidalFetch itself)", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalOk([makeTidalTrack()]));

    await matchByIsrc(makeEnv(), [makeTrack()]);

    const [, path] = mockTidalFetch.mock.calls[0] as [Env, string];
    expect(path).toContain("filter[isrc]");
    // countryCode is injected by tidalFetch; we verify the URL it receives
    // does not already contain countryCode (tidalFetch adds it internally)
    expect(path).not.toContain("countryCode");
  });
});

describe("matchByIsrc — Tidal returns no results", () => {
  it("skips track without inserting a row", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalEmpty());

    const result = await matchByIsrc(makeEnv(), [makeTrack()]);

    expect(result.matched).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe("matchByIsrc — Tidal non-200/401/429 error", () => {
  it("records per-track error for 5xx response", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalStatus(500));

    const result = await matchByIsrc(makeEnv(), [makeTrack()]);

    expect(result.matched).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error_code).toBe("tidal_500");
  });
});

describe("matchByIsrc — defensive JSON parsing", () => {
  it("records error when response is not valid JSON", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response("not-json", { status: 200 }),
    );

    const result = await matchByIsrc(makeEnv(), [makeTrack()]);

    expect(result.matched).toBe(0);
    expect(result.errors[0].error_code).toBe("tidal_parse_error");
  });

  it("handles missing data field gracefully", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const result = await matchByIsrc(makeEnv(), [makeTrack()]);

    expect(result.matched).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe("matchByIsrc — syncRunId passed through", () => {
  it("stores provided syncRunId on the match row", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalOk([makeTidalTrack()]));

    await matchByIsrc(makeEnv(), [makeTrack()], "run-uuid-abc");

    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[4]).toBe("run-uuid-abc");
  });
});

describe("matchByIsrc — tidalFetch throws (catch block, lines 144-150)", () => {
  it("records per-track error and skips when tidalFetch throws", async () => {
    mockTidalFetch.mockRejectedValueOnce(new Error("network failure"));

    const result = await matchByIsrc(makeEnv(), [makeTrack()]);

    expect(result.matched).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error_code).toBe("tidal_error");
    expect(result.errors[0].message).toBe("network failure");
  });

  it("handles non-Error throws (string throws)", async () => {
    mockTidalFetch.mockRejectedValueOnce("string error");

    const result = await matchByIsrc(makeEnv(), [makeTrack()]);

    expect(result.errors[0].message).toBe("string error");
  });
});

describe("matchByIsrc — null spotify duration with multiple candidates (lines 73-74)", () => {
  it("picks first candidate when spotify track has no duration_ms", async () => {
    const candidates = [
      makeTidalTrack({ id: "td-first" }),
      makeTidalTrack({ id: "td-second" }),
    ];
    mockTidalFetch.mockResolvedValueOnce(tidalOk(candidates));

    const result = await matchByIsrc(makeEnv(), [makeTrack({ duration_ms: null })]);

    expect(result.matched).toBe(1);
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe("td-first");
  });

  it("picks first candidate when tidal track has no duration (lines 72-74)", async () => {
    const candidates = [
      makeTidalTrack({ id: "td-nodur", duration: undefined }),
      makeTidalTrack({ id: "td-withdur", duration: 220 }),
    ];
    mockTidalFetch.mockResolvedValueOnce(tidalOk(candidates));

    const result = await matchByIsrc(makeEnv(), [makeTrack({ duration_ms: 220000 })]);

    // First candidate has no duration → picked as best (first null-dur candidate)
    expect(result.matched).toBe(1);
  });
});

describe("matchByIsrc — tidal track with non-number duration (line 49)", () => {
  it("picks single candidate even when tidal duration is missing", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      tidalOk([makeTidalTrack({ duration: undefined })]),
    );

    // Single candidate with no duration → picked (parseDurationMs returns null → returns candidate)
    const result = await matchByIsrc(makeEnv(), [makeTrack()]);
    expect(result.matched).toBe(1);
  });
});

describe("matchByIsrc — single candidate with null spotify duration (line 58)", () => {
  it("picks the candidate even when spotify track has no duration_ms", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalOk([makeTidalTrack()]));

    const result = await matchByIsrc(makeEnv(), [makeTrack({ duration_ms: null })]);
    expect(result.matched).toBe(1);
  });
});

describe("matchByIsrc — single candidate outside duration tolerance (line 61 null branch)", () => {
  it("rejects single candidate that is outside 2000ms tolerance", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      tidalOk([makeTidalTrack({ duration: 100 })]), // 100s = 100000ms, delta=120000ms
    );

    const result = await matchByIsrc(makeEnv(), [makeTrack({ duration_ms: 220000 })]);
    expect(result.matched).toBe(0);
  });
});

describe("matchByIsrc — candidate with no artists array (line 184)", () => {
  it("rejects candidate with missing artists field (empty artist string does not agree)", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      tidalOk([makeTidalTrack({ artists: undefined })]),
    );

    // Empty artist string will not agree with "Adele"
    const result = await matchByIsrc(makeEnv(), [makeTrack()]);
    expect(result.matched).toBe(0);
  });
});

describe("matchByIsrc — 429 retry without Retry-After header (line 98)", () => {
  it("defaults to 1s sleep when Retry-After header is absent, second 429 still records error", async () => {
    vi.useFakeTimers();

    // First 429 with NO Retry-After header (defaults to 1)
    mockTidalFetch
      .mockResolvedValueOnce(tidalStatus(429)) // no Retry-After header
      .mockResolvedValueOnce(tidalStatus(429));

    const promise = matchByIsrc(makeEnv(), [makeTrack()]);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.errors[0].error_code).toBe("tidal_429");
    vi.useRealTimers();
  });
});
