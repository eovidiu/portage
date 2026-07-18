// F-030 tasks 2.5 + 3.2: destination-playlist track id reader, shared by the
// append-mode dedup snapshot (design.md D3, taken once at job creation) and
// the write phase's crash reconcile (D7, one page per tick — "a cheap,
// targeted check, not a full-playlist scan").

import type { Env } from "../env";
import { getPlaylistTracks } from "../providers/tidal/playlist";
import { getSpotifyPlaylistItems } from "./spotify-source";

export type DestProvider = "spotify" | "tidal";

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

/** Single-page read of the destination's current tail — the D7 reconcile check. */
export async function readDestTailIds(
  env: Env,
  provider: DestProvider,
  playlistId: string,
): Promise<Set<string>> {
  const page = await readOnePage(env, provider, playlistId, null);
  return new Set(page.ids);
}
