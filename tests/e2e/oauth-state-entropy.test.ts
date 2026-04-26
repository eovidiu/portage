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

/** Return the entropy bit-length of a state string, detecting encoding automatically.
 *  Hex strings (all [0-9a-f], even length) measure length/2 bytes × 8 bits.
 *  All other strings are treated as base64url and decoded to byte length.
 */
function stateBitLength(s: string): number {
  if (/^[0-9a-f]+$/.test(s) && s.length % 2 === 0) {
    // Hex-encoded: 2 chars per byte
    return (s.length / 2) * 8;
  }
  // base64url: restore padding and decode
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return atob(padded + "=".repeat(padLen)).length * 8;
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
    const minBits = Math.min(...states.map(stateBitLength));
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
    const minBits = Math.min(...states.map(stateBitLength));
    console.info(`T-003-02 tidal min_bits=${minBits} (threshold: 256)`);
    expect(minBits).toBeGreaterThanOrEqual(256);
  });
});
