import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Env } from "../env";
import { createPlaylist, getPlaylist, addTracksToPlaylist } from "../providers/tidal/playlist";
import { flagInvalidTidalId } from "../db/matches";
import { requeueForInvalidTidalId } from "../db/unmatched";
import {
  getPlaylistConfig,
  setTidalPlaylistId,
} from "../db/playlist_configs";
import {
  selectUnsyncedMatchesForPlaylist,
  markMembershipSynced,
} from "../db/playlist_membership";

export interface PlaylistWriteResult {
  playlistId: string;
  added: number;
  skippedDuplicates: number;
  invalidIds: string[];
  errors: number;
}

/**
 * Resolve the Tidal playlist id for a given Spotify playlist.
 *
 * If tidalPlaylistId argument is provided it is used directly (after existence
 * check). Otherwise the id is read from playlist_configs.tidal_playlist_id.
 * When that field is also null the Tidal playlist is created and the new id is
 * persisted back to playlist_configs.
 *
 * A missing Tidal playlist (getPlaylist returns null) triggers automatic
 * recreation regardless of whether the id came from the caller or the DB.
 */
async function resolvePlaylistId(
  env: Env,
  sql: NeonQueryFunction<false, false>,
  spotifyPlaylistId: string,
  callerTidalId: string | null,
): Promise<string> {
  // If caller passed a tidal id directly, use it (still check existence)
  if (callerTidalId !== null) {
    const exists = await getPlaylist(env, callerTidalId);
    if (exists) return callerTidalId;
    // Caller-supplied id is gone — fall through to recreation logic below
    // by treating it like a stale config entry
    const config = await getPlaylistConfig(sql, spotifyPlaylistId);
    const name = config?.spotify_name ?? spotifyPlaylistId;
    const newId = await createPlaylist(env, name);
    await setTidalPlaylistId(sql, spotifyPlaylistId, newId);
    console.log(
      JSON.stringify({
        event: "playlist_recreated",
        spotify_playlist_id: spotifyPlaylistId,
        previous_id: callerTidalId,
        new_id: newId,
      }),
    );
    return newId;
  }

  // Caller passed null — look up from playlist_configs
  const config = await getPlaylistConfig(sql, spotifyPlaylistId);
  if (!config) {
    throw new Error(
      `[F-018] No playlist_configs row for spotify_playlist_id=${spotifyPlaylistId}`,
    );
  }

  const storedId = config.tidal_playlist_id;
  const name = config.spotify_name;

  if (!storedId) {
    // First sync: create the Tidal playlist and persist the id
    const newId = await createPlaylist(env, name);
    await setTidalPlaylistId(sql, spotifyPlaylistId, newId);
    console.log(
      JSON.stringify({
        event: "playlist_created_for_config",
        spotify_playlist_id: spotifyPlaylistId,
        tidal_playlist_id: newId,
        name,
      }),
    );
    return newId;
  }

  // Stored id exists — verify the Tidal playlist still lives
  const existing = await getPlaylist(env, storedId);
  if (existing) return storedId;

  // Playlist was deleted between syncs — recreate
  const newId = await createPlaylist(env, name);
  await setTidalPlaylistId(sql, spotifyPlaylistId, newId);
  console.log(
    JSON.stringify({
      event: "playlist_recreated",
      spotify_playlist_id: spotifyPlaylistId,
      previous_id: storedId,
      new_id: newId,
    }),
  );
  return newId;
}

/**
 * Run the playlist write pass for a Spotify→Tidal playlist pair.
 *
 * F-018: selects unsynced rows from playlist_membership × matches, sends the
 * corresponding Tidal track ids to addTracksToPlaylist, and on success flips
 * playlist_membership.synced_at for the written rows.
 *
 * The legacy sync_state.last_playlist_write_at watermark is NOT read or written
 * (R8). Per-row synced_at is the authoritative replacement.
 *
 * Default values preserve the single-argument call site used during the prep PR
 * transition window: writePlaylist(env) ≡ writePlaylist(env, '__liked__', null).
 */
export async function writePlaylist(
  env: Env,
  spotifyPlaylistId: string = "__liked__",
  tidalPlaylistId: string | null = null,
): Promise<PlaylistWriteResult> {
  const sql = neon(env.DATABASE_URL) as NeonQueryFunction<false, false>;

  const resolvedTidalId = await resolvePlaylistId(
    env,
    sql,
    spotifyPlaylistId,
    tidalPlaylistId,
  );

  const unsyncedMatches = await selectUnsyncedMatchesForPlaylist(sql, spotifyPlaylistId);

  // R12: short-circuit on empty — no Tidal subrequest needed
  if (unsyncedMatches.length === 0) {
    console.log(
      JSON.stringify({
        event: "playlist_write_completed",
        spotify_playlist_id: spotifyPlaylistId,
        tidal_playlist_id: resolvedTidalId,
        added: 0,
        skipped_duplicates: 0,
        invalid_ids: 0,
        errors: 0,
      }),
    );
    return {
      playlistId: resolvedTidalId,
      added: 0,
      skippedDuplicates: 0,
      invalidIds: [],
      errors: 0,
    };
  }

  const tidalIds = unsyncedMatches.map((m) => m.tidal_id);
  const result = await addTracksToPlaylist(env, resolvedTidalId, tidalIds);

  // R9: handle invalid Tidal ids via the existing F-008 quarantine path
  const invalidSet = new Set(result.invalidIds);
  for (const tidalId of result.invalidIds) {
    await flagInvalidTidalId(sql, tidalId);
    const match = unsyncedMatches.find((m) => m.tidal_id === tidalId);
    if (match) {
      await requeueForInvalidTidalId(sql, match.spotify_track_id);
    }
  }

  // R5: mark membership synced for tracks whose Tidal id was NOT invalid
  const writtenSpotifyIds = unsyncedMatches
    .filter((m) => !invalidSet.has(m.tidal_id))
    .map((m) => m.spotify_track_id);

  if (writtenSpotifyIds.length > 0) {
    await markMembershipSynced(sql, spotifyPlaylistId, writtenSpotifyIds, new Date().toISOString());
  }

  // R7: structured completion log
  console.log(
    JSON.stringify({
      event: "playlist_write_completed",
      spotify_playlist_id: spotifyPlaylistId,
      tidal_playlist_id: resolvedTidalId,
      added: result.added,
      skipped_duplicates: 0,
      invalid_ids: result.invalidIds.length,
      errors: result.errors,
    }),
  );

  return {
    playlistId: resolvedTidalId,
    added: result.added,
    skippedDuplicates: 0,
    invalidIds: result.invalidIds,
    errors: result.errors,
  };
}

