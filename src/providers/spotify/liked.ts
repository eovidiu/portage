// F-005: Spotify Liked Songs incremental fetch
//
// Pagination strategy: follows the `next` URL returned by Spotify (R1).
// Each page is 50 items, ordered by `added_at DESC` (most recent first).
// The cursor marks the last successfully-processed `added_at` timestamp.
// Stops paginating once a track's `added_at` is at or before `cursor - 60s` (R11 clock-skew tolerance).
//
// Atomicity (I-005 / F-005-R6): non-final pages are persisted without touching
// the cursor. The final page's inserts and cursor advance are in a single
// @neondatabase/serverless transaction (sync-callback array form) so a partial
// run never advances the cursor.
//
// 401 handling: delegates to spotifyFetch from oauth.ts (coalesced refresh + retry).

import { neon } from "@neondatabase/serverless";
import { spotifyFetch } from "./oauth";
import { buildUpsertQueries, upsertTracks, type TrackRow } from "../../db/tracks";
import { readCursor, buildCursorQuery } from "../../db/sync_state";
import type { Env } from "../../env";

// Verified: 2026-04-27 against https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks (path /v1/me/tracks, max page size = 50).
const LIKED_SONGS_URL = "https://api.spotify.com/v1/me/tracks?limit=50";
const CURSOR_KEY = "spotify_cursor";
const CLOCK_SKEW_MS = 60_000;

interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album: { name: string };
  duration_ms: number;
  external_ids?: { isrc?: string };
  type: string;
  is_local: boolean;
}

interface SpotifyPageItem {
  added_at: string;
  track: SpotifyTrack;
}

interface SpotifyTracksPage {
  items: SpotifyPageItem[];
  next: string | null;
}

export interface FetchResult {
  pagesProcessed: number;
  tracksInserted: number;
  tracksSkipped: number;
}

async function fetchPage(env: Env, url: string): Promise<SpotifyTracksPage> {
  // M1: use spotifyFetch for 401-coalesced-refresh + retry (F-002-R11)
  const response = await spotifyFetch(env, url);

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "1", 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));

    const retryResponse = await spotifyFetch(env, url);

    if (retryResponse.status === 429) {
      throw new Error("Spotify rate limit: second 429 received, aborting run");
    }

    if (!retryResponse.ok) {
      throw new Error(`Spotify API error on retry: ${retryResponse.status}`);
    }

    return retryResponse.json() as Promise<SpotifyTracksPage>;
  }

  if (!response.ok) {
    throw new Error(`Spotify API error: ${response.status}`);
  }

  return response.json() as Promise<SpotifyTracksPage>;
}

function shouldSkip(item: SpotifyPageItem): boolean {
  return item.track.is_local === true || item.track.type !== "track";
}

function toTrackRow(item: SpotifyPageItem): TrackRow {
  const t = item.track;
  return {
    spotify_id: t.id,
    isrc: t.external_ids?.isrc ?? null,
    artist: t.artists[0]?.name ?? "",
    title: t.name,
    album: t.album?.name ?? null,
    duration_ms: t.duration_ms ?? null,
    spotify_added_at: item.added_at,
  };
}

export async function fetchLikedSongs(env: Env): Promise<FetchResult> {
  const cursor = await readCursor(env, CURSOR_KEY);
  const cutoff = new Date(new Date(cursor).getTime() - CLOCK_SKEW_MS);

  const db = neon(env.DATABASE_URL);

  let url: string | null = LIKED_SONGS_URL;
  let totalInserted = 0;
  let totalSkipped = 0;
  let maxAddedAt: Date | null = null;

  // Collect all pages first so we can identify the final page for atomic cursor advance.
  // Any fetch error propagates immediately — partial collections do not persist anything.
  const allPages: Array<{ tracks: TrackRow[]; skipped: number }> = [];
  let stopPagination = false;

  while (url !== null && !stopPagination) {
    const page = await fetchPage(env, url);

    const tracksForPage: TrackRow[] = [];
    let skippedOnPage = 0;

    for (const item of page.items) {
      if (shouldSkip(item)) {
        skippedOnPage++;
        continue;
      }

      const addedAt = new Date(item.added_at);

      // R5 + R11: stop once we see a track at or before cursor - 60s
      if (addedAt <= cutoff) {
        stopPagination = true;
        break;
      }

      tracksForPage.push(toTrackRow(item));

      if (maxAddedAt === null || addedAt > maxAddedAt) {
        maxAddedAt = addedAt;
      }
    }

    allPages.push({ tracks: tracksForPage, skipped: skippedOnPage });
    url = stopPagination ? null : (page.next ?? null);
  }

  // Persist all pages. The final page's inserts are atomic with the cursor advance (I-005).
  for (let i = 0; i < allPages.length; i++) {
    const { tracks, skipped } = allPages[i];
    const isLastPage = i === allPages.length - 1;
    let inserted: number;

    if (isLastPage && maxAddedAt !== null) {
      // C1 fix: sync-callback array form required by @neondatabase/serverless transaction API
      // Each txSql(...) call returns an un-awaited NeonQueryInTransaction; driver executes them atomically.
      const newCursor = maxAddedAt.toISOString();
      const results = await db.transaction((txSql) => [
        ...buildUpsertQueries(txSql, tracks),
        buildCursorQuery(txSql, CURSOR_KEY, newCursor),
      ]);
      // results is QueryRows[][]; each upsert returns RETURNING rows (0 or 1 row per insert).
      // The last result is the cursor UPSERT — skip it for the insert count.
      const upsertResults = results.slice(0, tracks.length);
      inserted = upsertResults.filter((r) => (r as Record<string, unknown>[]).length > 0).length;
    } else {
      inserted = await upsertTracks(db, tracks);
    }

    totalInserted += inserted;
    totalSkipped += skipped;

    console.log(JSON.stringify({
      event: "fetch_page",
      page_index: i,
      items_seen: tracks.length + skipped,
      items_persisted: inserted,
      items_skipped: skipped,
    }));
  }

  return {
    pagesProcessed: allPages.length,
    tracksInserted: totalInserted,
    tracksSkipped: totalSkipped,
  };
}
