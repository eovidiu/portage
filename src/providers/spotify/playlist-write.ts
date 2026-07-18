// F-030 task 1.7: Spotify playlist write client (create + add items).
//
// Grounded against developer.spotify.com Web API reference (full citations in
// the F-030 grounding notes):
//   - Create: POST /v1/me/playlists — resolves the owner from the access
//     token; the legacy POST /users/{user_id}/playlists form is NOT used.
//   - Add items: POST /v1/playlists/{playlist_id}/items — the deprecated
//     POST /playlists/{playlist_id}/tracks path is NOT used. Max 100 URIs per
//     request; the copy engine (D6) caps batches at 50, enforced here.
//   - 429 handling: honor Retry-After once; a second 429 is reported back to
//     the caller instead of thrown, so the copy engine can leave the batch
//     `pending` for a later tick without failing the job.

import type { Env } from "../../env";
import { spotifyFetch } from "./oauth";

const SPOTIFY_ME_PLAYLISTS_URL = "https://api.spotify.com/v1/me/playlists";
const SPOTIFY_PLAYLISTS_URL = "https://api.spotify.com/v1/playlists";
const JSON_HEADERS = { "Content-Type": "application/json" };
const MAX_ADD_ITEMS_BATCH = 50;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CreatePlaylistResponse {
  id: string;
}

/** Create a private Spotify playlist for the current user. Returns its id. */
export async function createPlaylist(env: Env, name: string): Promise<string> {
  const response = await spotifyFetch(env, SPOTIFY_ME_PLAYLISTS_URL, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, public: false }),
  });

  if (!response.ok) {
    throw new Error(`createPlaylist failed: HTTP ${response.status}`);
  }

  const json = (await response.json()) as CreatePlaylistResponse;
  return json.id;
}

export interface AddItemsResult {
  added: number;
  snapshotId: string | null;
  rateLimited: boolean;
}

interface AddItemsResponse {
  snapshot_id: string;
}

async function interpretAddItemsResponse(
  response: Response,
  count: number,
): Promise<AddItemsResult> {
  if (!response.ok) {
    throw new Error(`addItems failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as AddItemsResponse;
  return { added: count, snapshotId: json.snapshot_id, rateLimited: false };
}

/**
 * Append tracks to a Spotify playlist in a single request (≤50 URIs — the
 * copy engine's D6 write-phase cap; Spotify itself allows up to 100).
 * Honors a 429 by waiting Retry-After and retrying once; a second 429
 * returns `rateLimited: true` rather than throwing, so the caller can leave
 * the batch for a later tick.
 */
export async function addItems(
  env: Env,
  playlistId: string,
  trackIds: string[],
): Promise<AddItemsResult> {
  if (trackIds.length > MAX_ADD_ITEMS_BATCH) {
    throw new Error(
      `addItems: batch of ${trackIds.length} exceeds the ${MAX_ADD_ITEMS_BATCH}-URI cap`,
    );
  }

  const uris = trackIds.map((id) => `spotify:track:${id}`);
  const url = `${SPOTIFY_PLAYLISTS_URL}/${playlistId}/items`;
  const body = JSON.stringify({ uris });

  const first = await spotifyFetch(env, url, { method: "POST", headers: JSON_HEADERS, body });

  if (first.status === 429) {
    const retryAfter = parseInt(first.headers.get("Retry-After") ?? "1", 10);
    await sleep(retryAfter * 1000);

    const second = await spotifyFetch(env, url, { method: "POST", headers: JSON_HEADERS, body });
    if (second.status === 429) {
      return { added: 0, snapshotId: null, rateLimited: true };
    }
    return interpretAddItemsResponse(second, uris.length);
  }

  return interpretAddItemsResponse(first, uris.length);
}
