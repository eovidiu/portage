## Context

The Worker already has a working Tidal client and a working fuzzy matcher. Three artifacts that constrain this design:

1. **`tidalFetch(env, path, options)`** at [src/providers/tidal/client.ts:47-72](../../../src/providers/tidal/client.ts). Handles per-invocation token cache (F-015 subrequest cap), 401 → cache invalidate + refresh + single retry, `countryCode` auto-injection from `env.TIDAL_COUNTRY_CODE` (default `"RO"`), and the JSON:API `application/vnd.api+json` Accept header. Anything that hits Tidal goes through it.
2. **Existing search call** at [src/match/fuzzy.ts:72-86](../../../src/match/fuzzy.ts). Hits `https://openapi.tidal.com/v2/searchResults/{encodeURIComponent(query)}?include=tracks,tracks.artists,tracks.albums`. Annotated `Verified: 2026-04-27 against tidal-api-oas.json` with a 2026-05-02 prod fix on the compound include paths. Implements the 429 + `Retry-After` single-retry pattern.
3. **Existing route module** at [src/routes/unmatched.ts](../../../src/routes/unmatched.ts). Hono sub-router mounted at `/unmatched` by [src/index.ts](../../../src/index.ts); inherits the F-019 CF Access middleware applied at the router level. Already exports `GET /`, `POST /:spotify_id/match`, `POST /:spotify_id/skip`.

The new endpoint is additive — it slots next to `/match` and `/skip` on the same router so it inherits auth for free.

Tidal API grounding (re-verified 2026-05-15 against vendored OAS at `src/providers/tidal/openapi-types.ts:9521+ , 21077+`):
- Path is `/searchResults/{id}` (camelCase; `searchresults` 404s).
- The `{id}` segment carries the URL-encoded free-text query, not a numeric id.
- Compound `include` paths (`tracks.artists`, `tracks.albums`) are required to resolve artist/album metadata from `included[]` per JSON:API §6.2.
- Upstream pagination is `page[cursor]`, NOT `limit`. Any limit we expose is a client-side slice over the first page.
- Response is `SearchResults_Single_Resource_Data_Document`: `data.relationships.tracks.data[]` carries refs; `included[]` carries full `Tracks_Resource_Object` / `Artists_Resource_Object` / `Albums_Resource_Object` resources.
- Track attributes: `title` (string), `duration` (ISO-8601, parse via `parseIsoDurationMs`), `isrc` (string|null).

## Goals / Non-Goals

**Goals:**
- One new public route `GET /unmatched/:spotify_id/search` that returns a flat candidate list the UI can render directly into a picker, no client-side JSON:API walking.
- Reuse `tidalFetch` and the existing `/searchResults/{id}` shape exactly — no second Tidal call path to maintain.
- Provide a token-bucket rate limit per CF Access principal so one user (or a runaway UI loop) cannot starve the scheduled fuzzy match of upstream quota.
- Validate input strictly so malformed `q` never reaches Tidal.
- Emit structured logs that let us see manual-search funnel metrics (how often the user resorts to manual after fuzzy fails) without leaking the raw query (which can contain user-typed text).

**Non-Goals:**
- No upstream pagination passthrough. v1 returns whatever the first `/searchResults/{id}` page yields, capped client-side at `limit` (default 10, max 25).
- No caching layer. The endpoint is hit on user action; misses are cheap.
- No fix for F-012 R3/R4 (Sprint-7 M1 auto-candidates returning `[]`). That fix lives in a different feature.
- No schema changes. The `unmatched`, `matches`, and `tracks` tables are not touched by this change.
- No client-side debouncing or popover behavior — that's the portage-ui counterpart.
- No "match" mutation. Selection reuses the existing `POST /unmatched/:spotify_id/match`.

## Decisions

### D1 — Mount under `/unmatched/:spotify_id/search`, not `/tidal/search`

The path scopes the search to a specific unmatched track. Three rationales:
- Inherits CF Access auth + 404-on-unknown-spotify_id semantics from the surrounding router's existing handlers.
- The contract pairs with the existing `POST .../match` cleanly; UI logic stays in one mental cluster.
- A top-level `/tidal/*` namespace would invite further proxy endpoints and re-expose the provider as a UI-facing concept. The product framing is "match an unmatched track," not "browse Tidal."

Alternative considered: `GET /tidal/search?q=...`. Rejected: more generic but encourages drift toward a thin Tidal proxy. The `:spotify_id` in the path also lets us return 404 cheaply for stale UI state without consulting Tidal.

### D2 — Extract `searchTidalCandidates(env, query)` helper, used by both fuzzy and manual

The 429+retry dance, the `/searchResults/{id}` URL composition with compound includes, and the JSON:API → flat candidate extraction (`extractCandidates` + `resolveTrack` in [fuzzy.ts:121-147](../../../src/match/fuzzy.ts)) are duplicated logic if the new route inlines them. Extracting to `src/match/tidal-search.ts` (or `src/providers/tidal/search.ts`) gives:
- One place to fix the next "verified against OAS" annotation when Tidal changes the endpoint.
- Fuzzy keeps its scoring; manual gets the raw candidates; both share the upstream call shape.

Signature:
```ts
export async function searchTidalCandidates(
  env: Env,
  query: string,
): Promise<{ candidates: ResolvedTidalCandidate[]; retried: boolean; status: number }>;
```

Alternative considered: inline the pattern in the new handler. Rejected — pasting the 429 retry into a second site is exactly the kind of drift that bit us in the 2026-05-02 compound-include prod incident.

### D3 — Manual response omits `confidence`

`confidence` in `matches` is `scoreCandidate(spotifyTrack, tidalCandidate)` — a function of the source Spotify row. Manual search by free-form `q` has no source row to score against (the user is the scorer). Exposing a stub `confidence: null` or `0` invites the UI to render misleading affordances.

Alternative considered: compute confidence against the *unmatched* track's `tracks` row (it has `title`/`artist`/`album`). Rejected for v1: the user typed a query that may intentionally diverge from the source ("Metallica One Live 1989" when the source is studio "One"); scoring against the source would punish the very escalation the manual endpoint exists to enable.

### D4 — Client-side limit slice, not upstream pagination passthrough

Upstream uses `page[cursor]` opaque cursors. Exposing them requires the UI to round-trip cursors, which couples the contract to a Tidal-specific pagination model. v1 returns the first page sliced to `limit` (default 10, max 25). If real usage shows the first page is consistently too narrow, v2 can add `next_cursor` to the response and pass `page[cursor]` to upstream — additive, non-breaking.

### D5 — Token-bucket rate limit keyed on CF Access email, 10 req/min

Two reasons it's per-principal not global:
- The whole app is single-tenant today, but the limit logic should remain correct if we ever add a second user.
- Per-IP would be fooled by CF's edge — the CF Access email is the most stable identity we have at the Worker.

10/min is generous for human picker use (one search per row, 60s spacing between rows is typical) and tight enough to prevent a runaway UI loop from sustaining a 429 storm at Tidal. Limit is **soft**: exceeding it returns 429 with `Retry-After: <seconds-until-token>`. State lives in a module-scope Map keyed on email; on Workers, that map persists for the warm isolate lifetime (~30s idle). This is good enough for v1; a future iteration can move to KV or Durable Objects if multi-isolate fairness becomes a concern.

### D6 — Manual `q` validation: length 1–200, reject control chars

200 chars matches Spotify's track-name + artist-name combined max plus headroom. Control characters (`/[\x00-\x1F]/`) are stripped *and* rejected (i.e., 400 if any are present, rather than silently sanitizing). Silent sanitization would mask malformed UI behavior; we want it to surface.

### D7 — Structured logging fields, not raw `q`

Log event `manual_search` with fields `spotify_id`, `q_len`, `result_count`, `tidal_status`, `duration_ms`. **Never** log raw `q` or the CF Access email. Rationale: `q` can contain user-typed text that may include unrelated context the user pasted; emails are PII; tokens never get logged anywhere. `q_len` is enough to detect "user typed nothing useful" patterns.

## Risks / Trade-offs

- **Upstream change** → Tidal renames `/searchResults` or changes the JSON:API shape. **Mitigation**: the existing in-repo `openapi-types.ts` is typegen from the canonical OAS; we re-run typegen and the type errors surface in `tidal-search.ts`. The 2026-04-27 / 2026-05-02 annotation pattern in `fuzzy.ts` shows the team practice of dated verification — F-024 adopts the same.
- **429 cascade between fuzzy + manual** → A user spam-clicks "Search" right before the cron-driven fuzzy run, exhausting Tidal quota for both. **Mitigation**: per-principal rate limit (D5) bounds manual traffic; fuzzy already has its own 429 deferral.
- **In-isolate rate limit drifts across cold starts** → A user gets `10*N` queries instead of 10 if Workers spawns N isolates concurrently. **Mitigation**: acceptable for v1 (single-tenant); upgrade path to KV/DO is non-breaking.
- **Refactor risk on fuzzy** → Extracting `searchTidalCandidates` from `fuzzy.ts` touches a hot path with 637 passing tests. **Mitigation**: refactor is `tasks.md` task #2 with a re-run of the full fuzzy test suite before any new handler code lands. If the refactor proves too invasive, fall back to inlining the pattern in the new handler and file a follow-up to extract later. The spec does not mandate the refactor — only the behavior.
- **`q` containing PII** → User pastes their email or other personal text into the picker. **Mitigation**: D7 logging discipline (no raw `q` in logs) is the structural guard; spec §R6 makes it a hard requirement.
- **Manual search masks broken auto-candidates** → If F-012 R3/R4 (auto-candidates) stays broken indefinitely, the manual endpoint becomes a crutch that erodes the user's incentive to fix it. **Mitigation**: this is product, not engineering. Out of scope for F-024.

## Migration Plan

- **Deploy**: wrangler deploy after vitest green; no DB migration; no secret changes. CF Access (F-019) already protects the router.
- **Rollback**: revert the route + helper. The new helper module can be deleted; fuzzy continues to work because the refactor (D2) is behaviorally identical and re-introduces the inlined pattern on revert.
- **Verification post-deploy**: hit `/healthz` (F-014) to confirm worker is up; hit `/unmatched/<known-id>/search?q=Metallica+One` with a CF Access session and confirm a non-empty `candidates[]`; check Worker logs for `event: "manual_search"` with no `q` field present.

## Open Questions

- **None blocking implementation.** Two product-level questions that may surface during UI integration but do not gate spec sign-off:
  - Should the UI pre-fill `q` with `<artist> <title>` from the unmatched row, or start blank? (UI side; not this spec's concern.)
  - When the user selects a candidate that turns out to already be matched to a *different* Spotify track, do we 409 or accept? Current `POST .../match` behavior governs — this spec adds no new conflict semantics.
