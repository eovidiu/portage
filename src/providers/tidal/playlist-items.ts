import type { Env } from "../../env";
import { tidalFetch } from "./client";
import { playlistTracksUrl, TIDAL_ARTISTS_URL } from "./playlist-endpoints";
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
  artistIds: string[];
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
 * durationMs) and artist ids, needed for the Tidal->Spotify copy direction.
 * `getPlaylistTracks` (playlist.ts) only extracts bare track ids for the
 * existing Spotify->Tidal dedup check; this reader is separate because it
 * resolves the full `included[]` track resource per item.
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
  const track = lookupIncluded(index, "tracks", ref.id);
  const attrs = track?.attributes;
  // Tracks_Relationships.artists is a Multi_Relationship_Data_Document
  // (openapi-types.ts:21916) — `data` is always an array or absent, never a
  // bare object, so no single-object fallback is needed here.
  const artistsData = track?.relationships?.artists?.data;
  const artistRefs = Array.isArray(artistsData) ? artistsData : [];
  return {
    tidalId: ref.id,
    isrc: typeof attrs?.isrc === "string" ? attrs.isrc : null,
    title: typeof attrs?.title === "string" ? attrs.title : null,
    durationMs: parseIsoDurationMs(attrs?.duration),
    artistIds: artistRefs.map((a) => a.id),
  };
}

// No documented cap on `filter[id]` array length for GET /artists (raw OAS
// schema: `{ type: array, items: { type: string } }`, no maxItems). This
// batch size is a conservative, NOT OAS-grounded choice — unlike BATCH_SIZE
// (playlist add-tracks, capped at 20 by the OAS's maxItems).
const ARTIST_BATCH_SIZE = 50;

interface ArtistsResponse {
  data?: Array<{ id: string; attributes?: { name?: string } }>;
}

/**
 * Resolve artist display names for a set of Tidal artist ids, batched via
 * `GET /artists?filter[id]=`. Artist names are NOT embedded in a track's
 * `included[]` resource (Tracks_Relationships.artists is identifiers only),
 * so this is always a separate round trip.
 *
 * Verified: 2026-07-18 against openapi-types.ts:2428 (path /artists) and
 * :18888-18892 (Artists_Multi_Resource_Data_Document — full attributes in
 * data[], no further include needed) and :18788-18820 (Artists_Attributes.name).
 */
export async function resolveArtistNames(
  env: Env,
  artistIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const uniqueIds = Array.from(new Set(artistIds));
  for (let i = 0; i < uniqueIds.length; i += ARTIST_BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + ARTIST_BATCH_SIZE);
    await _resolveArtistBatch(env, batch, names);
  }
  return names;
}

async function _resolveArtistBatch(
  env: Env,
  batch: string[],
  names: Map<string, string>,
): Promise<void> {
  const params = batch.map((id) => `filter[id]=${encodeURIComponent(id)}`).join("&");
  const response = await tidalFetch(env, `${TIDAL_ARTISTS_URL}?${params}`);
  if (!response.ok) {
    throw new Error(`resolveArtistNames failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as ArtistsResponse;
  for (const artist of json.data ?? []) {
    if (typeof artist.attributes?.name === "string") {
      names.set(artist.id, artist.attributes.name);
    }
  }
}
