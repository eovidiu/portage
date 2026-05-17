import type { NeonQueryFunction } from "@neondatabase/serverless";

// F-016: registry of Spotify playlists synced into Tidal. The synthetic
// '__liked__' row represents Liked Songs; extras come from
// env.SPOTIFY_EXTRA_PLAYLIST_IDS via the seeder. tidal_playlist_id is null
// until F-018 creates the Tidal counterpart on first sync. enabled (F-026a)
// gates orchestrator sync per row — the GET handler returns all rows.
export interface PlaylistConfigRow {
  spotify_playlist_id: string;
  spotify_name: string;
  tidal_playlist_id: string | null;
  created_at: string;
  last_synced_at: string | null;
  enabled: boolean;
}

export interface PlaylistConfigUpsertInput {
  spotify_playlist_id: string;
  spotify_name: string;
}

// F-016-R5: upsert by spotify_playlist_id; only spotify_name changes on
// conflict. tidal_playlist_id and created_at are preserved.
export async function upsertPlaylistConfig(
  sql: NeonQueryFunction<false, false>,
  input: PlaylistConfigUpsertInput,
): Promise<void> {
  await sql(
    `INSERT INTO playlist_configs (spotify_playlist_id, spotify_name)
     VALUES ($1, $2)
     ON CONFLICT (spotify_playlist_id) DO UPDATE SET
       spotify_name = EXCLUDED.spotify_name`,
    [input.spotify_playlist_id, input.spotify_name],
  );
}

export async function listPlaylistConfigs(
  sql: NeonQueryFunction<false, false>,
): Promise<PlaylistConfigRow[]> {
  const rows = await sql(
    `SELECT spotify_playlist_id, spotify_name, tidal_playlist_id,
            created_at, last_synced_at, enabled
       FROM playlist_configs`,
    [],
  );
  return rows as unknown as PlaylistConfigRow[];
}

export async function getPlaylistConfig(
  sql: NeonQueryFunction<false, false>,
  spotifyPlaylistId: string,
): Promise<PlaylistConfigRow | null> {
  const rows = await sql(
    `SELECT spotify_playlist_id, spotify_name, tidal_playlist_id,
            created_at, last_synced_at, enabled
       FROM playlist_configs
      WHERE spotify_playlist_id = $1`,
    [spotifyPlaylistId],
  );
  const arr = rows as unknown as PlaylistConfigRow[];
  return arr.length > 0 ? arr[0] : null;
}

export async function setTidalPlaylistId(
  sql: NeonQueryFunction<false, false>,
  spotifyPlaylistId: string,
  tidalPlaylistId: string,
): Promise<void> {
  await sql(
    `UPDATE playlist_configs
        SET tidal_playlist_id = $2
      WHERE spotify_playlist_id = $1`,
    [spotifyPlaylistId, tidalPlaylistId],
  );
}

export async function markSynced(
  sql: NeonQueryFunction<false, false>,
  spotifyPlaylistId: string,
  syncedAt: string,
): Promise<void> {
  await sql(
    `UPDATE playlist_configs
        SET last_synced_at = $2
      WHERE spotify_playlist_id = $1`,
    [spotifyPlaylistId, syncedAt],
  );
}
