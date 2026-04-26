import { describe, it, expect } from "vitest";
import { normaliseTitle, normaliseAlbum } from "../../src/match/title";

describe("normaliseTitle — remaster patterns", () => {
  it('strips "(2011 Remaster)"', () => {
    expect(normaliseTitle("Bohemian Rhapsody (2011 Remaster)")).toBe("Bohemian Rhapsody");
  });

  it('strips "(Remastered)"', () => {
    expect(normaliseTitle("Something (Remastered)")).toBe("Something");
  });

  it('strips "(Remaster)"', () => {
    expect(normaliseTitle("Song (Remaster)")).toBe("Song");
  });

  it("case-insensitive remaster stripping", () => {
    expect(normaliseTitle("Song (REMASTERED 2019)")).toBe("Song");
  });
});

describe("normaliseTitle — feat patterns", () => {
  it('strips "(feat. Pharrell Williams and Nile Rodgers)"', () => {
    expect(normaliseTitle("Get Lucky (feat. Pharrell Williams and Nile Rodgers)")).toBe("Get Lucky");
  });

  it('strips "(featuring ...)"', () => {
    expect(normaliseTitle("Track (featuring Someone)")).toBe("Track");
  });

  it('strips "(ft. ...)"', () => {
    expect(normaliseTitle("Track (ft. Someone)")).toBe("Track");
  });
});

describe("normaliseTitle — dash suffix patterns", () => {
  it('strips " - Single Version"', () => {
    expect(normaliseTitle("Song - Single Version")).toBe("Song");
  });

  it('strips " - Radio Edit"', () => {
    expect(normaliseTitle("Song - Radio Edit")).toBe("Song");
  });

  it('strips " - Remastered"', () => {
    expect(normaliseTitle("Song - Remastered")).toBe("Song");
  });

  it('strips " - Mono"', () => {
    expect(normaliseTitle("Song - Mono")).toBe("Song");
  });

  it('strips " - Stereo"', () => {
    expect(normaliseTitle("Song - Stereo")).toBe("Song");
  });
});

describe("normaliseTitle — year in parens", () => {
  it("strips trailing year in parens", () => {
    expect(normaliseTitle("Yesterday (1965)")).toBe("Yesterday");
  });
});

describe("normaliseTitle — edge cases", () => {
  it("returns original title when stripping produces empty string", () => {
    expect(normaliseTitle("(Remastered)")).toBe("(Remastered)");
  });

  it("leaves unaffected titles unchanged", () => {
    expect(normaliseTitle("Yesterday")).toBe("Yesterday");
  });

  it("trims whitespace after stripping", () => {
    expect(normaliseTitle("Song (Remaster)  ")).toBe("Song");
  });
});

describe("normaliseAlbum", () => {
  it("strips (Remastered) from album name", () => {
    expect(normaliseAlbum("Help! (Remastered)")).toBe("Help!");
  });

  it("leaves unrecognised parenthetical content unchanged", () => {
    expect(normaliseAlbum("A Night at the Opera (Deluxe Edition)")).toBe(
      "A Night at the Opera (Deluxe Edition)",
    );
  });
});
