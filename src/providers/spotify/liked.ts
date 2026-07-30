// F-005: Spotify Liked Songs incremental fetch
//
// Pagination strategy: follows the `next` URL returned by Spotify (R1).
// Each page is 50 items, ordered by `added_at DESC` (most recent first).
// The cursor marks the last successfully-processed `added_at` timestamp.
// Stops paginating once a track's `added_at` is at or before `cursor - 60s` (R11 clock-skew tolerance).
//
// Atomicity (I-005 / F-005-R6): non-final pages are persisted without touching
// sync_state. The last page of THIS invocation's inserts and ALL sync_state
// writes (cursor + resume URL + sweep max) are batched into a single
// @neondatabase/serverless transaction so a partial run never advances state.
//
// F-015: bounded per invocation. `maxPages` caps subrequests for Workers Free
// (default Number.POSITIVE_INFINITY = unbounded for back-compat). When we stop
// voluntarily mid-sweep (page.next != null but pagesFetched >= maxPages), the
// next page URL is persisted in sync_state.spotify_resume_url so the next
// invocation continues where this one left off without re-fetching processed
// pages. The cursor only advances when a sweep COMPLETES (cutoff hit OR
// page.next === null); during the sweep, sweep_max accumulates the newest
// added_at across invocations.
//
// 401 handling: delegates to spotifyFetch from oauth.ts (coalesced refresh + retry).

import { neon } from "@neondatabase/serverless";
import { spotifyFetch } from "./oauth";
import { buildUpsertQueries, type TrackRow } from "../../db/tracks";
import { retryAfterMs, MAX_RETRY_AFTER_S } from "../retry-after";
import { readCursor, readState, buildCursorQuery } from "../../db/sync_state";
import type { Env } from "../../env";

// Verified: 2026-04-27 against https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks (path /v1/me/tracks, max page size = 50).
const LIKED_SONGS_URL = "https://api.spotify.com/v1/me/tracks?limit=50";
const CURSOR_KEY = "spotify_cursor";
const RESUME_URL_KEY = "spotify_resume_url";
const SWEEP_MAX_KEY = "spotify_sweep_max";
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
  /** F-015: true when more pages remain in the current sweep after this invocation. */
  morePagesPending: boolean;
}

async function fetchPage(env: Env, url: string): Promise<SpotifyTracksPage> {
  // M1: use spotifyFetch for 401-coalesced-refresh + retry (F-002-R11)
  const response = await spotifyFetch(env, url);

  if (response.status === 429) {
    const backoffMs = retryAfterMs(response.headers.get("Retry-After"));
    if (backoffMs === null) {
      throw new Error(
        `Spotify rate limit: Retry-After exceeds the ${MAX_RETRY_AFTER_S}s cap, aborting run`,
      );
    }
    await new Promise((r) => setTimeout(r, backoffMs));

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

export async function fetchLikedSongs(
  env: Env,
  maxPages: number = Number.POSITIVE_INFINITY,
): Promise<FetchResult> {
  const cursor = await readCursor(env, CURSOR_KEY);
  const cutoff = new Date(new Date(cursor).getTime() - CLOCK_SKEW_MS);

  const db = neon(env.DATABASE_URL);
  const resumeUrlRaw = await readState(db, RESUME_URL_KEY);
  const sweepMaxRaw = await readState(db, SWEEP_MAX_KEY);
  const resumeUrl = resumeUrlRaw && resumeUrlRaw.length > 0 ? resumeUrlRaw : null;
  const sweepMaxBefore = sweepMaxRaw && sweepMaxRaw.length > 0 ? sweepMaxRaw : null;

  let url: string | null = resumeUrl ?? LIKED_SONGS_URL;
  let totalInserted = 0;
  let totalSkipped = 0;
  let runMaxAddedAt: Date | null = null;
  let pagesFetched = 0;
  let cutoffHit = false;
  let lastPageNext: string | null = null;

  const allPages: Array<{ tracks: TrackRow[]; skipped: number }> = [];

  while (url !== null && pagesFetched < maxPages && !cutoffHit) {
    const page = await fetchPage(env, url);
    pagesFetched++;
    lastPageNext = page.next;

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
        cutoffHit = true;
        break;
      }

      tracksForPage.push(toTrackRow(item));

      if (runMaxAddedAt === null || addedAt > runMaxAddedAt) {
        runMaxAddedAt = addedAt;
      }
    }

    allPages.push({ tracks: tracksForPage, skipped: skippedOnPage });
    if (cutoffHit) break;
    url = page.next;
  }

  // Determine sweep state after this invocation.
  // Sweep completes when (a) we hit the cursor cutoff, or (b) Spotify returned
  // page.next === null on the last fetched page. Otherwise we voluntarily
  // stopped mid-sweep (maxPages budget) — persist the next URL for resumption.
  const sweepComplete = cutoffHit || lastPageNext === null;
  const newResumeUrl = sweepComplete ? "" : (lastPageNext ?? "");

  // sweep_max accumulates across invocations of one sweep. The cursor only
  // advances when the sweep completes.
  let newSweepMax: string;
  if (runMaxAddedAt === null) {
    newSweepMax = sweepMaxBefore ?? "";
  } else if (sweepMaxBefore === null) {
    newSweepMax = runMaxAddedAt.toISOString();
  } else {
    const prev = new Date(sweepMaxBefore);
    newSweepMax = runMaxAddedAt > prev ? runMaxAddedAt.toISOString() : sweepMaxBefore;
  }

  const newCursor = sweepComplete && newSweepMax.length > 0 ? newSweepMax : cursor;
  // After sweep completes, clear sweep_max so the next sweep starts fresh.
  const newSweepMaxToPersist = sweepComplete ? "" : newSweepMax;

  // Persist all pages. The last page of this invocation's inserts are atomic
  // with the sync_state writes (I-005).
  for (let i = 0; i < allPages.length; i++) {
    const { tracks, skipped } = allPages[i];
    const isLastPage = i === allPages.length - 1;
    let inserted: number;

    if (isLastPage) {
      const results = await db.transaction((txSql) => [
        ...buildUpsertQueries(txSql, tracks),
        buildCursorQuery(txSql, CURSOR_KEY, newCursor),
        buildCursorQuery(txSql, RESUME_URL_KEY, newResumeUrl),
        buildCursorQuery(txSql, SWEEP_MAX_KEY, newSweepMaxToPersist),
      ]);
      const upsertResults = results.slice(0, tracks.length);
      inserted = upsertResults.filter((r) => (r as Record<string, unknown>[]).length > 0).length;
    } else if (tracks.length > 0) {
      // One batched transaction per page (one Neon subrequest). Per-row
      // upserts cost one subrequest each — a full 50-track page alone would
      // consume the free tier's entire 50-subrequest budget.
      const results = await db.transaction((txSql) => buildUpsertQueries(txSql, tracks));
      inserted = results.filter((r) => (r as Record<string, unknown>[]).length > 0).length;
    } else {
      inserted = 0;
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
    morePagesPending: !sweepComplete,
  };
}
