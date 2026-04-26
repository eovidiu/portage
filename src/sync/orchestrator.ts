import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";
import {
  insertRun,
  updateRun,
  markAbandonedRuns,
} from "../db/sync_runs";
import { fetchLikedSongs } from "../providers/spotify/liked";
import { matchByIsrc, type TrackCandidate } from "../match/isrc";
import { matchByFuzzy } from "../match/fuzzy";
import { writePlaylist } from "./playlist-writer";

export type OrchestratorOutcome =
  | "succeeded"
  | "partial"
  | "failed"
  | "skipped_locked";

export interface OrchestratorResult {
  outcome: OrchestratorOutcome;
  run_id?: string;
  error_code?: string;
  tracks_seen?: number;
  matched_isrc?: number;
  matched_fuzzy?: number;
  unmatched?: number;
  errors?: number;
}

// Deterministic 64-bit-safe integer key from 'sync_run_lock' via djb2 hash.
// djb2 stays within JS safe integer range (31-bit result).
function lockKey(): number {
  const s = "sync_run_lock";
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
  }
  return h;
}

const LOCK_KEY = lockKey();
const WALL_TIME_MS = 300_000;

async function tryAcquireLock(env: Env): Promise<boolean> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(`SELECT pg_try_advisory_lock($1) AS acquired`, [LOCK_KEY]);
  return (rows[0] as { acquired: boolean }).acquired;
}

async function releaseLock(env: Env): Promise<void> {
  const sql = neon(env.DATABASE_URL);
  await sql(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
}

async function fetchNewTracks(
  env: Env,
  startedAt: string,
): Promise<TrackCandidate[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT spotify_id, isrc, artist, duration_ms
     FROM tracks
     WHERE first_seen_at >= $1`,
    [startedAt],
  );
  return rows as TrackCandidate[];
}

async function runSyncBody(
  env: Env,
  runId: string,
  startedAt: string,
): Promise<OrchestratorResult> {
  let fetchResult: Awaited<ReturnType<typeof fetchLikedSongs>>;
  try {
    fetchResult = await fetchLikedSongs(env);
  } catch (err) {
    const errorCode = "spotify_reauth_required";
    await updateRun(env, runId, {
      status: "failed",
      error_code: errorCode,
      finished_at: new Date().toISOString(),
    });
    console.log(
      JSON.stringify({
        event: "sync_run_completed",
        run_id: runId,
        outcome: "failed",
        error_code: errorCode,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return { outcome: "failed", run_id: runId, error_code: errorCode };
  }

  const newTracks = await fetchNewTracks(env, startedAt);

  let isrcResult = { matched: 0, skipped: 0, errors: [] as Array<{ spotify_id: string; error_code: string; message: string }> };
  let fuzzyResult = { matched: 0, unmatched: 0, errors: [] as Array<{ spotify_id: string; error_code: string; message: string }> };

  try {
    isrcResult = await matchByIsrc(env, newTracks, runId);
  } catch (err) {
    isrcResult.errors.push({
      spotify_id: "unknown",
      error_code: "isrc_fatal",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    fuzzyResult = await matchByFuzzy(env, runId);
  } catch (err) {
    fuzzyResult.errors.push({
      spotify_id: "unknown",
      error_code: "fuzzy_fatal",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const totalErrors = isrcResult.errors.length + fuzzyResult.errors.length;
  const tracksUnmatched = fuzzyResult.unmatched;

  try {
    await writePlaylist(env);
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "playlist_write_failed",
        run_id: runId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const status = totalErrors > 0 ? "partial" : "succeeded";
  const finishedAt = new Date().toISOString();

  await updateRun(env, runId, {
    status,
    finished_at: finishedAt,
    tracks_seen: fetchResult.tracksInserted,
    matched_isrc: isrcResult.matched,
    matched_fuzzy: fuzzyResult.matched,
    unmatched: tracksUnmatched,
    errors: totalErrors,
  });

  const result: OrchestratorResult = {
    outcome: status,
    run_id: runId,
    tracks_seen: fetchResult.tracksInserted,
    matched_isrc: isrcResult.matched,
    matched_fuzzy: fuzzyResult.matched,
    unmatched: tracksUnmatched,
    errors: totalErrors,
  };

  console.log(
    JSON.stringify({
      event: "sync_run_completed",
      run_id: runId,
      outcome: status,
      tracks_seen: result.tracks_seen,
      matched_isrc: result.matched_isrc,
      matched_fuzzy: result.matched_fuzzy,
      unmatched: result.unmatched,
      errors: result.errors,
    }),
  );

  return result;
}

export async function runSync(env: Env): Promise<OrchestratorResult> {
  await markAbandonedRuns(env);

  const acquired = await tryAcquireLock(env);
  if (!acquired) {
    console.log(
      JSON.stringify({ event: "sync_skipped_locked", lock_key: LOCK_KEY }),
    );
    return { outcome: "skipped_locked" };
  }

  const startedAt = new Date().toISOString();
  let runId: string | undefined;

  try {
    const { run_id } = await insertRun(env);
    runId = run_id;

    let timedOut = false;
    const bodyPromise = runSyncBody(env, runId, startedAt);
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), WALL_TIME_MS),
    );

    const raceResult = await Promise.race([bodyPromise, timeoutPromise]);

    if (raceResult === "timeout") {
      timedOut = true;
    }

    if (timedOut) {
      const errorCode = "wall_time_exceeded";
      await updateRun(env, runId, {
        status: "partial",
        error_code: errorCode,
        finished_at: new Date().toISOString(),
      });
      console.log(
        JSON.stringify({
          event: "sync_run_completed",
          run_id: runId,
          outcome: "partial",
          error_code: errorCode,
        }),
      );
      return { outcome: "partial", run_id: runId, error_code: errorCode };
    }

    return raceResult as OrchestratorResult;
  } finally {
    await releaseLock(env);
  }
}
