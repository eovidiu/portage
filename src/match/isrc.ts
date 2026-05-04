import { neon } from "@neondatabase/serverless";
import { tidalFetch } from "../providers/tidal/client";
import { insertMatch } from "../db/matches";
import { artistAgrees } from "./artist";
import {
  parseIsoDurationMs,
  buildIncludedIndex,
  lookupIncluded,
  type JsonApiResource,
} from "./json-api";
import type { Env } from "../env";
import type { TrackCandidate } from "../db/tracks";

// Tidal Open API v2 — search by ISRC. The response is JSON:API: track
// resources expose attributes (`isrc`, `duration` as ISO-8601 like "PT3M40S")
// and a `relationships.artists.data[]` list of artist refs. Artist names live
// in the top-level `included[]` array when the request sets `include=artists`.
// Verified: 2026-04-27 against https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json (path /v2/tracks GET; filter[isrc] array(string); attributes.duration ISO-8601).
const TIDAL_TRACKS_URL = "https://openapi.tidal.com/v2/tracks";

const DURATION_TOLERANCE_MS = 2000;

// Re-export for back-compat (the type now lives in src/db/tracks.ts).
export type { TrackCandidate } from "../db/tracks";

export interface PerTrackError {
  spotify_id: string;
  error_code: string;
  message: string;
}

export interface MatchResult {
  matched: number;
  skipped: number;
  errors: PerTrackError[];
}

interface TidalSearchResponse {
  data?: JsonApiResource[];
  included?: JsonApiResource[];
}

interface ResolvedCandidate {
  id: string;
  durationMs: number | null;
  primaryArtist: string;
}

function resolveCandidate(
  track: JsonApiResource,
  index: ReturnType<typeof buildIncludedIndex>,
): ResolvedCandidate {
  const artistsRel = track.relationships?.artists?.data;
  const firstArtistRef = Array.isArray(artistsRel) ? artistsRel[0] : undefined;
  const artistResource = firstArtistRef
    ? lookupIncluded(index, "artists", firstArtistRef.id)
    : undefined;
  const artistName = artistResource?.attributes?.name;
  const primaryArtist = typeof artistName === "string" ? artistName : "";
  const durationMs = parseIsoDurationMs(track.attributes?.duration);
  return { id: track.id, durationMs, primaryArtist };
}

function pickBestCandidate(
  candidates: ResolvedCandidate[],
  spotifyDurationMs: number | null,
): ResolvedCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    if (spotifyDurationMs === null || candidates[0].durationMs === null) return candidates[0];
    return Math.abs(candidates[0].durationMs - spotifyDurationMs) <= DURATION_TOLERANCE_MS
      ? candidates[0]
      : null;
  }

  // Multiple candidates: pick the one with minimum duration delta, within tolerance.
  // Candidates with unknown durations (either side null) fall back to first-seen.
  let best: ResolvedCandidate | null = null;
  let bestDelta = Infinity;

  for (const c of candidates) {
    if (spotifyDurationMs === null || c.durationMs === null) {
      if (best === null) best = c;
      continue;
    }
    const delta = Math.abs(c.durationMs - spotifyDurationMs);
    if (delta <= DURATION_TOLERANCE_MS && delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }

  return best;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchByIsrc(
  env: Env,
  isrc: string,
): Promise<{ response: Response; retried: boolean }> {
  // include=artists materialises artist resources in `included[]` so the matcher
  // can verify F-006-R3 artist agreement; without this Tidal returns only artist
  // refs in `relationships`, leaving names unresolved.
  // F-006-R12: ISO 3901 mandates uppercase ISRCs. Spotify forwards values
  // verbatim and sometimes returns lowercase legacy entries; Tidal returns
  // HTTP 400 for those, so normalise here.
  const url = `${TIDAL_TRACKS_URL}?filter[isrc]=${encodeURIComponent(isrc.toUpperCase())}&include=artists`;
  const first = await tidalFetch(env, url);
  if (first.status !== 429) return { response: first, retried: false };

  const retryAfter = parseInt(first.headers.get("Retry-After") ?? "1", 10);
  await sleep(retryAfter * 1000);

  const second = await tidalFetch(env, url);
  return { response: second, retried: true };
}

/**
 * Runs the ISRC matching stage for the given tracks.
 *
 * Tracks without a match row inserted are left for F-007 (fuzzy matching).
 * Per-track errors (e.g. second 429) are accumulated in the returned `errors`
 * array so F-009 can eventually persist them.
 *
 * @param syncRunId - UUID of the current sync run (nullable; will be stored on match rows).
 */
export async function matchByIsrc(
  env: Env,
  tracks: TrackCandidate[],
  syncRunId: string | null = null,
): Promise<MatchResult> {
  const sql = neon(env.DATABASE_URL);
  const errors: PerTrackError[] = [];
  let matched = 0;
  let skipped = 0;

  for (const track of tracks) {
    if (!track.isrc) {
      skipped++;
      continue;
    }

    let tidalResponse: Response;
    try {
      const { response, retried } = await fetchByIsrc(env, track.isrc);
      if (response.status === 429 && retried) {
        errors.push({
          spotify_id: track.spotify_id,
          error_code: "tidal_429",
          message: "Second 429 received; track deferred to F-007",
        });
        skipped++;
        continue;
      }
      tidalResponse = response;
    } catch (err) {
      errors.push({
        spotify_id: track.spotify_id,
        error_code: "tidal_error",
        message: err instanceof Error ? err.message : String(err),
      });
      skipped++;
      continue;
    }

    if (!tidalResponse.ok) {
      errors.push({
        spotify_id: track.spotify_id,
        error_code: `tidal_${tidalResponse.status}`,
        message: `Tidal returned HTTP ${tidalResponse.status}`,
      });
      skipped++;
      continue;
    }

    let body: TidalSearchResponse;
    try {
      body = (await tidalResponse.json()) as TidalSearchResponse;
    } catch {
      errors.push({
        spotify_id: track.spotify_id,
        error_code: "tidal_parse_error",
        message: "Failed to parse Tidal response JSON",
      });
      skipped++;
      continue;
    }

    const rawCandidates = body.data ?? [];
    if (rawCandidates.length === 0) {
      skipped++;
      continue;
    }

    const includedIndex = buildIncludedIndex(body.included);
    const resolved = rawCandidates.map((c) => resolveCandidate(c, includedIndex));

    // Filter to candidates whose artist agrees with the Spotify artist
    const agreeing = resolved.filter((c) => {
      if (!artistAgrees(track.artist, c.primaryArtist)) {
        console.log(
          JSON.stringify({
            event: "isrc_artist_mismatch",
            spotify_id: track.spotify_id,
            tidal_id: c.id,
            spotify_artist: track.artist,
            tidal_artist: c.primaryArtist,
          }),
        );
        return false;
      }
      return true;
    });

    if (agreeing.length === 0) {
      skipped++;
      continue;
    }

    const best = pickBestCandidate(agreeing, track.duration_ms);
    if (!best) {
      skipped++;
      continue;
    }

    await insertMatch(sql, {
      spotify_id: track.spotify_id,
      tidal_id: best.id,
      method: "isrc",
      confidence: 0.95,
      sync_run_id: syncRunId,
    });
    matched++;
  }

  return { matched, skipped, errors };
}
