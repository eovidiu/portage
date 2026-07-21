import type { Env } from "../../env";
import { tidalFetch } from "./client";
import { playlistTracksUrl, TIDAL_TRACKS_URL } from "./playlist-endpoints";
import {
  parseIsoDurationMs,
  buildIncludedIndex,
  lookupIncluded,
  type JsonApiResource,
} from "../../match/json-api";

export interface PlaylistItem {
  tidalId: string;
  isrc: string | null;
  title: string | null;
  durationMs: number | null;
}

export interface PlaylistItemsPage {
  items: PlaylistItem[];
  hasMore: boolean;
  cursor: string | null;
}

interface ItemsResponse {
  data?: Array<{ id: string; type: string }>;
  included?: JsonApiResource[];
  links?: { meta?: { nextCursor?: string } };
}

/**
 * Fetch one page of playlist items with track attributes (isrc/title/
 * durationMs), needed for the Tidal->Spotify copy direction.
 * `getPlaylistTracks` (playlist.ts) only extracts bare track ids for the
 * existing Spotify->Tidal dedup check; this reader is separate because it
 * resolves the full `included[]` track resource per item.
 *
 * Artist linkage is NOT available here: the endpoint's `include` supports
 * only `items` (openapi-types.ts:8107-8119 — no `items.artists`), and live
 * responses (verified 2026-07-21) return included[] track resources with no
 * `relationships` key at all. Use `resolveTrackArtists` for artist names.
 *
 * Verified: 2026-07-18 against openapi-types.ts:8093-8149 (path) and
 * :20603-20625 (Playlists_Items_Multi_Relationship_Data_Document — data[] is
 * bare resource identifiers; included[] carries the full track resource when
 * `include=items` is set) and :21829-21903 (Tracks_Attributes — isrc, title,
 * duration all required; duration is ISO-8601, e.g. "PT2M58S").
 */
export async function getPlaylistItems(
  env: Env,
  playlistId: string,
  cursor: string | null = null,
): Promise<PlaylistItemsPage> {
  let url = `${playlistTracksUrl(playlistId)}?include=items`;
  if (cursor) url += `&page[cursor]=${encodeURIComponent(cursor)}`;
  const response = await tidalFetch(env, url);
  if (!response.ok) {
    throw new Error(`getPlaylistItems failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as ItemsResponse;
  const index = buildIncludedIndex(json.included);
  const items = (json.data ?? []).map((ref) => _toPlaylistItem(ref, index));
  const nextCursor = json.links?.meta?.nextCursor ?? null;
  return { items, hasMore: nextCursor !== null, cursor: nextCursor };
}

function _toPlaylistItem(
  ref: { id: string; type: string },
  index: ReturnType<typeof buildIncludedIndex>,
): PlaylistItem {
  const attrs = lookupIncluded(index, "tracks", ref.id)?.attributes;
  return {
    tidalId: ref.id,
    isrc: typeof attrs?.isrc === "string" ? attrs.isrc : null,
    title: typeof attrs?.title === "string" ? attrs.title : null,
    durationMs: parseIsoDurationMs(attrs?.duration),
  };
}

// URL-length-safe batch for repeated filter[id] params; matches the observed
// playlist-items page size (20), so one fetch page resolves in one batch.
// The OAS puts no maxItems on /tracks filter[id] — conservative choice.
const TRACK_BATCH_SIZE = 20;

interface TracksBatchResponse {
  data?: JsonApiResource[];
  included?: JsonApiResource[];
}

/**
 * Resolve primary-artist display names for a set of Tidal track ids, batched
 * via `GET /tracks?filter[id]=…&include=artists`. This is the only way to get
 * artist linkage for playlist items — see `getPlaylistItems`.
 *
 * Verified: 2026-07-21 against openapi-types.ts:11508 (path /tracks GET —
 * `filter[id]` is array(string) → repeated params, `include` supports
 * artists) and :21916 (Tracks_Relationships.artists) and :18788-18820
 * (Artists_Attributes.name), and live: data[] carries
 * relationships.artists.data and included[] the full artists resources,
 * de-duplicated when tracks share an artist.
 */
export async function resolveTrackArtists(
  env: Env,
  trackIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const uniqueIds = Array.from(new Set(trackIds));
  for (let i = 0; i < uniqueIds.length; i += TRACK_BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + TRACK_BATCH_SIZE);
    await _resolveTrackArtistBatch(env, batch, names);
  }
  return names;
}

async function _resolveTrackArtistBatch(
  env: Env,
  batch: string[],
  names: Map<string, string>,
): Promise<void> {
  const params = batch.map((id) => `filter[id]=${encodeURIComponent(id)}`).join("&");
  const response = await tidalFetch(env, `${TIDAL_TRACKS_URL}?${params}&include=artists`);
  if (!response.ok) {
    throw new Error(`resolveTrackArtists failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as TracksBatchResponse;
  const index = buildIncludedIndex(json.included);
  for (const track of json.data ?? []) {
    const artistsData = track.relationships?.artists?.data;
    const firstRef = Array.isArray(artistsData) ? artistsData[0] : undefined;
    const artist = firstRef ? lookupIncluded(index, "artists", firstRef.id) : undefined;
    const name = artist?.attributes?.name;
    if (typeof name === "string") {
      names.set(track.id, name);
    }
  }
}
