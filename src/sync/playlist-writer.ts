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
 * Run the full playlist write pass for the current sync.
 *
 * 2026-05-02 simplification: previously read full playlist contents via
 * `getAllPlaylistTrackIds` to dedupe before writing. That paginated read
 * grew with playlist size and Tidal rate-limited the GET on every cron
 * (HTTP 429), throwing inside writePlaylist, which left the watermark
 * frozen and the queue stuck. The watermark itself already prevents
 * double-writes in steady state: each match is selected exactly once
 * (`matched_at > last_write_at`), and the watermark advances atomically
 * after each successful invocation. Trade-off: a worker crash AFTER the
 * Tidal POST returns and BEFORE the watermark write could re-enqueue
 * already-written matches on the next run. For this single-tenant tool
 * the duplicate window is acceptable; manual cleanup is trivial if it
 * ever surfaces.
 */
export async function writePlaylist(env: Env): Promise<PlaylistWriteResult> {
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
