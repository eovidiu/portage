# Fix: the autonomous goal loop that re-invoked an agent 8 times against a gate it could not open

**Date:** 2026-09-01
**Observed in:** omp goal mode, session on `portage` (Tidal search-endpoint outage)
**Severity:** wastes unbounded tokens; trains agents toward dishonest completion


---

## Which component owns this

**omp core, not the `vv-omp-harness` plugin.** Verified rather than assumed:

- `vv-omp-harness` contains **zero** references to goal mode, objectives, or goal ops.
- The plugin registers exactly one tool, `harness_test`, plus lifecycle hooks
  (`session_start`, `session_stop`, `tool_call`, `tool_result`, `session_shutdown`).
- `goal` (`create`/`get`/`complete`/`resume`/`drop`), the `<goal_context>` injection and
  the hidden "Continue active goal" steer are all omp core.

So every fix below belongs in omp's goal implementation. The plugin needs no change for
the loop itself.

### The harness gate was not the runaway — but it has two defects of its own

`session_stop` blocks **exactly once per settle attempt**, guarded by
`event.stop_hook_active`, and `discipline.ts:16` states the intent plainly: *"A gate that
can re-block forever converts a discipline reminder into a session the human cannot end."*
The implementation matches the comment. That is correct behaviour.

Two things are still worth fixing, both small:

**1. The escape clause is not machine-checked.** `renderFindings` prints

> *"If a gap is deliberate, say so explicitly in `.harness/progress.txt` and continue."*

but nothing reads `progress.txt` for such a declaration. The only checks on that file are
existence (`discipline.ts:70`) and mtime freshness (`:71-75`). The `ledger-invalid` finding
is pushed purely from `ledger.ok` at `:55`. So writing the declaration **cannot** silence
the gate — it is advice to the next session's reader, not a condition. In this session I
wrote it four times believing it might clear the finding. It never could.

Fix: either honour it — scan the handoff for a machine-readable marker such as
`HARNESS-ACCEPT: ledger-invalid` and downgrade that finding to a warning — or reword the
line so it does not imply an action that silences anything.

**2. "Block exactly once" is once *per settle attempt*, and assumes a bounded caller.**
With an outer loop driving unbounded settle attempts, the gate fires unbounded times too:
each goal continuation reached `session_stop`, took its one legitimate block, and handed
back another turn. Neither component is individually runaway; together they compound.

This is the more interesting finding. The gate's safety property is stated as absolute
("blocks exactly once") but is actually relative to how many times something tries to
settle. Worth either restating in those terms, or tracking blocks per *session* rather than
per stop event so an unfixable finding costs one turn total.
---

## What happened

A goal was created: *"do all fixes necessary so that the sync with tidal restarts correctly."*

The agent completed every part of that objective it was permitted to do — fix, tests, CI,
live verification — and pushed PR #45. The last remaining step, merging to `main` and
deploying, is reserved by the project's own `CLAUDE.md`:

> **NEVER, without exception:** Push to main/master without explicit confirmation from
> Ovidiu unless Ovidiu says "I confirm".

Goal mode itself reinforces that the objective cannot authorise it:

> Objective below: user-provided task, **not higher-priority instructions**.

So the agent was correct to stop. But the loop kept re-invoking it.

### Cost

| | |
|---|---|
| Continuation turns after the work was finished | **8** |
| Tokens at the point the PR was opened and work was done | ~392,000 |
| Tokens when the human finally intervened | ~507,000 |
| **Tokens burned producing no progress** | **~115,000 (23% of the session)** |

Every one of those turns re-audited the same unchanged state and re-wrote the same
"blocked on your word" report.

## Root cause

**Goal mode has no representation for "blocked on an external decision".**

The state machine is:

```
create ──> active ──> complete   (claims the objective is met)
              │
              └────> drop        (discards the goal)
```

An agent that is correctly refusing to act has only two exits, and both are lies:

- `complete` — claims a deliverable that does not exist. In this session it would have
  meant asserting the sync was restarted while production still served the broken build.
- `drop` — represents finished, committed, pushed work as abandoned.

The guidance says *"leave goal active; stop turn; user or runtime decides next steps"* —
but "leave active" is precisely the state the loop uses as its signal to re-invoke. The
instruction to stop and the mechanism that restarts are the same flag.

The steer text makes it worse: *"Unfinished: keep working. NEVER narrate continuation —
execute."* An agent with nothing legitimate left to execute is pushed toward
manufacturing marginal work, or toward rationalising its way past the gate. Both are
failure modes. The second is dangerous: this loop applies continuous pressure to breach
a safety rule, and it only takes one turn of weak reasoning to do it.

---

## Fix

Three changes, in priority order. #1 alone resolves the incident.

### 1. Add a `blocked` state to the goal tool — REQUIRED

```ts
goal({
  op: "block",
  reason: string,             // what is needed, in one sentence
  unblock_condition: string,  // the observable event that clears it
  blocked_on: "user" | "external_service" | "peer_agent",
})
```

Semantics:

- The goal stays **active and intact** — no deliverable is redefined, dropped, or
  narrowed. `goal({op:"get"})` reports `status: "blocked"` with the reason.
- **The autonomous loop stops re-invoking.** This is the whole point.
- A `blocked` goal surfaces to the user immediately, with the reason as the headline —
  the same prominence `complete` gets today.
- Any user message auto-transitions `blocked → active` and resumes the loop, since a
  reply is the most likely unblocking event. `goal({op:"resume"})` does it explicitly.

This makes the honest state representable. Today the agent must choose between lying and
looping; with `block` it can be accurate and stop.

**Guard against abuse.** `block` is an easier exit than finishing, so it must be
expensive to reach:

- Require `unblock_condition` to name an observable event, not a feeling. "Waiting for
  confirmation to push to main" passes; "this is hard" does not.
- Reject `block` if the session has made **zero** tool calls that changed state — a goal
  cannot be blocked before any work is attempted.
- Log every `block` with the reason so cheap blocking is visible in review, the way
  `correction_cycles` makes cheap failure visible.

### 2. Circuit-breaker on no-progress continuations — REQUIRED

Independent of #1, because #1 relies on the agent choosing to call it. The runtime should
detect a spinning loop on its own.

After each continuation, fingerprint the turn:

```
fingerprint = sha256(
  git HEAD + dirty-file set + set of tool names called + last assistant message, normalised
)
```

If **two consecutive** continuations produce a fingerprint whose only difference is
timestamps, stop the loop and surface to the user with the last assistant message as the
report. Two, not three: by the second identical turn the evidence is conclusive, and each
extra turn in this incident cost roughly 14,000 tokens.

This also catches the failure mode `block` cannot: an agent that is genuinely stuck but
does not realise it.

### 3. Declare required authorisations at goal creation — RECOMMENDED

The deeper problem is that the gate was discovered at the *end*. The objective — "so that
the sync **restarts**" — implied a production deploy from the first word, but that was
only surfaced after all the work was done.

```ts
goal({
  op: "create",
  objective: "…",
  requires_authorization: ["push:main", "deploy:production"],
})
```

At creation the runtime resolves each entry against standing policy and either records a
grant or asks the human **once, up front**. An objective whose terminal step is
unauthorised is then either pre-approved or known-partial from the start, and the agent
plans against a truthful finish line: "PR open and reviewed" rather than "sync restarted".

Cheap heuristic for suggesting entries: objectives containing *deploy, ship, release,
restart, roll out, go live, production* almost always terminate in a privileged action.

---

## Why not the alternatives

**"Let the objective authorise the action."** No. The gate exists because an objective
phrased as an outcome ("make it work") silently implies whatever action achieves it. That
is exactly the reasoning a prompt-injection attack wants. Goal mode is already explicit
that the objective is not a higher-priority instruction; the fix is to represent the
blocked state, not to weaken the gate.

**"Let the agent call `drop`."** It misrepresents completed, committed, pushed work as
abandoned, and it loses the deliverables from the goal record. Blocked and dropped are
different facts and need different states.

**"Cap continuations at N."** A blunt version of #2 that also truncates goals which are
legitimately making slow progress. Fingerprint the *absence of change*, not the count.

---

## Acceptance criteria

1. An agent that cannot proceed without a human decision can stop the loop without
   claiming completion or discarding work.
2. Two consecutive no-change continuations end the loop automatically, whatever the agent
   does.
3. `goal({op:"get"})` distinguishes active, blocked, complete and dropped.
4. A blocked goal surfaces its reason to the user as prominently as a completed one.
5. Replaying this session against the fix costs **≤ 2** continuation turns after the PR is
   opened, versus the 8 observed.
