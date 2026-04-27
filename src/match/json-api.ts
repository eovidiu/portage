/**
 * JSON:API resolution helpers shared by ISRC and fuzzy matchers.
 *
 * Tidal Open API v2 returns JSON:API documents (`application/vnd.api+json`):
 * each resource has nested `attributes` + `relationships`, and related full
 * resources live in a top-level `included[]` array when the request asks for
 * them via `?include=...`. Both isrc.ts and fuzzy.ts need to:
 *   - parse ISO-8601 durations (`PT3M40S`)
 *   - look up referenced resources by `(type, id)` from `included[]`
 *
 * Source for the contract:
 *   https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json
 *   (see also `src/providers/tidal/openapi-types.ts` — generated types).
 */

const ISO_DURATION_RE = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/;

export interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    { data?: Array<{ id: string; type: string }> | { id: string; type: string } }
  >;
}

export type IncludedIndex = Map<string, JsonApiResource>;

/**
 * Parse an ISO-8601 duration of the form `PT[H]H[M]M[S]S` to milliseconds.
 * Returns null for non-strings, malformed strings, or `PT` with no components.
 * Fractional seconds are supported (e.g., `PT3M40.5S` → 220500).
 */
export function parseIsoDurationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO_DURATION_RE.exec(value);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const seconds = m[3] ? parseFloat(m[3]) : 0;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

/**
 * Build a lookup table over a JSON:API `included[]` array, keyed by `type:id`.
 * Resources missing an `id` or `type` are skipped defensively.
 */
export function buildIncludedIndex(
  included: JsonApiResource[] | undefined,
): IncludedIndex {
  const index: IncludedIndex = new Map();
  if (!included) return index;
  for (const r of included) {
    if (typeof r?.id !== "string" || typeof r?.type !== "string") continue;
    index.set(`${r.type}:${r.id}`, r);
  }
  return index;
}

/** Look up a resource from an IncludedIndex by `type` and `id`. */
export function lookupIncluded(
  index: IncludedIndex,
  type: string,
  id: string,
): JsonApiResource | undefined {
  return index.get(`${type}:${id}`);
}
