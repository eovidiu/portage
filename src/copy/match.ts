// F-030 task 2.4: copy-job matching phase. Direction-specific pipelines per
// design.md D4 (spotify_to_tidal: cache -> isrc -> fuzzy, write-back to
// tracks/matches) and D5 (tidal_to_spotify: isrc -> fuzzy, no reverse cache).

import { neon } from "@neondatabase/serverless";
import type { Env } from "../env";
import type { CopyJobRow } from "../db/copy_jobs";
import {
  listPendingForMatch,
  updateTrackMatch,
  type CopyJobTrackRow,
  type CopyCandidate,
} from "../db/copy_job_tracks";
import { insertMatch } from "../db/matches";
import { tidalFetch } from "../providers/tidal/client";
import { artistAgrees } from "../match/artist";
import { normaliseTitle } from "../match/title";
import { parseIsoDurationMs, buildIncludedIndex, lookupIncluded, type JsonApiResource } from "../match/json-api";
import { searchTidalCandidates } from "../match/tidal-search";
import { scoreCandidate, type ResolvedTidalCandidate, type SpotifyTrackInput } from "../match/score";
import { searchByIsrc, searchByText } from "../providers/spotify/search";

// F-028 D6 acceptance threshold, mirrored here since fuzzy.ts's constant
// isn't exported (src/match/** stays untouched per scope).
const ACCEPT_THRESHOLD = 0.80;
const MAX_CANDIDATES = 3;
const DURATION_TOLERANCE_MS = 2000;
const TIDAL_TRACKS_URL = "https://openapi.tidal.com/v2/tracks";

function toCopyCandidate(c: ResolvedTidalCandidate, score?: number): CopyCandidate {
  return {
    id: c.id,
    title: c.title,
    artist: c.primaryArtist,
    album: c.albumTitle || null,
    duration_ms: c.durationMs,
    ...(score !== undefined ? { score: Math.round(score * 100) / 100 } : {}),
  };
}

function trackAsSource(t: CopyJobTrackRow): SpotifyTrackInput {
  return { title: t.title, artist: t.artist ?? "", album: t.album, duration_ms: t.duration_ms, isrc: t.isrc };
}

/** Ranks candidates against a copy track by the shared score.ts weights. */
function rankAgainstTrack(
  track: CopyJobTrackRow,
  candidates: ResolvedTidalCandidate[],
): Array<{ candidate: ResolvedTidalCandidate; score: number }> {
  return candidates
    .map((c) => ({ candidate: c, score: scoreCandidate(trackAsSource(track), c).total }))
    .sort((a, b) => b.score - a.score);
}

/** Applies a fuzzy ranking's outcome: accept above threshold, else unmatched + top-3. */
async function applyFuzzyOutcome(
  env: Env,
  jobId: string,
  track: CopyJobTrackRow,
  ranked: Array<{ candidate: ResolvedTidalCandidate; score: number }>,
): Promise<void> {
  if (ranked.length === 0) {
    await updateTrackMatch(env, jobId, track.position, { state: "unmatched", reason: "no_candidates" });
    return;
  }
  const top = ranked[0];
  if (top.score >= ACCEPT_THRESHOLD) {
    await updateTrackMatch(env, jobId, track.position, {
      state: "matched",
      match_method: "fuzzy",
      confidence: Math.round(top.score * 100) / 100,
      dest_track_id: top.candidate.id,
    });
    return;
  }
  const candidates = ranked.slice(0, MAX_CANDIDATES).map((r) => toCopyCandidate(r.candidate, r.score));
  await updateTrackMatch(env, jobId, track.position, {
    state: "unmatched",
    reason: "fuzzy_below_threshold",
    candidates,
  });
}

// --- spotify_to_tidal -------------------------------------------------

interface CacheHit {
  tidal_id: string;
  confidence: number;
}

async function queryCache(
  env: Env,
  spotifyIds: string[],
): Promise<Map<string, CacheHit>> {
  if (spotifyIds.length === 0) return new Map();
  const sql = neon(env.DATABASE_URL);
  const rows = await sql(
    `SELECT spotify_id, tidal_id, confidence FROM matches WHERE spotify_id = ANY($1)`,
    [spotifyIds],
  );
  const map = new Map<string, CacheHit>();
  for (const r of rows as Array<{ spotify_id: string; tidal_id: string; confidence: number }>) {
    map.set(r.spotify_id, { tidal_id: r.tidal_id, confidence: r.confidence });
  }
  return map;
}

function resolveTidalIsrcCandidate(
  track: JsonApiResource,
  index: ReturnType<typeof buildIncludedIndex>,
): { id: string; durationMs: number | null; primaryArtist: string } {
  const artistsRel = track.relationships?.artists?.data;
  const firstArtistRef = Array.isArray(artistsRel) ? artistsRel[0] : undefined;
  const artistResource = firstArtistRef ? lookupIncluded(index, "artists", firstArtistRef.id) : undefined;
  const name = artistResource?.attributes?.name;
  return {
    id: track.id,
    durationMs: parseIsoDurationMs(track.attributes?.duration),
    primaryArtist: typeof name === "string" ? name : "",
  };
}

type IsrcSearchOutcome =
  | { status: "matched"; tidalId: string }
  | { status: "no_match" }
  | { status: "rate_limited" };

/**
 * Tidal ISRC search for the spotify_to_tidal direction. Reimplements the
 * (private, unexported) resolution logic from src/match/isrc.ts using only
 * exported building blocks — src/match/** is out of scope to modify.
 */
async function searchTidalByIsrc(
  env: Env,
  isrc: string,
  sourceArtist: string,
  sourceDurationMs: number | null,
): Promise<IsrcSearchOutcome> {
  const url = `${TIDAL_TRACKS_URL}?filter[isrc]=${encodeURIComponent(isrc.toUpperCase())}&include=artists`;
  const response = await tidalFetch(env, url);
  if (response.status === 429 || !response.ok) return { status: "no_match" };

  const body = (await response.json()) as { data?: JsonApiResource[]; included?: JsonApiResource[] };
  const index = buildIncludedIndex(body.included);
  const candidates = (body.data ?? []).map((c) => resolveTidalIsrcCandidate(c, index));
  const agreeing = candidates.filter((c) => artistAgrees(sourceArtist, c.primaryArtist));

  let best: (typeof agreeing)[number] | null = null;
  let bestDelta = Infinity;
  for (const c of agreeing) {
    if (sourceDurationMs === null || c.durationMs === null) {
      if (best === null) best = c;
      continue;
    }
    const delta = Math.abs(c.durationMs - sourceDurationMs);
    if (delta <= DURATION_TOLERANCE_MS && delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best ? { status: "matched", tidalId: best.id } : { status: "no_match" };
}

async function fuzzySearchTidal(track: CopyJobTrackRow, env: Env): Promise<ResolvedTidalCandidate[]> {
  const query = `${normaliseTitle(track.artist ?? "")} ${normaliseTitle(track.title)}`;
  const result = await searchTidalCandidates(env, query);
  if (result.status >= 400 || result.bodyParseError) return [];
  return result.candidates;
}

async function matchOneSpotifyToTidal(
  env: Env,
  jobId: string,
  track: CopyJobTrackRow,
  attemptIsrc: boolean,
): Promise<void> {
  if (attemptIsrc && track.isrc) {
    const outcome = await searchTidalByIsrc(env, track.isrc, track.artist ?? "", track.duration_ms);
    if (outcome.status === "matched") {
      const sql = neon(env.DATABASE_URL);
      await insertMatch(sql, {
        spotify_id: track.source_track_id,
        tidal_id: outcome.tidalId,
        method: "isrc",
        confidence: 0.95,
        sync_run_id: null,
      });
      await updateTrackMatch(env, jobId, track.position, {
        state: "matched",
        match_method: "isrc",
        confidence: 0.95,
        dest_track_id: outcome.tidalId,
      });
      return;
    }
  }

  const candidates = await fuzzySearchTidal(track, env);
  const ranked = rankAgainstTrack(track, candidates);
  if (ranked.length > 0 && ranked[0].score >= ACCEPT_THRESHOLD) {
    const sql = neon(env.DATABASE_URL);
    await insertMatch(sql, {
      spotify_id: track.source_track_id,
      tidal_id: ranked[0].candidate.id,
      method: "fuzzy",
      confidence: Math.round(ranked[0].score * 100) / 100,
      sync_run_id: null,
    });
  }
  await applyFuzzyOutcome(env, jobId, track, ranked);
}

async function matchSpotifyToTidal(
  env: Env,
  jobId: string,
  tracks: CopyJobTrackRow[],
  isrcBudget: number,
  fuzzyBudget: number,
): Promise<void> {
  const cache = await queryCache(env, tracks.map((t) => t.source_track_id));
  const remaining: CopyJobTrackRow[] = [];

  for (const track of tracks) {
    const hit = cache.get(track.source_track_id);
    if (hit) {
      await updateTrackMatch(env, jobId, track.position, {
        state: "matched",
        match_method: "cached",
        confidence: hit.confidence,
        dest_track_id: hit.tidal_id,
      });
    } else {
      remaining.push(track);
    }
  }

  const isrcPool = remaining.slice(0, isrcBudget);
  const fuzzyOnlyPool = remaining.slice(isrcBudget, isrcBudget + fuzzyBudget);

  for (const track of isrcPool) await matchOneSpotifyToTidal(env, jobId, track, true);
  for (const track of fuzzyOnlyPool) await matchOneSpotifyToTidal(env, jobId, track, false);
}

// --- tidal_to_spotify ---------------------------------------------------

async function matchOneTidalToSpotify(
  env: Env,
  jobId: string,
  track: CopyJobTrackRow,
  attemptIsrc: boolean,
): Promise<void> {
  if (attemptIsrc && track.isrc) {
    const outcome = await searchByIsrc(env, track.isrc, trackAsSource(track));
    if (outcome.status === "matched" && outcome.candidate) {
      await updateTrackMatch(env, jobId, track.position, {
        state: "matched",
        match_method: "isrc",
        confidence: outcome.confidence ?? 0.95,
        dest_track_id: outcome.candidate.id,
      });
      return;
    }
  }

  const result = await searchByText(env, track.title, track.artist ?? "");
  const candidates = result.status === "ok" ? result.candidates : [];
  const ranked = rankAgainstTrack(track, candidates);
  await applyFuzzyOutcome(env, jobId, track, ranked);
}

async function matchTidalToSpotify(
  env: Env,
  jobId: string,
  tracks: CopyJobTrackRow[],
  isrcBudget: number,
  fuzzyBudget: number,
): Promise<void> {
  const isrcPool = tracks.slice(0, isrcBudget);
  const fuzzyOnlyPool = tracks.slice(isrcBudget, isrcBudget + fuzzyBudget);

  for (const track of isrcPool) await matchOneTidalToSpotify(env, jobId, track, true);
  for (const track of fuzzyOnlyPool) await matchOneTidalToSpotify(env, jobId, track, false);
}

// --- entry point ---------------------------------------------------------

/** One matching-phase tick step: processes up to isrcBudget+fuzzyBudget pending tracks. */
export async function runMatchPhaseStep(
  env: Env,
  job: CopyJobRow,
  isrcBudget: number,
  fuzzyBudget: number,
): Promise<void> {
  const pending = await listPendingForMatch(env, job.job_id, isrcBudget + fuzzyBudget);
  if (pending.length === 0) return;

  if (job.direction === "spotify_to_tidal") {
    await matchSpotifyToTidal(env, job.job_id, pending, isrcBudget, fuzzyBudget);
  } else {
    await matchTidalToSpotify(env, job.job_id, pending, isrcBudget, fuzzyBudget);
  }
}
