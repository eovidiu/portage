// F-030 tasks 2.5 + 3.2: destination-playlist track id reader, shared by the
// append-mode dedup snapshot (design.md D3, taken once at job creation) and
// the write phase's crash reconcile (D7, rewritten in the review B1 fix to a
// single item-count read instead of a first-page-only tail read).

import type { Env } from "../env";
import { getPlaylistTracks } from "../providers/tidal/playlist";
import { getSpotifyPlaylistItems } from "./spotify-source";
import { tidalFetch } from "../providers/tidal/client";
import { spotifyFetch } from "../providers/spotify/oauth";
import { playlistUrl } from "../providers/tidal/playlist-endpoints";

export type DestProvider = "spotify" | "tidal";

const SPOTIFY_PLAYLIST_URL = "https://api.spotify.com/v1/playlists";

async function readOnePage(
  env: Env,
  provider: DestProvider,
  playlistId: string,
  cursor: string | null,
): Promise<{ ids: string[]; hasMore: boolean; cursor: string | null }> {
  if (provider === "tidal") {
    const page = await getPlaylistTracks(env, playlistId, cursor);
    return { ids: page.trackIds, hasMore: page.hasMore, cursor: page.cursor };
  }
  const page = await getSpotifyPlaylistItems(env, playlistId, cursor);
  return { ids: page.items.map((i) => i.id), hasMore: page.hasMore, cursor: page.cursor };
}

export interface DestSnapshotResult {
  ids: string[];
  oversized: boolean;
}

/**
 * Paginates a destination playlist to completion, capped at `cap` ids —
 * design.md D3: "guard with a size cap and fail the job creation past
 * ~5000 ids". Stops fetching further pages as soon as the cap is exceeded.
 */
export async function snapshotDestTracks(
  env: Env,
  provider: DestProvider,
  playlistId: string,
  cap: number,
): Promise<DestSnapshotResult> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const page = await readOnePage(env, provider, playlistId, cursor);
    ids.push(...page.ids);
    if (ids.length > cap) return { ids, oversized: true };
    hasMore = page.hasMore;
    cursor = page.cursor;
  }

  return { ids, oversized: false };
}

interface TidalPlaylistResponse {
  data: { attributes: { numberOfItems?: number } };
}

interface SpotifyPlaylistTracksTotalResponse {
  tracks?: { total?: number };
}

/**
 * Reads the destination playlist's current item count — the B1 count-based
 * write-phase crash reconcile (design.md D7). One subrequest; replaces the
 * old first-page-only tail read, which was blind to a crashed write batch
 * once a multi-page destination advanced past page 1.
 *
 * Tidal: GET /v2/playlists/{id} -> attributes.numberOfItems.
 *   Verified: 2026-07-18 against openapi-types.ts:20558-20601
 *   (Playlists_Attributes.numberOfItems?: number).
 * Spotify: GET /v1/playlists/{id}?fields=tracks.total -> tracks.total.
 *   Verified: 2026-07-18 against the same tracks.total shape already used in
 *   src/providers/spotify/playlists.ts's MePlaylistsResponse.
 */
export async function readDestItemCount(
  env: Env,
  provider: DestProvider,
  playlistId: string,
): Promise<number> {
  if (provider === "tidal") {
    const response = await tidalFetch(env, playlistUrl(playlistId));
    if (!response.ok) throw new Error(`readDestItemCount failed: HTTP ${response.status}`);
    const json = (await response.json()) as TidalPlaylistResponse;
    return json.data.attributes.numberOfItems ?? 0;
  }

  const url = `${SPOTIFY_PLAYLIST_URL}/${encodeURIComponent(playlistId)}?fields=tracks.total`;
  const response = await spotifyFetch(env, url);
  if (!response.ok) throw new Error(`readDestItemCount failed: HTTP ${response.status}`);
  const json = (await response.json()) as SpotifyPlaylistTracksTotalResponse;
  return json.tracks?.total ?? 0;
}
