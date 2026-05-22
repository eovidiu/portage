// F-028: flexible fuzzy matching algorithm. One test file per spec scenario
// from openspec/changes/flexible-fuzzy-matching/specs/fuzzy-matching/spec.md.
// Each `it()` block is a direct restatement of one #### Scenario from the
// requirements doc, so post-archive the change-spec scenarios survive as
// living tests.
import { describe, it, expect } from "vitest";
import { tokenSetRatio, tokenSortRatio } from "../../src/match/artist";
import { normaliseTitle, normaliseText } from "../../src/match/title";
import { scoreCandidate, type ResolvedTidalCandidate } from "../../src/match/score";

function makeTidal(overrides: Partial<ResolvedTidalCandidate> = {}): ResolvedTidalCandidate {
  return {
    id: "td-1",
    title: "Default Title",
    primaryArtist: "Default Artist",
    artists: ["Default Artist"],
    albumTitle: "Default Album",
    durationMs: 200_000,
    isrc: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Requirement: Title scoring uses token-set ratio
// ---------------------------------------------------------------------------

describe("F-028: title scoring uses token-set ratio", () => {
  it("asymmetric qualifier suffix survives a high title score", () => {
    // Real production case: "Swallowed - 2014 Remastered" (Bush) was rejected
    // by the old tokenSortRatio path.
    const sp = "Swallowed - 2014 Remastered";
    const td = "Swallowed";
    expect(tokenSetRatio(normaliseTitle(sp), normaliseTitle(td))).toBeGreaterThanOrEqual(0.85);
    // Old behaviour for context — tokenSortRatio of the raw strings scores
    // much lower because "- 2014 Remastered" tokens dominate the diff.
    expect(tokenSortRatio(sp, td)).toBeLessThan(0.85);
  });

  it("parenthetical subtitle on one side only", () => {
    // "Ill Ray (The King)" vs "Ill Ray" — current normaliseTitle does NOT
    // strip arbitrary parentheticals (only feat./remaster/year forms), so
    // the asymmetry must be absorbed by the set-ratio primitive.
    const sp = "Ill Ray (The King)";
    const td = "Ill Ray";
    expect(tokenSetRatio(normaliseTitle(sp), normaliseTitle(td))).toBeGreaterThanOrEqual(0.85);
  });

  it("both sides identical produces 1.0", () => {
    expect(tokenSetRatio("Comfortably Numb", "Comfortably Numb")).toBe(1);
  });

  it("completely disjoint inputs produce a low score (no spurious 1.0)", () => {
    // Empty-intersection pathology guard — see the rapidfuzz fallback in
    // tokenSetRatio. Without the fallback, "" -> 1.0 spuriously.
    expect(tokenSetRatio("apple banana", "orange grape")).toBeLessThan(0.5);
  });

  it("one side empty scores 0, not 1", () => {
    expect(tokenSetRatio("Comfortably Numb", "")).toBe(0);
    expect(tokenSetRatio("", "Comfortably Numb")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Requirement: smart-quote + dash normalisation
// ---------------------------------------------------------------------------

describe("F-028: normaliseText maps smart quotes + en/em dashes to ASCII", () => {
  it("smart apostrophe (U+2019) → ASCII apostrophe (U+0027)", () => {
    expect(normaliseText("It’s Never Over")).toBe("It's Never Over");
  });

  it("smart double quotes (U+201C/D) → ASCII double quote", () => {
    expect(normaliseText("“Heroes” - 2017 Remaster")).toBe('"Heroes" - 2017 Remaster');
  });

  it("en dash (U+2013) and em dash (U+2014) → ASCII hyphen", () => {
    expect(normaliseText("Café Tacvba – Eres")).toBe("Café Tacvba - Eres");
    expect(normaliseText("Title — Subtitle")).toBe("Title - Subtitle");
  });

  it("preserves diacritics (NOT ASCII-folded)", () => {
    expect(normaliseText("Felicità")).toBe("Felicità");
    expect(normaliseText("Răsărit perfect")).toBe("Răsărit perfect");
  });

  it("smart-quote-only delta in title scores >= 0.95", () => {
    const sp = normaliseTitle("It’s Never Over");
    const td = normaliseTitle("It's Never Over");
    expect(tokenSetRatio(sp, td)).toBeGreaterThanOrEqual(0.95);
  });
});

// ---------------------------------------------------------------------------
// Requirement: widened strip-pattern set
// ---------------------------------------------------------------------------

describe("F-028: STRIP_PATTERNS widens for common qualifier suffixes", () => {
  it.each([
    ["Needles and Pins - 1999 Remaster", "Needles and Pins"],
    ["Swallowed - 2014 Remastered", "Swallowed"],
    ["Zero - Remastered 2012", "Zero"],
    ["Curtains - Single Edit", "Curtains"],
    ["Hate - Original", "Hate"],
    ["Rox In The Box - Live", "Rox In The Box"],
    ["Four Out Of Five - Recorded at Electric Lady Studios, New York", "Four Out Of Five"],
    ["Some Track - Bonus Track", "Some Track"],
    ["Some Track - Mono Mix", "Some Track"],
    ["Some Track - Stereo Mix", "Some Track"],
    ["Annihilation (Live)", "Annihilation"],
    ["Some Track (Live at Red Rocks)", "Some Track"],
  ])("strips %j → %j", (input, expected) => {
    expect(normaliseTitle(input)).toBe(expected);
  });

  it("empty-after-strip falls back to the trimmed normalised original, never empty", () => {
    // An input that is entirely a strip pattern — preserve operator's
    // input rather than returning "" which would tokenise to nothing.
    const input = "- Live";
    const result = normaliseTitle(input);
    expect(result.length).toBeGreaterThan(0);
  });

  it("preserves the existing parenthetical year-remaster patterns from F-007", () => {
    // Pre-F-028 behaviour must still hold.
    expect(normaliseTitle("Comfortably Numb (2011 Remaster)")).toBe("Comfortably Numb");
    expect(normaliseTitle("Comfortably Numb (Remaster)")).toBe("Comfortably Numb");
  });

  it("does NOT eat mid-string content that happens to match a qualifier", () => {
    // Anchoring to end-of-string is important — a song titled like
    // "Live At The Apollo" should not lose "Live" from the middle.
    // Our patterns are anchored with `\s*$`, so a title that begins with
    // "Live" survives.
    expect(normaliseTitle("Live At The Apollo")).toBe("Live At The Apollo");
  });
});

// ---------------------------------------------------------------------------
// Requirement: ISRC-prefix tiebreaker boost
// ---------------------------------------------------------------------------

describe("F-028: ISRC-prefix tiebreaker boost", () => {
  it("same 7-char prefix adds +0.05 to total", () => {
    const sp = {
      title: "Anno Satana",
      artist: "The Smashing Pumpkins",
      album: "ATUM",
      duration_ms: 220_000,
      isrc: "USYFZ2036707", // same first 7: "USYFZ20"
    };
    const td = makeTidal({
      title: "Anno Satana",
      primaryArtist: "The Smashing Pumpkins",
      albumTitle: "ATUM",
      durationMs: 220_000,
      isrc: "USYFZ2099999", // same prefix, different recording id
    });
    const breakdown = scoreCandidate(sp, td);
    expect(breakdown.isrcPrefixBoost).toBe(0.05);
    // total includes the +0.05 stacked on top of the weighted base.
    expect(breakdown.total).toBeGreaterThan(0.85 + 0.04);
  });

  it("different ISRC prefix → no boost", () => {
    const sp = {
      title: "Whole Lotta Love",
      artist: "Led Zeppelin",
      album: "Coda",
      duration_ms: 333_000,
      isrc: "USAT29900471",
    };
    const td = makeTidal({
      title: "Whole Lotta Love",
      primaryArtist: "Led Zeppelin",
      albumTitle: "Coda",
      durationMs: 333_000,
      isrc: "USJT11600370", // different country+registrant
    });
    const breakdown = scoreCandidate(sp, td);
    expect(breakdown.isrcPrefixBoost).toBe(0);
  });

  it("null ISRC on Spotify side → no boost", () => {
    const sp = {
      title: "Some Track",
      artist: "Some Artist",
      album: "Some Album",
      duration_ms: 200_000,
      isrc: null,
    };
    const td = makeTidal({ isrc: "USYFZ2036707" });
    expect(scoreCandidate(sp, td).isrcPrefixBoost).toBe(0);
  });

  it("null ISRC on Tidal side → no boost", () => {
    const sp = {
      title: "Some Track",
      artist: "Some Artist",
      album: "Some Album",
      duration_ms: 200_000,
      isrc: "USYFZ2036707",
    };
    const td = makeTidal({ isrc: null });
    expect(scoreCandidate(sp, td).isrcPrefixBoost).toBe(0);
  });

  it("ISRC shorter than 7 chars on either side → no boost", () => {
    const sp = { title: "T", artist: "A", album: "X", duration_ms: 200_000, isrc: "USYFZ2" };
    const td = makeTidal({ isrc: "USYFZ2099999" });
    expect(scoreCandidate(sp, td).isrcPrefixBoost).toBe(0);
  });

  it("boost can push a near-miss above the 0.80 threshold", () => {
    // Construct a candidate that lands in the 0.78 territory pre-boost
    // and assert it lands >= 0.80 post-boost. The exact numbers depend on
    // the weight formula; this is a behavioural assertion, not arithmetic.
    const sp = {
      title: "Buona Sera - Remastered 1991",
      artist: "Louis Prima",
      album: "Anthology",
      duration_ms: 175_000,
      isrc: "USCA29000802",
    };
    const td = makeTidal({
      title: "Buona Sera",
      primaryArtist: "Louis Prima",
      albumTitle: "His Greatest Hits",
      durationMs: 178_000, // 3s drift
      isrc: "USCA29099999", // same prefix
    });
    const breakdown = scoreCandidate(sp, td);
    // The combination of (a) tokenSetRatio absorbing the year-remaster
    // strip, (b) ISRC prefix boost, should land >= 0.80.
    expect(breakdown.total).toBeGreaterThanOrEqual(0.80);
  });
});

// ---------------------------------------------------------------------------
// Requirement: backward-compatible output shape
// ---------------------------------------------------------------------------

describe("F-028: ScoreBreakdown shape is backward-compatible (only added isrcPrefixBoost)", () => {
  it("retains the five legacy fields plus the new isrcPrefixBoost", () => {
    const sp = { title: "X", artist: "Y", album: "Z", duration_ms: 200_000 };
    const td = makeTidal();
    const breakdown = scoreCandidate(sp, td);
    expect(Object.keys(breakdown).sort()).toEqual(
      ["albumScore", "artistScore", "durationScore", "isrcPrefixBoost", "titleScore", "total"].sort(),
    );
  });
});
