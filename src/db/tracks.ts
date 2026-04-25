import { neon } from "@neondatabase/serverless";
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

// Upserts a batch of tracks, ON CONFLICT DO NOTHING (idempotent per F-005-R8).
// Returns the number of rows actually inserted.
export async function upsertTracks(
  sql: ReturnType<typeof neon>,
  tracks: TrackRow[],
): Promise<number> {
  if (tracks.length === 0) return 0;

  let inserted = 0;
  for (const t of tracks) {
    const rows = await sql(
      `INSERT INTO tracks
         (spotify_id, isrc, artist, title, album, duration_ms, spotify_added_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (spotify_id) DO NOTHING
       RETURNING spotify_id`,
      [t.spotify_id, t.isrc, t.artist, t.title, t.album, t.duration_ms, t.spotify_added_at],
    );
    if (rows.length > 0) inserted++;
  }
  return inserted;
}

export async function countTracks(env: Env): Promise<number> {
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(`SELECT COUNT(*)::integer AS n FROM tracks`, []);
  return rows[0].n as number;
}
