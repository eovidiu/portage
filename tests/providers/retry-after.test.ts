import { describe, it, expect } from "vitest";
import { retryAfterMs, MAX_RETRY_AFTER_S } from "../../src/providers/retry-after";

describe("retryAfterMs", () => {
  it("converts an in-cap Retry-After to milliseconds", () => {
    expect(retryAfterMs("5")).toBe(5000);
    expect(retryAfterMs("1")).toBe(1000);
  });

  it("allows exactly the cap", () => {
    expect(retryAfterMs(String(MAX_RETRY_AFTER_S))).toBe(MAX_RETRY_AFTER_S * 1000);
  });

  it("returns null when the penalty exceeds the cap", () => {
    expect(retryAfterMs(String(MAX_RETRY_AFTER_S + 1))).toBeNull();
    expect(retryAfterMs("3600")).toBeNull();
  });

  it("falls back to 1s for an absent header", () => {
    expect(retryAfterMs(null)).toBe(1000);
  });

  it("falls back to 1s for malformed or non-positive values", () => {
    expect(retryAfterMs("soon")).toBe(1000);
    expect(retryAfterMs("-5")).toBe(1000);
    expect(retryAfterMs("0")).toBe(1000);
  });

  it("parses integer prefixes the way the previous per-site parseInt did", () => {
    expect(retryAfterMs("5.9")).toBe(5000);
  });
});
