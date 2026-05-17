import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { insertMatch } from "../db/matches";
import { upsertUnmatched } from "../db/unmatched";
import { normaliseTitle } from "./title";
import { scoreCandidate, type ResolvedTidalCandidate } from "./score";
import { searchTidalCandidates } from "./tidal-search";
import type { Env } from "../env";

/**
 * F-007 fuzzy matcher. Iterates pending unmatched tracks, asks
 * `searchTidalCandidates` for Tidal candidates, ranks by the weighted score
 * in score.ts, and either records a match or upserts an unmatched row.
 *
 * The Tidal upstream call shape (URL, 429 retry, JSON:API walk) lives in
 * `tidal-search.ts` and is shared with F-024 (manual Tidal picker). Keeping
 * one place to update the "verified against OAS" annotation prevents the
 * 2026-05-02-style compound-include incident from repeating.
 */

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

// F-015 + Sprint 6 review M2/M3: predicate matches fetchPendingMatchQueue in
// src/db/tracks.ts. Skipped rows never re-enter; pending rows respect a 7-day
// cooldown. Keep the two SELECTs in sync if either changes.
async function fetchUnmatchedTracks(
  sql: NeonQueryFunction<false, false>,
  limit: number,
): Promise<SpotifyTrackRow[]> {
  const rows = await sql(
    `SELECT t.spotify_id, t.title, t.artist, t.album, t.duration_ms
     FROM tracks t
     LEFT JOIN matches m ON t.spotify_id = m.spotify_id
     LEFT JOIN unmatched u ON t.spotify_id = u.spotify_id
     WHERE m.spotify_id IS NULL
       AND (u.status IS NULL
            OR (u.status = 'pending'
                AND u.last_attempt_at < now() - interval '7 days'))
     ORDER BY t.first_seen_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows as SpotifyTrackRow[];
}

export interface MatchByFuzzyOptions {
  /** F-015: per-invocation queue cap. Defaults to Number.MAX_SAFE_INTEGER (no cap). */
  limit?: number;
  /** F-009: sync_run id for matches.sync_run_id provenance. */
  syncRunId?: string | null;
}

export async function matchByFuzzy(
  env: Env,
  options: MatchByFuzzyOptions = {},
): Promise<FuzzyMatchResult> {
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  const syncRunId = options.syncRunId ?? null;
  const sql = neon(env.DATABASE_URL);
  const tracks = await fetchUnmatchedTracks(sql, limit);

  let matched = 0;
  let unmatched = 0;
  const errors: FuzzyMatchResult["errors"] = [];

  for (const track of tracks) {
    const query = `${normaliseTitle(track.artist)} ${normaliseTitle(track.title)}`;

    let result;
    try {
      result = await searchTidalCandidates(env, query);
    } catch (err) {
      errors.push({
        spotify_id: track.spotify_id,
        error_code: "tidal_error",
        message: err instanceof Error ? err.message : String(err),
      });
      unmatched++;
      continue;
    }

    if (result.status === 429 && result.retried) {
      errors.push({
        spotify_id: track.spotify_id,
        error_code: "tidal_429",
        message: "Second 429 received; track deferred to next run",
      });
      unmatched++;
      continue;
    }

    if (result.status >= 400) {
      errors.push({
        spotify_id: track.spotify_id,
        error_code: `tidal_${result.status}`,
        message: `Tidal returned HTTP ${result.status}`,
      });
      unmatched++;
      continue;
    }

    if (result.bodyParseError) {
      errors.push({
        spotify_id: track.spotify_id,
        error_code: "tidal_parse_error",
        message: "Failed to parse Tidal search response JSON",
      });
      unmatched++;
      continue;
    }

    const candidates = result.candidates.slice(0, MAX_CANDIDATES);

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
      await upsertUnmatched(sql, {
        spotify_id: track.spotify_id,
        reason: "no_candidates",
        sync_run_id: syncRunId,
      });
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
      // F-027a: persist the top 3 ranked candidates alongside the row so
      // the operator can pick from them on the run-detail page later.
      // Only on the fuzzy_below_threshold branch — no_candidates has
      // nothing to persist (caught upstream).
      const persistedCandidates = ranked.slice(0, 3).map((scored) => ({
        tidal_id: scored.candidate.id,
        title: scored.candidate.title,
        artist: scored.candidate.primaryArtist,
        album: scored.candidate.albumTitle || null,
        score: Math.round(scored.score * 100) / 100,
      }));
      await upsertUnmatched(sql, {
        spotify_id: track.spotify_id,
        reason: "fuzzy_below_threshold",
        sync_run_id: syncRunId,
        candidates: persistedCandidates,
      });
      unmatched++;
    }
  }

  return { matched, unmatched, errors };
}
