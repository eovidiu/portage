/**
 * T-014-03: GET /healthz p95 response time < 50 ms
 * T-014-11: Mixed 50 requests (healthz + readyz) max < 3 s
 *
 * Hardware baseline: M-series Mac. On slower machines these thresholds may fail.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startWrangler, stopWrangler, timedFetch, percentile, mintToken } from "./harness.js";

beforeAll(async () => {
  await startWrangler();
});

afterAll(async () => {
  await stopWrangler();
});

// ---- T-014-03: GET /healthz p95 < 50 ms ----
describe("T-014-03: GET /healthz response time p95", () => {
  it("p95 across 100 sequential requests is < 50 ms", async () => {
    const durations: number[] = [];

    for (let i = 0; i < 100; i++) {
      const { res, durationMs } = await timedFetch("/healthz");
      expect(res.status).toBe(200);
      durations.push(durationMs);
    }

    durations.sort((a, b) => a - b);
    const p95 = percentile(durations, 95);

    // Log so CI can observe on pass/fail.
    console.info(`T-014-03 p95=${p95.toFixed(2)} ms (threshold: 50 ms)`);

    expect(p95).toBeLessThan(50);
  });
});

// ---- T-014-11: Mixed 50 requests max < 3 s ----
describe("T-014-11: Mixed healthz + readyz max response time", () => {
  it("max response time across 50 alternating requests is < 3000 ms", async () => {
    const token = await mintToken();
    const authHeader = { Authorization: `Bearer ${token}` };
    const durations: number[] = [];

    for (let i = 0; i < 50; i++) {
      const path = i % 2 === 0 ? "/healthz" : "/readyz";
      const headers = path === "/healthz" ? {} : authHeader;
      const { durationMs } = await timedFetch(path, headers);
      durations.push(durationMs);
    }

    const maxMs = Math.max(...durations);
    console.info(`T-014-11 max=${maxMs.toFixed(2)} ms (threshold: 3000 ms)`);

    expect(maxMs).toBeLessThan(3_000);
  });
});
