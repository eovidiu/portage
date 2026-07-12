## 1. Notify module (TDD)

- [x] 1.1 Write failing tests for `sendNtfyNotification`: no-op when NTFY_TOPIC unset; POST to `{NTFY_URL:-https://ntfy.sh}/{topic}` with Title/Priority/Tags headers; Bearer header only when NTFY_TOKEN set; non-2xx and rejected fetch swallowed with `ntfy_notify_failed` log (topic absent from log); 5 s abort wiring
- [x] 1.2 Write failing tests for outcome formatting: title/priority/tags per outcome table (D5), body contains counts + error_code + run_id, skipped_locked publishes nothing, abandoned-sweep message shape
- [x] 1.3 Implement `src/notify/ntfy.ts` to green (Verified: marker citing https://docs.ntfy.sh/publish/ above the base-URL constant)

## 2. Env + orchestrator hook (TDD)

- [x] 2.1 Add `NTFY_TOPIC?` / `NTFY_URL?` / `NTFY_TOKEN?` to `src/env.ts` with doc comments
- [x] 2.2 Write failing orchestrator tests: outcome notification fires for succeeded/partial/failed, not for skipped_locked; abandoned sweep >0 notifies before the run; pre-lock throw attempts a crash notification then rethrows; notify rejection does not alter the result
- [x] 2.3 Refactor `runSync` into wrapper + `runSyncCore` per design D1 (move `markAbandonedRuns` into wrapper), wire notifications; existing orchestrator tests stay green unchanged

## 3. Gates, docs, ship

- [x] 3.1 `npm test` full suite + `npm run typecheck` green
- [x] 3.2 Register F-029 in `.harness/features.json`; update README captures row / docs/operations/pre-deploy-checklist.md with NTFY secret setup; add NTFY vars to `.env.example` placeholders if the file exists
- [ ] 3.3 Commit referencing F-029; live-verify by publishing through the real code path to a scratch topic
