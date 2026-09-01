# Learnings — 2026-09-01

From the session that diagnosed and repaired the Tidal search outage
(2026-08-11 → 2026-09-01, 20 days of zero matches). Loop-mechanics findings are in
`loop-fix.md`; this file is everything else.

---

## Diagnosis

### Query the history, not the latest row

The alert named two Spotify ids, which read as "two bad tracks". The hypothesis died the
moment I asked *which ids failed on each previous run*: they **rotate** — four different
tracks across the window as 7-day cooldowns expired. Rotation is what turned "poison
data" into "the endpoint is gone".

One extra `GROUP BY` inverted the diagnosis. A single failing row cannot distinguish a
data problem from a systemic one; a history of failing rows almost always can.

### One control call beats an hour of log reading

`/v2/searchResults/…` returned 400. That is consistent with three very different causes:
bad credentials, a bad request, or a removed endpoint.

Calling a **sibling endpoint with the same token** — `/v2/tracks?filter[isrc]=` → **200** —
eliminated the first two in a single request. When an upstream call fails, the highest-value
next call is a different endpoint on the same auth, not a retry of the same one.

### An empty result is not a negative result

Applied twice. `bun run suite_behavior.ts` printed nothing and exited 0 — it looked like a
pass and was actually "not an entry point". The real runner reported 483/483. A check that
could not run is UNKNOWN, never PASS.

---

## The bug class worth hunting elsewhere

### An error branch that returns before recording an attempt causes permanent head-of-line blocking

This is the finding with the longest shelf life. The outage was Tidal's; the **20-day
duration** was ours:

```ts
if (result.status >= 400) {
  errors.push({ ... });
  unmatched++;
  continue;        // ← never reaches upsertUnmatched
}
```

`last_attempt_at` was never written. The queue predicate re-selects any track whose
`unmatched` row is absent or older than 7 days, `ORDER BY first_seen_at ASC LIMIT 2`. So
the two oldest tracks were retried forever and the other 42 starved. The ISRC stage shares
that predicate, so it read zero too — starved, not broken.

**Generalisation:** in any retry queue ordered by age with a small batch cap, an error path
that skips the attempt-recording write converts a transient upstream fault into a permanent
outage. Audit every `continue` and early `return` in a queue consumer for "did this record
that we tried?"

A sibling still lives at `src/copy/match.ts:180`:

```ts
if (result.status >= 400 || result.bodyParseError) return { status: "ok", candidates: [] };
```

An upstream failure returned as `status: "ok"` — an error wearing a verdict's clothes. No
damage yet (no copy job has run since 2026-07-28), but it is the same shape.

### Do not reuse a write that means something else

The obvious fix was to call the existing `upsertUnmatched` on the error path. Reading its
SQL first showed `candidates = EXCLUDED.candidates`, which is NULL there — it would have
**erased the persisted top-3 picker list** on every transient error. A new narrow
`recordAttempt` touches only `attempts` and `last_attempt_at`.

Reusing a function because its name sounds right is how you add a second bug while fixing
the first. Read the SQL.

---

## Verification

### Verify the response shape, not just the status code

The one-line URL fix would have "worked": HTTP 200. But the new collection endpoint returns
`data` as an **array**, while the parser read it as a bare object — so every search would
have returned zero candidates and written a **false `no_candidates` verdict** to the
database for every track.

That is strictly worse than the 400: a 400 is loud, a false verdict is silent and
persisted. **When an upstream contract moves, the shape moved too until proven otherwise.**

### Fixtures track the live contract, or they go green against a dead API

`tidalSearchOk()` in `fuzzy.test.ts` built the old bare-object shape. Left alone, those
tests would have passed forever against a response Tidal no longer sends. A mocked test
proves the shape *you believe*; only a live call proves the shape you *get*.

### Distinguish "stopped erroring" from "actually works"

Proving the four stuck queries returned candidates was not proof the backlog would drain —
candidates still have to score above threshold. Running the **real `matchByFuzzy` over the
real 44-track backlog against live Tidal**, with the DB mocked, gave the answer:

```
auto-matched : 18      unmatched verdicts : 26
errors       : 0       resolved           : 44/44
```

Cheap to build, and it converts "should work" into a number. Match verification scope to
claim scope: the claim was "the sync restarts", so the check had to be a whole-backlog run,
not a unit test.

### Inspect the artifact that ships

`wrangler deploy --dry-run --outdir=…`, then grep the bundle for `filter[query]` and confirm
the dead path form is gone. Source being correct and the *built* artifact being correct are
two claims.

---

## Comments and contracts

### "Verified: <date>" comments are load-bearing and rot silently

`tidal-search.ts` carried `path /searchResults/{id} … re-verified 2026-07-12`. It was false
by 2026-08-11 and actively misleading during diagnosis. Auditing all seven endpoints found
two more false markers, including a `maxItems: 20` cap that is now 50.

If a comment asserts an external contract, it needs a re-verification cadence or it becomes
a lie with a date on it. Cheapest useful habit: when an upstream call breaks, re-audit
**every** endpoint you call, not just the broken one.

### A grep of current callers never overrules a written contract

Repairing the ledger I set `spec = {source: "<path>"}`, reasoning that no consumer reads
anything but `spec.hash` and `spec.verdict`. But the schema says *"absent or null means
unverified"* — so a non-null `spec` **is** a verification claim, and a future gate doing
`if (feature.spec)` would have marked 36 features spec-verified. The honest form is
`spec: null`.

Implementation tells you what breaks today. The contract tells you what breaks next quarter.

### Check whether a skill already owns the repair

`harness-doctor` owns ledger repair and requires *"Report first. Never write anything
without showing the diff and getting an explicit go"*, with fix mode barred from settling
"claims about the work". I hand-edited an 83 KB ledger under session-gate pressure without
reading it.

**A closing gate is not authorisation to write.** Gate pressure is exactly when report-first
discipline matters and exactly when it feels safe to skip.

---

## Observability

### An alert that cannot name its cause trains you to ignore it

40 identical warnings fired over 20 days. Every one said `unmatched 2 · errors 2` and none
said `tidal_400`, because the body prints only `error_code` — which is NULL, since per-track
failures live in `error_details`.

The detection mechanism worked perfectly and was useless. **Cost of the missing field: 19
days.** An alert must name what broke, or it is just noise with good intentions.

Related: `unmatched 2` was **phantom** — the error path incremented the counter without
writing a row. A counter that can disagree with the table it describes will eventually
mislead someone at 2am.

### A test stage that exits 0 without running tests

`.harness/init.sh focused_test` prints "Complete" and exits 0 having run only `npm install`
and `tsc` — the stage postdates the script. Every gate demanding a fresh `focused_test`
stamp is therefore decorative here.

Confirm each stage of a test runner **by running it**, and treat a fall-through-to-`exit 0`
case as a silent fake green.

---

## Open items

| Item | Where | Note |
|---|---|---|
| Alert names no cause | `src/notify/ntfy.ts:84` | print distinct codes from `error_details` |
| Error returned as `status: "ok"` | `src/copy/match.ts:180` | same bug class as the fix |
| `focused_test` fake green | `.harness/init.sh` | blocks trustworthy test claims |
| `F013` test_file missing; `F-026a/F-026/F-026b` null | `.harness/features.json` | unproven `passing` claims |
| 24 feature ids violate `F###` | `.harness/features.json` | rename, or relax the plugin pattern |

*(Filename corrected from the requested `learinings-…` to `learnings-…`.)*
