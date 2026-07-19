// F-030 tasks 3.1-3.2: shared validation helpers for the /api/copy routes.

import type { Env } from "../../env";
import type { CopyDirection } from "../../db/copy_jobs";
import { listOwnPlaylists as listTidalOwnPlaylists } from "../../providers/tidal/own-playlists";
import { getPlaylist } from "../../providers/tidal/playlist";
import {
  listOwnPlaylists as listSpotifyOwnPlaylists,
  fetchSpotifyPlaylistName,
} from "../../providers/spotify/playlists";

export type CopyProvider = "spotify" | "tidal";

// Bounds the ownership-check pagination walk — generous for any realistic
// operator library (100 pages x ~50/page = 5000 playlists).
const MAX_OWNERSHIP_PAGES = 100;

export function directionFor(sourceProvider: CopyProvider): CopyDirection {
  return sourceProvider === "spotify" ? "spotify_to_tidal" : "tidal_to_spotify";
}

export function destProviderFor(sourceProvider: CopyProvider): CopyProvider {
  return sourceProvider === "spotify" ? "tidal" : "spotify";
}

/** Walks the operator's own-playlists listing to confirm ownership of `playlistId`. */
export async function findOwnPlaylist(
  env: Env,
  provider: CopyProvider,
  playlistId: string,
): Promise<boolean> {
  if (provider === "tidal") {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_OWNERSHIP_PAGES; page++) {
      const result = await listTidalOwnPlaylists(env, cursor);
      if (result.playlists.some((p) => p.id === playlistId)) return true;
      if (!result.hasMore) return false;
      cursor = result.cursor;
    }
    return false;
  }

  let offset = 0;
  for (let page = 0; page < MAX_OWNERSHIP_PAGES; page++) {
    const result = await listSpotifyOwnPlaylists(env, offset);
    if (result.playlists.some((p) => p.id === playlistId)) return true;
    if (result.nextOffset === null) return false;
    offset = result.nextOffset;
  }
  return false;
}

/** Resolves a source playlist's display name; null when unknown/unreachable. */
export async function resolveSourceName(
  env: Env,
  provider: CopyProvider,
  playlistId: string,
): Promise<string | null> {
  if (provider === "tidal") {
    const playlist = await getPlaylist(env, playlistId);
    return playlist?.name ?? null;
  }
  try {
    return await fetchSpotifyPlaylistName(env, playlistId);
  } catch {
    return null;
  }
}
