import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { tidalFetch } from "../providers/tidal/client";
import { insertMatch } from "../db/matches";
import { upsertUnmatched } from "../db/unmatched";
import { normaliseTitle } from "./title";
import { scoreCandidate, type ResolvedTidalCandidate } from "./score";
import {
  parseIsoDurationMs,
  buildIncludedIndex,
  lookupIncluded,
  type JsonApiResource,
  type IncludedIndex,
} from "./json-api";
import type { Env } from "../env";

/**
 * Tidal Open API v2 — fuzzy search by artist+title.
 *
 * We hit the singular `/searchResults/{id}` endpoint with
 * `?include=tracks,artists,albums` so the response carries:
 *   - data.relationships.tracks.data[]: refs to top track candidates
 *   - included[]:                       full Tracks/Artists/Albums resources
 *
 * The relationships variant `/searchResults/{id}/relationships/tracks` only
 * accepts `include=tracks` per the OAS, which leaves the candidates without
 * resolvable artist/album metadata — the F-007 weighted score (artist 0.30 +
 * album 0.10) couldn't reach the 0.85 accept threshold without those.
 *
 * Pagination on this endpoint is `page[cursor]`, NOT `limit`. F-007-R3 caps
 * at 5 candidates; we slice client-side from `relationships.tracks.data[]`.
 */
// Verified: 2026-04-27 against https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json (path /v2/searchResults/{id} GET, camelCase; include enum allows tracks,artists,albums; data is SearchResults_Resource_Object).
const TIDAL_SEARCH_BASE = "https://openapi.tidal.com/v2/searchResults";

const ACCEPT_THRESHOLD = 0.85;
const TIE_EPSILON = 0.001;
const MAX_CANDIDATES = 5;

interface SpotifyTrackRow {
  spotify_id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
}

interface ScoredCandidate {
  candidate: ResolvedTidalCandidate;
  score: number;
  durationDelta: number;
}

export interface FuzzyMatchResult {
  matched: number;
  unmatched: number;
  errors: Array<{ spotify_id: string; error_code: string; message: string }>;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function searchTidal(
  env: Env,
  query: string,
): Promise<{ response: Response; retried: boolean }> {
  const encoded = encodeURIComponent(query);
  const url = `${TIDAL_SEARCH_BASE}/${encoded}?include=tracks,artists,albums`;
  const first = await tidalFetch(env, url);
  if (first.status !== 429) return { response: first, retried: false };

  const retryAfter = parseInt(first.headers.get("Retry-After") ?? "1", 10);
  await sleep(retryAfter * 1000);

  const second = await tidalFetch(env, url);
  return { response: second, retried: true };
}

/** Resolve a single track resource into a scoring-ready candidate. */
function resolveTrack(
  track: JsonApiResource,
  index: IncludedIndex,
): ResolvedTidalCandidate {
  const attrs = track.attributes ?? {};
  const title = typeof attrs.title === "string" ? attrs.title : "";
  const durationMs = parseIsoDurationMs(attrs.duration);

  const artistRel = track.relationships?.artists?.data;
  const firstArtistRef = Array.isArray(artistRel) ? artistRel[0] : undefined;
  const artistResource = firstArtistRef
    ? lookupIncluded(index, "artists", firstArtistRef.id)
    : undefined;
  const artistName = artistResource?.attributes?.name;
  const primaryArtist = typeof artistName === "string" ? artistName : "";

  const albumRel = track.relationships?.albums?.data;
  const firstAlbumRef = Array.isArray(albumRel) ? albumRel[0] : undefined;
  const albumResource = firstAlbumRef
    ? lookupIncluded(index, "albums", firstAlbumRef.id)
    : undefined;
  const albumTitleAttr = albumResource?.attributes?.title;
  const albumTitle = typeof albumTitleAttr === "string" ? albumTitleAttr : "";

  return { id: track.id, title, primaryArtist, albumTitle, durationMs };
}

/**
 * Walk a `/searchResults/{id}` response: pick top track refs from
 * `data.relationships.tracks.data[]`, resolve each via `included[]`, and
 * cap at MAX_CANDIDATES per F-007-R3.
 */
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
    if (out.length >= MAX_CANDIDATES) break;
    if (!ref || typeof ref.id !== "string" || ref.type !== "tracks") continue;
    const track = lookupIncluded(index, "tracks", ref.id);
    if (!track) continue;
    out.push(resolveTrack(track, index));
  }
  return out;
}

function rankCandidates(
  sp: SpotifyTrackRow,
  candidates: ResolvedTidalCandidate[],
): ScoredCandidate[] {
  return candidates
    .map((c) => {
      const breakdown = scoreCandidate(sp, c);
      const tdMs = c.durationMs ?? 0;
      const spMs = sp.duration_ms ?? 0;
      return {
        candidate: c,
        score: breakdown.total,
        durationDelta: Math.abs(tdMs - spMs),
      };
    })
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (Math.abs(diff) <= TIE_EPSILON) return a.durationDelta - b.durationDelta;
      return diff;
    });
}

async function fetchUnmatchedTracks(
  sql: NeonQueryFunction<false, false>,
): Promise<SpotifyTrackRow[]> {
  const rows = await sql(
    `SELECT t.spotify_id, t.title, t.artist, t.album, t.duration_ms
     FROM tracks t
     LEFT JOIN matches m ON t.spotify_id = m.spotify_id
     WHERE m.spotify_id IS NULL`,
    [],
  );
  return rows as SpotifyTrackRow[];
}

export async function matchByFuzzy(
  env: Env,
  syncRunId: string | null = null,
): Promise<FuzzyMatchResult> {
  const sql = neon(env.DATABASE_URL);
  const tracks = await fetchUnmatchedTracks(sql);

  let matched = 0;
  let unmatched = 0;
  const errors: FuzzyMatchResult["errors"] = [];

  for (const track of tracks) {
    const query = `${normaliseTitle(track.artist)} ${normaliseTitle(track.title)}`;

    let tidalResponse: Response;
    try {
      const { response, retried } = await searchTidal(env, query);
      if (response.status === 429 && retried) {
        errors.push({
          spotify_id: track.spotify_id,
          error_code: "tidal_429",
          message: "Second 429 received; track deferred to next run",
        });
        unmatched++;
        continue;
      }
      tidalResponse = response;
    } catch (err) {
      errors.push({
        spotify_id: track.spotify_id,
        error_code: "tidal_error",
        message: err instanceof Error ? err.message : String(err),
      });
      unmatched++;
      continue;
    }

    if (!tidalResponse.ok) {
      errors.push({
        spotify_id: track.spotify_id,
        error_code: `tidal_${tidalResponse.status}`,
        message: `Tidal returned HTTP ${tidalResponse.status}`,
      });
      unmatched++;
      continue;
    }

    let body: unknown;
    try {
      body = await tidalResponse.json();
    } catch {
      errors.push({
        spotify_id: track.spotify_id,
        error_code: "tidal_parse_error",
        message: "Failed to parse Tidal search response JSON",
      });
      unmatched++;
      continue;
    }

    const candidates = extractCandidates(body);

    if (candidates.length === 0) {
      console.log(
        JSON.stringify({
          event: "fuzzy_decision",
          spotify_id: track.spotify_id,
          top_candidate_id: null,
          top_score: null,
          second_best_score: null,
          decision: "no_candidates",
        }),
      );
      await upsertUnmatched(sql, { spotify_id: track.spotify_id, reason: "no_candidates" });
      unmatched++;
      continue;
    }

    const ranked = rankCandidates(track, candidates);
    const top = ranked[0];
    const secondScore = ranked[1]?.score ?? null;

    if (top.score >= ACCEPT_THRESHOLD) {
      console.log(
        JSON.stringify({
          event: "fuzzy_decision",
          spotify_id: track.spotify_id,
          top_candidate_id: top.candidate.id,
          top_score: top.score,
          second_best_score: secondScore,
          decision: "accepted",
        }),
      );
      const confidence = Math.round(top.score * 100) / 100;
      await insertMatch(sql, {
        spotify_id: track.spotify_id,
        tidal_id: top.candidate.id,
        method: "fuzzy",
        confidence,
        sync_run_id: syncRunId,
      });
      matched++;
    } else {
      console.log(
        JSON.stringify({
          event: "fuzzy_decision",
          spotify_id: track.spotify_id,
          top_candidate_id: top.candidate.id,
          top_score: top.score,
          second_best_score: secondScore,
          decision: "rejected_below_threshold",
        }),
      );
      await upsertUnmatched(sql, {
        spotify_id: track.spotify_id,
        reason: "fuzzy_below_threshold",
      });
      unmatched++;
    }
  }

  return { matched, unmatched, errors };
}
