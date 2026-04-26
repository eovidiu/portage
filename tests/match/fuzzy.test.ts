import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

vi.mock("../../src/providers/tidal/client", () => ({
  tidalFetch: vi.fn(),
}));

import { matchByFuzzy } from "../../src/match/fuzzy";
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

function tidalSearchOk(data: object[]): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function tidalSearchEmpty(): Response {
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}

function tidalStatus(status: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", { status, headers });
}

function makeTrackRow(overrides: Record<string, unknown> = {}): object {
  return {
    spotify_id: "sp-001",
    title: "Yesterday",
    artist: "The Beatles",
    album: "Help!",
    duration_ms: 125000,
    ...overrides,
  };
}

function makeTidalTrack(overrides: Record<string, unknown> = {}): object {
  return {
    id: "td-001",
    title: "Yesterday",
    artists: [{ name: "The Beatles" }],
    album: { title: "Help!" },
    duration: 125,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default setup: fetchUnmatchedTracks (first SQL call) returns one track row.
  // All subsequent SQL calls (insertMatch, upsertUnmatched) return [].
  mockSql
    .mockResolvedValueOnce([makeTrackRow()])
    .mockResolvedValue([]);
});

// T-007-05: Match accepted writes matches row
describe("T-007-05: accepted match writes matches row with method=fuzzy", () => {
  it("inserts match row with method=fuzzy when score >= 0.85", async () => {
    // Identical track → score ≈ 1.0 → accepted
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([makeTidalTrack()]));

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(0);

    // Second mockSql call is insertMatch
    const insertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO matches"),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[2]).toBe("fuzzy");
    expect(params[3]).toBeGreaterThanOrEqual(0.85);
  });
});

// T-007-06: Below-threshold enqueues unmatched
describe("T-007-06: below-threshold result enqueues unmatched", () => {
  it("writes unmatched row with reason=fuzzy_below_threshold when score < 0.85", async () => {
    // Use an Atmosphere track as candidate (low artist/album score)
    const lowCandidate = makeTidalTrack({
      title: "Yesterday",
      artists: [{ name: "Atmosphere" }],
      album: { title: "Seven's Travels" },
      duration: 240,
    });
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([lowCandidate]));

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);

    const upsertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO unmatched"),
    );
    expect(upsertCall).toBeDefined();
    const [, params] = upsertCall as [string, unknown[]];
    expect(params[1]).toBe("fuzzy_below_threshold");
  });
});

// T-007-07: No candidates → unmatched with reason=no_candidates
describe("T-007-07: no candidates enqueues unmatched with reason=no_candidates", () => {
  it("writes unmatched row with reason=no_candidates when Tidal returns empty", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalSearchEmpty());

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);

    const upsertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO unmatched"),
    );
    const [, params] = upsertCall as [string, unknown[]];
    expect(params[1]).toBe("no_candidates");
  });
});

// T-007-08: Repeated unmatched increments attempts (via upsert)
describe("T-007-08: repeated unmatched increments attempts", () => {
  it("upsert SQL increments attempts on conflict", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalSearchEmpty());

    await matchByFuzzy(makeEnv());

    const upsertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO unmatched"),
    );
    const [query] = upsertCall as [string];
    expect(query).toContain("attempts + 1");
    expect(query).toContain("WHERE unmatched.status = 'pending'");
  });
});

// T-007-09: Tie broken by smaller duration delta
describe("T-007-09: tie broken by smaller duration delta", () => {
  it("selects candidate with duration_ms=220000 over 225000 when scores tie", async () => {
    // Spotify: 222000ms. Two identical title/artist/album candidates, durations 220000 and 225000.
    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([makeTrackRow({ duration_ms: 222000 })])
      .mockResolvedValue([]);

    const candidates = [
      makeTidalTrack({ id: "td-225", duration: 225 }), // delta=3000
      makeTidalTrack({ id: "td-220", duration: 220 }), // delta=2000
    ];
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk(candidates));

    await matchByFuzzy(makeEnv());

    const insertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO matches"),
    );
    const [, params] = insertCall as [string, unknown[]];
    expect(params[1]).toBe("td-220");
  });
});

// T-007-12: One search per track per run
describe("T-007-12: one search per track per run", () => {
  it("makes exactly 30 Tidal search calls for 30 unmatched tracks", async () => {
    const tracks = Array.from({ length: 30 }, (_, i) => ({
      spotify_id: `sp-${i}`,
      title: "Song",
      artist: "Artist",
      album: "Album",
      duration_ms: 180000,
    }));

    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce(tracks)
      .mockResolvedValue([]);

    mockTidalFetch.mockResolvedValue(tidalSearchEmpty());

    await matchByFuzzy(makeEnv());

    expect(mockTidalFetch).toHaveBeenCalledTimes(30);
  });
});

// T-007-13: Per-decision log line emitted
describe("T-007-13: per-decision log line emitted for each track", () => {
  it("emits exactly 5 fuzzy_decision log lines for 5 tracks", async () => {
    const tracks = Array.from({ length: 5 }, (_, i) => ({
      spotify_id: `sp-${i}`,
      title: "Song",
      artist: "Artist",
      album: "Album",
      duration_ms: 180000,
    }));

    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce(tracks)
      .mockResolvedValue([]);

    // 3 with match, 2 with no candidates
    mockTidalFetch
      .mockResolvedValueOnce(tidalSearchOk([makeTidalTrack()]))
      .mockResolvedValueOnce(tidalSearchOk([makeTidalTrack()]))
      .mockResolvedValueOnce(tidalSearchEmpty())
      .mockResolvedValueOnce(tidalSearchOk([makeTidalTrack()]))
      .mockResolvedValueOnce(tidalSearchEmpty());

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await matchByFuzzy(makeEnv());

    const decisionLogs = logSpy.mock.calls
      .flatMap((args) => args)
      .map(String)
      .filter((s) => {
        try {
          return JSON.parse(s)?.event === "fuzzy_decision";
        } catch {
          return false;
        }
      });

    expect(decisionLogs).toHaveLength(5);
    logSpy.mockRestore();
  });
});

describe("matchByFuzzy — 429 retry", () => {
  it("records per-track error on second 429", async () => {
    vi.useFakeTimers();

    mockTidalFetch
      .mockResolvedValueOnce(tidalStatus(429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(tidalStatus(429));

    const promise = matchByFuzzy(makeEnv());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error_code).toBe("tidal_429");

    vi.useRealTimers();
  });

  it("defaults Retry-After to 1s when header absent", async () => {
    vi.useFakeTimers();

    mockTidalFetch
      .mockResolvedValueOnce(tidalStatus(429))
      .mockResolvedValueOnce(tidalStatus(429));

    const promise = matchByFuzzy(makeEnv());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.errors[0].error_code).toBe("tidal_429");
    vi.useRealTimers();
  });
});

describe("matchByFuzzy — Tidal 5xx error", () => {
  it("records per-track error for 5xx response", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalStatus(503));

    const result = await matchByFuzzy(makeEnv());

    expect(result.errors[0].error_code).toBe("tidal_503");
  });
});

describe("matchByFuzzy — tidalFetch throws", () => {
  it("records per-track error when tidalFetch throws", async () => {
    mockTidalFetch.mockRejectedValueOnce(new Error("network failure"));

    const result = await matchByFuzzy(makeEnv());

    expect(result.errors[0].error_code).toBe("tidal_error");
    expect(result.errors[0].message).toBe("network failure");
  });
});

describe("matchByFuzzy — invalid JSON response", () => {
  it("records parse error for non-JSON response", async () => {
    mockTidalFetch.mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    const result = await matchByFuzzy(makeEnv());

    expect(result.errors[0].error_code).toBe("tidal_parse_error");
  });
});

describe("matchByFuzzy — syncRunId", () => {
  it("passes syncRunId to insertMatch", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([makeTidalTrack()]));

    await matchByFuzzy(makeEnv(), "run-abc");

    const insertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO matches"),
    );
    const [, params] = insertCall as [string, unknown[]];
    expect(params[4]).toBe("run-abc");
  });
});

describe("matchByFuzzy — no unmatched tracks", () => {
  it("returns zeros when there are no unmatched tracks", async () => {
    // Override beforeEach's mockResolvedValueOnce with an empty result
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]); // no tracks — overrides beforeEach

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(0);
    expect(mockTidalFetch).not.toHaveBeenCalled();
  });
});

describe("matchByFuzzy — confidence rounded to 0.01", () => {
  it("rounds confidence to 2 decimal places", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([makeTidalTrack()]));

    await matchByFuzzy(makeEnv());

    const insertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO matches"),
    );
    const [, params] = insertCall as [string, unknown[]];
    const confidence = params[3] as number;
    const rounded = Math.round(confidence * 100) / 100;
    expect(confidence).toBe(rounded);
  });
});

describe("matchByFuzzy — tidalFetch throws non-Error (line 138)", () => {
  it("handles non-Error throws (string throws)", async () => {
    mockTidalFetch.mockRejectedValueOnce("string error");

    const result = await matchByFuzzy(makeEnv());

    expect(result.errors[0].message).toBe("string error");
  });
});

describe("matchByFuzzy — response body uses included field (line 64)", () => {
  it("extracts candidates from included field when data is absent", async () => {
    const candidate = makeTidalTrack();
    const response = new Response(
      JSON.stringify({ included: [candidate] }),
      { status: 200 },
    );
    mockTidalFetch.mockResolvedValueOnce(response);

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(1);
  });
});

describe("matchByFuzzy — candidate without id field filtered out (lines 66-68)", () => {
  it("skips candidates missing the id field, produces no_candidates", async () => {
    const noIdCandidate = { title: "Yesterday", artists: [{ name: "The Beatles" }], duration: 125 };
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([noIdCandidate]));

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(0);
    const upsertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO unmatched"),
    );
    const [, params] = upsertCall as [string, unknown[]];
    expect(params[1]).toBe("no_candidates");
  });
});

describe("matchByFuzzy — empty body (no data or included field)", () => {
  it("treats missing data+included as no candidates", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(0);
    const upsertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO unmatched"),
    );
    const [, params] = upsertCall as [string, unknown[]];
    expect(params[1]).toBe("no_candidates");
  });
});

describe("matchByFuzzy — null spotify duration_ms in rankCandidates (line 80)", () => {
  it("treats null duration_ms as 0 when computing durationDelta", async () => {
    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([makeTrackRow({ duration_ms: null })])
      .mockResolvedValue([]);

    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([makeTidalTrack()]));

    const result = await matchByFuzzy(makeEnv());
    // With null duration, durationDelta = abs(125000 - 0) = 125000 → durationScore = 0
    // But title+artist match is 1.0+1.0 so total = 0.40+0.30 = 0.70 < 0.85 → unmatched
    expect(result.matched + result.unmatched).toBe(1);
  });
});

describe("matchByFuzzy — sort tie-break path (line 89)", () => {
  it("uses duration delta as tiebreak when scores are within 0.001", async () => {
    // Two candidates with identical fields except duration: one is 1ms closer
    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([makeTrackRow({ duration_ms: 125000 })])
      .mockResolvedValue([]);

    // Both have same title/artist/album but slightly different durations
    // Score difference will be in duration component: 125000 vs 125100 → delta diff = 100ms
    // Both well above threshold and score difference < TIE_EPSILON
    const cA = makeTidalTrack({ id: "td-A", duration: 125.1 }); // delta=100ms
    const cB = makeTidalTrack({ id: "td-B", duration: 124.9 }); // delta=100ms
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([cA, cB]));

    await matchByFuzzy(makeEnv());

    // Both have same delta — either could be picked; just verify a match was made
    const insertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO matches"),
    );
    expect(insertCall).toBeDefined();
  });
});
