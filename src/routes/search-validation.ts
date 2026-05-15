// F-024 R2: input validation for GET /unmatched/:spotify_id/search.
//
// Two validators, both fail-closed: any non-string, out-of-range, or
// control-char input becomes a 400 before we touch Tidal upstream.

const Q_MAX_LEN = 200;
const LIMIT_DEFAULT = 10;
const LIMIT_MIN = 1;
const LIMIT_MAX = 25;
const CONTROL_CHARS = /[\x00-\x1F]/;

export type QueryValidation =
  | { ok: true; q: string }
  | { ok: false; error: "invalid_query"; message: string };

export type LimitValidation =
  | { ok: true; limit: number }
  | { ok: false; error: "invalid_limit"; message: string };

export function validateSearchQuery(raw: unknown): QueryValidation {
  if (typeof raw !== "string") {
    return { ok: false, error: "invalid_query", message: "q is required" };
  }
  const q = raw.trim();
  if (q.length === 0) {
    return { ok: false, error: "invalid_query", message: "q must not be empty" };
  }
  if (q.length > Q_MAX_LEN) {
    return {
      ok: false,
      error: "invalid_query",
      message: `q must be at most ${Q_MAX_LEN} characters`,
    };
  }
  if (CONTROL_CHARS.test(q)) {
    return {
      ok: false,
      error: "invalid_query",
      message: "q must not contain control characters",
    };
  }
  return { ok: true, q };
}

export function validateSearchLimit(raw: unknown): LimitValidation {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, limit: LIMIT_DEFAULT };
  }
  if (typeof raw !== "string" && typeof raw !== "number") {
    return { ok: false, error: "invalid_limit", message: "limit must be an integer" };
  }
  const str = String(raw);
  if (!/^-?\d+$/.test(str)) {
    return { ok: false, error: "invalid_limit", message: "limit must be an integer" };
  }
  const n = parseInt(str, 10);
  if (n < LIMIT_MIN || n > LIMIT_MAX) {
    return {
      ok: false,
      error: "invalid_limit",
      message: `limit must be between ${LIMIT_MIN} and ${LIMIT_MAX}`,
    };
  }
  return { ok: true, limit: n };
}
