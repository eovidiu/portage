import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Env } from "../env";
import { createPlaylist, getPlaylist, getAllPlaylistTrackIds, addTracksToPlaylist } from "../providers/tidal/playlist";
import { selectMatchesNewerThan, flagInvalidTidalId } from "../db/matches";
import { readState, writeState } from "../db/sync_state";
import { requeueForInvalidTidalId } from "../db/unmatched";

const COLD_START_TS = "1970-01-01T00:00:00Z";
const KEY_PLAYLIST_ID = "tidal_playlist_id";
const KEY_LAST_WRITE_AT = "last_playlist_write_at";

export interface PlaylistWriteResult {
  playlistId: string;
  added: number;
  skippedDuplicates: number;
  invalidIds: string[];
  errors: number;
}

/**
 * Ensure the Tidal playlist exists, creating or recreating as needed.
 * Returns the current playlist id and persists it to sync_state.
 */
async function ensurePlaylist(
  env: Env,
  sql: NeonQueryFunction<false, false>,
): Promise<string> {
  const stored = await readState(sql, KEY_PLAYLIST_ID);
  const title = env.TIDAL_PLAYLIST_TITLE || "Spotify Liked";

  if (stored) {
    const playlist = await getPlaylist(env, stored);
    if (playlist) return stored;

    // Playlist gone — recreate
    const newId = await createPlaylist(env, title);
    console.log(
      JSON.stringify({
        event: "playlist_recreated",
        previous_id: stored,
        new_id: newId,
      }),
    );
    await writeState(sql, KEY_PLAYLIST_ID, newId);
    return newId;
  }

  const newId = await createPlaylist(env, title);
  await writeState(sql, KEY_PLAYLIST_ID, newId);
  return newId;
}

/** Run the full playlist write pass for the current sync. */
export async function writePlaylist(env: Env): Promise<PlaylistWriteResult> {
  const sql = neon(env.DATABASE_URL) as NeonQueryFunction<false, false>;

  const playlistId = await ensurePlaylist(env, sql);

  const lastWriteAt = (await readState(sql, KEY_LAST_WRITE_AT)) ?? COLD_START_TS;
  const newMatches = await selectMatchesNewerThan(sql, lastWriteAt);

  if (newMatches.length === 0) {
    return { playlistId, added: 0, skippedDuplicates: 0, invalidIds: [], errors: 0 };
  }

  const existingIds = await getAllPlaylistTrackIds(env, playlistId);

  const toAdd = newMatches.filter((m) => !existingIds.has(m.tidal_id));
  const skippedDuplicates = newMatches.length - toAdd.length;

  if (toAdd.length === 0) {
    return { playlistId, added: 0, skippedDuplicates, invalidIds: [], errors: 0 };
  }

  const tidalIds = toAdd.map((m) => m.tidal_id);
  const result = await addTracksToPlaylist(env, playlistId, tidalIds);

  // Handle invalid track ids: flag in matches + requeue to unmatched
  for (const tidalId of result.invalidIds) {
    await flagInvalidTidalId(sql, tidalId);
    // Find the spotify_id for this tidal_id from our newMatches list
    const match = newMatches.find((m) => m.tidal_id === tidalId);
    if (match) {
      await requeueForInvalidTidalId(sql, match.spotify_id);
    }
  }

  // Advance the watermark only on overall success (even partial writes advance it
  // so that successfully-added tracks are not retried; deduplication handles safety)
  await writeState(sql, KEY_LAST_WRITE_AT, new Date().toISOString());

  return {
    playlistId,
    added: result.added,
    skippedDuplicates,
    invalidIds: result.invalidIds,
    errors: result.errors,
  };
}
