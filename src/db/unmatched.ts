import { type NeonQueryFunction } from "@neondatabase/serverless";

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
 * Re-queue a spotify_id as unmatched because its Tidal match is no longer valid.
 * Unlike upsertUnmatched, this bypasses the status='pending' guard so that
 * previously matched/skipped rows can be re-queued.
 */
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
