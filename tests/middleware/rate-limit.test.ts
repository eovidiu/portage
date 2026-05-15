// F-024 R4: token-bucket rate limit, 10 req / 60 s per principal.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { takeToken, _resetBuckets } from "../../src/middleware/rate-limit";

beforeEach(() => {
  _resetBuckets();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("takeToken — bucket capacity", () => {
  it("allows 10 takes in a row for the same principal", () => {
    for (let i = 0; i < 10; i++) {
      const result = takeToken("alice@example.com");
      expect(result.allowed).toBe(true);
    }
  });

  it("rejects the 11th take with retryAfterSec between 1 and 60", () => {
    for (let i = 0; i < 10; i++) takeToken("alice@example.com");
    const result = takeToken("alice@example.com");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
      expect(result.retryAfterSec).toBeLessThanOrEqual(60);
    }
  });
});

describe("takeToken — independence between principals", () => {
  it("alice exhausting her bucket does not affect bob", () => {
    for (let i = 0; i < 10; i++) takeToken("alice@example.com");
    expect(takeToken("alice@example.com").allowed).toBe(false);
    expect(takeToken("bob@example.com").allowed).toBe(true);
  });
});

describe("takeToken — refill over time", () => {
  it("refills proportionally to elapsed time", () => {
    for (let i = 0; i < 10; i++) takeToken("alice@example.com");
    expect(takeToken("alice@example.com").allowed).toBe(false);

    // 30 seconds later — 5 tokens worth of refill (10 tokens / 60s = 1/6 per second).
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 5; i++) {
      expect(takeToken("alice@example.com").allowed).toBe(true);
    }
    expect(takeToken("alice@example.com").allowed).toBe(false);
  });

  it("fully refills after 60 seconds", () => {
    for (let i = 0; i < 10; i++) takeToken("alice@example.com");
    expect(takeToken("alice@example.com").allowed).toBe(false);

    vi.advanceTimersByTime(60_000);
    for (let i = 0; i < 10; i++) {
      expect(takeToken("alice@example.com").allowed).toBe(true);
    }
  });

  it("does not refill beyond capacity", () => {
    takeToken("alice@example.com"); // 9 remaining
    vi.advanceTimersByTime(600_000); // 10 minutes — would over-refill if uncapped
    for (let i = 0; i < 10; i++) {
      expect(takeToken("alice@example.com").allowed).toBe(true);
    }
    expect(takeToken("alice@example.com").allowed).toBe(false);
  });
});

describe("takeToken — retryAfterSec semantics", () => {
  it("returns a small positive integer right after exhaustion", () => {
    for (let i = 0; i < 10; i++) takeToken("alice@example.com");
    const result = takeToken("alice@example.com");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(Number.isInteger(result.retryAfterSec)).toBe(true);
      expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
    }
  });
});
