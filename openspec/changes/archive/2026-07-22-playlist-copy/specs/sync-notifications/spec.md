# sync-notifications (delta)

## ADDED Requirements

### Requirement: Copy-job terminal notification
The Worker SHALL send an ntfy notification when a copy job reaches a terminal state
(`completed`, `completed_with_unmatched`, `failed`, `cancelled` via API), including
the direction, source playlist name, written/skipped/unmatched counts, and
`error_code` when failed. Notification delivery failures SHALL NOT affect job state
(existing non-fatal pattern).

#### Scenario: Completion notified
- **WHEN** a tick moves a copy job to `completed_with_unmatched`
- **THEN** an ntfy message is sent with the job's name, direction, and counts

#### Scenario: Notification failure is non-fatal
- **WHEN** the ntfy request fails
- **THEN** the job's terminal state and `finished_at` are unaffected
