import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Env } from "../env";

export interface UnmatchedRow {
  spotify_id: string;
  reason: string;
}

/**
 * Upsert an unmatched row. On conflict, increments attempts and updates
 * last_attempt_at and reason — but only when status is still 'pending'.
 * A previously matched/skipped row stays untouched.
 */
export async function upsertUnmatched(
  sql: NeonQueryFunction<false, false>,
  row: UnmatchedRow,
): Promise<void> {
  await sql(
    `INSERT INTO unmatched (spotify_id, reason, attempts, last_attempt_at, status)
     VALUES ($1, $2, 1, now(), 'pending')
     ON CONFLICT (spotify_id) DO UPDATE
       SET attempts        = unmatched.attempts + 1,
           last_attempt_at = now(),
           reason          = EXCLUDED.reason
     WHERE unmatched.status = 'pending'`,
    [row.spotify_id, row.reason],
  );
}

export async function getUnmatchedCount(
  sql: NeonQueryFunction<false, false>,
): Promise<number> {
  const rows = await sql(
    `SELECT COUNT(*)::integer AS n FROM unmatched WHERE status = 'pending'`,
    [],
  );
  return (rows as { n: number }[])[0]?.n ?? 0;
}

/**
 * Env-bound wrapper around getUnmatchedCount. Lives in the db layer so that
 * route-level vi.mock(db/unmatched) covers it cleanly — the neon() call
 * resolves to the real connection only when this module is unmocked.
 */
export async function getUnmatchedCountByEnv(env: Env): Promise<number> {
  const sql = neon(env.DATABASE_URL);
  return getUnmatchedCount(sql);
}

/**
 * Re-queue a spotify_id as unmatched because its Tidal match is no longer valid.
 * Unlike upsertUnmatched, this bypasses the status='pending' guard so that
 * previously matched/skipped rows can be re-queued.
 */
export interface PendingUnmatchedRow {
  spotify_id: string;
  spotify_artist: string;
  spotify_title: string;
  spotify_album: string | null;
  isrc: string | null;
  reason: string;
  attempts: number;
  last_attempt_at: string | null;
  candidates?: Array<{
    tidal_id: string;
    title: string;
    artist: string;
    album: string | null;
    duration_ms: number | null;
    score: number;
  }>;
}

export interface ManualMatchResult {
  spotify_id: string;
  tidal_id: string;
  method: "manual";
  confidence: number;
  matched_at: string;
}

export interface SkipResult {
  spotify_id: string;
  status: "skipped";
}

/**
 * Returns pending unmatched rows joined with tracks metadata, ordered by
 * last_attempt_at DESC. Limit is capped to 100 (enforced by caller).
 */
export async function listPending(
  env: Env,
  { limit }: { limit: number },
): Promise<PendingUnmatchedRow[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT u.spotify_id,
            t.artist  AS spotify_artist,
            t.title   AS spotify_title,
            t.album   AS spotify_album,
            t.isrc,
            u.reason,
            u.attempts,
            u.last_attempt_at::text AS last_attempt_at
     FROM unmatched u
     JOIN tracks t ON t.spotify_id = u.spotify_id
     WHERE u.status = 'pending'
     ORDER BY u.last_attempt_at DESC
     LIMIT $1`,
    [limit],
  );
  return (rows as PendingUnmatchedRow[]).map((r) => ({ ...r, candidates: [] }));
}

/**
 * Atomically inserts a matches row and sets unmatched.status = 'matched'.
 * Uses a transaction to enforce I-001.
 */
export async function markMatched(
  env: Env,
  spotifyId: string,
  tidalId: string,
): Promise<ManualMatchResult> {
  const sql = neon(env.DATABASE_URL);
  const now = new Date().toISOString();

  await sql.transaction((txSql) => [
    txSql(
      `INSERT INTO matches (spotify_id, tidal_id, method, confidence, sync_run_id)
       VALUES ($1, $2, 'manual', 1.00, NULL)
       ON CONFLICT (spotify_id) DO UPDATE
         SET tidal_id   = EXCLUDED.tidal_id,
             method     = 'manual',
             confidence = 1.00,
             sync_run_id = NULL`,
      [spotifyId, tidalId],
    ),
    txSql(
      `UPDATE unmatched SET status = 'matched' WHERE spotify_id = $1`,
      [spotifyId],
    ),
  ]);

  return {
    spotify_id: spotifyId,
    tidal_id: tidalId,
    method: "manual",
    confidence: 1.0,
    matched_at: now,
  };
}

/**
 * Sets unmatched.status = 'skipped'. Idempotent — calling on an already-skipped
 * row is a no-op (status stays 'skipped').
 */
export async function markSkipped(
  env: Env,
  spotifyId: string,
): Promise<SkipResult> {
  const sql = neon(env.DATABASE_URL);
  await sql(
    `UPDATE unmatched SET status = 'skipped'
     WHERE spotify_id = $1 AND status = 'pending'`,
    [spotifyId],
  );
  return { spotify_id: spotifyId, status: "skipped" };
}

export async function requeueForInvalidTidalId(
  sql: NeonQueryFunction<false, false>,
  spotifyId: string,
): Promise<void> {
  await sql(
    `INSERT INTO unmatched (spotify_id, reason, attempts, last_attempt_at, status)
     VALUES ($1, 'tidal_track_removed', 1, now(), 'pending')
     ON CONFLICT (spotify_id) DO UPDATE
       SET reason          = 'tidal_track_removed',
           attempts        = unmatched.attempts + 1,
           last_attempt_at = now(),
           status          = 'pending'`,
    [spotifyId],
  );
}
