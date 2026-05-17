## ADDED Requirements

### Requirement: Run detail page

The SPA SHALL render a `/runs/:run_id/tracks` route showing the per-track manifest for the specified sync run. The page consumes `GET /sync/runs/:run_id/tracks` (per the `per-run-track-detail` capability) and presents:

- A **run summary header** carrying the run's status, error_code (if any), started_at, finished_at, and item counts. The same data the `/runs` row carried — surfaced again here so the operator doesn't need to keep the list page in another tab.
- A **per-track manifest** rendered as a 5-column table at widths `≥ md` (Spotify track / Status / Method / Tidal id / Confidence). Below `md` the manifest collapses to a stacked-card list via `useMediaQuery`, surfacing the same fields per card.
- Two **filters**: status (matched / unmatched / all) and method (isrc / fuzzy / manual / —). Both URL-synced like the `/runs` and `/captures` filters: `/runs/:run_id/tracks?status=unmatched`.
- **Pagination** at `limit=20` by default, with PREV / NEXT controls and a "PAGE M OF N" indicator matching the `/runs` and `/captures` convention.

The Tidal id cell SHALL render as a link (`<a href="https://tidal.com/track/<tidal_id>" target="_blank" rel="noopener noreferrer">`) when populated. Unmatched rows SHALL surface the `reason` field in place of the Tidal id.

#### Scenario: Direct navigation to a known run
- **WHEN** the operator visits `/runs/<run-id>/tracks` and the Worker returns matched + unmatched rows
- **THEN** the page renders the summary header plus the manifest table with one row per item; the filters default to status=all, method=any

#### Scenario: Filter by unmatched
- **WHEN** the operator clicks the "Unmatched" filter on the detail page
- **THEN** the SPA refetches with `?status=unmatched` and the URL updates to `/runs/<run-id>/tracks?status=unmatched`

#### Scenario: Filter by method
- **WHEN** the operator selects "Fuzzy" from the method filter while status is set to "matched"
- **THEN** the SPA refetches with `?status=matched&method=fuzzy` and the URL syncs

#### Scenario: Unknown run id
- **WHEN** the operator visits `/runs/<nonexistent-id>/tracks` and the Worker returns 404 `{ "error": "run_not_found" }`
- **THEN** the page renders a "Run not found" empty state with a link back to `/runs`, NOT a generic 500

#### Scenario: Mobile stacked-card variant
- **WHEN** the operator visits `/runs/<run-id>/tracks` on a viewport narrower than 768 px
- **THEN** the page renders the manifest as a stacked-card list (one card per row) surfacing the same Spotify / Status / Method / Tidal / Confidence fields in a vertical layout, with the same filters and pagination above

### Requirement: Runs row links to detail

Each row on `/runs` SHALL navigate to `/runs/<run_id>/tracks` when activated. The link SHALL be implemented as a routed `<Link>` so the navigation preserves browser history and is keyboard-accessible. The existing filter URL params on `/runs` SHALL NOT be carried into the detail URL.

#### Scenario: Click a row to drill in
- **WHEN** the operator clicks a row on `/runs`
- **THEN** the SPA navigates to `/runs/<that-run-id>/tracks` and the detail page renders without a full page reload

#### Scenario: Keyboard navigation
- **WHEN** the operator focuses a row on `/runs` and presses Enter
- **THEN** the SPA navigates to the detail page exactly as if the row had been clicked
