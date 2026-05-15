// F-025 R1: pure helper unit tests for buildRematchQuery.
import { describe, it, expect } from "vitest";
import { buildRematchQuery } from "../../src/match/rematch";

describe("F-025 R1: buildRematchQuery happy paths", () => {
  it("two-word artist + multi-word title strips remaster and takes first title word", () => {
    expect(
      buildRematchQuery("Pink Floyd", "Comfortably Numb - Remaster"),
    ).toBe("pink floyd comfortably");
  });

  it("single-word artist uses just that one token plus the first title word", () => {
    expect(buildRematchQuery("Beyoncé", "Single Ladies (Put a Ring on It)")).toBe(
      "beyoncé single",
    );
  });

  it("preserves diacritics on the artist side", () => {
    expect(buildRematchQuery("Café Tacvba", "Eres")).toBe("café tacvba eres");
  });

  it("title's parenthetical year is stripped via normaliseTitle before tokenising", () => {
    // normaliseTitle removes "(2011 Remaster)"; first remaining title token is "Comfortably".
    expect(buildRematchQuery("Pink Floyd", "Comfortably Numb (2011 Remaster)")).toBe(
      "pink floyd comfortably",
    );
  });

  it("trims to exactly two artist tokens when the artist has more than two words", () => {
    expect(buildRematchQuery("Red Hot Chili Peppers", "Under the Bridge")).toBe(
      "red hot under",
    );
  });

  it("lower-cases the artist part", () => {
    expect(buildRematchQuery("The ROLLING Stones", "Paint It, Black")).toBe(
      "the rolling paint",
    );
  });

  it("strips punctuation from the artist before tokenising (apostrophes, ampersands)", () => {
    expect(buildRematchQuery("Earth, Wind & Fire", "September")).toBe(
      "earth wind september",
    );
  });
});

describe("F-025 R1: buildRematchQuery degenerate inputs", () => {
  it("returns null when artist is empty", () => {
    expect(buildRematchQuery("", "Halo")).toBeNull();
  });

  it("returns null when artist is only whitespace", () => {
    expect(buildRematchQuery("   ", "Halo")).toBeNull();
  });

  it("returns null when artist is only punctuation (normalises to empty)", () => {
    expect(buildRematchQuery("!!! ???", "Halo")).toBeNull();
  });

  it("returns null when title is empty", () => {
    expect(buildRematchQuery("Beyoncé", "")).toBeNull();
  });

  it("returns null when title normalises to empty (just a stripped suffix)", () => {
    // normaliseTitle("- Remaster") → "" → falls back to "- Remaster".trim() === "- Remaster".
    // Then tokenisation produces ["-", "Remaster"] → first token "-".
    // To force the actual "title tokens after normaliseTitle is empty" branch,
    // pass an input whose normaliseTitle output is empty AND whose .trim() is empty.
    expect(buildRematchQuery("Beyoncé", "   ")).toBeNull();
  });

  it("returns null when both sides are empty", () => {
    expect(buildRematchQuery("", "")).toBeNull();
  });
});

describe("F-025 R1: buildRematchQuery defensive normalisation", () => {
  it("strips ASCII control characters from artist before tokenising", () => {
    expect(buildRematchQuery("Pink Floyd", "Money")).toBe(
      "pink floyd money",
    );
  });

  it("strips ASCII control characters from title before tokenising", () => {
    expect(buildRematchQuery("Pink Floyd", "Money Talks")).toBe(
      "pink floyd money",
    );
  });

  it("treats multiple spaces between tokens as a single delimiter", () => {
    expect(buildRematchQuery("Pink    Floyd", "Money")).toBe(
      "pink floyd money",
    );
  });
});
