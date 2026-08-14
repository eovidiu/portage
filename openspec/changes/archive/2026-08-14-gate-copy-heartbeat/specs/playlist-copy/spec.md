## ADDED Requirements

### Requirement: Active-job flag gates database access
The Worker SHALL maintain an advisory flag in a Cloudflare KV namespace recording whether a
non-terminal copy job exists. The flag SHALL be armed when a copy job is created and released on
every transition into a terminal status. The flag SHALL be treated as a cache of `copy_jobs` and
never as a source of truth: any KV failure — read error, write error, or an unbound namespace —
SHALL be reported as "an active job may exist" so the caller falls through to the authoritative
Postgres query. No KV failure may fail a copy job, reject an API request, or abort a tick.

#### Scenario: Flag armed on job creation
- **WHEN** a copy job row is successfully inserted
- **THEN** the active-job flag is present in KV

#### Scenario: Losing the single-active race does not arm the flag
- **WHEN** the insert is rejected by the single-active-job unique index
- **THEN** no flag is written and the request still returns `409 { error: "job_already_active" }`

#### Scenario: Flag released on a terminal transition
- **WHEN** a job moves to `completed`, `completed_with_unmatched`, `failed`, or `cancelled`
- **THEN** the active-job flag is removed from KV

#### Scenario: Non-terminal transition retains the flag
- **WHEN** a job moves from `matching` to `writing`
- **THEN** the active-job flag remains present, so later ticks still see the live job

#### Scenario: KV failure never breaks correctness
- **WHEN** the KV namespace is unavailable or unbound at any call site
- **THEN** job creation, cancellation and status transitions all succeed, the failure is logged,
  and the tick falls back to querying `copy_jobs` exactly as it did before this capability existed

#### Scenario: A lost flag write is recovered
- **WHEN** the flag write is lost but a non-terminal job exists in the database
- **THEN** reading that job through the job inspection API re-arms the flag, and the twice-daily
  sync path reconciles the flag from `copy_jobs` as a backstop

## MODIFIED Requirements

### Requirement: Chunked execution on a dedicated cron
A `*/5 * * * *` cron schedule SHALL drive `runCopyTick`. `scheduled.ts` SHALL
dispatch on `controller.cron`: the existing two schedules keep invoking `runSync`
unchanged. A tick SHALL read the active-job flag before any database access and, when the flag is
absent, SHALL return without performing **any** Neon query and without acquiring the lock — an idle
heartbeat SHALL cost zero database work, because Neon's free plan autosuspends only after five
minutes of inactivity and a query every five minutes holds the compute awake permanently. When the
flag is present the tick SHALL query `copy_jobs` for the authoritative answer; if that query finds
no non-terminal job the tick SHALL clear the stale flag before returning. A tick
SHALL acquire the same Postgres advisory lock as the sync engine and skip (not fail)
when it is held. Each tick SHALL advance exactly one phase step (fetch one source
page, or match one batch, or write one batch) within the documented budget
(`COPY_BATCH_ISRC`/`COPY_BATCH_FUZZY` env-tunable, defaults 2), persisting all state
before the tick ends. The fetch cursor SHALL only advance atomically with the
persistence of that page's rows.

#### Scenario: Idle tick performs no database work
- **WHEN** the copy cron fires and the active-job flag is absent
- **THEN** the tick performs zero Neon queries, does not acquire the lock, and exits

#### Scenario: Stale flag is self-healed
- **WHEN** the copy cron fires with the flag present but no `copy_jobs` row is non-terminal
- **THEN** the tick clears the flag and exits, so subsequent idle ticks perform no database work

#### Scenario: Lock contention skips the tick
- **WHEN** the copy cron fires while a sync run holds the advisory lock
- **THEN** the tick exits without processing and the job resumes on a later tick

#### Scenario: Job progresses across ticks
- **WHEN** an active job exists in phase `fetching` with a stored cursor
- **THEN** the tick fetches exactly one source page, persists its tracks and the new
  cursor atomically, and leaves the job resumable

#### Scenario: Sync crons unaffected
- **WHEN** either of the two original cron expressions fires
- **THEN** `runSync` executes exactly as before this change

### Requirement: Job completion and terminal states
When every track reaches a terminal per-track state, the job SHALL finish as
`completed` (zero unmatched) or `completed_with_unmatched`, with `finished_at` set.
Provider-fatal errors (revoked token, playlist deleted) SHALL land the job in
`failed` with an `error_code`. Job counters returned by the API SHALL be recomputed
from `copy_job_tracks`, not read from possibly-stale counter columns.

A non-terminal job that has shown no observable change for longer than a configured staleness
window SHALL be swept into `failed` with an `error_code` distinguishing it from a provider-fatal
failure, and the sweep SHALL release the active-job flag. The sweep SHALL run on the twice-daily
sync path, never on the copy tick, because running it on the tick would reintroduce the
per-heartbeat database query this capability removes. For staleness to be measurable, `updated_at`
on `copy_jobs` SHALL advance only when job state actually changes, and SHALL NOT be advanced by a
tick that observes no change.

#### Scenario: Clean completion
- **WHEN** the last matched track is written and no tracks are unmatched
- **THEN** the job status becomes `completed` with non-null `finished_at`

#### Scenario: Completion with leftovers
- **WHEN** all tracks are written, skipped, or unmatched and at least one is unmatched
- **THEN** the job status becomes `completed_with_unmatched`

#### Scenario: Stalled job is swept
- **WHEN** a non-terminal job has not changed for longer than the staleness window
- **THEN** the sync path moves it to `failed` with a stalled `error_code`, sets `finished_at`,
  and releases the active-job flag

#### Scenario: Slow but progressing job is left alone
- **WHEN** a large job is advancing only a few tracks per tick but its counters are still changing
- **THEN** the sweep does not touch it, however long it has been running in total

#### Scenario: A tick that changes nothing does not refresh staleness
- **WHEN** a tick completes without changing job status, counters, or error state
- **THEN** `updated_at` is unchanged, so a wedged job remains detectable as stale
