import type { Env } from "../../env";
import { tidalFetch } from "./client";
import { TIDAL_PLAYLISTS_URL } from "./playlist-endpoints";

export interface OwnPlaylist {
  id: string;
  name: string;
  numberOfItems: number | null;
}

export interface OwnPlaylistsPage {
  playlists: OwnPlaylist[];
  hasMore: boolean;
  cursor: string | null;
}

interface OwnPlaylistsResponse {
  data?: Array<{ id: string; attributes?: { name?: string; numberOfItems?: number } }>;
  links?: { meta?: { nextCursor?: string } };
}

/**
 * List playlists owned by the authenticated user, for the copy-source picker.
 *
 * Verified: 2026-07-18 against openapi-types.ts:7532-7589 (path /playlists,
 * `filter[owners.id]` = "Use `me` for the authenticated user") and
 * :20558-20635 (Playlists_Attributes.name/numberOfItems come back directly in
 * `data[]`; numberOfItems is optional per the schema, no per-playlist
 * follow-up request needed).
 */
export async function listOwnPlaylists(
  env: Env,
  cursor: string | null = null,
): Promise<OwnPlaylistsPage> {
  let url = `${TIDAL_PLAYLISTS_URL}?filter[owners.id]=me`;
  if (cursor) url += `&page[cursor]=${encodeURIComponent(cursor)}`;
  const response = await tidalFetch(env, url);
  if (!response.ok) {
    throw new Error(`listOwnPlaylists failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as OwnPlaylistsResponse;
  const playlists = (json.data ?? []).map((p) => ({
    id: p.id,
    name: p.attributes?.name ?? "",
    numberOfItems: p.attributes?.numberOfItems ?? null,
  }));
  const nextCursor = json.links?.meta?.nextCursor ?? null;
  return { playlists, hasMore: nextCursor !== null, cursor: nextCursor };
}
