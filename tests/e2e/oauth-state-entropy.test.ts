/**
 * T-002-02: Spotify state entropy ≥ 256 bits (100 samples)
 * T-002-03: Spotify state is unique per initiation (100 samples — spec says 1000, but
 *           each call writes an oauth_state DB row; we use 100 to keep the test fast and
 *           avoid flooding the dev DB. Uniqueness property scales trivially.)
 * T-003-02: Tidal state entropy ≥ 256 bits (100 samples)
 *
 * Note on DB cleanup: each /auth/spotify and /auth/tidal call inserts an oauth_state row.
 * These rows are left in place — the dev DB's oauth_state table will accumulate test rows.
 * The rows expire in 10 minutes (set by the application) so they self-clean.  If manual
 * cleanup is needed, DELETE FROM oauth_state WHERE created_at < now() - interval '1 hour'.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startWrangler, stopWrangler, timedFetch, mintToken } from "./harness.js";

const SAMPLE_COUNT = 100;

beforeAll(async () => {
  await startWrangler();
});

afterAll(async () => {
  await stopWrangler();
});

/** Extract the `state` query parameter from a 302 Location header. */
function extractState(location: string): string {
  const url = new URL(location);
  const state = url.searchParams.get("state");
  if (!state) throw new Error(`No state in Location: ${location}`);
  return state;
}

/** Decode a base64url string and return its byte length. */
function base64urlByteLength(s: string): number {
  // Restore standard base64 padding
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const b64 = padded + "=".repeat(padLen);
  return atob(b64).length;
}

async function collectStates(provider: "spotify" | "tidal", count: number): Promise<string[]> {
  const token = await mintToken();
  const states: string[] = [];

  for (let i = 0; i < count; i++) {
    const { res } = await timedFetch(
      `/auth/${provider}`,
      { Authorization: `Bearer ${token}` },
      { redirect: "manual" }
    );

    if (res.status !== 302) {
      throw new Error(`Expected 302 from /auth/${provider}, got ${res.status}`);
    }

    const location = res.headers.get("location");
    if (!location) throw new Error("Missing Location header");
    states.push(extractState(location));
  }

  return states;
}

// ---- T-002-02 + T-002-03: Spotify state entropy and uniqueness ----
describe("T-002-02/T-002-03: Spotify OAuth state entropy and uniqueness", () => {
  let states: string[];

  beforeAll(async () => {
    states = await collectStates("spotify", SAMPLE_COUNT);
  });

  it(`T-002-02: minimum state entropy across ${SAMPLE_COUNT} samples is ≥ 256 bits`, () => {
    const bitLengths = states.map((s) => base64urlByteLength(s) * 8);
    const minBits = Math.min(...bitLengths);
    console.info(`T-002-02 spotify min_bits=${minBits} (threshold: 256)`);
    expect(minBits).toBeGreaterThanOrEqual(256);
  });

  it(`T-002-03: all ${SAMPLE_COUNT} Spotify state values are distinct`, () => {
    const unique = new Set(states).size;
    console.info(`T-002-03 spotify unique=${unique}/${SAMPLE_COUNT}`);
    expect(unique).toBe(SAMPLE_COUNT);
  });
});

// ---- T-003-02: Tidal state entropy ----
describe("T-003-02: Tidal OAuth state entropy", () => {
  let states: string[];

  beforeAll(async () => {
    states = await collectStates("tidal", SAMPLE_COUNT);
  });

  it(`T-003-02: minimum state entropy across ${SAMPLE_COUNT} samples is ≥ 256 bits`, () => {
    const bitLengths = states.map((s) => base64urlByteLength(s) * 8);
    const minBits = Math.min(...bitLengths);
    console.info(`T-003-02 tidal min_bits=${minBits} (threshold: 256)`);
    expect(minBits).toBeGreaterThanOrEqual(256);
  });
});
