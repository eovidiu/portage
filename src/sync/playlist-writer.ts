import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Env } from "../env";
import { createPlaylist, getPlaylist, addTracksToPlaylist } from "../providers/tidal/playlist";
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

/**
 * Run the playlist write pass for a Spotify→Tidal playlist pair.
 *
 * F-018 (Phase B prep): signature generalised to take a Spotify playlist id
 * and an optional Tidal playlist id. Defaults preserve the legacy single-arg
 * call site during the prep PR transition window — the body still uses the
 * pre-multi-playlist flow (sync_state.tidal_playlist_id +
 * selectMatchesNewerThan + watermark). The F-018 implementation PR replaces
 * this body to use playlist_configs + selectUnsyncedMatchesForPlaylist +
 * markMembershipSynced. Both the legacy and new callers can co-exist on this
 * signature without behaviour change until F-018 lands.
 *
 * 2026-05-02 simplification (preserved in this stub body): previously read
 * full playlist contents via `getAllPlaylistTrackIds` to dedupe before
 * writing. The watermark itself already prevents double-writes in steady
 * state: each match is selected exactly once
 * (`matched_at > last_write_at`), and the watermark advances atomically
 * after each successful invocation. Trade-off: a worker crash AFTER the
 * Tidal POST returns and BEFORE the watermark write could re-enqueue
 * already-written matches on the next run.
 */
export async function writePlaylist(
  env: Env,
  // F-018 prep stub: the new params are ignored by this body. F-018's PR
  // replaces the body to consume them. spotifyPlaylistId='__liked__' is the
  // synthetic key for Liked Songs (F-016-R2). tidalPlaylistId=null lets the
  // caller defer Tidal id resolution to F-018 (look up from playlist_configs,
  // create if absent).
  _spotifyPlaylistId: string = "__liked__",
  _tidalPlaylistId: string | null = null,
): Promise<PlaylistWriteResult> {
  const sql = neon(env.DATABASE_URL) as NeonQueryFunction<false, false>;

  const playlistId = await ensurePlaylist(env, sql);

  const lastWriteAt = (await readState(sql, KEY_LAST_WRITE_AT)) ?? COLD_START_TS;
  const newMatches = await selectMatchesNewerThan(sql, lastWriteAt);

  if (newMatches.length === 0) {
    return { playlistId, added: 0, skippedDuplicates: 0, invalidIds: [], errors: 0 };
  }

  const tidalIds = newMatches.map((m) => m.tidal_id);
  const result = await addTracksToPlaylist(env, playlistId, tidalIds);

  // Handle invalid track ids: flag in matches + requeue to unmatched
  for (const tidalId of result.invalidIds) {
    await flagInvalidTidalId(sql, tidalId);
    const match = newMatches.find((m) => m.tidal_id === tidalId);
    if (match) {
      await requeueForInvalidTidalId(sql, match.spotify_id);
    }
  }

  // Advance the watermark on any successful return from addTracksToPlaylist
  // (even partial writes — the per-batch loop never throws). The watermark
  // is the sole gate against re-write next run.
  await writeState(sql, KEY_LAST_WRITE_AT, new Date().toISOString());

  return {
    playlistId,
    added: result.added,
    skippedDuplicates: 0,
    invalidIds: result.invalidIds,
    errors: result.errors,
  };
}
