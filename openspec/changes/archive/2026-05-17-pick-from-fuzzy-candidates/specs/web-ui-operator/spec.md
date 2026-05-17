## ADDED Requirements

### Requirement: Run-detail page surfaces fuzzy candidates inline

On `/runs/:run_id/tracks`, each unmatched row whose `reason` is `"fuzzy_below_threshold"` AND whose response carries a non-empty `candidates` array SHALL render an inline "Show 3 candidates" disclosure control. Activating the disclosure expands a sub-list of the persisted candidates. Rows without persisted candidates (other reasons, or rows that predate `pick-from-fuzzy-candidates`) SHALL NOT render the disclosure.

Each candidate entry SHALL display: title, artist, album, the rounded score (e.g. `0.84`), and a "Use this" action. The rank-1 candidate SHALL carry a subtle visual indicator (e.g. an "above threshold by N" or "top fuzzy match" badge) to call out the matcher's preferred pick.

The disclosure SHALL use semantic `<details>`/`<summary>` so it is keyboard-operable and screen-reader-accessible without bespoke focus management.

#### Scenario: Disclosure visible for fuzzy_below_threshold with candidates
- **WHEN** the run-detail manifest contains an unmatched row with `reason: "fuzzy_below_threshold"` and `candidates: [a, b, c]`
- **THEN** the row's reason cell renders a `<details>` element labelled "Show 3 candidates"; expanding it reveals 3 candidate entries each with title, artist, album, score, and a "Use this" button

#### Scenario: No disclosure for no_candidates reason
- **WHEN** the manifest contains an unmatched row with `reason: "no_candidates"` (and therefore no `candidates` field on the response)
- **THEN** the row's reason cell renders the plain `no_candidates` text with NO disclosure control

#### Scenario: No disclosure for historical rows without persisted candidates
- **WHEN** the manifest contains an unmatched row with `reason: "fuzzy_below_threshold"` but the response carries no `candidates` field (row predates the schema add)
- **THEN** the row renders the bare reason text only

### Requirement: "Use this" action persists a manual match against the current run

Clicking "Use this" SHALL POST `/unmatched/<spotify_id>/match` with body `{ "tidal_id": <candidate.tidal_id>, "sync_run_id": <URL run_id> }`. The UI SHALL optimistically transition the row to `status: "matched"`, `method: "manual"`, `tidal_id: <picked>`, then refetch the per-run-tracks query. On error (any non-2xx), the row SHALL roll back to its previous state and a sonner toast SHALL surface the failure reason.

The disclosure SHALL collapse automatically on successful pick so the operator sees the new matched state without an extra interaction.

#### Scenario: Successful pick
- **WHEN** the operator clicks "Use this" on a candidate and the POST returns 200/201
- **THEN** the row in the manifest transitions to `status: "matched"`, `method: "manual"`, with the picked `tidal_id`; the disclosure is collapsed; no error toast appears

#### Scenario: Picked manual match shows up in the same run's manifest
- **WHEN** the operator picks a candidate from `/runs/<run-id>/tracks` and the manual-match POST carries `sync_run_id: <run-id>` (per the `per-run-track-detail` capability)
- **THEN** the next render of the manifest includes the row as matched (the manual match's `sync_run_id` belongs to this run, so the per-run filter keeps it)

#### Scenario: POST failure rolls back the optimistic transition
- **WHEN** the operator clicks "Use this" and the POST returns a non-2xx response
- **THEN** the row reverts to its previous unmatched state with the candidates list still available; a sonner toast surfaces "Failed to apply manual match — please try again"

#### Scenario: Mobile candidate list with full-width "Use this"
- **WHEN** the operator opens the disclosure on a viewport narrower than 768 px
- **THEN** the candidates render as a vertical stack of mini-cards, each with a full-width 44 px "Use this" button (per UI-PHASE-10 touch-target convention)
