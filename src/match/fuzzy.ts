import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { tidalFetch } from "../providers/tidal/client";
import { insertMatch } from "../db/matches";
import { upsertUnmatched } from "../db/unmatched";
import { normaliseTitle } from "./title";
import { scoreCandidate, tidalDurationMs, type TidalCandidateInput } from "./score";
import type { Env } from "../env";

// TODO(ovidiu): Verify this endpoint against current Tidal Open API v2 docs.
// Documented form as of 2026-04-26: GET /v2/searchresults/{query}/relationships/tracks
// with ?countryCode=<CC>&include=tracks&limit=5
const TIDAL_SEARCH_BASE = "https://openapi.tidal.com/v2/searchresults";

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

interface TidalSearchResponse {
  data?: TidalCandidateInput[];
  included?: TidalCandidateInput[];
}

interface ScoredCandidate {
  candidate: TidalCandidateInput & { id: string };
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
  const url = `${TIDAL_SEARCH_BASE}/${encoded}/relationships/tracks?include=tracks&limit=${MAX_CANDIDATES}`;
  const first = await tidalFetch(env, url);
  if (first.status !== 429) return { response: first, retried: false };

  const retryAfter = parseInt(first.headers.get("Retry-After") ?? "1", 10);
  await sleep(retryAfter * 1000);

  const second = await tidalFetch(env, url);
  return { response: second, retried: true };
}

function extractCandidates(body: TidalSearchResponse): Array<TidalCandidateInput & { id: string }> {
  const items = body.data ?? body.included ?? [];
  return items
    .filter((item): item is TidalCandidateInput & { id: string } =>
      typeof (item as Record<string, unknown>).id === "string",
    )
    .slice(0, MAX_CANDIDATES);
}

function rankCandidates(
  sp: SpotifyTrackRow,
  candidates: Array<TidalCandidateInput & { id: string }>,
): ScoredCandidate[] {
  return candidates
    .map((c) => {
      const breakdown = scoreCandidate(sp, c);
      const tdMs = tidalDurationMs(c);
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

    let body: TidalSearchResponse;
    try {
      body = (await tidalResponse.json()) as TidalSearchResponse;
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
