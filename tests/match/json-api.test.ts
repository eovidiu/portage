import { describe, it, expect } from "vitest";
import {
  parseIsoDurationMs,
  buildIncludedIndex,
  lookupIncluded,
  type IncludedIndex,
} from "../../src/match/json-api";

describe("parseIsoDurationMs", () => {
  it("parses PT3M40S as 220000ms", () => {
    expect(parseIsoDurationMs("PT3M40S")).toBe(220000);
  });

  it("parses PT2M58S (canonical Tidal example) as 178000ms", () => {
    expect(parseIsoDurationMs("PT2M58S")).toBe(178000);
  });

  it("parses fractional seconds PT3M40.5S as 220500ms", () => {
    expect(parseIsoDurationMs("PT3M40.5S")).toBe(220500);
  });

  it("parses hours form PT1H1M1S as 3661000ms", () => {
    expect(parseIsoDurationMs("PT1H1M1S")).toBe(3661000);
  });

  it("parses hours-only PT1H as 3600000ms", () => {
    expect(parseIsoDurationMs("PT1H")).toBe(3600000);
  });

  it("parses seconds-only PT45S as 45000ms", () => {
    expect(parseIsoDurationMs("PT45S")).toBe(45000);
  });

  it("returns null for empty PT (no components)", () => {
    expect(parseIsoDurationMs("PT")).toBeNull();
  });

  it("returns null for malformed string", () => {
    expect(parseIsoDurationMs("garbage")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseIsoDurationMs("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parseIsoDurationMs(undefined)).toBeNull();
    expect(parseIsoDurationMs(null)).toBeNull();
    expect(parseIsoDurationMs(220)).toBeNull();
    expect(parseIsoDurationMs({})).toBeNull();
  });
});

describe("buildIncludedIndex", () => {
  it("indexes resources by type+id", () => {
    const idx = buildIncludedIndex([
      { id: "a1", type: "artists", attributes: { name: "Adele" } },
      { id: "t1", type: "tracks", attributes: { title: "Hello" } },
    ]);
    expect(lookupIncluded(idx, "artists", "a1")?.attributes?.name).toBe("Adele");
    expect(lookupIncluded(idx, "tracks", "t1")?.attributes?.title).toBe("Hello");
  });

  it("returns an empty index when included is undefined", () => {
    const idx = buildIncludedIndex(undefined);
    expect(lookupIncluded(idx, "artists", "anything")).toBeUndefined();
  });

  it("returns an empty index when included is empty", () => {
    const idx = buildIncludedIndex([]);
    expect(lookupIncluded(idx, "artists", "anything")).toBeUndefined();
  });

  it("ignores entries missing id or type", () => {
    const idx = buildIncludedIndex([
      // @ts-expect-error - testing defensive parsing
      { type: "artists" },
      // @ts-expect-error - testing defensive parsing
      { id: "x" },
      { id: "good", type: "artists", attributes: { name: "OK" } },
    ]);
    expect(lookupIncluded(idx, "artists", "good")?.attributes?.name).toBe("OK");
  });

  it("namespaces by type so same id under different types do not collide", () => {
    const idx = buildIncludedIndex([
      { id: "1", type: "tracks", attributes: { title: "Track One" } },
      { id: "1", type: "artists", attributes: { name: "Artist One" } },
    ]);
    expect(lookupIncluded(idx, "tracks", "1")?.attributes?.title).toBe("Track One");
    expect(lookupIncluded(idx, "artists", "1")?.attributes?.name).toBe("Artist One");
  });
});

describe("lookupIncluded", () => {
  const empty: IncludedIndex = new Map();

  it("returns undefined when type+id is not present", () => {
    expect(lookupIncluded(empty, "artists", "missing")).toBeUndefined();
  });
});
