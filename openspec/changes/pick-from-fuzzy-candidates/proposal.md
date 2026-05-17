## Why

The run-detail page (UI-PHASE-14 / F-027) tells the operator that a track landed in `unmatched` with reason `fuzzy_below_threshold`, but stops there. The fuzzy matcher actually *ranked* Tidal candidates before rejecting them — top scored 0.84, threshold is 0.85, so the operator sees nothing — yet that 0.84 candidate is very likely the right answer. Today the only way to recover is to leave the run-detail page, go to `/unmatched`, use the manual Tidal search (UI-PHASE-8) and re-discover what the matcher already considered. That's wasted work and lost information.

This change persists the top-3 ranked candidates at the moment of the fuzzy rejection and surfaces them inline on the run-detail page, with a one-click "Use this" action that records a manual match against the original run.

## What Changes

- **Worker schema add**: `unmatched.candidates JSONB` storing the top 3 ranked candidates from the failed fuzzy match. Shape per element: `{tidal_id, title, artist, album, score}`. NULL when not applicable (rows that landed unmatched for `no_candidates`, manual `/unmatched/:id/skip`, or rows that predate this change).
- **Orchestrator wiring**: when the fuzzy matcher writes an unmatched row with `reason: fuzzy_below_threshold`, it persists `ranked.slice(0, 3)` alongside the existing fields. No change to the `no_candidates` path (those have nothing to persist).
- **GET `/sync/runs/:run_id/tracks` response shape gains a `candidates` field** on unmatched rows when the underlying `unmatched.candidates` JSONB is non-null. Absent on matched rows and on unmatched rows where candidates weren't recorded (e.g. `no_candidates`, manual skip, pre-existing rows).
- **POST `/unmatched/:spotify_id/match` accepts an optional `sync_run_id` field** in the body. When provided, the resulting `matches` row carries that `sync_run_id` so manual picks from a run-detail page populate that run's manifest. The existing body shape (`{ tidal_id: string }`) stays backwards-compatible.
- **UI**: on `/runs/:run_id/tracks`, each unmatched row with `reason: "fuzzy_below_threshold"` AND a non-empty `candidates` array gains an expandable "Show 3 candidates" affordance. Expanding lists each candidate with its title, artist, album, score, and a "Use this" button. Clicking the button POSTs `/unmatched/:spotify_id/match` with the candidate's `tidal_id` plus the URL's `run_id`, optimistically flips the row to matched, then refetches the manifest.

## Capabilities

### Modified Capabilities

- `per-run-track-detail`: orchestrator persists top-3 candidates on `fuzzy_below_threshold` rejection; GET response shape adds `candidates` on unmatched rows when present.
- `web-ui-operator`: run-detail page surfaces the candidate list with a per-candidate manual-match action. New requirement that `POST /unmatched/:id/match` propagates the URL's `run_id` when invoked from this surface.

## Impact

**Worker repo (`portage`):**
- DB migration: `ALTER TABLE unmatched ADD COLUMN IF NOT EXISTS candidates JSONB`. No index needed (always queried with the row, never filtered on).
- `src/db/unmatched.ts` — `UnmatchedRow` interface gains an optional `candidates` field; `upsertUnmatched` writes it on insert + on conflict update.
- `src/match/fuzzy.ts` — the `fuzzy_below_threshold` branch passes `ranked.slice(0, 3).map(...)` as `candidates`. The `no_candidates` branch keeps `candidates: undefined`.
- `src/routes/unmatched.ts` — `POST /unmatched/:spotify_id/match` accepts an optional `sync_run_id` body field and threads it through `insertMatch`.
- `src/db/sync_runs.ts` — `listRunTracks` projects the `candidates` JSONB on the unmatched half. Type `RunTrackUnmatchedRow` gains `candidates?: Array<{...}>`.
- Tests for the new orchestrator behavior + POST body extension + GET projection.
- No new Worker harness feature — this is a focused extension of F-027 (`F-027a candidate-replay` if we want a sub-id, or just an amendment to F-027).

**UI repo (`portage-ui`, this repo):**
- `src/hooks/useRunTracks.ts` — `RunTrackUnmatched` type gains optional `candidates`.
- New component `src/components/RunTrackCandidates.tsx` rendering the inline expander + candidate list + per-row "Use this" action.
- `src/components/RunTracksTable.tsx` — wires the candidate expander into the row's reason cell (desktop) and into the card's reason block (mobile).
- New hook `src/hooks/useMatchFromRun.ts` — mutation that wraps the existing `useMatchUnmatched` pattern but propagates the run_id and invalidates the per-run-tracks cache on success.
- `tests/mocks/operator.ts` extended with handlers that surface candidates on the unmatched rows + a manual-match handler that accepts `sync_run_id`.
- New tests under `tests/components/RunTrackCandidates.test.tsx` and additions to `tests/pages/RunTracksPage.test.tsx`.

**Cross-repo sequencing:**
- Worker side ships first (schema + orchestrator + GET projection + POST extension). UI side pre-ships against MSW mocks, opens PR after the Worker is live. Same model as F-026 / F-027.
