// F-030 task 2.3: generic Spotify playlist-track page reader for the copy
// engine's fetch phase (spotify_to_tidal direction). Phase 1 exported
// listOwnPlaylists (browse) and playlist-write.ts (create/add) but no
// "read an arbitrary playlist's tracks" reader — src/providers/spotify/
// playlists.ts's fetchPlaylistTracks is coupled to the sync engine's own
// tracks/playlist_membership tables and DB cursor state, not reusable here.
// This module reuses the same verified endpoint contract already used (and
// cited) in that file: GET /v1/playlists/{id}/tracks, Spotify's standard
// paging envelope (`items[]` + `next`).

import type { Env } from "../env";
import { spotifyFetch } from "../providers/spotify/oauth";

// Verified: 2026-07-18 against the same endpoint/shape already used and
// cited in src/providers/spotify/playlists.ts
// (SPOTIFY_PLAYLIST_TRACKS_URL_TEMPLATE, "Verified: 2026-05-09"). Page size
// 50 mirrors design.md D6's fetch-phase budget ("50 Spotify ... items").
const PAGE_LIMIT = 50;

interface SpotifySourceTrack {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album?: { name: string };
  duration_ms?: number;
  external_ids?: { isrc?: string };
  type: string;
  is_local: boolean;
}

interface SpotifySourcePageItem {
  track: SpotifySourceTrack | null;
}

interface SpotifyTracksResponse {
  items: SpotifySourcePageItem[];
  next: string | null;
}

export interface SpotifySourceItem {
  id: string;
  isrc: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  duration_ms: number | null;
}

export interface SpotifySourcePage {
  items: SpotifySourceItem[];
  hasMore: boolean;
  cursor: string | null;
}

function shouldSkip(item: SpotifySourcePageItem): boolean {
  if (!item.track) return true;
  if (item.track.is_local === true) return true;
  if (item.track.type !== "track") return true;
  return false;
}

function toSourceItem(item: SpotifySourcePageItem): SpotifySourceItem {
  const t = item.track!;
  return {
    id: t.id,
    isrc: t.external_ids?.isrc ?? null,
    title: t.name,
    artist: t.artists[0]?.name ?? null,
    album: t.album?.name ?? null,
    duration_ms: t.duration_ms ?? null,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(env: Env, url: string): Promise<SpotifyTracksResponse> {
  const response = await spotifyFetch(env, url);

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "1", 10);
    await sleep(retryAfter * 1000);

    const retry = await spotifyFetch(env, url);
    if (retry.status === 429) {
      throw new Error("Spotify rate limit: second 429 received while fetching source playlist");
    }
    if (!retry.ok) throw new Error(`Spotify API error on retry: ${retry.status}`);
    return retry.json() as Promise<SpotifyTracksResponse>;
  }

  if (!response.ok) throw new Error(`Spotify API error: ${response.status}`);
  return response.json() as Promise<SpotifyTracksResponse>;
}

/**
 * Fetch one page of a Spotify playlist's tracks for the copy engine's fetch
 * phase. `cursor` is the opaque `next` URL from the previous page (or null
 * for the first page) — stored verbatim in copy_jobs.fetch_cursor.
 */
export async function getSpotifyPlaylistItems(
  env: Env,
  playlistId: string,
  cursor: string | null,
): Promise<SpotifySourcePage> {
  const url =
    cursor ??
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${PAGE_LIMIT}`;
  const page = await fetchPage(env, url);
  const items = page.items.filter((i) => !shouldSkip(i)).map(toSourceItem);
  return { items, hasMore: page.next !== null, cursor: page.next };
}
