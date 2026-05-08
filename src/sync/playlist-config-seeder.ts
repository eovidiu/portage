// F-016: seed playlist_configs at the top of every orchestrator run.
// Ensures the synthetic '__liked__' row exists, then upserts each extra
// playlist declared in env.SPOTIFY_EXTRA_PLAYLIST_IDS by fetching its
// current Spotify name. Failures on individual IDs are logged structurally
// and do not abort the seeder (R6).

import { neon } from "@neondatabase/serverless";
import { upsertPlaylistConfig } from "../db/playlist_configs";
import { fetchSpotifyPlaylistName } from "../providers/spotify/playlists";
import type { Env } from "../env";

const LIKED_KEY = "__liked__";
const LIKED_NAME = "Spotify Liked";

function parseExtraIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== LIKED_KEY);
}

export async function seedPlaylistConfigs(env: Env): Promise<void> {
  const sql = neon(env.DATABASE_URL);

  // F-016-R2: __liked__ row is the synthetic key for Liked Songs.
  await upsertPlaylistConfig(sql, {
    spotify_playlist_id: LIKED_KEY,
    spotify_name: LIKED_NAME,
  });

  const extraIds = parseExtraIds(env.SPOTIFY_EXTRA_PLAYLIST_IDS);

  for (const id of extraIds) {
    try {
      const name = await fetchSpotifyPlaylistName(env, id);
      await upsertPlaylistConfig(sql, {
        spotify_playlist_id: id,
        spotify_name: name,
      });
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "playlist_name_fetch_failed",
          spotify_playlist_id: id,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
