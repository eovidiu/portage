// F-030 task 2.3: copy-job fetch phase — one source page per tick, atomic
// cursor+rows persist (design.md D6, mirrors I-005).

import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";
import type { CopyJobRow } from "../db/copy_jobs";
import { insertFetchedPage, type CopyTrackInput } from "../db/copy_job_tracks";
import { buildUpsertQueries, type TrackRow } from "../db/tracks";
import { getSpotifyPlaylistItems } from "./spotify-source";
import { getPlaylistItems, resolveTrackArtists } from "../providers/tidal/playlist-items";

async function fetchSpotifyToTidalPage(
  env: Env,
  job: CopyJobRow,
): Promise<{ tracks: CopyTrackInput[]; hasMore: boolean; cursor: string | null }> {
  const page = await getSpotifyPlaylistItems(env, job.source_playlist_id, job.fetch_cursor);
  const tracks: CopyTrackInput[] = page.items.map((i) => ({
    source_track_id: i.id,
    isrc: i.isrc,
    title: i.title,
    artist: i.artist,
    album: i.album,
    duration_ms: i.duration_ms,
  }));

  // D4 write-back requires matches.spotify_id to satisfy its FK to tracks —
  // ensure the source track exists in the sync engine's catalogue table
  // before the matching phase ever attempts insertMatch for it. The whole
  // page MUST go through one db.transaction() call (one Neon HTTP
  // subrequest): per-row upserts on a 50-track page consumed the entire
  // 50-subrequest free-tier budget and killed the tick before the page
  // persist, leaving the job 'queued' forever.
  if (tracks.length > 0) {
    const db = neon(env.DATABASE_URL);
    const now = new Date().toISOString();
    const rows: TrackRow[] = page.items.map((i) => ({
      spotify_id: i.id,
      isrc: i.isrc,
      artist: i.artist ?? "",
      title: i.title,
      album: i.album,
      duration_ms: i.duration_ms,
      spotify_added_at: now,
    }));
    await db.transaction((txSql) => buildUpsertQueries(txSql, rows));
  }

  return { tracks, hasMore: page.hasMore, cursor: page.cursor };
}

async function fetchTidalToSpotifyPage(
  env: Env,
  job: CopyJobRow,
): Promise<{ tracks: CopyTrackInput[]; hasMore: boolean; cursor: string | null }> {
  const page = await getPlaylistItems(env, job.source_playlist_id, job.fetch_cursor);
  const names = await resolveTrackArtists(env, page.items.map((i) => i.tidalId));

  const tracks: CopyTrackInput[] = page.items.map((i) => ({
    source_track_id: i.tidalId,
    isrc: i.isrc,
    title: i.title ?? "",
    // The /tracks artist batch doesn't resolve album relationships, so
    // tidal_to_spotify sourced tracks always carry album=null (score.ts's
    // album component contributes 0 for this direction — documented gap).
    artist: names.get(i.tidalId) ?? null,
    album: null,
    duration_ms: i.durationMs,
  }));

  return { tracks, hasMore: page.hasMore, cursor: page.cursor };
}

/** One fetch-phase tick step: one source page, persisted atomically with the cursor. */
export async function runFetchPhaseStep(env: Env, job: CopyJobRow): Promise<void> {
  const { tracks, hasMore, cursor } =
    job.direction === "spotify_to_tidal"
      ? await fetchSpotifyToTidalPage(env, job)
      : await fetchTidalToSpotifyPage(env, job);

  await insertFetchedPage(env, job.job_id, {
    tracks,
    positionStart: job.fetched,
    cursor,
    isLastPage: !hasMore,
    ...(hasMore ? {} : { totalTracks: job.fetched + tracks.length }),
  });
}
