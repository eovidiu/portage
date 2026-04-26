import type { Env } from "../../env";
import { tidalFetch } from "./client";
import {
  BATCH_SIZE,
  PLAYLIST_PRIVACY,
  TIDAL_PLAYLISTS_URL,
  playlistUrl,
  playlistTracksUrl,
} from "./playlist-endpoints";

export interface TidalPlaylist {
  id: string;
  title: string;
}

export interface PlaylistTracksPage {
  trackIds: string[];
  hasMore: boolean;
  cursor: string | null;
}

const PLAYLIST_DESCRIPTION =
  "Synced from Spotify by spotify-roon-sync. Do not edit manually.";

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Create a new Tidal playlist. Returns the created playlist id. */
export async function createPlaylist(env: Env, title: string): Promise<string> {
  const body = JSON.stringify({
    data: {
      type: "playlists",
      attributes: {
        title,
        description: PLAYLIST_DESCRIPTION,
        privacy: PLAYLIST_PRIVACY,
      },
    },
  });
  const response = await tidalFetch(env, TIDAL_PLAYLISTS_URL, {
    method: "POST",
    body,
  });
  if (!response.ok) {
    throw new Error(`createPlaylist failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as { data: { id: string } };
  return json.data.id;
}

/** Fetch a playlist by id. Returns null if 404/403. */
export async function getPlaylist(
  env: Env,
  playlistId: string,
): Promise<TidalPlaylist | null> {
  const response = await tidalFetch(env, playlistUrl(playlistId));
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) {
    throw new Error(`getPlaylist failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as {
    data: { id: string; attributes: { title: string } };
  };
  return { id: json.data.id, title: json.data.attributes.title };
}

/** Fetch one page of playlist track ids. */
export async function getPlaylistTracks(
  env: Env,
  playlistId: string,
  cursor: string | null = null,
): Promise<PlaylistTracksPage> {
  let url = `${playlistTracksUrl(playlistId)}?include=items&limit=100`;
  if (cursor) url += `&page[cursor]=${encodeURIComponent(cursor)}`;
  const response = await tidalFetch(env, url);
  if (!response.ok) {
    throw new Error(`getPlaylistTracks failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as {
    data?: Array<{ id: string }>;
    included?: Array<{ id: string }>;
    meta?: { cursor?: string };
    links?: { next?: string };
  };
  const items = json.included ?? json.data ?? [];
  const trackIds = items.map((i) => i.id);
  const nextCursor = json.meta?.cursor ?? null;
  const hasMore = nextCursor !== null || (json.links?.next !== undefined);
  return { trackIds, hasMore, cursor: nextCursor };
}

/** Fetch all track ids currently in the playlist (handles pagination). */
export async function getAllPlaylistTrackIds(
  env: Env,
  playlistId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  let hasMore = true;
  while (hasMore) {
    const page = await getPlaylistTracks(env, playlistId, cursor);
    for (const id of page.trackIds) ids.add(id);
    hasMore = page.hasMore;
    cursor = page.cursor;
  }
  return ids;
}

export interface AddTracksResult {
  added: number;
  invalidIds: string[];
  errors: number;
}

/**
 * Append trackIds to playlist in batches of BATCH_SIZE.
 * Handles 429 inline (Retry-After once; second 429 aborts batch).
 * Handles invalid-track errors per batch item.
 * Returns counts of added, invalid, and errored tracks.
 */
export async function addTracksToPlaylist(
  env: Env,
  playlistId: string,
  trackIds: string[],
): Promise<AddTracksResult> {
  let added = 0;
  const invalidIds: string[] = [];
  let errors = 0;

  for (let i = 0; i < trackIds.length; i += BATCH_SIZE) {
    const batch = trackIds.slice(i, i + BATCH_SIZE);
    const result = await _addBatch(env, playlistId, batch);
    added += result.added;
    invalidIds.push(...result.invalidIds);
    errors += result.errors;
    if (result.aborted) {
      // 429 after retry: count remaining tracks as errors (Math.max guards partial last batch)
      errors += Math.max(0, trackIds.length - i - BATCH_SIZE);
      break;
    }
  }

  return { added, invalidIds, errors };
}

interface BatchResult {
  added: number;
  invalidIds: string[];
  errors: number;
  aborted: boolean;
}

async function _addBatch(
  env: Env,
  playlistId: string,
  batch: string[],
): Promise<BatchResult> {
  const body = JSON.stringify({
    data: batch.map((id) => ({ type: "tracks", id })),
  });

  const first = await tidalFetch(env, playlistTracksUrl(playlistId), {
    method: "POST",
    body,
  });

  if (first.status === 429) {
    const retryAfter = parseInt(first.headers.get("Retry-After") ?? "1", 10);
    await sleep(retryAfter * 1000);
    const second = await tidalFetch(env, playlistTracksUrl(playlistId), {
      method: "POST",
      body,
    });
    if (second.status === 429) {
      return { added: 0, invalidIds: [], errors: batch.length, aborted: true };
    }
    return _interpretBatchResponse(second, batch);
  }

  return _interpretBatchResponse(first, batch);
}

async function _interpretBatchResponse(
  response: Response,
  batch: string[],
): Promise<BatchResult> {
  if (response.ok) {
    return { added: batch.length, invalidIds: [], errors: 0, aborted: false };
  }

  // Check for invalid-track error (400 or 422 with error details)
  if (response.status === 400 || response.status === 422) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { added: 0, invalidIds: [], errors: batch.length, aborted: false };
    }
    const invalid = _extractInvalidIds(body, batch);
    if (invalid.length > 0) {
      return {
        added: batch.length - invalid.length,
        invalidIds: invalid,
        errors: 0,
        aborted: false,
      };
    }
  }

  return { added: 0, invalidIds: [], errors: batch.length, aborted: false };
}

/** Parse Tidal error body for invalid/unavailable track ids. */
function _extractInvalidIds(body: unknown, batch: string[]): string[] {
  if (typeof body !== "object" || body === null) return [];
  const errors = (body as Record<string, unknown>).errors;
  if (!Array.isArray(errors)) return [];
  const invalid: string[] = [];
  for (const err of errors) {
    if (typeof err !== "object" || err === null) continue;
    const source = (err as Record<string, unknown>).source;
    if (typeof source === "object" && source !== null) {
      const pointer = (source as Record<string, unknown>).pointer;
      if (typeof pointer === "string") {
        // pointer like "/data/2/id" → index 2
        const match = pointer.match(/\/data\/(\d+)/);
        if (match) {
          const idx = parseInt(match[1], 10);
          if (idx >= 0 && idx < batch.length) invalid.push(batch[idx]);
        }
      }
    }
    // Also handle simple id-keyed errors
    const id = (err as Record<string, unknown>).id;
    if (typeof id === "string" && batch.includes(id) && !invalid.includes(id)) {
      invalid.push(id);
    }
  }
  return invalid;
}
