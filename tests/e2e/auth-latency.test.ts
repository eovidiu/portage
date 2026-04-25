/**
 * T-001-10: JWT verification middleware p95 latency < 5 ms across 1000 sequential requests.
 *
 * Endpoint: GET /sync/status — returns 404 (F-009 not implemented) but the JWT middleware
 * runs and completes before the 404 handler fires. We measure wall-clock per-request time,
 * which is an upper bound on middleware time; network loopback on localhost adds negligible
 * overhead on M-series Mac (< 0.5 ms per hop).
 *
 * Hardware baseline: M-series Mac. On a slow machine this threshold may legitimately fail.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startWrangler, stopWrangler, timedFetch, percentile, mintToken } from "./harness.js";

const SAMPLE_COUNT = 1000;

beforeAll(async () => {
  await startWrangler();
});

afterAll(async () => {
  await stopWrangler();
});

// ---- T-001-10: JWT verification p95 < 5 ms ----
describe("T-001-10: JWT verification middleware p95 latency", () => {
  it(`p95 across ${SAMPLE_COUNT} sequential requests with unique tokens is < 5 ms`, async () => {
    // Pre-mint all tokens (offline, doesn't count toward latency measurement).
    const tokens: string[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      tokens.push(await mintToken());
    }

    const durations: number[] = [];

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const { durationMs } = await timedFetch("/sync/status", {
        Authorization: `Bearer ${tokens[i]}`,
      });
      durations.push(durationMs);
    }

    durations.sort((a, b) => a - b);
    const p95 = percentile(durations, 95);
    const p50 = percentile(durations, 50);

    console.info(
      `T-001-10 n=${SAMPLE_COUNT} p50=${p50.toFixed(2)} ms  p95=${p95.toFixed(2)} ms  (threshold: 5 ms)`
    );

    expect(p95).toBeLessThan(5);
  });
});
