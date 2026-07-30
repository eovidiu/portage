// F-016: Spotify playlist name lookup. Used by the seeder when adding a new
// extra playlist to the registry.
// F-017: Multi-playlist track fetch. Mirrors fetchLikedSongs from liked.ts but
// for /v1/playlists/{id}/tracks. Per-playlist cursor state via keyForPlaylist.
// playlist_membership rows piggyback on the page transaction (extended I-005).

import { neon } from "@neondatabase/serverless";
import { spotifyFetch } from "./oauth";
import { buildUpsertQueries, type TrackRow } from "../../db/tracks";
import { retryAfterMs, MAX_RETRY_AFTER_S } from "../retry-after";
import {
  buildMembershipUpsertQueries,
  type PlaylistMembershipRow,
} from "../../db/playlist_membership";
import {
  readCursor,
  readState,
  buildCursorQuery,
  keyForPlaylist,
} from "../../db/sync_state";
import type { Env } from "../../env";

// Path /v1/playlists/{playlist_id} with optional ?fields= projection.
// Verified: 2026-05-08 against https://developer.spotify.com/documentation/web-api/reference/get-playlist
const SPOTIFY_PLAYLIST_URL = "https://api.spotify.com/v1/playlists/";

// Path /v1/playlists/{playlist_id}/tracks. 50-item page size, follow next URL for pagination.
// Verified: 2026-05-09 against https://developer.spotify.com/documentation/web-api/reference/get-playlists-tracks
const SPOTIFY_PLAYLIST_TRACKS_URL_TEMPLATE = (id: string) =>
  `https://api.spotify.com/v1/playlists/${id}/tracks?limit=50`;

// Path /v1/me/playlists. Limit max 50 (Spotify caps this endpoint below the
// usual 100), offset paging. Uses the standard Spotify Paging Object envelope
// (href, items[], limit, next, offset, previous, total) also seen on the
// playlist-tracks endpoint above.
// Verified: 2026-07-18 against https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists
const SPOTIFY_ME_PLAYLISTS_URL = "https://api.spotify.com/v1/me/playlists";
const ME_PLAYLISTS_PAGE_LIMIT = 50;

const CLOCK_SKEW_MS = 60_000;

interface PlaylistNameResponse {
  name?: string;
}

// F-016-R4 + R7: fetch the Spotify playlist name. On non-OK response, throws
// an Error whose message includes the status. On empty/missing name, falls
// back to a deterministic synthetic ('Spotify Playlist {id}').
export async function fetchSpotifyPlaylistName(
  env: Env,
  spotifyPlaylistId: string,
): Promise<string> {
  const url = `${SPOTIFY_PLAYLIST_URL}${encodeURIComponent(spotifyPlaylistId)}?fields=name`;
  const response = await spotifyFetch(env, url);

  if (!response.ok) {
    throw new Error(
      `Spotify playlist name fetch failed: ${response.status} for ${spotifyPlaylistId}`,
    );
  }

  const data = (await response.json()) as PlaylistNameResponse;
  const name = data.name;
  if (typeof name !== "string" || name.length === 0) {
    return `Spotify Playlist ${spotifyPlaylistId}`;
  }
  return name;
}

// =============================================================================
// fetchPlaylistTracks (F-017)
// =============================================================================

interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album?: { name: string };
  duration_ms?: number;
  external_ids?: { isrc?: string };
  type: string;
  is_local: boolean;
}

interface PlaylistPageItem {
  added_at: string;
  track: SpotifyTrack | null;
}

interface PlaylistTracksPage {
  items: PlaylistPageItem[];
  next: string | null;
}

export interface FetchResult {
  pagesProcessed: number;
  tracksInserted: number;
  tracksSkipped: number;
  morePagesPending: boolean;
}

async function fetchPlaylistPage(env: Env, url: string): Promise<PlaylistTracksPage> {
  // F-017-R4: spotifyFetch handles 401-coalesced refresh + retry.
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
    return retryResponse.json() as Promise<PlaylistTracksPage>;
  }

  if (!response.ok) {
    throw new Error(`Spotify API error: ${response.status}`);
  }

  return response.json() as Promise<PlaylistTracksPage>;
}

// F-017-R7: skip null track (catalog removal), local uploads, non-track items.
function shouldSkip(item: PlaylistPageItem): boolean {
  if (!item.track) return true;
  if (item.track.is_local === true) return true;
  if (item.track.type !== "track") return true;
  return false;
}

function toTrackRow(item: PlaylistPageItem): TrackRow {
  const t = item.track!;
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

// F-017: fetch a Spotify playlist's tracks with bounded pagination + per-playlist
// cursor state. Returns when (a) cursor cutoff hit, (b) page.next === null, or
// (c) maxPages exhausted. On (c), persists resume_url for the next invocation.
export async function fetchPlaylistTracks(
  env: Env,
  spotifyPlaylistId: string,
  maxPages: number = Number.POSITIVE_INFINITY,
): Promise<FetchResult> {
  const cursorKey = keyForPlaylist("cursor", spotifyPlaylistId);
  const resumeKey = keyForPlaylist("resume_url", spotifyPlaylistId);
  const sweepMaxKey = keyForPlaylist("sweep_max", spotifyPlaylistId);

  const cursor = await readCursor(env, cursorKey);
  const cutoff = new Date(new Date(cursor).getTime() - CLOCK_SKEW_MS);

  const db = neon(env.DATABASE_URL);
  const resumeUrlRaw = await readState(db, resumeKey);
  const sweepMaxRaw = await readState(db, sweepMaxKey);
  const resumeUrl = resumeUrlRaw && resumeUrlRaw.length > 0 ? resumeUrlRaw : null;
  const sweepMaxBefore = sweepMaxRaw && sweepMaxRaw.length > 0 ? sweepMaxRaw : null;

  const defaultUrl = SPOTIFY_PLAYLIST_TRACKS_URL_TEMPLATE(spotifyPlaylistId);
  let url: string | null = resumeUrl ?? defaultUrl;
  let totalInserted = 0;
  let totalSkipped = 0;
  let runMaxAddedAt: Date | null = null;
  let pagesFetched = 0;
  let cutoffHit = false;
  let lastPageNext: string | null = null;

  const allPages: Array<{
    tracks: TrackRow[];
    memberships: PlaylistMembershipRow[];
    skipped: number;
  }> = [];

  while (url !== null && pagesFetched < maxPages && !cutoffHit) {
    const page = await fetchPlaylistPage(env, url);
    pagesFetched++;
    lastPageNext = page.next;

    const tracksForPage: TrackRow[] = [];
    const membershipForPage: PlaylistMembershipRow[] = [];
    let skippedOnPage = 0;

    for (const item of page.items) {
      if (shouldSkip(item)) {
        skippedOnPage++;
        continue;
      }

      const addedAt = new Date(item.added_at);
      if (addedAt <= cutoff) {
        cutoffHit = true;
        break;
      }

      tracksForPage.push(toTrackRow(item));
      membershipForPage.push({
        spotify_playlist_id: spotifyPlaylistId,
        spotify_track_id: item.track!.id,
        added_at: item.added_at,
      });

      if (runMaxAddedAt === null || addedAt > runMaxAddedAt) {
        runMaxAddedAt = addedAt;
      }
    }

    allPages.push({
      tracks: tracksForPage,
      memberships: membershipForPage,
      skipped: skippedOnPage,
    });
    if (cutoffHit) break;
    url = page.next;
  }

  // Sweep state: completes when we hit cursor cutoff or Spotify says no more pages.
  // Otherwise we voluntarily stopped (maxPages budget) — persist resume URL.
  const sweepComplete = cutoffHit || lastPageNext === null;
  const newResumeUrl = sweepComplete ? "" : (lastPageNext ?? "");

  // sweep_max accumulates across mid-sweep invocations of one sweep. Cursor
  // only advances when the sweep completes.
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
  const newSweepMaxToPersist = sweepComplete ? "" : newSweepMax;

  // Persist all pages. Last page's transaction is atomic with the sync_state
  // writes (extended I-005: tracks + membership + cursor advance together).
  for (let i = 0; i < allPages.length; i++) {
    const { tracks, memberships, skipped } = allPages[i];
    const isLastPage = i === allPages.length - 1;
    let inserted: number;

    if (isLastPage) {
      const results = await db.transaction((txSql) => [
        ...buildUpsertQueries(txSql, tracks),
        ...buildMembershipUpsertQueries(txSql, memberships),
        buildCursorQuery(txSql, cursorKey, newCursor),
        buildCursorQuery(txSql, resumeKey, newResumeUrl),
        buildCursorQuery(txSql, sweepMaxKey, newSweepMaxToPersist),
      ]);
      const upsertResults = results.slice(0, tracks.length);
      inserted = upsertResults.filter(
        (r) => (r as Record<string, unknown>[]).length > 0,
      ).length;
    } else if (tracks.length + memberships.length > 0) {
      // Non-last pages persist tracks + memberships in ONE batched transaction
      // (one Neon subrequest) — still outside the cursor transaction, and
      // idempotent ON CONFLICT DO NOTHING means re-fetch on retry doesn't
      // duplicate. Per-row upserts cost one subrequest each — a full 50-track
      // page alone would consume the free tier's entire 50-subrequest budget.
      const results = await db.transaction((txSql) => [
        ...buildUpsertQueries(txSql, tracks),
        ...buildMembershipUpsertQueries(txSql, memberships),
      ]);
      inserted = results
        .slice(0, tracks.length)
        .filter((r) => (r as Record<string, unknown>[]).length > 0).length;
    } else {
      inserted = 0;
    }

    totalInserted += inserted;
    totalSkipped += skipped;

    console.log(
      JSON.stringify({
        event: "fetch_page",
        playlist_id: spotifyPlaylistId,
        page_index: i,
        items_seen: tracks.length + skipped,
        items_persisted: inserted,
        items_skipped: skipped,
      }),
    );
  }

  return {
    pagesProcessed: allPages.length,
    tracksInserted: totalInserted,
    tracksSkipped: totalSkipped,
    morePagesPending: !sweepComplete,
  };
}

// =============================================================================
// listOwnPlaylists (F-030 task 1.6)
// =============================================================================

export interface SpotifyOwnPlaylist {
  id: string;
  name: string;
  trackCount: number;
}

export interface ListOwnPlaylistsResult {
  playlists: SpotifyOwnPlaylist[];
  nextOffset: number | null;
}

interface MePlaylistsResponse {
  items: Array<{ id: string; name: string; tracks?: { total?: number } }>;
  next: string | null;
}

async function fetchMePlaylistsPage(env: Env, url: string): Promise<MePlaylistsResponse> {
  const response = await spotifyFetch(env, url);

  if (response.status === 429) {
    const backoffMs = retryAfterMs(response.headers.get("Retry-After"));
    if (backoffMs === null) {
      throw new Error(
        `Spotify rate limit: Retry-After exceeds the ${MAX_RETRY_AFTER_S}s cap, aborting playlist list`,
      );
    }
    await new Promise((r) => setTimeout(r, backoffMs));

    const retryResponse = await spotifyFetch(env, url);
    if (retryResponse.status === 429) {
      throw new Error("Spotify rate limit: second 429 received, aborting playlist list");
    }
    if (!retryResponse.ok) {
      throw new Error(`Spotify API error on retry: ${retryResponse.status}`);
    }
    return retryResponse.json() as Promise<MePlaylistsResponse>;
  }

  if (!response.ok) {
    throw new Error(`Spotify API error: ${response.status}`);
  }

  return response.json() as Promise<MePlaylistsResponse>;
}

// F-030 task 1.6: list the operator's own Spotify playlists, offset-paginated.
// `nextOffset` mirrors the page envelope's `next` field so callers can page
// without re-deriving state from `total` (which can go stale mid-listing).
export async function listOwnPlaylists(
  env: Env,
  offset: number = 0,
): Promise<ListOwnPlaylistsResult> {
  const url = `${SPOTIFY_ME_PLAYLISTS_URL}?limit=${ME_PLAYLISTS_PAGE_LIMIT}&offset=${offset}`;
  const page = await fetchMePlaylistsPage(env, url);

  const playlists = page.items.map((item) => ({
    id: item.id,
    name: item.name,
    trackCount: item.tracks?.total ?? 0,
  }));

  const nextOffset = page.next !== null ? offset + ME_PLAYLISTS_PAGE_LIMIT : null;

  return { playlists, nextOffset };
}
