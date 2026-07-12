# sync-notifications

## ADDED Requirements

### Requirement: Notification configuration is optional and secret-safe
The Worker SHALL read three optional environment values: `NTFY_TOPIC` (Worker secret),
`NTFY_URL` (defaulting to `https://ntfy.sh` when unset), and `NTFY_TOKEN` (Worker
secret). When `NTFY_TOPIC` is unset, the notification capability SHALL be a complete
no-op: no outbound request, no log line, and no change to sync behavior. The topic
value MUST NOT appear in any log line.

#### Scenario: NTFY_TOPIC unset
- **WHEN** a sync run completes and `NTFY_TOPIC` is not configured
- **THEN** no request is made to any ntfy endpoint and the run result is unchanged

#### Scenario: Default base URL
- **WHEN** `NTFY_TOPIC` is set and `NTFY_URL` is unset
- **THEN** the notification is POSTed to `https://ntfy.sh/{NTFY_TOPIC}`

#### Scenario: Bearer auth
- **WHEN** `NTFY_TOKEN` is set
- **THEN** the publish request carries `Authorization: Bearer {NTFY_TOKEN}`

#### Scenario: No auth header without token
- **WHEN** `NTFY_TOKEN` is unset
- **THEN** the publish request carries no `Authorization` header

### Requirement: Every finished sync run publishes an outcome notification
After `runSync` produces a final result with outcome `succeeded`, `partial`, or
`failed`, the Worker SHALL publish one notification to `{NTFY_URL}/{NTFY_TOPIC}` via
HTTP POST with headers per https://docs.ntfy.sh/publish/: `Title` of
`Portage sync {outcome}`, `Priority` of `2` for `succeeded` and `4` for `partial` and
`failed`, and `Tags` of `white_check_mark` / `warning` / `rotating_light`
respectively. The plain-text body SHALL include the run counts (tracks seen, ISRC
matches, fuzzy matches, unmatched, errors), the `error_code` when present, and the
`run_id`. Because both the scheduled handler and `POST /sync/run` invoke `runSync`,
this requirement covers scheduled runs, manual runs, and manual runs that outlive the
route's 25 s response race. An outcome of `skipped_locked` SHALL NOT publish.

#### Scenario: Scheduled run succeeds
- **WHEN** a cron-triggered run finishes with outcome `succeeded`
- **THEN** one POST is made to `{NTFY_URL}/{NTFY_TOPIC}` with `Title: Portage sync succeeded`, `Priority: 2`, `Tags: white_check_mark`, and a body containing the counts and run_id

#### Scenario: Run fails
- **WHEN** a run finishes with outcome `failed` and error_code `spotify_reauth_required`
- **THEN** one POST is made with `Title: Portage sync failed`, `Priority: 4`, `Tags: rotating_light`, and a body containing `spotify_reauth_required` and the run_id

#### Scenario: Run partial
- **WHEN** a run finishes with outcome `partial`
- **THEN** one POST is made with `Title: Portage sync partial`, `Priority: 4`, `Tags: warning`

#### Scenario: Lock contention is silent
- **WHEN** `runSync` returns outcome `skipped_locked`
- **THEN** no notification is published

### Requirement: Abandoned-run sweeps publish an alert
When the pre-run `markAbandonedRuns` sweep marks one or more rows abandoned, the
Worker SHALL publish a notification with `Title` reporting the swept count,
`Priority: 4`, and `Tags: ghost`, before the new run's outcome notification. A sweep
of zero rows SHALL NOT publish.

#### Scenario: Sweep catches an isolate-killed run
- **WHEN** `markAbandonedRuns` returns 1
- **THEN** a notification with Priority 4 and a title containing the count is published

#### Scenario: Clean sweep
- **WHEN** `markAbandonedRuns` returns 0
- **THEN** no sweep notification is published

### Requirement: Notification failures never affect the sync
A failed, refused, or timed-out publish SHALL NOT change the run's outcome, stored
`sync_runs` row, or the caller-visible result/response. The publish request SHALL be
aborted after at most 5 seconds. Every publish failure SHALL emit one structured
`ntfy_notify_failed` log line that includes the error message and MUST NOT include the
topic.

#### Scenario: ntfy endpoint unreachable
- **WHEN** the POST to ntfy rejects (network error)
- **THEN** `runSync`'s result is identical to the no-notification case and a `ntfy_notify_failed` log line is emitted

#### Scenario: ntfy returns HTTP 429
- **WHEN** the POST resolves with a non-2xx status
- **THEN** the run result is unchanged and a `ntfy_notify_failed` log line is emitted

### Requirement: Orchestrator crash still notifies
If `runSync`'s pre-lock section throws (e.g. the database is unreachable before a run
row exists), the Worker SHALL attempt a `failed`-style notification describing the
crash and then rethrow the original error so existing caller behavior is preserved.

#### Scenario: acquireLock throws
- **WHEN** `runSync` throws before producing a result
- **THEN** a Priority 4 notification is attempted and the error still propagates to the caller
