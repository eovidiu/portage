## Why

When F-007 fuzzy matching rejects a track and F-012's auto-candidate fetch is unavailable (Sprint-7 M1: candidates return `[]`), the only path to resolution is for the user to leave portage, search Tidal in another browser tab, copy the track id, and paste it into the Unmatched page's "Paste Tidal track id" field. This is a daily friction point on a tool whose entire purpose is to make Spotify→Tidal sync invisible. A server-side proxy that lets the UI request candidate matches on-demand — using whatever query string the user types — closes the loop without exposing Tidal credentials to the browser.

## What Changes

- **NEW** route `GET /unmatched/:spotify_id/search?q=...&limit=...` on the Worker, mounted alongside existing `/match` and `/skip` in [src/routes/unmatched.ts](../../../src/routes/unmatched.ts).
- Validates the caller's query (length 1–200, no control chars) and clamps `limit` (default 10, max 25).
- Calls Tidal's catalog search via the existing `tidalFetch()` wrapper and the same `/v2/searchResults/{id}?include=tracks,tracks.artists,tracks.albums` endpoint F-007 fuzzy already uses.
- Maps the Tidal JSON:API response into a flat candidate list `{ tidal_id, title, artists[], album, duration_ms, isrc }` — explicitly **omits** `confidence` (that field is fuzzy-only; manual search has no source track to score against).
- Honors Tidal's `429 + Retry-After` semantics with a single retry, then surfaces 429 to the caller.
- Adds a token-bucket rate limit (10 req/min) keyed on the CF Access authenticated email so a single user cannot hammer Tidal upstream.
- Registers feature `F024` in [.harness/features.json](../../../.harness/features.json) with `depends_on: []`.

Non-goals: no caching, no auto-retry beyond a single 429, no schema changes, no fix for F-012's broken auto-candidates (Sprint-7 M1 is separate work), no client-side debouncing (UI concern owned by the portage-ui counterpart).

## Capabilities

### New Capabilities
- `tidal-catalog-search`: server-side proxy for Tidal's catalog search that lets the authenticated UI fetch candidate Tidal tracks for an unmatched Spotify track using a free-form query. Owns query validation, upstream proxy mapping, rate limiting, error taxonomy, and structured observability.

### Modified Capabilities
<!-- None. F-012 (unmatched queue) is referenced as a peer but its requirements are not changing — the new endpoint is additive. -->

## Impact

- **Affected code**: [src/routes/unmatched.ts](../../../src/routes/unmatched.ts) (new handler), [src/match/fuzzy.ts](../../../src/match/fuzzy.ts) (refactor opportunity to extract a shared `searchTidalCandidates` helper used by both fuzzy match and the new manual route — design.md elaborates), [src/providers/tidal/client.ts](../../../src/providers/tidal/client.ts) (reused unchanged).
- **APIs**: new public route `GET /unmatched/:spotify_id/search`; the existing `POST /unmatched/:spotify_id/match` is reused for selection (no new write path).
- **Dependencies**: none added. Reuses `tidalFetch`, the existing token cache + 401 refresh, and `src/match/json-api.ts` helpers (`parseIsoDurationMs`, `buildIncludedIndex`, `lookupIncluded`).
- **Cross-repo**: a sibling OpenSpec change `web-ui-tidal-search` in [portage-ui](https://github.com/eovidiu/portage-ui) consumes this endpoint. Both specs bind to the same response contract; cross-repo drift is the primary risk and is mitigated by the verification step in the plan.
- **Operational**: adds one upstream provider call per row the user opts to research manually. No scheduled-execution impact (this endpoint is only hit from the UI on user action).
- **Security**: CF Access (F-019) gates the route; Tidal bearer token never leaves the Worker; rate limit prevents a single principal from triggering Tidal-side throttling that would degrade fuzzy match in the next scheduled run.
