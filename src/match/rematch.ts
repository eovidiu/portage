// F-025: rematch heuristic.
//
// The operator's hand-tuned trick on tracks that F-007 fuzzy + F-024 manual
// search both miss: instead of querying Tidal with the full
// `<artist> <title>` string (which trips up on featured-artist suffixes,
// parenthetical version markers, and long primary-artist names), search
// with the short query `<firstTwoArtistWords> <firstTitleWord>`. Encoding
// it once as a sweep over the queue turns a per-row keystroke ritual into
// one operator action.
//
// This module is pure: zero DB access, zero Tidal access. The route layer
// composes it with `listPending` (sweep) or `getPendingUnmatched`
// (single-row) plus `searchTidalCandidates`.

import { normaliseTitle } from "./title";
import type { Env } from "../env";
import { listPending } from "../db/unmatched";
import { searchTidalCandidates } from "./tidal-search";
import { mapCandidateToResponseShape, type SearchResponseCandidate } from "../routes/search-mapper";
import { TidalReauthRequired } from "../providers/tidal/oauth";

const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

/**
 * Light artist normalisation: strips control chars + non-letter/digit/
 * whitespace runes, collapses to lower case. Intentionally preserves
 * diacritics so `"Beyoncé"` tokenises to `"beyoncé"` and Tidal still
 * matches the artist resource directly. Mirrors the normaliser used by
 * `artistAgrees` in src/match/artist.ts.
 */
function normaliseArtist(input: string): string {
  return input
    .replace(CONTROL_CHARS_RE, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function tokenise(input: string): string[] {
  return input.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Build the rematch query for a single row. Returns `null` when either side
 * tokenises to zero non-empty tokens — callers MUST treat this as a
 * deterministic per-row error rather than fall back to the full query, so
 * the sweep's behaviour stays auditable.
 *
 * Contract (see openspec/changes/f-025-rematch-heuristic/specs/.../spec.md):
 *   buildRematchQuery("Pink Floyd", "Comfortably Numb - Remaster")
 *     === "pink floyd comfortably"
 *   buildRematchQuery("Beyoncé", "Halo")
 *     === "beyoncé halo"
 *   buildRematchQuery("", "Halo") === null
 */
export function buildRematchQuery(artist: string, title: string): string | null {
  const artistTokens = tokenise(normaliseArtist(artist));
  if (artistTokens.length === 0) return null;

  const titleTokens = tokenise(
    normaliseTitle(title.replace(CONTROL_CHARS_RE, "")).toLowerCase(),
  );
  if (titleTokens.length === 0) return null;

  const artistPart = artistTokens.slice(0, 2).join(" ");
  return `${artistPart} ${titleTokens[0]}`;
}

export type RematchRowError =
  | "invalid_input"
  | "tidal_timeout"
  | "tidal_upstream"
  | "tidal_reauth_required";

export interface RematchRow {
  spotify_id: string;
  spotify_title: string;
  spotify_artist: string;
  spotify_album: string | null;
  query: string | null;
  candidates: SearchResponseCandidate[];
  error: RematchRowError | null;
}

export interface RematchSweepResult {
  items: RematchRow[];
  total_pending: number;
  fetched_at: string;
}

/**
 * Per-row Tidal step. Exported so the single-row route can reuse the same
 * helper and inherit the same error taxonomy. Returns the populated
 * `candidates` + `error` fields on a `RematchRow`-shaped record.
 *
 * `timeoutMs` is honoured by racing the Tidal call against a setTimeout
 * reject. Mirrors F-024's per-request timeout pattern.
 */
export async function searchOneRematch(
  env: Env,
  query: string,
  timeoutMs: number,
  limit: number,
): Promise<
  | { ok: true; candidates: SearchResponseCandidate[]; tidalStatus: number }
  | { ok: false; error: Exclude<RematchRowError, "invalid_input">; tidalStatus: number | null }
> {
  let result;
  try {
    result = await raceWithTimeout(searchTidalCandidates(env, query), timeoutMs);
  } catch (err) {
    if (err instanceof TidalReauthRequired) {
      return { ok: false, error: "tidal_reauth_required", tidalStatus: null };
    }
    if (err instanceof RematchTimeout) {
      return { ok: false, error: "tidal_timeout", tidalStatus: null };
    }
    return { ok: false, error: "tidal_upstream", tidalStatus: null };
  }

  if (result.status >= 400 || result.bodyParseError) {
    return { ok: false, error: "tidal_upstream", tidalStatus: result.status };
  }

  const candidates = result.candidates.slice(0, limit).map(mapCandidateToResponseShape);
  return { ok: true, candidates, tidalStatus: result.status };
}

interface SweepOptions {
  /** Maximum rows the sweep visits. Caller has already clamped to [1, 25]. */
  limit: number;
  /** Per-row Tidal timeout in ms. */
  perRowTimeoutMs: number;
  /** Per-row candidate cap surfaced to the UI. */
  candidatesPerRow: number;
}

/**
 * Iterate pending unmatched rows in `last_attempt_at DESC` order (same as
 * GET /unmatched), apply `buildRematchQuery` per row, and call Tidal for
 * every row that produced a valid query. Partial failures are recorded
 * inline on `RematchRow.error`; the sweep never throws once it starts.
 */
export async function runRematchSweep(
  env: Env,
  totalPending: number,
  options: SweepOptions,
): Promise<RematchSweepResult> {
  const rows = await listPending(env, { limit: options.limit });
  const items: RematchRow[] = [];

  for (const row of rows) {
    const query = buildRematchQuery(row.spotify_artist, row.spotify_title);
    if (query === null) {
      items.push({
        spotify_id: row.spotify_id,
        spotify_title: row.spotify_title,
        spotify_artist: row.spotify_artist,
        spotify_album: row.spotify_album,
        query: null,
        candidates: [],
        error: "invalid_input",
      });
      emitRowLog({
        spotify_id: row.spotify_id,
        q_len: 0,
        result_count: null,
        tidal_status: null,
        error: "invalid_input",
        duration_ms: 0,
      });
      continue;
    }

    const startedAt = Date.now();
    const tidal = await searchOneRematch(
      env,
      query,
      options.perRowTimeoutMs,
      options.candidatesPerRow,
    );
    const duration = Date.now() - startedAt;

    if (tidal.ok) {
      items.push({
        spotify_id: row.spotify_id,
        spotify_title: row.spotify_title,
        spotify_artist: row.spotify_artist,
        spotify_album: row.spotify_album,
        query,
        candidates: tidal.candidates,
        error: null,
      });
      emitRowLog({
        spotify_id: row.spotify_id,
        q_len: query.length,
        result_count: tidal.candidates.length,
        tidal_status: tidal.tidalStatus,
        error: null,
        duration_ms: duration,
      });
    } else {
      items.push({
        spotify_id: row.spotify_id,
        spotify_title: row.spotify_title,
        spotify_artist: row.spotify_artist,
        spotify_album: row.spotify_album,
        query,
        candidates: [],
        error: tidal.error,
      });
      emitRowLog({
        spotify_id: row.spotify_id,
        q_len: query.length,
        result_count: null,
        tidal_status: tidal.tidalStatus,
        error: tidal.error,
        duration_ms: duration,
      });
    }
  }

  return {
    items,
    total_pending: totalPending,
    fetched_at: new Date().toISOString(),
  };
}

export function summariseSweep(result: RematchSweepResult): {
  rows_visited: number;
  ok: number;
  invalid_input: number;
  tidal_upstream: number;
  tidal_timeout: number;
  tidal_reauth_required: number;
} {
  let ok = 0;
  let invalidInput = 0;
  let upstream = 0;
  let timeout = 0;
  let reauth = 0;
  for (const item of result.items) {
    if (item.error === null) ok++;
    else if (item.error === "invalid_input") invalidInput++;
    else if (item.error === "tidal_upstream") upstream++;
    else if (item.error === "tidal_timeout") timeout++;
    else if (item.error === "tidal_reauth_required") reauth++;
  }
  return {
    rows_visited: result.items.length,
    ok,
    invalid_input: invalidInput,
    tidal_upstream: upstream,
    tidal_timeout: timeout,
    tidal_reauth_required: reauth,
  };
}

interface RowLogFields {
  spotify_id: string;
  q_len: number;
  result_count: number | null;
  tidal_status: number | null;
  error: RematchRowError | null;
  duration_ms: number;
}

export function emitRowLog(fields: RowLogFields): void {
  console.log(
    JSON.stringify({
      event: "rematch_row",
      spotify_id: fields.spotify_id,
      q_len: fields.q_len,
      result_count: fields.result_count,
      tidal_status: fields.tidal_status,
      error: fields.error,
      duration_ms: fields.duration_ms,
    }),
  );
}

class RematchTimeout extends Error {
  constructor() {
    super("rematch_timeout");
    this.name = "RematchTimeout";
  }
}

async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RematchTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
