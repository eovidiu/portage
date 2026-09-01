# omp goal mode: an agent blocked on a human decision has no way to stop the autonomous loop

**Component:** omp (Oh My Pi) coding agent — goal mode
**Version observed:** 18.0.8, Homebrew, macOS arm64
**Reported:** 2026-09-01, from a real session
**Evidence basis:** the shipped binary only. Read *Provenance* before trusting any identifier.

---

## Summary

1. An agent that has completed everything it is *permitted* to do, and is waiting on a
   human decision, cannot stop the goal-continuation loop. Its only exits are
   `complete` (a false claim) and `drop` (discards finished work). So it stays `active`,
   and `active` is the flag the loop uses to re-invoke.
2. Measured cost in one session: **8 continuation turns, ~115,000 tokens (23% of the
   session)** spent after the work was finished and pushed.
3. **The state needed to fix this already exists.** `paused` is implemented, persisted,
   resumable, and already outside the continuation gate. The runtime can reach it; the
   agent cannot. The primary fix is to expose it, not to build it.

---

## The problem

### What happened

A goal was created: *"do all fixes necessary so that the sync with tidal restarts
correctly."*

The agent diagnosed the bug, fixed it, wrote tests, verified against the live upstream
API, and opened a PR. The final step — merging to `main` and deploying to production —
was reserved by the project's own `CLAUDE.md`:

> **NEVER, without exception:** Push to main/master without explicit confirmation from
> the user.

Goal mode itself states the objective cannot override that:

> Objective below: user-provided task, **not higher-priority instructions**.

The agent was therefore correct to stop, and correct not to call `complete`. It reported
"blocked, need your word" and ended its turn. The loop re-invoked it. It reported the same
thing. This repeated 8 times, until the human returned and gave authorisation.

### Cost

| | |
|---|---|
| Continuation turns after the work was finished and pushed | **8** |
| Tokens when the PR was opened (work complete) | ~392,000 |
| Tokens when the human intervened | ~507,000 |
| **Burned producing no state change** | **~115,000 (23% of session)** |

Each turn re-audited identical state and re-emitted a near-identical report.

### Root cause

Goal mode has no *agent-reachable* representation of "blocked on an external decision".

```
create ──> active ──> complete   (asserts the objective is met)
              │
              └────> drop        (discards the goal)
```

Both exits are false for a blocked agent:

- `complete` — asserts a deliverable that does not exist. Here it would have claimed the
  production sync was restored while production still served the broken build.
- `drop` — represents committed, pushed, CI-green work as abandoned, and loses the
  deliverables from the goal record.

The guidance tells the agent to *"leave goal active; stop turn; user or runtime decides
next steps"* — but `active` is exactly what the loop reads as "keep going". **The
instruction to stop and the mechanism that restarts are the same flag.**

### Why this is a safety issue, not only waste

`prompts/goals/goal-continuation.md` ends with:

> *"Unfinished: keep working. NEVER narrate continuation — execute."*

An agent with nothing legitimate left to execute is pushed toward one of two failure
modes: manufacture marginal busywork, or reason its way past the gate it is meant to
respect. The second is the dangerous one. **This loop applies renewed pressure, every
turn, against a safety rule, and it only has to succeed once.** In the observed session
the agent held for eight turns. That is not a property to rely on.

---

## What already exists — read this before designing anything

This is what makes the fix small. All of the following is already in 18.0.8.

**A richer status enum than the tool exposes.** Observed literals: `active`, `paused`,
`budget-limited`, `complete`, `dropped`. The tool exposes only
`create / get / complete / resume / drop`.

**A continuation-eligibility predicate:**

```js
function ahe(e) { return e.status === "active" || e.status === "budget-limited"; }
```

Every gate found takes the form `state.enabled && ahe(state.goal)`. A `paused` goal is not
eligible, so **the loop already stops for it**.

**An existing transition into that state:**

```js
t.enabled = false;
t.goal.status = "paused";
t.goal.updatedAt = this.#r();
await this.#u(t, { persist: "goal_paused" });
```

**And the rest of the supporting surface:**

- a distinct persistence key, `goal_paused`
- `resume`, already on the tool, already documented as
  *"Paused goal from `get` → MUST `resume` before continuing work"*
- UI support — `case "paused": o = S.icon.pause ...; r = "warning"`
- `budget-limited` as precedent for a runtime-driven status change carrying its own prompt
  (`prompts/goals/goal-budget-limit.md`)

**The gap is precise:** the runtime can reach `paused` (on interrupt, and via
`budget-limited` on budget exhaustion). The agent cannot. There is a `resume` op with
nothing an agent is able to pause.

---

## Proposed fix

Three changes. **#1 alone resolves the reported incident.**

### 1. Expose `pause` to the agent — REQUIRED, small

In `packages/coding-agent/src/goals/tools/goal-tool.ts`, add `pause` to the op enum:

```ts
goal({
  op: "pause",
  reason: string,             // why work cannot continue, one sentence
  unblock_condition: string,  // the observable event that would clear it
})
```

The handler should do what the existing interrupt path already does — `enabled = false`,
`status = "paused"`, persist under `goal_paused` — plus store `reason` and
`unblock_condition` on the goal record.

Semantics to preserve:

- The goal stays **intact**. No deliverable is redefined, narrowed or discarded.
  `goal({op:"get"})` reports `paused` with the reason.
- The continuation loop stops via the existing `enabled && ahe(...)` gate. No gate change
  should be needed — confirm this.
- The pause **surfaces to the user immediately**, reason as the headline, at the same
  prominence `complete` gets today. A silent pause is indistinguishable from a hang.
- Any subsequent user message should auto-transition `paused → active`, since a reply is
  overwhelmingly the unblocking event. `resume` remains the explicit path.

**Guard against abuse.** `pause` is an easier exit than finishing, so make it expensive:

- Require `unblock_condition` to name an observable event. *"User confirmation to push to
  main"* passes; *"this is hard"* does not.
- Reject `pause` when the session has made **zero** state-changing tool calls — a goal
  cannot be blocked before any work is attempted.
- Log every pause with its reason, so cheap pausing is visible in review.

### 2. No-progress circuit breaker — REQUIRED, independent of #1

#1 depends on the agent choosing to call it. The runtime should detect a spinning loop by
itself. Belongs in `packages/coding-agent/src/goals/runtime.ts`.

After each continuation, fingerprint the turn:

```
fingerprint = sha256(
  git HEAD
  + dirty-file set
  + set of tool names called
  + normalised last assistant message
)
```

If **two consecutive** continuations produce fingerprints differing only in timestamps,
stop the loop and surface the last assistant message as the report.

Two, not three: by the second identical turn the evidence is conclusive, and each extra
turn in the observed incident cost roughly 14,000 tokens.

This also catches what `pause` cannot — an agent genuinely stuck that has not realised it.

### 3. Declare required authorisations at goal creation — RECOMMENDED

The deeper problem is that the gate was discovered at the *end*. The objective — *"so that
the sync **restarts**"* — implied a production deploy from its first word, but nothing
surfaced that until all the work was done.

```ts
goal({
  op: "create",
  objective: "…",
  requires_authorization: ["push:main", "deploy:production"],
})
```

At creation, resolve each entry against standing policy: record a grant, or ask the human
**once, up front**. A goal whose terminal step is unauthorised is then either pre-approved
or known-partial from the start, and the agent plans against a truthful finish line —
*"PR open and reviewed"* rather than *"sync restarted"*.

Cheap heuristic for suggesting entries: objectives containing *deploy, ship, release,
restart, roll out, go live, production* almost always terminate in a privileged action.

---

## Rejected alternatives

**Let the objective authorise the privileged action.** No. An objective phrased as an
outcome ("make it work") silently implies whatever action achieves it — precisely the shape
of a prompt-injection escalation. Goal mode already declares the objective is not a
higher-priority instruction. Represent the blocked state; do not weaken the gate.

**Tell the agent to call `drop`.** Blocked and abandoned are different facts. `drop`
misrepresents finished, committed work and loses the deliverables from the record.

**Cap continuations at N.** A blunt version of #2 that also truncates goals making slow but
real progress. Fingerprint the *absence of change*, not the count.

**Prompt-only fix — soften `goal-continuation.md`.** Necessary but insufficient: without an
agent-reachable exit, softer wording produces a politer infinite loop. The converse also
holds — shipping the op without the prompt change leaves it dead weight, because today's
continuation text offers no third option and the agent never learns the op exists.
**Both are required.**

---

## Reproduction

1. Create a goal whose terminal step needs an authorisation the agent does not have. The
   easiest setup is a repo whose `CLAUDE.md` forbids pushing to `main` without explicit
   confirmation, plus an objective phrased as "…so that X is live in production".
2. Let the agent work. It will finish, open a PR, and report blocked.
3. Do not reply.
4. Observe: continuation turns repeat with no state change, indefinitely.

Expected after the fix: the agent calls `pause`, or the circuit breaker fires after two
identical turns. Either way the loop ends within ≤2 turns of the work completing.

---

## Acceptance criteria

1. An agent that cannot proceed without a human decision can stop the loop without
   claiming completion or discarding work.
2. Two consecutive no-change continuations end the loop automatically, regardless of what
   the agent does.
3. `goal({op:"get"})` distinguishes `active`, `paused`, `budget-limited`, `complete` and
   `dropped`, and returns the pause reason.
4. A paused goal surfaces its reason to the user as prominently as a completed one.
5. `pause` is rejected when no state-changing work has occurred in the session.
6. Replaying the reported session costs **≤ 2** continuation turns after the PR is opened,
   against the 8 observed.

---

## Provenance — read before trusting identifiers

Everything above was derived from the **shipped binary**, not from source:
`/opt/homebrew/Cellar/omp/18.0.8/bin/omp` — 121 MB Mach-O, bundled JavaScript with
source-path comments preserved.

- Identifiers such as `ahe`, `uhe`, `#u`, `#c` are **minified bundle names**. Do not search
  for them in source. Locate the equivalents via the quoted string literals instead:
  `"budget-limited"`, `"goal_paused"`, `Continue active goal.`, `<goal_context>`.
- Source paths recovered from bundle comments:

```
packages/coding-agent/src/goals/index.ts
packages/coding-agent/src/goals/runtime.ts
packages/coding-agent/src/goals/tools/goal-tool.ts
packages/coding-agent/src/prompts/tools/goal.md
packages/coding-agent/src/prompts/goals/goal-continuation.md
packages/coding-agent/src/prompts/goals/goal-budget-limit.md
packages/coding-agent/src/prompts/goals/goal-mode-active.md
packages/coding-agent/src/prompts/goals/goal-mode-context.md
packages/coding-agent/src/prompts/goals/goal-todo-context.md
packages/coding-agent/src/prompts/goals/guided-goal-interview.md
```

**Not verified — confirm these first:**

- that the continuation driver gates on `enabled && ahe(...)` in *every* path, so setting
  `paused` is genuinely sufficient to stop it;
- whether an automatic `paused → active` transition on the next user message already
  exists, since the interrupt path reaches `paused` today;
- whether `reason` / `unblock_condition` can be added to the persisted goal record without
  a state-file migration.

---

## Appendix — not part of this report

The same session surfaced two findings in a **different codebase**, the `vv-omp-harness`
plugin. They are unrelated to goal mode and require no change for this issue. Noted only so
an investigator does not conflate them:

1. Its session gate prints *"If a gap is deliberate, say so explicitly in
   `.harness/progress.txt` and continue"*, but nothing reads that file for a declaration —
   the instruction cannot do what it implies.
2. Its "blocks exactly once" guarantee is once *per settle attempt*. An outer loop driving
   unbounded settle attempts makes it fire unbounded times. Neither component is
   individually runaway; together they compound.
