// F-024 + F-007: shared Tidal catalog search helper.
//
// Owns:
//   - URL composition against /v2/searchResults/{id} with the compound
//     include path that JSON:API §6.2 requires to resolve tracks' artist
//     + album metadata.
//   - the 429 + Retry-After single-retry pattern.
//   - the JSON:API → ResolvedTidalCandidate[] walk.
//
// Verified: 2026-05-15 against the vendored OpenAPI types at
// src/providers/tidal/openapi-types.ts (paths /v2/searchResults/{id} GET,
// camelCase; data is SearchResults_Single_Resource_Data_Document).
//
// Both fuzzy.ts (auto-match) and routes/unmatched.ts (manual picker) call
// this helper. Callers cap the candidate list at their own threshold —
// fuzzy keeps the top 5 by score; manual slices to the validated limit.

import type { Env } from "../env";
import { tidalFetch } from "../providers/tidal/client";
import {
  parseIsoDurationMs,
  buildIncludedIndex,
  lookupIncluded,
  type JsonApiResource,
  type IncludedIndex,
} from "./json-api";
import type { ResolvedTidalCandidate } from "./score";

// Verified: https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json — server https://openapi.tidal.com/v2, path /searchResults/{id} (marker lost when F-024 extracted this constant from fuzzy.ts; re-verified 2026-07-12)
const TIDAL_SEARCH_BASE = "https://openapi.tidal.com/v2/searchResults";

export interface SearchResult {
  candidates: ResolvedTidalCandidate[];
  retried: boolean;
  status: number;
  /**
   * True when the upstream returned 2xx but the body could not be parsed as
   * JSON. Lets callers distinguish "Tidal said empty" from "Tidal returned
   * garbage" — the latter must surface to operators (fuzzy logs it as
   * `tidal_parse_error`; the manual route returns 502 `tidal_upstream_error`).
   */
  bodyParseError: boolean;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSearchUrl(query: string): string {
  const encoded = encodeURIComponent(query);
  return `${TIDAL_SEARCH_BASE}/${encoded}?include=tracks,tracks.artists,tracks.albums`;
}

function resolveTrack(
  track: JsonApiResource,
  index: IncludedIndex,
): ResolvedTidalCandidate {
  const attrs = track.attributes ?? {};
  const title = typeof attrs.title === "string" ? attrs.title : "";
  const durationMs = parseIsoDurationMs(attrs.duration);
  const isrc = typeof attrs.isrc === "string" ? attrs.isrc : null;

  const artistRel = track.relationships?.artists?.data;
  const artistRefs = Array.isArray(artistRel) ? artistRel : [];
  const artists: string[] = [];
  for (const ref of artistRefs) {
    if (!ref || typeof ref.id !== "string") continue;
    const resource = lookupIncluded(index, "artists", ref.id);
    const name = resource?.attributes?.name;
    if (typeof name === "string" && name.length > 0) artists.push(name);
  }
  const primaryArtist = artists[0] ?? "";

  const albumRel = track.relationships?.albums?.data;
  const firstAlbumRef = Array.isArray(albumRel) ? albumRel[0] : undefined;
  const albumResource = firstAlbumRef
    ? lookupIncluded(index, "albums", firstAlbumRef.id)
    : undefined;
  const albumTitleAttr = albumResource?.attributes?.title;
  const albumTitle = typeof albumTitleAttr === "string" ? albumTitleAttr : "";

  return { id: track.id, title, primaryArtist, artists, albumTitle, durationMs, isrc };
}

function extractCandidates(body: unknown): ResolvedTidalCandidate[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;

  const data = b.data as
    | {
        relationships?: {
          tracks?: { data?: Array<{ id: string; type: string }> };
        };
      }
    | undefined;
  const trackRefs = data?.relationships?.tracks?.data;
  if (!Array.isArray(trackRefs)) return [];

  const includedRaw = Array.isArray(b.included) ? (b.included as JsonApiResource[]) : [];
  const index = buildIncludedIndex(includedRaw);

  const out: ResolvedTidalCandidate[] = [];
  for (const ref of trackRefs) {
    if (!ref || typeof ref.id !== "string" || ref.type !== "tracks") continue;
    const track = lookupIncluded(index, "tracks", ref.id);
    if (!track) continue;
    out.push(resolveTrack(track, index));
  }
  return out;
}

/**
 * Call Tidal's catalog search and return resolved candidates plus the upstream
 * status. Honors a single 429 + Retry-After retry; non-429 statuses are
 * returned as-is for the caller to map to its own error taxonomy. Malformed
 * bodies surface as `candidates: []` with the original 2xx status — callers
 * that need to distinguish "Tidal said empty" from "body was garbage" can do
 * so via response inspection or by trusting the helper's empty-result
 * semantics (manual search is happy to render an empty picker).
 */
export async function searchTidalCandidates(
  env: Env,
  query: string,
): Promise<SearchResult> {
  const url = buildSearchUrl(query);

  let response = await tidalFetch(env, url);
  let retried = false;

  if (response.status === 429) {
    retried = true;
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "1", 10);
    await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000);
    response = await tidalFetch(env, url);
  }

  const status = response.status;

  if (!response.ok) {
    return { candidates: [], retried, status, bodyParseError: false };
  }

  let body: unknown = null;
  let bodyParseError = false;
  try {
    body = await response.json();
  } catch {
    bodyParseError = true;
  }

  return {
    candidates: bodyParseError ? [] : extractCandidates(body),
    retried,
    status,
    bodyParseError,
  };
}
