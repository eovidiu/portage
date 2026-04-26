import { neon } from "@neondatabase/serverless";
import { tidalFetch } from "../providers/tidal/client";
import { insertMatch } from "../db/matches";
import { artistAgrees } from "./artist";
import type { Env } from "../env";

// TODO(ovidiu): Verify URL template against Tidal Open API v2 docs.
// Tidal Open API v2 — search by ISRC
// https://developer.tidal.com/reference/get_tracks-v2
const TIDAL_TRACKS_URL = "https://openapi.tidal.com/v2/tracks";

const DURATION_TOLERANCE_MS = 2000;

export interface TrackCandidate {
  spotify_id: string;
  isrc: string | null;
  artist: string;
  duration_ms: number | null;
}

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

interface TidalArtist {
  name: string;
}

interface TidalTrack {
  id: string;
  isrc?: string;
  artists?: TidalArtist[];
  duration?: number;
}

interface TidalSearchResponse {
  data?: TidalTrack[];
}

function parseDurationMs(tidalTrack: TidalTrack): number | null {
  if (typeof tidalTrack.duration === "number") return tidalTrack.duration * 1000;
  return null;
}

function pickBestCandidate(
  candidates: TidalTrack[],
  spotifyDurationMs: number | null,
): TidalTrack | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    if (spotifyDurationMs === null) return candidates[0];
    const durationMs = parseDurationMs(candidates[0]);
    if (durationMs === null) return candidates[0];
    return Math.abs(durationMs - spotifyDurationMs) <= DURATION_TOLERANCE_MS
      ? candidates[0]
      : null;
  }

  // Multiple candidates: pick the one with minimum duration delta, within tolerance
  let best: TidalTrack | null = null;
  let bestDelta = Infinity;

  for (const c of candidates) {
    const durationMs = parseDurationMs(c);
    if (spotifyDurationMs === null || durationMs === null) {
      if (best === null) best = c;
      continue;
    }
    const delta = Math.abs(durationMs - spotifyDurationMs);
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
  const url = `${TIDAL_TRACKS_URL}?filter[isrc]=${encodeURIComponent(isrc)}`;
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

    const candidates = body.data ?? [];
    if (candidates.length === 0) {
      skipped++;
      continue;
    }

    // Filter to candidates whose artist agrees with the Spotify artist
    const agreeing = candidates.filter((c) => {
      const tidalArtist = c.artists?.[0]?.name ?? "";
      if (!artistAgrees(track.artist, tidalArtist)) {
        console.log(
          JSON.stringify({
            event: "isrc_artist_mismatch",
            spotify_id: track.spotify_id,
            tidal_id: c.id,
            spotify_artist: track.artist,
            tidal_artist: tidalArtist,
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
