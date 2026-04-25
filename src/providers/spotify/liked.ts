// F-005: Spotify Liked Songs incremental fetch
//
// Pagination strategy: follows the `next` URL returned by Spotify (R1).
// Each page is 50 items, ordered by `added_at DESC` (most recent first).
// The cursor marks the last successfully-processed `added_at` timestamp.
// Stops paginating once a track's `added_at` is at or before `cursor - 60s` (R11 clock-skew tolerance).
//
// Atomicity (I-005 / F-005-R6): non-final pages are persisted without touching
// the cursor. The final page's inserts and cursor advance are in a single
// @neondatabase/serverless transaction so a partial run never advances the cursor.

import { neon } from "@neondatabase/serverless";
import { ensureFreshToken } from "./oauth";
import { upsertTracks, type TrackRow } from "../../db/tracks";
import { readCursor, writeCursor } from "../../db/sync_state";
import type { Env } from "../../env";

const LIKED_SONGS_URL = "https://api.spotify.com/v1/me/tracks?limit=50";
const CURSOR_KEY = "spotify_cursor";
const USER_AGENT = "spotify-roon-sync/1.0";
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

async function fetchPageWithRetry(
  url: string,
  accessToken: string,
): Promise<SpotifyTracksPage> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
    },
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "1", 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));

    const retryResponse = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
      },
    });

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
  const accessToken = await ensureFreshToken(env);
  const cursor = await readCursor(env, CURSOR_KEY);
  const cutoff = new Date(new Date(cursor).getTime() - CLOCK_SKEW_MS);

  const db = neon(env.DATABASE_URL);

  let url: string | null = LIKED_SONGS_URL;
  let pageIndex = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let maxAddedAt: Date | null = null;

  // Collect all pages first so we can identify the final page for atomic cursor advance.
  // Throw on any fetch error — partial collections do not persist anything.
  const allPages: Array<{ tracks: TrackRow[]; skipped: number; nextUrl: string | null }> = [];
  let stopPagination = false;

  while (url !== null && !stopPagination) {
    const page = await fetchPageWithRetry(url, accessToken);

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

    allPages.push({ tracks: tracksForPage, skipped: skippedOnPage, nextUrl: page.next ?? null });
    url = stopPagination ? null : (page.next ?? null);
    pageIndex++;
  }

  // Persist all pages. The final page's inserts are atomic with the cursor advance (I-005).
  for (let i = 0; i < allPages.length; i++) {
    const { tracks, skipped } = allPages[i];
    const isLastPage = i === allPages.length - 1;
    let inserted: number;

    if (isLastPage && maxAddedAt !== null) {
      // I-005: atomic transaction — tracks inserts + cursor advance
      let atomicInserted = 0;
      await db.transaction(async (txSql) => {
        atomicInserted = await upsertTracks(txSql, tracks);
        await writeCursor(txSql, CURSOR_KEY, maxAddedAt!.toISOString());
      });
      inserted = atomicInserted;
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

  // Edge case: no pages fetched at all (account empty or cursor already at tip)
  if (allPages.length === 0) {
    console.log(JSON.stringify({
      event: "fetch_page",
      page_index: 0,
      items_seen: 0,
      items_persisted: 0,
      items_skipped: 0,
    }));
  }

  return {
    pagesProcessed: allPages.length,
    tracksInserted: totalInserted,
    tracksSkipped: totalSkipped,
  };
}
