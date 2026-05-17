## Context

F-024 (manual Tidal catalog search) shipped 2026-05-15 and gives the operator
a free-form picker on every unmatched row. In practice the operator's query
is rarely free-form: a recurring rescue pattern is "first two artist words +
first song word" — short enough to dodge featured-artist suffixes and
parenthetical version markers, specific enough that Tidal's relevance
ranking pins the canonical recording on top.

Encoding that heuristic as a sweep over the queue (not a per-row keystroke)
is the smallest change that turns the manual ritual into one operator action
per session.

## Goals / Non-Goals

**Goals**

- Encode the "first two artist words + first title word" heuristic as a
  pure, unit-testable function shared by sweep and per-row endpoints.
- Provide a bulk sweep that returns candidates for up to 25 pending rows in
  one operator action while staying inside the 50-subrequest Workers budget.
- Reuse the F-024 response shape so the UI's existing candidate-row component
  can render rematch candidates without a new mapper.
- Stay read-only — no DB writes, no auto-match — so the operator stays in
  the loop on every selection.

**Non-Goals**

- Auto-match on a confidence threshold (F-007's job; the rematch heuristic
  doesn't score candidates, it just surfaces them).
- Cache results across calls. Rematch is operator-driven and infrequent.
- Build a per-principal rate-limit bucket distinct from F-024's. The sweep
  cap (25 rows × 1 upstream call each = 25 outbound calls per sweep) plus
  the CF Access edge gate cover the relevant abuse paths for a single-tenant
  deployment.

## Decisions

### D1: Heuristic is `firstTwoArtistWords + " " + firstTitleWord`

Why this exact shape:

- "First two artist words" covers the common pattern where a primary artist's
  name is two words (`"Pink Floyd"`, `"Iron Maiden"`, `"Daft Punk"`) and
  drops trailing `feat.`/`ft.`/comma-separated collaborator chains that
  Tidal indexes poorly.
- "First title word" drops parenthetical version qualifiers, remaster years,
  and "- Single Version" suffixes — all already stripped by `normaliseTitle`
  before splitting.
- The two pieces are joined by a single space (no quotes, no Tidal-specific
  search operators) so the request format matches what F-024 already proxies.

**Edge cases the helper handles deterministically:**

| Input artist | Input title | Built query |
|---|---|---|
| `"The Rolling Stones"` | `"Paint It, Black"` | `"the rolling paint"` |
| `"Beyoncé"` (single word) | `"Halo"` | `"beyoncé halo"` |
| `"Drake feat. Lil Wayne"` | `"HYFR"` | `"drake feat hyfr"` (normalised before split) |
| `""` (empty artist) | `"X"` | `null` — caller skips/marks the row as `invalid_input` |
| `"A B"` | `""` | `null` |

When the helper returns `null` (degenerate input), the route skips the
upstream call entirely and includes the row in the response with
`error: "invalid_input"` instead of `candidates`. This keeps the response
deterministic and lets the UI surface "we couldn't even form a query" as a
distinct state from "Tidal returned zero candidates".

### D2: Sweep cap = 25, default = 10

Workers free tier allows 50 subrequests per invocation. The sweep makes one
Tidal `searchTidalCandidates` call per row. A cap of 25 leaves 25 budget
headroom for the existing 401-refresh path on tidalFetch (worst case ~2x
per call) and for any future per-call overhead. Default 10 keeps the typical
operator interaction fast (~3s upper bound at 300ms/row) while letting
power-users opt into the full 25 by passing `limit=25` explicitly.

### D3: Iteration order = `last_attempt_at DESC`

Same order F-012 uses for `GET /unmatched`. Operators looking at the queue
in the UI and clicking "Run rematch" expect the sweep to act on what they
see at the top of the list. Reusing `listPending(env, { limit })` keeps the
ordering invariant in one place.

### D4: Per-row errors are inline, not exceptions

A single Tidal hiccup mid-sweep must NOT abort the whole sweep. Each row's
result is one of three shapes:

```
{ spotify_id, ..., query: "...", candidates: [...] }            // happy path
{ spotify_id, ..., query: "...", candidates: [], error: "tidal_upstream" } // upstream hiccup
{ spotify_id, ..., query: null,  candidates: [], error: "invalid_input" }  // helper rejected the input
```

`error` is one of a closed set: `"invalid_input"`, `"tidal_timeout"`,
`"tidal_upstream"`, `"tidal_reauth_required"`. The route still returns 200
because the sweep itself succeeded; per-row failures are data, not transport
errors. The summary log line includes counts per error category so an
operator can see "20 rows, 3 invalid_input, 1 tidal_upstream, 16 ok" at a
glance.

### D5: Reuse F-024 response shape for candidates

Each row's `candidates` array contains `SearchResponseCandidate` objects
(produced by `mapCandidateToResponseShape`). This means the UI's existing
"Use" affordance — which already knows how to call
`POST /unmatched/:spotify_id/match` with a `tidal_id` — works on rematch
candidates without modification. The only new UI work is rendering one
extra wrapper per row.

### D6: No new rate-limit bucket

F-024 introduced a per-principal token bucket on the per-row search route.
The sweep makes up to 25 upstream calls in a tight loop, but it's still
one operator action (one button click). Adding a separate bucket would
make the sweep brittle (a half-completed sweep is worse than a 429-fast-
fail), and the CF Access edge already prevents anonymous abuse. The
per-row `GET /unmatched/:spotify_id/rematch` variant DOES take a token
from the existing F-024 bucket because it's keystroke-driven (matching
F-024's threat model).

## Risks / Trade-offs

- **R1: Heuristic over-recovers wrong songs.** A short query is by design
  ambiguous. Mitigation: the route is read-only; nothing is committed until
  the operator clicks "Use" on a specific candidate. The risk is operator
  time spent rejecting noise, not silent data corruption.
- **R2: Sweep latency.** 25 sequential Tidal calls at ~300ms each is ~7.5s
  upper bound. Workers free tier allows 30s CPU + 30s wall on scheduled
  workers but front-end requests are bounded at 30s. The 25 cap stays
  comfortably inside that envelope. Future work: parallelise with
  `Promise.allSettled` if real-world p95 exceeds 5s.
- **R3: Cross-repo drift on candidate shape.** Already mitigated by sharing
  the F-024 mapper. A breaking change to the candidate shape would have to
  ship through both repos' OpenSpec changes in lockstep — the existing
  F-024 pattern.

## Migration Plan

- The two routes are additive. No deployment ordering required between the
  Worker and the UI: the UI gracefully shows "Rematch unavailable" if the
  route 404s (the Worker hasn't shipped yet); the Worker accepts requests
  to the route even when no UI client is calling it.
- No DB migrations.
- No config or secret additions.
