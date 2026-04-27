import { describe, it, expect } from "vitest";
import { scoreCandidate } from "../../src/match/score";
import type { SpotifyTrackInput, ResolvedTidalCandidate } from "../../src/match/score";

function makeSpotify(overrides: Partial<SpotifyTrackInput> = {}): SpotifyTrackInput {
  return {
    title: "Yesterday",
    artist: "The Beatles",
    album: "Help!",
    duration_ms: 125000,
    ...overrides,
  };
}

function makeTidal(overrides: Partial<ResolvedTidalCandidate> = {}): ResolvedTidalCandidate {
  return {
    id: "td-001",
    title: "Yesterday",
    primaryArtist: "The Beatles",
    albumTitle: "Help!",
    durationMs: 125000,
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
      primaryArtist: "Atmosphere",
      albumTitle: "Seven's Travels",
      durationMs: 240000,
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
      primaryArtist: "Queen",
      albumTitle: "A Night at the Opera (Deluxe Remastered Version)",
      durationMs: 354000,
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
      primaryArtist: "Daft Punk",
      albumTitle: "Random Access Memories",
      durationMs: 248000,
    });
    const { total } = scoreCandidate(sp, td);
    expect(total).toBeGreaterThanOrEqual(0.85);
  });
});

// T-007-10: Score weights sum correctly
describe("T-007-10: score weights sum correctly", () => {
  it("title=1.0, artist=1.0, duration=0.5, album=0.0 → 0.80", () => {
    const sp = makeSpotify({ duration_ms: 200000, album: "Alpha" });
    const td = makeTidal({
      title: "Yesterday",
      primaryArtist: "The Beatles",
      albumTitle: "Completely Different Album Name That Won't Match",
      durationMs: 202500, // delta=2500ms → durationScore=0.5
    });
    const { total } = scoreCandidate(sp, td);
    expect(total).toBeCloseTo(0.80, 2);
  });
});

// T-007-11: Duration score is zero beyond 5000ms delta
describe("T-007-11: duration score is zero beyond 5000ms delta", () => {
  it("durationScore = 0.0 when delta is 10000ms", () => {
    const sp = makeSpotify({ duration_ms: 200000 });
    const td = makeTidal({ durationMs: 210000 });
    const { durationScore } = scoreCandidate(sp, td);
    expect(durationScore).toBe(0.0);
  });

  it("durationScore = 0.5 when delta is exactly 2500ms", () => {
    const sp = makeSpotify({ duration_ms: 200000 });
    const td = makeTidal({ durationMs: 202500 });
    const { durationScore } = scoreCandidate(sp, td);
    expect(durationScore).toBeCloseTo(0.5, 4);
  });

  it("durationScore = 1.0 when delta is zero", () => {
    const sp = makeSpotify({ duration_ms: 200000 });
    const td = makeTidal({ durationMs: 200000 });
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

describe("scoreCandidate — null/missing fields", () => {
  it("treats empty primaryArtist as zero artist score against a non-empty Spotify artist", () => {
    const sp = makeSpotify();
    const td = makeTidal({ primaryArtist: "" });
    const { artistScore, total } = scoreCandidate(sp, td);
    expect(artistScore).toBe(0);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(1);
  });

  it("treats empty title as zero title score", () => {
    const sp = makeSpotify();
    const td = makeTidal({ title: "" });
    const { titleScore } = scoreCandidate(sp, td);
    expect(titleScore).toBe(0);
  });

  it("treats null durationMs as zero (delta = spotify duration)", () => {
    const sp = makeSpotify({ duration_ms: 200000 });
    const td = makeTidal({ durationMs: null });
    const { durationScore } = scoreCandidate(sp, td);
    // delta = 200000 → capped at 5000 → durationScore = 0
    expect(durationScore).toBe(0);
  });

  it("treats null spotify duration as zero (asymmetric to tidal)", () => {
    const sp = makeSpotify({ duration_ms: null });
    const td = makeTidal({ durationMs: 125000 });
    const { durationScore } = scoreCandidate(sp, td);
    // sp=0, td=125000 → delta=125000 → cap → 0
    expect(durationScore).toBe(0);
  });

  it("treats null spotify album as no album score", () => {
    const sp = makeSpotify({ album: null });
    const td = makeTidal({ albumTitle: "Help!" });
    const { albumScore } = scoreCandidate(sp, td);
    // sp normalises to "" → tokenSortRatio("", "Help!") < 0.9 → 0
    expect(albumScore).toBe(0);
  });

  it("treats empty albumTitle as no album score", () => {
    const sp = makeSpotify();
    const td = makeTidal({ albumTitle: "" });
    const { albumScore } = scoreCandidate(sp, td);
    expect(albumScore).toBe(0);
  });
});
