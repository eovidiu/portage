/**
 * T-011-13: GET /sync/runs p95 < 200 ms with 1000 sync_runs rows (F-011-R8).
 *
 * Seeds the Neon test DB (via DATABASE_URL from .dev.vars) with 1000 sync_runs
 * rows if fewer than 1000 exist. Seeding is idempotent: skipped when count >= 1000.
 * A stable LCG RNG (seed=42) drives deterministic row data.
 *
 * Sends 50 GET /sync/runs requests (limit=100) through the live wrangler dev process,
 * captures wall-clock durations, and asserts p95 < 200 ms.
 *
 * Hardware note: 200 ms is generous for M-series Mac (~5-20 ms observed).
 * On slow CI hardware the threshold may need adjustment.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { startWrangler, stopWrangler, timedFetch, percentile, mintToken } from "./harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "../..");

const SAMPLE_COUNT = 50;
const SEED_TARGET = 1000;
const P95_THRESHOLD_MS = 200;

function readDatabaseUrl(): string {
  const devVarsPath = join(PROJECT_ROOT, ".dev.vars");
  const contents = readFileSync(devVarsPath, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("DATABASE_URL=")) {
      const raw = trimmed.slice("DATABASE_URL=".length).trim();
      return raw.replace(/^["'](.*)["']$/, "$1");
    }
  }
  throw new Error(".dev.vars missing DATABASE_URL — cannot seed e2e DB");
}

/** Minimal LCG RNG, seed-deterministic. */
function makeLcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

async function seedSyncRuns(): Promise<number> {
  const databaseUrl = readDatabaseUrl();
  const sql = neon(databaseUrl);

  const countRows = await sql("SELECT COUNT(*) AS cnt FROM sync_runs", []);
  const current = parseInt((countRows[0] as { cnt: string }).cnt, 10);

  if (current >= SEED_TARGET) {
    console.info(`T-011-13 seed: ${current} rows already present, skipping seed`);
    return current;
  }

  const needed = SEED_TARGET - current;
  console.info(`T-011-13 seed: inserting ${needed} rows (current=${current})`);

  const rng = makeLcg(42);
  const statuses = ["succeeded", "partial", "failed"] as const;

  // Insert in batches of 100 to avoid large single queries.
  const BATCH = 100;
  let inserted = 0;

  while (inserted < needed) {
    const batchSize = Math.min(BATCH, needed - inserted);
    const values: string[] = [];
    const params: unknown[] = [];
    let pIdx = 1;

    for (let i = 0; i < batchSize; i++) {
      const statusIdx = Math.floor(rng() * 3);
      const status = statuses[statusIdx];
      const daysAgo = rng() * 30;
      const startedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
      const durationMs = Math.floor(rng() * 30_000) + 1_000;
      const finishedAt = new Date(
        new Date(startedAt).getTime() + durationMs
      ).toISOString();
      const tracksSeen = Math.floor(rng() * 50);
      const matchedIsrc = Math.floor(rng() * tracksSeen);
      const matchedFuzzy = Math.floor(rng() * (tracksSeen - matchedIsrc));
      const unmatched = tracksSeen - matchedIsrc - matchedFuzzy;
      const errors = status === "partial" ? Math.floor(rng() * 5) + 1 : 0;
      const errorCode = status !== "succeeded" ? "wall_time_exceeded" : null;

      values.push(
        `($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}, $${pIdx + 8})`
      );
      params.push(
        status, startedAt, finishedAt, errorCode,
        tracksSeen, matchedIsrc, matchedFuzzy, unmatched, errors
      );
      pIdx += 9;
    }

    await sql(
      `INSERT INTO sync_runs (status, started_at, finished_at, error_code, tracks_seen, matched_isrc, matched_fuzzy, unmatched, errors)
       VALUES ${values.join(", ")}`,
      params
    );

    inserted += batchSize;
  }

  const finalRows = await sql("SELECT COUNT(*) AS cnt FROM sync_runs", []);
  const finalCount = parseInt((finalRows[0] as { cnt: string }).cnt, 10);
  console.info(`T-011-13 seed: done, total rows = ${finalCount}`);
  return finalCount;
}

let seededCount = 0;

beforeAll(async () => {
  seededCount = await seedSyncRuns();
  await startWrangler();
});

afterAll(async () => {
  await stopWrangler();
});

describe("T-011-13: GET /sync/runs p95 latency with 1000 rows", () => {
  it(
    `p95 across ${SAMPLE_COUNT} sequential requests is < ${P95_THRESHOLD_MS} ms (seeded rows: ${SEED_TARGET})`,
    async () => {
      expect(seededCount).toBeGreaterThanOrEqual(SEED_TARGET);

      const token = await mintToken();
      const durations: number[] = [];

      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const { durationMs } = await timedFetch("/sync/runs?limit=100", {
          Authorization: `Bearer ${token}`,
        });
        durations.push(durationMs);
      }

      durations.sort((a, b) => a - b);
      const p50 = percentile(durations, 50);
      const p95 = percentile(durations, 95);

      console.info(
        `T-011-13 n=${SAMPLE_COUNT} rows=${seededCount} p50=${p50.toFixed(2)} ms  p95=${p95.toFixed(2)} ms  (threshold: ${P95_THRESHOLD_MS} ms)`
      );

      expect(p95).toBeLessThan(P95_THRESHOLD_MS);
    },
    60_000
  );
});
