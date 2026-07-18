// F-030 task 1.8: Spotify catalog search (ISRC lookup + fuzzy text search) for
// the tidal_to_spotify copy direction.
//
// Grounded against developer.spotify.com Web API reference, "Search"
// (full citations in the F-030 grounding notes):
//   - GET /v1/search?q=isrc:<CODE>&type=track — ISRC is a field filter scoped
//     to track search.
//   - GET /v1/search?q=track:<title> artist:<artist>&type=track — fuzzy text
//     search via the same field-filter syntax.
//   - limit: default 5, max 10 (smaller than other Spotify endpoints — the
//     copy engine uses the max, 10).
//   - 429 + Retry-After, same rolling-30s-window rate limit as other
//     endpoints; a second consecutive 429 is reported back to the caller as
//     a typed result rather than thrown, so the engine can leave the track
//     `pending` for a later tick (spotify-catalog-search spec, "Rate-limit
//     handling").
//
// Candidates are mapped into `ResolvedTidalCandidate` — the shape score.ts's
// scoreCandidate already consumes — so the P2 matching engine can rank them
// with the existing weights without any change to src/match/.

import type { Env } from "../../env";
import { spotifyFetch } from "./oauth";
import { artistAgrees } from "../../match/artist";
import type { SpotifyTrackInput, ResolvedTidalCandidate } from "../../match/score";

const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";
const SEARCH_LIMIT = 10; // documented max for /v1/search (default is 5)
const DURATION_TOLERANCE_MS = 2000;
const ISRC_CONFIDENCE = 0.95;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SpotifySearchTrackItem {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album?: { name: string };
  duration_ms?: number;
  external_ids?: { isrc?: string };
}

interface SpotifySearchResponse {
  tracks?: { items: SpotifySearchTrackItem[] };
}

function toResolvedCandidate(item: SpotifySearchTrackItem): ResolvedTidalCandidate {
  const artists = item.artists.map((a) => a.name);
  return {
    id: item.id,
    title: item.name,
    primaryArtist: artists[0] ?? "",
    artists,
    albumTitle: item.album?.name ?? "",
    durationMs: item.duration_ms ?? null,
    isrc: item.external_ids?.isrc ?? null,
  };
}

type SearchOutcome = { status: "ok"; items: SpotifySearchTrackItem[] } | { status: "rate_limited" };

async function fetchSearch(env: Env, q: string): Promise<SearchOutcome> {
  const url = `${SPOTIFY_SEARCH_URL}?q=${encodeURIComponent(q)}&type=track&limit=${SEARCH_LIMIT}`;
  const first = await spotifyFetch(env, url);

  if (first.status === 429) {
    const retryAfter = parseInt(first.headers.get("Retry-After") ?? "1", 10);
    await sleep(retryAfter * 1000);

    const second = await spotifyFetch(env, url);
    if (second.status === 429) {
      return { status: "rate_limited" };
    }
    if (!second.ok) throw new Error(`Spotify search failed: HTTP ${second.status}`);
    const body = (await second.json()) as SpotifySearchResponse;
    return { status: "ok", items: body.tracks?.items ?? [] };
  }

  if (!first.ok) throw new Error(`Spotify search failed: HTTP ${first.status}`);
  const body = (await first.json()) as SpotifySearchResponse;
  return { status: "ok", items: body.tracks?.items ?? [] };
}

export interface IsrcMatchResult {
  status: "matched" | "no_match" | "rate_limited";
  candidate?: ResolvedTidalCandidate;
  confidence?: number;
}

/**
 * ISRC-first lookup for the tidal_to_spotify direction. Accepts a candidate
 * only when its artist agrees (same normalization as the Tidal ISRC matcher,
 * `src/match/isrc.ts`) and duration is within ±2000ms; picks the closest
 * duration match among agreeing candidates.
 */
export async function searchByIsrc(
  env: Env,
  isrc: string,
  source: SpotifyTrackInput,
): Promise<IsrcMatchResult> {
  const outcome = await fetchSearch(env, `isrc:${isrc.toUpperCase()}`);
  if (outcome.status === "rate_limited") return { status: "rate_limited" };

  const candidates = outcome.items.map(toResolvedCandidate);
  const agreeing = candidates.filter((c) => artistAgrees(source.artist, c.primaryArtist));

  const sourceDuration = source.duration_ms ?? null;
  let best: ResolvedTidalCandidate | null = null;
  let bestDelta = Infinity;

  for (const c of agreeing) {
    if (sourceDuration === null || c.durationMs === null) {
      if (best === null) best = c;
      continue;
    }
    const delta = Math.abs(c.durationMs - sourceDuration);
    if (delta <= DURATION_TOLERANCE_MS && delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }

  if (!best) return { status: "no_match" };
  return { status: "matched", candidate: best, confidence: ISRC_CONFIDENCE };
}

export interface TextSearchResult {
  status: "ok" | "rate_limited";
  candidates: ResolvedTidalCandidate[];
}

/**
 * Fuzzy text search fallback. Returns mapped candidates only — ranking
 * against the source track (score.ts's title/artist/duration/album weights)
 * is the P2 matching engine's responsibility.
 */
export async function searchByText(
  env: Env,
  title: string,
  artist: string,
): Promise<TextSearchResult> {
  const outcome = await fetchSearch(env, `track:${title} artist:${artist}`);
  if (outcome.status === "rate_limited") return { status: "rate_limited", candidates: [] };

  return { status: "ok", candidates: outcome.items.map(toResolvedCandidate) };
}
