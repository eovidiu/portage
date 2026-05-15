// F-024 R2: query and limit validation
import { describe, it, expect } from "vitest";
import {
  validateSearchQuery,
  validateSearchLimit,
} from "../../src/routes/search-validation";

describe("validateSearchQuery", () => {
  it("accepts a normal query", () => {
    const result = validateSearchQuery("Metallica One");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.q).toBe("Metallica One");
  });

  it("trims surrounding whitespace before length check", () => {
    const result = validateSearchQuery("   Metallica   ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.q).toBe("Metallica");
  });

  it("rejects missing q (undefined)", () => {
    const result = validateSearchQuery(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_query");
  });

  it("rejects empty string", () => {
    const result = validateSearchQuery("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_query");
  });

  it("rejects whitespace-only string", () => {
    const result = validateSearchQuery("   \t   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_query");
  });

  it("rejects non-string input (number)", () => {
    const result = validateSearchQuery(42);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_query");
  });

  it("rejects non-string input (array)", () => {
    const result = validateSearchQuery(["Metallica"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_query");
  });

  it("accepts exactly 200 characters", () => {
    const result = validateSearchQuery("x".repeat(200));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.q.length).toBe(200);
  });

  it("rejects 201 characters", () => {
    const result = validateSearchQuery("x".repeat(201));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_query");
  });

  it("rejects q containing a BEL (0x07) control char", () => {
    const result = validateSearchQuery("Metallica\x07One");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_query");
  });

  it("rejects q containing a null byte", () => {
    const result = validateSearchQuery("Metallica\x00One");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_query");
  });

  it("rejects q containing a newline", () => {
    const result = validateSearchQuery("Metallica\nOne");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_query");
  });
});

describe("validateSearchLimit", () => {
  it("defaults to 10 when absent (undefined)", () => {
    const result = validateSearchLimit(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.limit).toBe(10);
  });

  it("defaults to 10 when empty string", () => {
    const result = validateSearchLimit("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.limit).toBe(10);
  });

  it("accepts integer string '5'", () => {
    const result = validateSearchLimit("5");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.limit).toBe(5);
  });

  it("accepts the boundary value 1", () => {
    const result = validateSearchLimit("1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.limit).toBe(1);
  });

  it("accepts the boundary value 25", () => {
    const result = validateSearchLimit("25");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.limit).toBe(25);
  });

  it("rejects 0", () => {
    const result = validateSearchLimit("0");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_limit");
  });

  it("rejects 26", () => {
    const result = validateSearchLimit("26");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_limit");
  });

  it("rejects negative numbers", () => {
    const result = validateSearchLimit("-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_limit");
  });

  it("rejects non-integer numeric string '5.5'", () => {
    const result = validateSearchLimit("5.5");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_limit");
  });

  it("rejects non-numeric string 'abc'", () => {
    const result = validateSearchLimit("abc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_limit");
  });

  it("rejects integer with trailing garbage '5xyz'", () => {
    const result = validateSearchLimit("5xyz");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_limit");
  });
});
