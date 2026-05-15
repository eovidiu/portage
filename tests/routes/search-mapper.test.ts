// F-024 R3: ResolvedTidalCandidate → flat response shape mapper.
import { describe, it, expect } from "vitest";
import type { ResolvedTidalCandidate } from "../../src/match/score";
import { mapCandidateToResponseShape } from "../../src/routes/search-mapper";

function baseCandidate(overrides: Partial<ResolvedTidalCandidate> = {}): ResolvedTidalCandidate {
  return {
    id: "td-1",
    title: "One",
    primaryArtist: "Metallica",
    artists: ["Metallica"],
    albumTitle: "...And Justice For All",
    durationMs: 447_000,
    isrc: "USEL18800020",
    ...overrides,
  };
}

describe("mapCandidateToResponseShape — full happy path", () => {
  it("returns every contract field with no confidence field", () => {
    const out = mapCandidateToResponseShape(baseCandidate());
    expect(out).toEqual({
      tidal_id: "td-1",
      title: "One",
      artists: ["Metallica"],
      album: "...And Justice For All",
      duration_ms: 447_000,
      isrc: "USEL18800020",
    });
    expect(out).not.toHaveProperty("confidence");
  });
});

describe("mapCandidateToResponseShape — null/empty propagation", () => {
  it("maps empty albumTitle to null album", () => {
    const out = mapCandidateToResponseShape(baseCandidate({ albumTitle: "" }));
    expect(out.album).toBeNull();
  });

  it("preserves non-empty album as-is", () => {
    const out = mapCandidateToResponseShape(baseCandidate({ albumTitle: "Master of Puppets" }));
    expect(out.album).toBe("Master of Puppets");
  });

  it("maps null durationMs to 0", () => {
    const out = mapCandidateToResponseShape(baseCandidate({ durationMs: null }));
    expect(out.duration_ms).toBe(0);
  });

  it("preserves numeric durationMs", () => {
    const out = mapCandidateToResponseShape(baseCandidate({ durationMs: 123_456 }));
    expect(out.duration_ms).toBe(123_456);
  });

  it("returns artists as the array from the candidate", () => {
    const out = mapCandidateToResponseShape(
      baseCandidate({ artists: ["Run-DMC", "Aerosmith"], primaryArtist: "Run-DMC" }),
    );
    expect(out.artists).toEqual(["Run-DMC", "Aerosmith"]);
  });

  it("returns empty artists array when none resolved", () => {
    const out = mapCandidateToResponseShape(
      baseCandidate({ artists: [], primaryArtist: "" }),
    );
    expect(out.artists).toEqual([]);
  });

  it("preserves null isrc", () => {
    const out = mapCandidateToResponseShape(baseCandidate({ isrc: null }));
    expect(out.isrc).toBeNull();
  });
});
