import { describe, it, expect } from "vitest";
import { scoreCandidate, tidalDurationMs } from "../../src/match/score";
import type { SpotifyTrackInput, TidalCandidateInput } from "../../src/match/score";

function makeSpotify(overrides: Partial<SpotifyTrackInput> = {}): SpotifyTrackInput {
  return {
    title: "Yesterday",
    artist: "The Beatles",
    album: "Help!",
    duration_ms: 125000,
    ...overrides,
  };
}

function makeTidal(overrides: Partial<TidalCandidateInput> = {}): TidalCandidateInput {
  return {
    title: "Yesterday",
    artists: [{ name: "The Beatles" }],
    album: { title: "Help!" },
    duration: 125,
    ...overrides,
  };
}

// T-007-01: Identical metadata scores >= 0.99
describe("T-007-01: identical metadata scores ≥ 0.99", () => {
  it("scores 1.0 for exact match", () => {
    const { total } = scoreCandidate(makeSpotify(), makeTidal());
    expect(total).toBeGreaterThanOrEqual(0.99);
  });
});

// T-007-02: Completely different track scores below threshold
describe("T-007-02: completely different track scores < 0.85", () => {
  it("Yesterday by Atmosphere gets low score against The Beatles version", () => {
    const sp = makeSpotify({ title: "Yesterday", artist: "The Beatles", album: "Help!", duration_ms: 125000 });
    const td = makeTidal({
      title: "Yesterday",
      artists: [{ name: "Atmosphere" }],
      album: { title: "Seven's Travels" },
      duration: 240,
    });
    const { total } = scoreCandidate(sp, td);
    expect(total).toBeLessThan(0.85);
  });
});

// T-007-03: Remastered title normalised to base — score ≥ 0.85
describe("T-007-03: remastered title normalised (T-007-03)", () => {
  it("Bohemian Rhapsody (2011 Remaster) matches Bohemian Rhapsody", () => {
    const sp = makeSpotify({
      title: "Bohemian Rhapsody",
      artist: "Queen",
      album: "A Night at the Opera",
      duration_ms: 354000,
    });
    const td = makeTidal({
      title: "Bohemian Rhapsody (2011 Remaster)",
      artists: [{ name: "Queen" }],
      album: { title: "A Night at the Opera (Deluxe Remastered Version)" },
      duration: 354,
    });
    const { total } = scoreCandidate(sp, td);
    expect(total).toBeGreaterThanOrEqual(0.85);
  });
});

// T-007-04: "feat." stripped from title for matching — score ≥ 0.85
describe('T-007-04: "feat." stripped from title (T-007-04)', () => {
  it("Get Lucky scores well against feat. version", () => {
    const sp = makeSpotify({
      title: "Get Lucky",
      artist: "Daft Punk",
      album: "Random Access Memories",
      duration_ms: 248000,
    });
    const td = makeTidal({
      title: "Get Lucky (feat. Pharrell Williams and Nile Rodgers)",
      artists: [{ name: "Daft Punk" }],
      album: { title: "Random Access Memories" },
      duration: 248,
    });
    const { total } = scoreCandidate(sp, td);
    expect(total).toBeGreaterThanOrEqual(0.85);
  });
});

// T-007-10: Score weights sum correctly
describe("T-007-10: score weights sum correctly", () => {
  it("title=1.0, artist=1.0, duration=0.5, album=0.0 → 0.80", () => {
    // duration=0.5 means delta = 2500ms (half of 5000ms cap)
    const sp = makeSpotify({ duration_ms: 200000, album: "Alpha" });
    const td = makeTidal({
      title: "Yesterday",         // normalises same → titleScore ≈ 1.0
      artists: [{ name: "The Beatles" }],
      album: { title: "Completely Different Album Name That Won't Match" },
      duration: 202.5,             // 202500ms → delta = 2500 → durationScore = 0.5
    });
    const { total } = scoreCandidate(sp, td);
    // 0.40*1 + 0.30*1 + 0.20*0.5 + 0.10*0 = 0.80
    expect(total).toBeCloseTo(0.80, 2);
  });
});

// T-007-11: Duration score is zero beyond 5000ms delta
describe("T-007-11: duration score is zero beyond 5000ms delta", () => {
  it("durationScore = 0.0 when delta is 10000ms", () => {
    const sp = makeSpotify({ duration_ms: 200000 });
    const td = makeTidal({ duration: 210 }); // 210000ms, delta=10000
    const { durationScore } = scoreCandidate(sp, td);
    expect(durationScore).toBe(0.0);
  });

  it("durationScore = 0.5 when delta is exactly 2500ms", () => {
    const sp = makeSpotify({ duration_ms: 200000 });
    const td = makeTidal({ duration: 202.5 }); // delta=2500
    const { durationScore } = scoreCandidate(sp, td);
    expect(durationScore).toBeCloseTo(0.5, 4);
  });

  it("durationScore = 1.0 when delta is zero", () => {
    const sp = makeSpotify({ duration_ms: 200000 });
    const td = makeTidal({ duration: 200 }); // exact match
    const { durationScore } = scoreCandidate(sp, td);
    expect(durationScore).toBe(1.0);
  });
});

// T-007-14: Determinism
describe("T-007-14: determinism", () => {
  it("same inputs produce identical scores on 10 repeated calls", () => {
    const sp = makeSpotify();
    const td = makeTidal();
    const scores = Array.from({ length: 10 }, () => scoreCandidate(sp, td).total);
    const first = scores[0];
    expect(scores.every((s) => s === first)).toBe(true);
  });
});

describe("tidalDurationMs", () => {
  it("converts seconds to ms", () => {
    expect(tidalDurationMs({ duration: 125 })).toBe(125000);
  });

  it("returns 0 when duration is missing", () => {
    expect(tidalDurationMs({})).toBe(0);
  });
});

describe("scoreCandidate — null/missing fields", () => {
  it("handles missing tidal artists gracefully", () => {
    const sp = makeSpotify();
    const td = makeTidal({ artists: undefined });
    const { total } = scoreCandidate(sp, td);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(1);
  });

  it("handles missing tidal title gracefully", () => {
    const sp = makeSpotify();
    const td = makeTidal({ title: undefined });
    const { total } = scoreCandidate(sp, td);
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it("handles null spotify duration", () => {
    const sp = makeSpotify({ duration_ms: null });
    const td = makeTidal({ duration: 125 });
    const { durationScore } = scoreCandidate(sp, td);
    expect(durationScore).toBe(0.0);
  });

  it("handles null spotify album", () => {
    const sp = makeSpotify({ album: null });
    const td = makeTidal({ album: { title: "Help!" } });
    const { albumScore } = scoreCandidate(sp, td);
    expect(albumScore).toBeGreaterThanOrEqual(0);
  });

  it("handles missing tidal album object (line 54 null branch)", () => {
    const sp = makeSpotify();
    const td = makeTidal({ album: undefined });
    const { albumScore } = scoreCandidate(sp, td);
    // td.album is undefined → tdAlbum = "" → tokenSortRatio("Help!", "") < 0.9 → albumScore = 0
    expect(albumScore).toBe(0.0);
  });
});
