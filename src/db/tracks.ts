import { neon, type NeonQueryFunctionInTransaction } from "@neondatabase/serverless";
import type { Env } from "../env";

export interface TrackRow {
  spotify_id: string;
  isrc: string | null;
  artist: string;
  title: string;
  album: string | null;
  duration_ms: number | null;
  spotify_added_at: string;
}

// F-015: input shape for the match-stage queue. The eligibility predicate in
// `fetchPendingMatchQueue` is shared with `fetchUnmatchedTracks` in fuzzy.ts —
// keep the two SELECTs in sync.
export interface TrackCandidate {
  spotify_id: string;
  isrc: string | null;
  artist: string;
  duration_ms: number | null;
}

// Builds un-awaited upsert queries for use inside a db.transaction() sync callback.
// Returns one NeonQueryInTransaction per track.
export function buildUpsertQueries(
  txSql: NeonQueryFunctionInTransaction<false, false>,
  tracks: TrackRow[],
) {
  return tracks.map((t) =>
    txSql(
      `INSERT INTO tracks
         (spotify_id, isrc, artist, title, album, duration_ms, spotify_added_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (spotify_id) DO NOTHING
       RETURNING spotify_id`,
      [t.spotify_id, t.isrc, t.artist, t.title, t.album, t.duration_ms, t.spotify_added_at],
    )
  );
}

export async function countTracks(env: Env): Promise<number> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(`SELECT COUNT(*)::integer AS n FROM tracks`, []);
  return (rows as Record<string, unknown>[])[0].n as number;
}

/**
 * F-024: cheap existence check used by the manual Tidal-search route to
 * return 404 unknown_spotify_id before any upstream call.
 */
export async function trackExists(env: Env, spotifyId: string): Promise<boolean> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT 1 FROM tracks WHERE spotify_id = $1 LIMIT 1`,
    [spotifyId],
  );
  return (rows as unknown[]).length > 0;
}

// F-015: returns up to `limit` tracks eligible for a fresh match attempt.
// A track is eligible iff it is NOT already matched AND either has no
// `unmatched` row OR is pending and was last attempted >7 days ago. Skipped
// rows never re-enter the queue (closes Sprint 6 review M2 + M3).
export async function fetchPendingMatchQueue(
  env: Env,
  limit: number,
): Promise<TrackCandidate[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT t.spotify_id, t.isrc, t.artist, t.duration_ms
     FROM tracks t
     LEFT JOIN matches m ON m.spotify_id = t.spotify_id
     LEFT JOIN unmatched u ON u.spotify_id = t.spotify_id
     WHERE m.spotify_id IS NULL
       AND (u.status IS NULL
            OR (u.status = 'pending'
                AND u.last_attempt_at < now() - interval '7 days'))
     ORDER BY t.first_seen_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows as TrackCandidate[];
}
