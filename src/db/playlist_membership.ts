import type {
  NeonQueryFunction,
  NeonQueryFunctionInTransaction,
} from "@neondatabase/serverless";

// F-017: per-playlist track membership. Idempotent on the composite PK
// (spotify_playlist_id, spotify_track_id). synced_at is NULL on insert and
// flipped to a timestamp by F-018's write pass when the corresponding Tidal
// track is appended to the Tidal playlist.
export interface PlaylistMembershipRow {
  spotify_playlist_id: string;
  spotify_track_id: string;
  added_at: string;
}

// F-017-R8: outside-transaction single-row upsert. ON CONFLICT DO NOTHING
// preserves the original added_at on duplicate.
export async function upsertMembership(
  sql: NeonQueryFunction<false, false>,
  row: PlaylistMembershipRow,
): Promise<void> {
  await sql(
    `INSERT INTO playlist_membership
       (spotify_playlist_id, spotify_track_id, added_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (spotify_playlist_id, spotify_track_id) DO NOTHING`,
    [row.spotify_playlist_id, row.spotify_track_id, row.added_at],
  );
}

// F-017-R6: builds un-awaited upsert queries for use inside db.transaction()
// sync-callback array form. Returns one NeonQueryInTransaction per row.
// Mirrors src/db/tracks.ts buildUpsertQueries.
export function buildMembershipUpsertQueries(
  txSql: NeonQueryFunctionInTransaction<false, false>,
  rows: PlaylistMembershipRow[],
) {
  return rows.map((r) =>
    txSql(
      `INSERT INTO playlist_membership
         (spotify_playlist_id, spotify_track_id, added_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (spotify_playlist_id, spotify_track_id) DO NOTHING`,
      [r.spotify_playlist_id, r.spotify_track_id, r.added_at],
    ),
  );
}

// F-018 use-site (specified here for cohesion). Sets synced_at for a batch of
// track IDs in a single round-trip via WHERE spotify_track_id = ANY($3).
export async function markMembershipSynced(
  sql: NeonQueryFunction<false, false>,
  spotifyPlaylistId: string,
  spotifyTrackIds: string[],
  syncedAt: string,
): Promise<void> {
  if (spotifyTrackIds.length === 0) return;
  await sql(
    `UPDATE playlist_membership
        SET synced_at = $2
      WHERE spotify_playlist_id = $1
        AND spotify_track_id = ANY($3::text[])`,
    [spotifyPlaylistId, syncedAt, spotifyTrackIds],
  );
}

// F-018 use-site. JOINs membership with matches; returns the (track_id, tidal_id)
// pairs that have a valid Tidal counterpart and have NOT yet been synced to the
// named Tidal playlist. Excludes tidal_id_invalid matches (F-008 quarantine).
export interface UnsyncedMatch {
  spotify_track_id: string;
  tidal_id: string;
}

export async function selectUnsyncedMatchesForPlaylist(
  sql: NeonQueryFunction<false, false>,
  spotifyPlaylistId: string,
): Promise<UnsyncedMatch[]> {
  const rows = await sql(
    `SELECT pm.spotify_track_id AS spotify_track_id,
            m.tidal_id          AS tidal_id
       FROM playlist_membership pm
       JOIN matches m ON m.spotify_id = pm.spotify_track_id
      WHERE pm.spotify_playlist_id = $1
        AND pm.synced_at IS NULL
        AND NOT m.tidal_id_invalid`,
    [spotifyPlaylistId],
  );
  return rows as unknown as UnsyncedMatch[];
}
