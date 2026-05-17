## Context

The fuzzy matcher (`src/match/fuzzy.ts`) ranks up to 5 Tidal candidates per Spotify track. When the top score is below the `ACCEPT_THRESHOLD = 0.85`, the track lands in the `unmatched` table with `reason: "fuzzy_below_threshold"`. The ranked scores are logged to console (event `fuzzy_decision`, fields `top_score` / `second_best_score`) but the actual candidate metadata — Tidal id, title, artist — is discarded the moment the function returns.

Operationally, this is the most expensive information to recompute. By the time the operator looks at a run, the Tidal catalog state may have drifted, fuzzy match weights might have been retuned, and the manual Tidal search (UI-PHASE-8) won't necessarily surface the same near-misses the orchestrator found. Persisting the top 3 at the time of the decision freezes a useful record.

Constraints inherited from existing system:

- `unmatched` is keyed on `spotify_id`; one row per track, regardless of how many runs touched it. The `sync_run_id` column (F-027) records which run last wrote the row. A row that gets re-processed across runs will overwrite its prior candidates with the latest fuzzy ranking — that's correct behavior.
- The `POST /unmatched/:spotify_id/match` endpoint already exists (UI-PHASE-3 / F-016) for the manual-match flow on `/unmatched`. It removes the unmatched row and inserts into `matches` with `method: "manual"`. Today it does NOT carry a `sync_run_id`.
- The orchestrator's fuzzy match writes are inside a `for` loop over tracks; per-row failures are logged but don't abort the run (T-009-24 invariant). Adding a JSONB column doesn't change that flow.

## Goals / Non-Goals

**Goals:**

- Let the operator pick a near-miss candidate from the run-detail page in one click — no separate Tidal search trip.
- Preserve the exact candidate set the fuzzy matcher considered, including score, so the operator can compare the matcher's ranking against their own judgement.
- When the operator picks a candidate from a run's detail page, the resulting manual match SHOULD show up in that run's manifest (matched method=manual) — keeping the run's audit trail accurate.
- Render the candidates inline (no modal, no navigation away) so the operator can scan multiple unmatched rows quickly.

**Non-Goals:**

- Persisting candidates for `no_candidates` rejections — there are no candidates to persist.
- Persisting candidates for ISRC rejections — ISRC either matches or falls through to fuzzy; we already capture the fuzzy candidates downstream.
- Backfilling historical `unmatched` rows with their (now-lost) candidates. Rows that predate this change show no candidates affordance. Documented.
- Multi-select bulk-pick UI — single-click per candidate is enough.
- Showing more than 3 candidates. Three is enough to discriminate; more is noise.
- Auto-suggesting "this is probably the right one" — the operator is the decision-maker. Show scores, let them choose.

## Decisions

### D1: Store candidates as `JSONB` on `unmatched`, not a separate `match_candidates` table

A single nullable column adds zero query complexity (read with the row, no join) and zero index overhead (we never filter on a candidate field). A separate table would force one query per row × runs and a foreign-key cascade on cleanup. JSONB is the right tool when the shape is read-as-blob and never aggregated across rows.

**Alternatives considered:**

- **`match_candidates(spotify_id, sync_run_id, rank, tidal_id, score)`** — relational. Cheaper to query "show me every near-miss across runs" but we don't have that use case. Adds joins to `listRunTracks`.
- **External log retention** — Worker logs already carry `fuzzy_decision` events. Reading them from R2 or Logpush is technically possible but operationally fragile (retention policy, format drift).

### D2: Top 3 (not 5)

Three names fit comfortably on the run-detail row's reason cell at desktop widths and stack cleanly on mobile. With `MAX_CANDIDATES = 5` upstream, slicing 5 → 3 throws away the 4th + 5th, which are the most marginal. Operator decision quality doesn't improve at N>3.

**Alternatives considered:**

- **Top 5** — too tall a list per row; visually overwhelms the table on runs with dozens of failures.
- **Top 1 only** — degenerate; the matcher already picked the top one and rejected it. Operator needs ≥2 to compare.

### D3: Candidates shape — minimal metadata + score

Persisted JSONB row shape:
```json
[
  { "tidal_id": "12345678", "title": "Sweet Caroline", "artist": "Neil Diamond", "album": "Sweet Caroline", "score": 0.84 },
  { "tidal_id": "12345679", "title": "Sweet Caroline (Live)", "artist": "Neil Diamond", "album": "Hot August Night", "score": 0.81 },
  { "tidal_id": "12345680", "title": "Sweet Caroline", "artist": "Bon Jovi", "album": "Cover Sessions", "score": 0.74 }
]
```

Title + artist + album are the human-readable disambiguators. `tidal_id` is the action key (passed back on the manual-match POST). Score lets the operator compare against the threshold.

**Alternatives considered:**

- **Include `duration_ms` and `isrc`** — would help in edge cases but bloats the column. Postponed; can add later without a migration if the storage shape stays JSONB.

### D4: `POST /unmatched/:spotify_id/match` body gains an OPTIONAL `sync_run_id`

Backwards-compatible: existing callers (the manual-match flow on `/unmatched`) send `{ tidal_id }` only. When the body carries `sync_run_id`, the Worker stamps it on the inserted `matches` row so the manual pick belongs to that run.

**Alternatives considered:**

- **New endpoint** `POST /sync/runs/:run_id/manual-match` — clearer but doubles the API surface for one optional field. The single-endpoint approach with an optional discriminator is fine REST.
- **Always-NULL** for manual matches (status quo) — keeps manual matches floating outside any run. The run-detail page would show the row as still unmatched after the pick (the per-run filter only sees rows with the matching `sync_run_id`). That defeats the user-visible feedback loop ("I picked it, why is the row still red?").

### D5: Inline expander, not modal or popover

Expander reuses the same `<details>` semantics the operator already knows from disclosure widgets. No focus-trap complexity, keyboard nav comes for free, accessibility is correct out of the box. Modal/popover would force the operator to dismiss to look at the next row.

**Alternatives considered:**

- **Modal** — heavyweight for what's essentially a sub-list.
- **Always-visible** (no expander) — bloats the table on runs with many `fuzzy_below_threshold` rows.
- **Click-to-navigate to a per-track page** — too much friction.

### D6: Manual-pick action shape — optimistic update + cache invalidation

Same pattern as `useMatchUnmatched` (UI-PHASE-3) and `useTogglePlaylist` (UI-PHASE-13). The picked row is set to matched in the local cache immediately, the POST fires; on success the per-run-tracks query is invalidated (refetches with the new state). On error, the row rolls back and a sonner toast surfaces the message.

**Alternatives considered:**

- **Refetch-only (no optimistic)** — feels laggy. The pick is intentional; we should reflect it instantly.

### D7: Mobile = stacked-card pattern unchanged; candidates render as a vertical sub-list inside the card

Below `md`, the reason cell already collapses into a card field. The expander stays in the same place; expansion reveals the candidate list as a vertical stack of mini-cards, each with a full-width "Use this" button (44px touch target per UI-PHASE-10 convention).

### D8: Operator hint: which candidate would the matcher have picked if threshold were lower?

The candidate with rank 1 is highlighted with a subtle "top fuzzy match" badge. Score is displayed against the threshold (e.g. `0.84` vs threshold `0.85`) so the operator sees how close it was. This is the most important affordance for the original failure pattern — the matcher missed by 0.01.

## Risks / Trade-offs

- **JSONB column unbounded** — operator picks something, row gets pruned from unmatched but the JSONB stays in the moved-to-matches state? No — DELETE FROM unmatched takes the JSONB with it. → Not a risk.
- **Stale candidates after Tidal catalog edits** — a Tidal track in the candidates JSONB might be removed or re-titled by Tidal after the orchestrator captured it → Mitigation: the `tidal_id` is still valid (matches.tidal_id only stores the id). The displayed title/artist may go stale, but the action still works. We don't refetch the candidate metadata at view time.
- **`sync_run_id` propagation could confuse aggregate stats** — matches.sync_run_id is used by F-027's per-run manifest. Adding manual matches with a non-NULL sync_run_id INCREASES the "matched count" for that run after the fact → Acceptable. The run's manifest stays accurate; the historical aggregate count (`stats.match_rate`) is computed at-rest from matches.* anyway, so a recomputation simply picks up the new row. No stat freezes per spec.
- **JSONB validation** — the column accepts any shape. A bug in the orchestrator could write malformed JSON → Mitigation: type assertion in `listRunTracks` (treat unparseable JSONB as empty); SPA defensive check (`candidates?.length > 0 ?`). The DB stays valid as JSON because Postgres validates JSONB at insert time.
- **Operator picks a candidate that's wildly wrong** — manual match is permanent (the unmatched row is removed). Same risk as today's `/unmatched` manual-match flow. The operator can re-process via the existing rematch sweep if needed.

## Migration Plan

1. **Worker repo, single PR**:
   1. `ALTER TABLE unmatched ADD COLUMN IF NOT EXISTS candidates JSONB`. Apply on Neon prod + dev via the temp-branch verify cycle.
   2. Update `db/schema.sql`. Update `UnmatchedRow` interface in `src/db/unmatched.ts` to include optional `candidates`.
   3. Wire `upsertUnmatched` to write the new field on insert + on conflict update.
   4. Update `src/match/fuzzy.ts` to pass `ranked.slice(0, 3)` (projected to the JSONB shape) on the `fuzzy_below_threshold` branch only.
   5. Update `listRunTracks` to project `candidates` on the unmatched half.
   6. Update `POST /unmatched/:spotify_id/match` to accept optional `sync_run_id` and forward to `insertMatch`.
   7. Tests for the orchestrator persistence + GET projection + POST extension.
   8. Open PR, merge, `wrangler deploy`.
2. **UI repo, pre-shipped against MSW**:
   1. Add `UI-PHASE-15` to `.harness/features.json`.
   2. Update `useRunTracks` type. Add `useMatchFromRun` mutation.
   3. Build `RunTrackCandidates` component.
   4. Wire into `RunTracksTable` (desktop + mobile branches).
   5. Tests, PR after Worker side is live, merge, deploy.

**Rollback**:

- Worker: revert the route/db helpers. The `candidates` column is harmless if left in place (nullable, no foreign-key cascade). The orchestrator stops writing it; existing rows keep whatever was already in there.
- UI: revert the PR. The detail page reverts to showing the bare `fuzzy_below_threshold` reason. No SPA dependency on the new shape elsewhere.

## Open Questions

- Should the candidate list also surface on `/unmatched` (the existing manual-match queue) since the same JSONB is now available? Probably yes — but that's a UI-PHASE-16 follow-up, not in scope here. The run-detail page is where the operator most often discovers the rejection.
- Should there be a "regenerate candidates" action that re-runs the fuzzy matcher on demand against today's Tidal state? Out of scope; existing rematch sweep (F-025) covers that need.
- Confidence display: just the raw score, or a "near miss" label when `score >= 0.80`? Score is enough; label is decoration.
