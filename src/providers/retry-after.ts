// Bounds the single 429 + Retry-After retry that every provider call site
// implements. Spotify penalty-boxes hammered apps with Retry-After values of
// minutes to hours; sleeping through one keeps the isolate alive in a
// setTimeout until Cloudflare evicts it with nothing recorded — the
// 2026-07-27..29 sync runs died exactly this way (one wall_time_exceeded at
// the 300 s guard, then three silent abandons). A penalty longer than the cap
// means the call must take its existing second-429 path immediately and let
// the next cron retry instead.
export const MAX_RETRY_AFTER_S = 30;

/**
 * Milliseconds to sleep before the single 429 retry, or null when the
 * advertised penalty exceeds MAX_RETRY_AFTER_S — the caller MUST NOT sleep
 * and takes its second-429 path directly. Absent or malformed headers fall
 * back to 1 s, matching the previous per-site parseInt(header ?? "1") logic.
 */
export function retryAfterMs(header: string | null): number | null {
  const parsed = parseInt(header ?? "1", 10);
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  return seconds > MAX_RETRY_AFTER_S ? null : seconds * 1000;
}
