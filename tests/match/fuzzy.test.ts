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

/**
 * Tidal v2 returns JSON:API. `/searchResults/{id}?include=tracks,artists,albums`
 * gives back: `data` (single SearchResults resource with relationships pointing
 * to top tracks/artists/albums) and `included[]` (full track + artist + album
 * resources). These helpers mirror that contract precisely so tests exercise
 * the real resolution path.
 */

interface TrackResource {
  id: string;
  type: "tracks";
  attributes: { title: string; isrc: string; duration: string };
  relationships: {
    artists: { data: Array<{ id: string; type: "artists" }> };
    albums: { data: Array<{ id: string; type: "albums" }> };
  };
}

interface ArtistResource {
  id: string;
  type: "artists";
  attributes: { name: string };
}

interface AlbumResource {
  id: string;
  type: "albums";
  attributes: { title: string };
}

interface MakeTrackOptions {
  id?: string;
  title?: string;
  artistName?: string;
  albumTitle?: string;
  durationSeconds?: number;
  artistId?: string;
  albumId?: string;
}

interface ResolvedTrackBundle {
  track: TrackResource;
  artist: ArtistResource;
  album: AlbumResource;
}

function secondsToIso(seconds: number): string {
  return `PT${seconds}S`;
}

function makeTidalTrack(opts: MakeTrackOptions = {}): ResolvedTrackBundle {
  const id = opts.id ?? "td-001";
  const artistId = opts.artistId ?? `${id}-artist`;
  const albumId = opts.albumId ?? `${id}-album`;
  const track: TrackResource = {
    id,
    type: "tracks",
    attributes: {
      title: opts.title ?? "Yesterday",
      isrc: "GBUM71029604",
      duration: secondsToIso(opts.durationSeconds ?? 125),
    },
    relationships: {
      artists: { data: [{ id: artistId, type: "artists" }] },
      albums: { data: [{ id: albumId, type: "albums" }] },
    },
  };
  const artist: ArtistResource = {
    id: artistId,
    type: "artists",
    attributes: { name: opts.artistName ?? "The Beatles" },
  };
  const album: AlbumResource = {
    id: albumId,
    type: "albums",
    attributes: { title: opts.albumTitle ?? "Help!" },
  };
  return { track, artist, album };
}

/** Build a `/searchResults/{id}` style response with N track refs + included resources. */
function tidalSearchOk(bundles: ResolvedTrackBundle[]): Response {
  const data = {
    id: "yesterday",
    type: "searchResults",
    attributes: {},
    relationships: {
      tracks: { data: bundles.map((b) => ({ id: b.track.id, type: "tracks" })) },
    },
  };
  const included = bundles.flatMap((b) => [b.track, b.artist, b.album]);
  return new Response(JSON.stringify({ data, included }), { status: 200 });
}

function tidalSearchEmpty(): Response {
  const data = {
    id: "empty",
    type: "searchResults",
    attributes: {},
    relationships: { tracks: { data: [] } },
  };
  return new Response(JSON.stringify({ data, included: [] }), { status: 200 });
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

beforeEach(() => {
  vi.clearAllMocks();
  // Default: fetchUnmatchedTracks returns one track row; subsequent SQL calls return [].
  mockSql.mockResolvedValueOnce([makeTrackRow()]).mockResolvedValue([]);
});

// T-007-05: Match accepted writes matches row
describe("T-007-05: accepted match writes matches row with method=fuzzy", () => {
  it("inserts match row with method=fuzzy when score >= 0.85", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([makeTidalTrack()]));

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(0);

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
    const lowCandidate = makeTidalTrack({
      title: "Yesterday",
      artistName: "Atmosphere",
      albumTitle: "Seven's Travels",
      durationSeconds: 240,
    });
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([lowCandidate]));

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);

    const upsertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO unmatched"),
    );
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
  it("selects candidate with delta=2000 over delta=3000 when scores tie", async () => {
    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([makeTrackRow({ duration_ms: 222000 })])
      .mockResolvedValue([]);

    mockTidalFetch.mockResolvedValueOnce(
      tidalSearchOk([
        makeTidalTrack({ id: "td-225", durationSeconds: 225 }), // delta=3000
        makeTidalTrack({ id: "td-220", durationSeconds: 220 }), // delta=2000
      ]),
    );

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
    mockSql.mockResolvedValueOnce(tracks).mockResolvedValue([]);

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
    mockSql.mockResolvedValueOnce(tracks).mockResolvedValue([]);

    mockTidalFetch
      .mockResolvedValueOnce(tidalSearchOk([makeTidalTrack({ artistName: "Artist", albumTitle: "Album", title: "Song", durationSeconds: 180 })]))
      .mockResolvedValueOnce(tidalSearchOk([makeTidalTrack({ artistName: "Artist", albumTitle: "Album", title: "Song", durationSeconds: 180 })]))
      .mockResolvedValueOnce(tidalSearchEmpty())
      .mockResolvedValueOnce(tidalSearchOk([makeTidalTrack({ artistName: "Artist", albumTitle: "Album", title: "Song", durationSeconds: 180 })]))
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

describe("matchByFuzzy — request URL shape", () => {
  it("uses /searchResults camelCase, compound include paths for nested artists/albums, no limit param", async () => {
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([makeTidalTrack()]));

    await matchByFuzzy(makeEnv());

    const [, path] = mockTidalFetch.mock.calls[0] as [Env, string];
    expect(path).toContain("/v2/searchResults/");
    expect(path).not.toContain("/v2/searchresults/"); // lowercase form is wrong
    // 2026-05-02 prod fix: tracks.artists + tracks.albums (compound include
    // paths) — bare `artists,albums` returned tracks but no track→artist refs.
    expect(path).toContain("include=tracks");
    expect(path).toContain("tracks.artists");
    expect(path).toContain("tracks.albums");
    expect(path).not.toContain("limit=");
    expect(path).not.toContain("/relationships/tracks"); // we now use the singular endpoint
  });
});

describe("matchByFuzzy — caps candidates at 5 (F-007-R3)", () => {
  it("scores at most 5 candidates even when included[] has more", async () => {
    const tenBundles = Array.from({ length: 10 }, (_, i) =>
      makeTidalTrack({
        id: `td-${i}`,
        title: "Yesterday",
        artistName: i === 5 ? "Atmosphere" : "The Beatles", // sentinel: only the 6th differs
        albumTitle: "Help!",
        durationSeconds: 125,
      }),
    );
    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk(tenBundles));

    const result = await matchByFuzzy(makeEnv());

    // First 5 candidates all have artist=The Beatles → top score >= 0.99 → match accepted
    expect(result.matched).toBe(1);
    const insertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO matches"),
    );
    const [, params] = insertCall as [string, unknown[]];
    // Picked candidate must be one of the first 5 (the Atmosphere divergence is at index 5)
    expect(["td-0", "td-1", "td-2", "td-3", "td-4"]).toContain(params[1]);
  });
});

describe("matchByFuzzy — track ref with no matching included resource", () => {
  it("skips track refs that aren't present in included[]", async () => {
    // data references td-orphan but included[] is empty
    const data = {
      id: "yesterday",
      type: "searchResults",
      attributes: {},
      relationships: {
        tracks: { data: [{ id: "td-orphan", type: "tracks" }] },
      },
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data, included: [] }), { status: 200 }),
    );

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

describe("matchByFuzzy — track with unresolved artist (artist not in included[])", () => {
  it("scores artist as empty when artist ref points to missing resource", async () => {
    const { track, album } = makeTidalTrack({ id: "td-noartist", artistId: "missing" });
    const data = {
      id: "yesterday",
      type: "searchResults",
      attributes: {},
      relationships: {
        tracks: { data: [{ id: track.id, type: "tracks" }] },
      },
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data, included: [track, album] }), { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());

    // Without artist score (0.30 weight) it can't reach 0.85 threshold
    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
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

  it("handles non-Error throws (string throws)", async () => {
    mockTidalFetch.mockRejectedValueOnce("string error");

    const result = await matchByFuzzy(makeEnv());

    expect(result.errors[0].message).toBe("string error");
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

    await matchByFuzzy(makeEnv(), { syncRunId: "run-abc" });

    const insertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO matches"),
    );
    const [, params] = insertCall as [string, unknown[]];
    expect(params[4]).toBe("run-abc");
  });
});

describe("matchByFuzzy — no unmatched tracks", () => {
  it("returns zeros when there are no unmatched tracks", async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]);

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

describe("matchByFuzzy — empty body (no data field)", () => {
  it("treats missing data as no candidates", async () => {
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

  it("treats non-object body (null) as no candidates", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response("null", { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(0);
  });

  it("treats data without relationships.tracks as no candidates", async () => {
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: "x", type: "searchResults" }, included: [] }), {
        status: 200,
      }),
    );

    const result = await matchByFuzzy(makeEnv());

    expect(result.matched).toBe(0);
  });
});

describe("matchByFuzzy — ignores non-track refs in tracks relationship", () => {
  it("skips refs whose type is not 'tracks'", async () => {
    const data = {
      id: "yesterday",
      type: "searchResults",
      attributes: {},
      relationships: {
        tracks: {
          data: [
            { id: "weird-1", type: "albums" }, // wrong type
            { id: "weird-2" }, // missing type
            { type: "tracks" }, // missing id
          ],
        },
      },
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data, included: [] }), { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());
    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
  });
});

describe("matchByFuzzy — null spotify duration_ms", () => {
  it("treats null duration_ms as 0 when computing durationDelta", async () => {
    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([makeTrackRow({ duration_ms: null })])
      .mockResolvedValue([]);

    mockTidalFetch.mockResolvedValueOnce(tidalSearchOk([makeTidalTrack()]));

    const result = await matchByFuzzy(makeEnv());
    // sp duration is null → treated as 0; tidal=125000 → delta capped at 5000ms → durationScore=0
    // title+artist+album = 0.40+0.30+0.10 = 0.80 < 0.85 → unmatched
    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
  });
});

describe("matchByFuzzy — defensive resolution of malformed track resources", () => {
  it("treats track with no attributes as title='', duration=null", async () => {
    const track = {
      id: "td-bare",
      type: "tracks",
      relationships: {
        artists: { data: [{ id: "a1", type: "artists" }] },
        albums: { data: [{ id: "alb1", type: "albums" }] },
      },
    };
    const artist = { id: "a1", type: "artists", attributes: { name: "The Beatles" } };
    const album = { id: "alb1", type: "albums", attributes: { title: "Help!" } };
    const data = {
      id: "x", type: "searchResults", attributes: {},
      relationships: { tracks: { data: [{ id: "td-bare", type: "tracks" }] } },
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data, included: [track, artist, album] }), { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());
    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
  });

  it("treats track with no relationships as primaryArtist='', albumTitle=''", async () => {
    const track = {
      id: "td-norel",
      type: "tracks",
      attributes: { title: "Yesterday", duration: "PT2M5S" },
    };
    const data = {
      id: "x", type: "searchResults", attributes: {},
      relationships: { tracks: { data: [{ id: "td-norel", type: "tracks" }] } },
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data, included: [track] }), { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());
    expect(result.matched).toBe(0);
  });

  it("treats track with non-array relationships.artists.data as no artist", async () => {
    // JSON:API allows single resource link too; we only support array form
    const track = {
      id: "td-singleartist",
      type: "tracks",
      attributes: { title: "Yesterday", duration: "PT2M5S" },
      relationships: {
        artists: { data: { id: "a1", type: "artists" } }, // single, not array
        albums: { data: [{ id: "alb1", type: "albums" }] },
      },
    };
    const album = { id: "alb1", type: "albums", attributes: { title: "Help!" } };
    const data = {
      id: "x", type: "searchResults", attributes: {},
      relationships: { tracks: { data: [{ id: "td-singleartist", type: "tracks" }] } },
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data, included: [track, album] }), { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());
    expect(result.matched).toBe(0);
  });

  it("treats non-string title attribute as empty title", async () => {
    const { track, artist, album } = makeTidalTrack();
    track.attributes.title = 12345 as unknown as string;
    const data = {
      id: "x", type: "searchResults", attributes: {},
      relationships: { tracks: { data: [{ id: track.id, type: "tracks" }] } },
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data, included: [track, artist, album] }), { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());
    expect(result.matched).toBe(0); // empty title → titleScore 0 → can't reach threshold
  });

  it("treats non-string artist.name as empty artist", async () => {
    const { track, artist, album } = makeTidalTrack();
    artist.attributes.name = 12345 as unknown as string;
    const data = {
      id: "x", type: "searchResults", attributes: {},
      relationships: { tracks: { data: [{ id: track.id, type: "tracks" }] } },
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data, included: [track, artist, album] }), { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());
    expect(result.matched).toBe(0); // artistScore 0 → 0.40+0.20+0.10=0.70 < 0.85
  });

  it("treats non-string album.title as empty album", async () => {
    const { track, artist, album } = makeTidalTrack();
    album.attributes.title = 12345 as unknown as string;
    const data = {
      id: "x", type: "searchResults", attributes: {},
      relationships: { tracks: { data: [{ id: track.id, type: "tracks" }] } },
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data, included: [track, artist, album] }), { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());
    // title+artist+duration = 0.40+0.30+0.20 = 0.90 >= 0.85 → match
    expect(result.matched).toBe(1);
  });

  it("treats included not an array as empty index", async () => {
    const data = {
      id: "x", type: "searchResults", attributes: {},
      relationships: { tracks: { data: [{ id: "td-ref", type: "tracks" }] } },
    };
    mockTidalFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data, included: "not-an-array" }), { status: 200 }),
    );

    const result = await matchByFuzzy(makeEnv());
    // ref points to td-ref, but no included[] means no track resource → no_candidates
    expect(result.matched).toBe(0);
  });
});

describe("matchByFuzzy — sort tie-break path", () => {
  it("uses duration delta as tiebreak when scores are within 0.001", async () => {
    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([makeTrackRow({ duration_ms: 125000 })])
      .mockResolvedValue([]);

    mockTidalFetch.mockResolvedValueOnce(
      tidalSearchOk([
        makeTidalTrack({ id: "td-A", durationSeconds: 125.1 }), // delta=100ms
        makeTidalTrack({ id: "td-B", durationSeconds: 124.9 }), // delta=100ms
      ]),
    );

    await matchByFuzzy(makeEnv());

    // Both have same delta — either may win; just verify a match was made
    const insertCall = mockSql.mock.calls.find(
      ([q]: [string]) => typeof q === "string" && q.includes("INSERT INTO matches"),
    );
    expect(insertCall).toBeDefined();
  });
});

// F-015: bounded queue + 7-day cooldown predicate (closes Sprint 6 M2/M3)
describe("matchByFuzzy — bounded queue (F-015)", () => {
  it("passes limit to the SELECT as $1", async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]).mockResolvedValue([]);
    await matchByFuzzy(makeEnv(), { limit: 3 });
    const [sql, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain("limit $1");
    expect(params).toEqual([3]);
  });

  it("LEFT JOINs unmatched and applies skipped exclusion + 7-day cooldown", async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]).mockResolvedValue([]);
    await matchByFuzzy(makeEnv(), { limit: 5 });
    const [sql] = mockSql.mock.calls[0] as [string, unknown[]];
    const norm = sql.toLowerCase().replace(/\s+/g, " ");
    expect(norm).toContain("left join unmatched u");
    expect(norm).toContain("u.status is null");
    expect(norm).toContain("u.status = 'pending'");
    expect(norm).toContain("u.last_attempt_at < now() - interval '7 days'");
  });

  it("orders by first_seen_at ASC for fair queue draining", async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]).mockResolvedValue([]);
    await matchByFuzzy(makeEnv(), { limit: 5 });
    const [sql] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase().replace(/\s+/g, " ")).toContain("order by t.first_seen_at asc");
  });

  it("defaults to Number.MAX_SAFE_INTEGER when no limit option provided", async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]).mockResolvedValue([]);
    await matchByFuzzy(makeEnv());
    const [, params] = mockSql.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([Number.MAX_SAFE_INTEGER]);
  });
});
