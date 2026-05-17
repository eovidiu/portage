import { neon, Pool, type PoolClient } from "@neondatabase/serverless";
import type { Env } from "../env";
import {
  insertRun,
  updateRun,
  markAbandonedRuns,
} from "../db/sync_runs";
import { fetchPendingMatchQueue } from "../db/tracks";
import { fetchLikedSongs } from "../providers/spotify/liked";
import { SpotifyAuthError } from "../providers/spotify/oauth";
import { IntegrityError } from "../crypto";
import { matchByIsrc } from "../match/isrc";
import { matchByFuzzy } from "../match/fuzzy";
import { writePlaylist } from "./playlist-writer";
import { seedPlaylistConfigs } from "./playlist-config-seeder";
import { listEnabledPlaylistConfigs, markSynced } from "../db/playlist_configs";
import { fetchPlaylistTracks } from "../providers/spotify/playlists";

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
const DEFAULT_WALL_TIME_MS = 300_000;

// F-015: per-invocation budget defaults — keep small to fit Workers Free
// 50-subrequest cap. Operator can tune via env: MATCH_BATCH_ISRC,
// MATCH_BATCH_FUZZY, LIKED_PAGES_PER_RUN.
const DEFAULT_MATCH_BATCH_ISRC = 5;
const DEFAULT_MATCH_BATCH_FUZZY = 5;
const DEFAULT_LIKED_PAGES_PER_RUN = 1;
// F-016b/F-009-R20: max extra playlists per invocation (not counting __liked__).
const DEFAULT_MAX_PLAYLISTS_PER_RUN = 3;

function readBudget(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// F-009-R15: outer-error classifier for the F-005 fetch stage.
// Maps the thrown value to one of the discriminated codes from the
// failure-modes table.
type FetchErrorCode =
  | "spotify_reauth_required"
  | "spotify_transient"
  | "decrypt_failed"
  | "fetch_failed";

const TRANSIENT_MESSAGE_PATTERN = /rate limit|Spotify API error.*: 5\d\d/;

function classifyFetchError(err: unknown): FetchErrorCode {
  if (err instanceof SpotifyAuthError) {
    return err.code === "reauth_required"
      ? "spotify_reauth_required"
      : "spotify_transient";
  }
  if (err instanceof IntegrityError) return "decrypt_failed";
  if (err instanceof Error && TRANSIENT_MESSAGE_PATTERN.test(err.message)) {
    return "spotify_transient";
  }
  return "fetch_failed";
}

// Postgres advisory locks are session-scoped. The Neon HTTP driver opens a
// fresh session per query, so a lock acquired via `neon()` would auto-release
// the moment the query returns — providing zero protection. The acquire and
// release queries must share a single session, so we use Pool/WebSocket for
// the lock pair only. Everything else in the orchestrator (insertRun, updateRun,
// markAbandonedRuns, fetchNewTracks) stays on plain `neon()` since those
// queries don't need session affinity.
interface LockSession {
  pool: Pool;
  client: PoolClient;
}

async function acquireLock(env: Env): Promise<LockSession | null> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [LOCK_KEY],
    );
    const acquired = (rows[0] as { acquired: boolean }).acquired;
    if (!acquired) {
      client.release();
      await pool.end();
      return null;
    }
    return { pool, client };
  } catch (err) {
    client.release();
    await pool.end();
    throw err;
  }
}

async function releaseLock(session: LockSession): Promise<void> {
  try {
    await session.client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
  } finally {
    session.client.release();
    await session.pool.end();
  }
}

async function runSyncBody(
  env: Env,
  runId: string,
  _startedAt: string,
): Promise<OrchestratorResult> {
  const isrcBatch = readBudget(env.MATCH_BATCH_ISRC, DEFAULT_MATCH_BATCH_ISRC);
  const fuzzyBatch = readBudget(env.MATCH_BATCH_FUZZY, DEFAULT_MATCH_BATCH_FUZZY);
  const likedPages = readBudget(env.LIKED_PAGES_PER_RUN, DEFAULT_LIKED_PAGES_PER_RUN);
  // F-009-R20: cap of extras per invocation; __liked__ is always included on top.
  const maxPlaylists = readBudget(env.MAX_PLAYLISTS_PER_RUN, DEFAULT_MAX_PLAYLISTS_PER_RUN);

  // F-009-R16: seed playlist_configs before any fetch so __liked__ row exists
  // and any new SPOTIFY_EXTRA_PLAYLIST_IDS entries are upserted. Idempotent.
  await seedPlaylistConfigs(env);

  // F-009-R17 + F-026b: list ENABLED configs only and split into
  // __liked__ + extras (capped). Disabled rows are skipped at the SQL
  // level so they never consume subrequest budget. The SPA's GET
  // /api/playlists still returns all rows (including disabled) — only
  // the orchestrator filters.
  const sql = neon(env.DATABASE_URL);
  const configs = await listEnabledPlaylistConfigs(sql);
  const liked = configs.find((c) => c.spotify_playlist_id === "__liked__");
  const extras = configs
    .filter((c) => c.spotify_playlist_id !== "__liked__")
    .slice(0, maxPlaylists - 1);

  // Fetch __liked__ first; a failure here aborts the whole run (R15 path).
  let likedTracksSeen = 0;
  let fetchResult: Awaited<ReturnType<typeof fetchLikedSongs>>;
  try {
    fetchResult = await fetchLikedSongs(env, likedPages);
    likedTracksSeen = fetchResult.tracksInserted;
  } catch (err) {
    const errorCode = classifyFetchError(err);
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

  // F-009-R18: post-fetch __liked__ membership upsert. After fetchLikedSongs
  // returns, backfill playlist_membership for any tracks not already present.
  // One DB round-trip per run; idempotent via LEFT JOIN + ON CONFLICT DO NOTHING.
  await sql(
    `INSERT INTO playlist_membership (spotify_playlist_id, spotify_track_id, added_at, synced_at)
     SELECT '__liked__', t.spotify_id, t.spotify_added_at, NULL
     FROM tracks t
     LEFT JOIN playlist_membership pm
       ON pm.spotify_playlist_id = '__liked__' AND pm.spotify_track_id = t.spotify_id
     WHERE pm.spotify_track_id IS NULL
     ON CONFLICT DO NOTHING`,
    [],
  );

  // F-009-R17 extras: fetch each extra playlist, logging errors without aborting.
  let extrasTracksSeen = 0;
  for (const config of extras) {
    try {
      const extraResult = await fetchPlaylistTracks(
        env,
        config.spotify_playlist_id,
        likedPages,
      );
      extrasTracksSeen += extraResult.tracksInserted;
    } catch (err) {
      const errorCode = classifyFetchError(err);
      console.log(
        JSON.stringify({
          event: "playlist_fetch_failed",
          run_id: runId,
          spotify_playlist_id: config.spotify_playlist_id,
          error_code: errorCode,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // F-009-R19: global ISRC + fuzzy match queue runs once, shared across all
  // playlists. Matching is not per-playlist.
  const isrcQueue = await fetchPendingMatchQueue(env, isrcBatch);

  let isrcResult = {
    matched: 0,
    skipped: 0,
    errors: [] as Array<{ spotify_id: string; error_code: string; message: string }>,
  };
  let fuzzyResult = {
    matched: 0,
    unmatched: 0,
    errors: [] as Array<{ spotify_id: string; error_code: string; message: string }>,
  };

  try {
    isrcResult = await matchByIsrc(env, isrcQueue, runId);
  } catch (err) {
    isrcResult.errors.push({
      spotify_id: "unknown",
      error_code: "isrc_fatal",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    fuzzyResult = await matchByFuzzy(env, { limit: fuzzyBatch, syncRunId: runId });
  } catch (err) {
    fuzzyResult.errors.push({
      spotify_id: "unknown",
      error_code: "fuzzy_fatal",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const allErrors = [...isrcResult.errors, ...fuzzyResult.errors];
  const totalErrors = allErrors.length;
  const tracksUnmatched = fuzzyResult.unmatched;

  // F-009-R19 write loop: iterate the same playlist set processed in the fetch
  // loop. Per-playlist write failures are logged but do not abort the run.
  const playlistsToWrite = liked
    ? [liked, ...extras]
    : extras;

  for (const config of playlistsToWrite) {
    try {
      const playlistResult = await writePlaylist(
        env,
        config.spotify_playlist_id,
        config.tidal_playlist_id,
      );
      // F-026b: record last_synced_at on each per-row success. Per-row
      // errors (caught below) leave the prior timestamp untouched.
      await markSynced(sql, config.spotify_playlist_id, new Date().toISOString());
      console.log(
        JSON.stringify({
          event: "playlist_write_completed",
          run_id: runId,
          spotify_playlist_id: config.spotify_playlist_id,
          playlist_id: playlistResult.playlistId,
          added: playlistResult.added,
          skipped_duplicates: playlistResult.skippedDuplicates,
          invalid_ids: playlistResult.invalidIds.length,
          errors: playlistResult.errors,
        }),
      );
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "playlist_write_failed",
          run_id: runId,
          spotify_playlist_id: config.spotify_playlist_id,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // F-009-R22: aggregate counts across all playlists into a single sync_runs row.
  const totalTracksSeen = likedTracksSeen + extrasTracksSeen;

  // F-009 spec: status='partial' requires (errors > 0 AND progress > 0); with
  // errors but zero progress the run is 'failed' per the state-machine
  // diagram in architecture.md §8.1.
  const progress =
    isrcResult.matched +
    fuzzyResult.matched +
    tracksUnmatched +
    isrcResult.skipped;
  const status =
    totalErrors > 0 ? (progress > 0 ? "partial" : "failed") : "succeeded";
  const finishedAt = new Date().toISOString();

  await updateRun(env, runId, {
    status,
    finished_at: finishedAt,
    tracks_seen: totalTracksSeen,
    matched_isrc: isrcResult.matched,
    matched_fuzzy: fuzzyResult.matched,
    unmatched: tracksUnmatched,
    errors: totalErrors,
    error_details: totalErrors > 0 ? allErrors : null,
  });

  const result: OrchestratorResult = {
    outcome: status,
    run_id: runId,
    tracks_seen: totalTracksSeen,
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
  const wallTimeMs =
    env.WALL_TIME_OVERRIDE_MS !== undefined
      ? Number(env.WALL_TIME_OVERRIDE_MS)
      : DEFAULT_WALL_TIME_MS;

  await markAbandonedRuns(env);

  const session = await acquireLock(env);
  if (!session) {
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
      setTimeout(() => resolve("timeout"), wallTimeMs),
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
  } catch (err) {
    // F-023: catch the silent-abandon class. Without this, errors from the
    // un-wrapped outer code in runSyncBody (seedPlaylistConfigs,
    // listPlaylistConfigs, the post-fetch membership INSERT, the final
    // updateRun) escape runSync entirely and leave the sync_runs row at
    // status='running' until the next cron's markAbandonedRuns sweeps it
    // ~12h later. Production query 2026-05-13: 7 of 8 failed runs in 14d
    // were silent-abandons. Now they get classified as orchestrator_fatal
    // with the message preserved in error_details.
    const errorCode = "orchestrator_fatal";
    const message = err instanceof Error ? err.message : String(err);
    if (runId !== undefined) {
      try {
        await updateRun(env, runId, {
          status: "failed",
          error_code: errorCode,
          errors: 1,
          error_details: [
            { spotify_id: "unknown", error_code: "orchestrator_fatal", message },
          ],
          finished_at: new Date().toISOString(),
        });
      } catch (updateErr) {
        // Defensive: updateRun itself may have been what threw originally,
        // or Neon may still be unreachable. Log the second failure and
        // continue — the next cron's markAbandonedRuns is the safety net.
        console.log(
          JSON.stringify({
            event: "sync_run_update_failed_in_catch",
            run_id: runId,
            primary_error: message,
            secondary_error:
              updateErr instanceof Error ? updateErr.message : String(updateErr),
          }),
        );
      }
    }
    console.log(
      JSON.stringify({
        event: "sync_run_completed",
        run_id: runId,
        outcome: "failed",
        error_code: errorCode,
        message,
      }),
    );
    return { outcome: "failed", run_id: runId, error_code: errorCode };
  } finally {
    await releaseLock(session);
  }
}
