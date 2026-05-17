## ADDED Requirements

### Requirement: Captures viewer page

The SPA SHALL render a `/captures` route showing a paginated list of
captures sourced from `GET /captures?limit=&offset=&source=&status=`. Each
row displays `captured_at`, `source`, `match_status`, the Spotify track
metadata (artist + title), and `context_note`.

#### Scenario: Empty captures
- **WHEN** `/captures` returns an empty array
- **THEN** the page displays an empty-state message "No captures yet"

#### Scenario: Captures with rows
- **WHEN** `/captures` returns N rows
- **THEN** the page renders N rows in reverse-chronological order

### Requirement: Filter by source

The page SHALL provide a dropdown filter for `source` with the values
`siri`, `share_sheet`, `shortcut`, `manual`, and an "all" option that
clears the filter. Selecting a value updates the URL and the query.

#### Scenario: Filter by siri
- **WHEN** the operator selects "siri" from the source filter
- **THEN** the SPA fetches `/captures?limit=20&offset=0&source=siri` and
  the URL updates to `/captures?source=siri`

### Requirement: Filter by match_status

The page SHALL provide a filter for `match_status` with the values
`matched`, `unmatched`, `pending`, and an "all" option.

#### Scenario: Filter by unmatched
- **WHEN** the operator selects "unmatched"
- **THEN** the SPA fetches `/captures?limit=20&offset=0&status=unmatched`

### Requirement: Safe rendering of context_note

The page SHALL render `context_note` strings using default React text
escaping. The component MUST NOT use `dangerouslySetInnerHTML` or any
equivalent HTML-injection sink. Display SHALL truncate to 500 characters
(the same limit the Worker enforces on POST).

#### Scenario: context_note containing HTML markup
- **WHEN** a row's `context_note` contains the string
  `<script>alert(1)</script>`
- **THEN** the page renders the literal characters
  `<script>alert(1)</script>` as text and no script executes
