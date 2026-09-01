# Feature ID map — 2026-09-01 rename

Reference for reading feature ids that appear in **commit messages, `docs/specs/`
filenames, and source comments**. Those were deliberately left untouched; this file is how
you translate them.

## Why

The harness validator hard-codes the feature-id pattern:

```ts
// vv-omp-harness/src/schema.ts:15
export const FEATURE_ID_RE = /^F[0-9]{3}$/;
```

`.harness/features.json` had 24 ids that never matched it — hyphenated (`F-015`), suffixed
(`F004b`, `F-026a`) or named (`F-Integ`, `F-Q1`). **The ledger had therefore never
validated**, and the harness session gate blocked on it every session with
`features[2].id: invalid value "F004b", expected pattern F###`.

The alternative was relaxing the regex in the plugin. Renaming here was chosen instead, so
the plugin's contract stays strict and the cost is confined to this repo — this file.

## The rename

**Hyphenated numerics** — hyphen dropped, number preserved:

| Old | New | | Old | New |
|---|---|---|---|---|
| `F-015` | `F015` | | `F-024` | `F024` |
| `F-016` | `F016` | | `F-025` | `F025` |
| `F-017` | `F017` | | `F-026` | `F026` |
| `F-018` | `F018` | | `F-027` | `F027` |
| `F-019` | `F019` | | `F-028` | `F028` |
| `F-020` | `F020` | | `F-029` | `F029` |
| `F-021` | `F021` | | `F-030` | `F030` |
| `F-022` | `F022` | | `F-031` | `F031` |
| `F-023` | `F023` | | | |

**Variants and named ids** — reassigned into a reserved block from `F040`. The numeric
relationship to their parent is lost, which is the main reason this file exists:

| Old | New | Parent / note |
|---|---|---|
| `F004b` | `F040` | variant of `F004` |
| `F-016b` | `F041` | variant of `F016` |
| `F-026a` | `F042` | variant of `F026` |
| `F-026b` | `F043` | variant of `F026` |
| `F-027a` | `F044` | variant of `F027` |
| `F-Integ` | `F045` | integration-test feature |
| `F-Q1` | `F046` | quality feature |

`F032`–`F039` were left clear on purpose: commit messages reference an `F-032` (the KV copy
heartbeat, PR #43) that was never entered in the ledger, so that range stays reserved
rather than being reused for something unrelated.

## Six dangling references repaired at the same time

`depends_on` held five ids that **never existed in any form** — hyphenated spellings of
features stored unhyphenated. The validator counted these among its errors. They were
pointers into nothing:

| Feature | Broken ref | Now resolves to |
|---|---|---|
| `F028` (was `F-028`) | `F-007` | `F007` |
| `F029` (was `F-029`) | `F-009` | `F009` |
| `F030` (was `F-030`) | `F-002`, `F-006`, `F-007`, `F-008` | `F002`, `F006`, `F007`, `F008` |

## What was NOT changed

Deliberately, to keep the blast radius at zero:

- **Commit messages** — e.g. `feat(F-032): …`, `fix(match): … (#45)`. Immutable history.
- **`docs/specs/F-0NN-*.md` filenames** — e.g. `docs/specs/F-014-health-status.md`.
- **Source comments** — e.g. `// F-029 sync-notifications`, `// F-032:`, `// F-015`.
- **`openspec/` change directories** — e.g. `openspec/changes/f-024-tidal-catalog-search/`.
- **Prose inside the ledger.** `discovered_via` was remapped only where the entire value
  was an id. Free text mentioning an old id (for example `F-024`'s note beginning
  "F-012 Sprint-7 M1 broken auto-candidates…") was left verbatim.

Read any of those through the tables above.

## Verification

Applied programmatically, not by hand, with these invariants checked:

- no new id collided with an existing one, and no two old ids mapped to the same new id;
- all non-id fields byte-identical before and after;
- 38 features before and after, status histogram unchanged, array order preserved;
- every `depends_on` entry resolves to a real feature — **zero dangling refs**.

Then run through the harness's own validator (`vv-omp-harness/src/schema.ts`,
`validateFeaturesFile`):

```
ERRORS  : 0
features: 38 | passing: 38
```

Down from 30 errors. Remaining output is warnings only — `test_spec` ×38 and `spec_doc`
×36, both unknown-but-tolerated fields this repo uses for spec document paths.

## Note

`.harness/` is gitignored in this repo, so `features.json` itself is not in version
control. **This file is the only committed record of the rename.**
