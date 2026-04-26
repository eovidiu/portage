import { describe, it, expect } from "vitest";
import { artistAgrees, tokenSortRatio } from "../../src/match/artist";

describe("tokenSortRatio", () => {
  it("identical strings → 1.0", () => {
    expect(tokenSortRatio("adele", "adele")).toBe(1);
  });

  it("different token order → same ratio as sorted", () => {
    expect(tokenSortRatio("b a", "a b")).toBe(1);
  });

  it("empty strings → 1.0", () => {
    expect(tokenSortRatio("", "")).toBe(1);
  });

  it("completely different strings → ratio < 0.5", () => {
    expect(tokenSortRatio("adele", "metallica")).toBeLessThan(0.5);
  });
});

// T-006-06: "feat." in artist normalised correctly
describe('artistAgrees — "feat." normalisation (T-006-06)', () => {
  it('strips feat. suffix: "Daft Punk feat. Pharrell Williams" agrees with "Daft Punk"', () => {
    expect(artistAgrees("Daft Punk feat. Pharrell Williams", "Daft Punk")).toBe(true);
  });

  it('strips "featuring" suffix', () => {
    expect(artistAgrees("Eminem featuring Rihanna", "Eminem")).toBe(true);
  });

  it('strips "ft." suffix', () => {
    expect(artistAgrees("Jay-Z ft. Beyoncé", "Jay-Z")).toBe(true);
  });
});

// T-006-07: Parenthetical content stripped from artist comparison
describe("artistAgrees — parenthetical stripping (T-006-07)", () => {
  it('strips parenthetical: "The Rolling Stones (Live)" agrees with "The Rolling Stones"', () => {
    expect(artistAgrees("The Rolling Stones (Live)", "The Rolling Stones")).toBe(true);
  });
});

describe("artistAgrees — exact match", () => {
  it("identical artists agree", () => {
    expect(artistAgrees("Adele", "Adele")).toBe(true);
  });

  it("case-insensitive comparison", () => {
    expect(artistAgrees("adele", "ADELE")).toBe(true);
  });
});

describe("artistAgrees — disagreement", () => {
  it('"Adele" does not agree with "Random Cover Band"', () => {
    expect(artistAgrees("Adele", "Random Cover Band")).toBe(false);
  });

  it("completely different artists do not agree", () => {
    expect(artistAgrees("Metallica", "Taylor Swift")).toBe(false);
  });
});
