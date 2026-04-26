// T-013: DB helper tests for src/db/captures.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/env";

const mockSql = vi.fn();
vi.mock("@neondatabase/serverless", () => ({
  neon: () => mockSql,
}));

import { insertCapture, findRecentCapture, listCaptures } from "../../src/db/captures";

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgresql://test",
    JWT_SECRET: "test-jwt-secret-32-bytes-long-ok!",
    TOKEN_ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzLWxvbmc=",
    SPOTIFY_CLIENT_ID: "test",
    SPOTIFY_CLIENT_SECRET: "test",
    SPOTIFY_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/spotify/callback",
    TIDAL_CLIENT_ID: "test",
    TIDAL_CLIENT_SECRET: "test",
    TIDAL_REDIRECT_URI: "https://portage.eovidiu.co.uk/auth/tidal/callback",
    TIDAL_COUNTRY_CODE: "RO",
    TIDAL_PLAYLIST_TITLE: "Spotify Liked",
  };
}

const VALID_ID = "3n3Ppam7vgaVa1iaRUc9Lp";

function makeInsertParams(overrides = {}) {
  return {
    spotify_id: VALID_ID,
    captured_at: "2026-04-25T14:32:00.000Z",
    location_lat: 44.4268,
    location_lng: 26.1025,
    source: "siri",
    context_note: "saw cover in coffee shop",
    ...overrides,
  };
}

function makeCaptureRow(overrides = {}) {
  return {
    capture_id: "9c2b0000-0000-0000-0000-000000000001",
    spotify_id: VALID_ID,
    captured_at: "2026-04-25T14:32:00Z",
    location_lat: 44.4268,
    location_lng: 26.1025,
    source: "siri",
    context_note: "saw cover in coffee shop",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// T-013-02: insertCapture happy path
describe("T-013-02: insertCapture — happy path", () => {
  it("inserts a row and returns the persisted capture", async () => {
    const returned = makeCaptureRow();
    mockSql.mockResolvedValueOnce([returned]);

    const result = await insertCapture(makeEnv(), makeInsertParams());

    expect(result).toEqual(returned);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("INSERT INTO captures");
    expect(params[0]).toBe(VALID_ID);
    expect(params[1]).toBe("2026-04-25T14:32:00.000Z");
    expect(params[2]).toBe(44.4268);
    expect(params[3]).toBe(26.1025);
    expect(params[4]).toBe("siri");
    expect(params[5]).toBe("saw cover in coffee shop");
  });

  it("passes null for optional fields when omitted", async () => {
    const returned = makeCaptureRow({ location_lat: null, location_lng: null, context_note: null });
    mockSql.mockResolvedValueOnce([returned]);

    const result = await insertCapture(
      makeEnv(),
      makeInsertParams({ location_lat: null, location_lng: null, context_note: null }),
    );

    expect(result.location_lat).toBeNull();
    expect(result.location_lng).toBeNull();
    expect(result.context_note).toBeNull();
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
    expect(params[5]).toBeNull();
  });
});

// T-013: insertCapture FK violation (23503) propagates
describe("T-013: insertCapture — FK violation propagates", () => {
  it("throws the Postgres error when spotify_id not in tracks", async () => {
    const fkError = new Error("FK violation") as Error & { code: string };
    fkError.code = "23503";
    mockSql.mockRejectedValueOnce(fkError);

    await expect(insertCapture(makeEnv(), makeInsertParams())).rejects.toMatchObject({
      code: "23503",
    });
  });
});

// T-013: insertCapture generic DB error propagates
describe("T-013: insertCapture — generic DB error propagates", () => {
  it("propagates non-FK errors to the caller", async () => {
    mockSql.mockRejectedValueOnce(new Error("Connection refused"));

    await expect(insertCapture(makeEnv(), makeInsertParams())).rejects.toThrow(
      "Connection refused",
    );
  });
});

// T-013-12: findRecentCapture — within 60s returns the row
describe("T-013-12: findRecentCapture — within 60s returns row", () => {
  it("returns the capture row when one exists within 60 seconds", async () => {
    const row = makeCaptureRow();
    mockSql.mockResolvedValueOnce([row]);

    const result = await findRecentCapture(makeEnv(), VALID_ID);

    expect(result).toEqual(row);
    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("interval '60 seconds'");
    expect(params[0]).toBe(VALID_ID);
  });

  it("passes the correct spotify_id to the query", async () => {
    mockSql.mockResolvedValueOnce([makeCaptureRow()]);

    await findRecentCapture(makeEnv(), VALID_ID);

    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(VALID_ID);
  });
});

// T-013-12: findRecentCapture — older than 60s returns null
describe("T-013-12: findRecentCapture — no recent capture returns null", () => {
  it("returns null when no capture within 60 seconds", async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await findRecentCapture(makeEnv(), VALID_ID);

    expect(result).toBeNull();
  });
});

// T-013-14: listCaptures — default limit, no filter
describe("T-013-14: listCaptures — default limit, no date filter", () => {
  it("passes limit as first param and builds no WHERE clause", async () => {
    mockSql.mockResolvedValueOnce([]);

    await listCaptures(makeEnv(), 50);

    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(50);
    expect(query).not.toContain("WHERE");
  });
});

// T-013-14: listCaptures — match_status correctly shaped
describe("T-013-14: listCaptures — returns match_status from LEFT JOIN", () => {
  it("returns rows with match_status as returned by the DB query", async () => {
    const rows = [
      { ...makeCaptureRow({ capture_id: "id-1" }), match_status: "matched", tidal_id: "12345" },
      { ...makeCaptureRow({ capture_id: "id-2" }), match_status: "unmatched", tidal_id: null },
      { ...makeCaptureRow({ capture_id: "id-3" }), match_status: "pending", tidal_id: null },
    ];
    mockSql.mockResolvedValueOnce(rows);

    const result = await listCaptures(makeEnv(), 50);

    expect(result).toHaveLength(3);
    expect(result[0].match_status).toBe("matched");
    expect(result[0].tidal_id).toBe("12345");
    expect(result[1].match_status).toBe("unmatched");
    expect(result[2].match_status).toBe("pending");
  });
});

// T-013: listCaptures — pagination cap
describe("T-013: listCaptures — limit param is forwarded", () => {
  it("forwards the limit value to the SQL query", async () => {
    mockSql.mockResolvedValueOnce([]);

    await listCaptures(makeEnv(), 100);

    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(100);
  });
});

// T-013: listCaptures — fromDate filter
describe("T-013: listCaptures — fromDate adds WHERE clause", () => {
  it("adds captured_at >= condition when fromDate is provided", async () => {
    mockSql.mockResolvedValueOnce([]);

    await listCaptures(makeEnv(), 50, "2026-04-01T00:00:00Z");

    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("captured_at >=");
    expect(params).toContain("2026-04-01T00:00:00Z");
  });
});

// T-013: listCaptures — toDate filter
describe("T-013: listCaptures — toDate adds WHERE clause", () => {
  it("adds captured_at <= condition when toDate is provided", async () => {
    mockSql.mockResolvedValueOnce([]);

    await listCaptures(makeEnv(), 50, undefined, "2026-04-30T00:00:00Z");

    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("captured_at <=");
    expect(params).toContain("2026-04-30T00:00:00Z");
  });
});

// T-013: listCaptures — both date filters
describe("T-013: listCaptures — both fromDate and toDate", () => {
  it("includes both conditions joined by AND", async () => {
    mockSql.mockResolvedValueOnce([]);

    await listCaptures(makeEnv(), 50, "2026-04-01T00:00:00Z", "2026-04-30T00:00:00Z");

    const [query, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("WHERE");
    expect(query).toContain("AND");
    expect(params).toContain("2026-04-01T00:00:00Z");
    expect(params).toContain("2026-04-30T00:00:00Z");
  });
});

// T-013: listCaptures — SQL includes LEFT JOINs for match_status
describe("T-013: listCaptures — query includes LEFT JOINs", () => {
  it("queries matches and unmatched tables via LEFT JOIN", async () => {
    mockSql.mockResolvedValueOnce([]);

    await listCaptures(makeEnv(), 50);

    const [query] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("LEFT JOIN matches");
    expect(query).toContain("LEFT JOIN unmatched");
    expect(query).toContain("match_status");
  });
});

// T-013: listCaptures — empty result
describe("T-013: listCaptures — empty result", () => {
  it("returns an empty array when no captures exist", async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await listCaptures(makeEnv(), 50);

    expect(result).toEqual([]);
  });
});
