# Work order — the template, then a real one

A work order is the unit a fresh session executes: self-contained, so a
session holding only [`../BOOTSTRAP.md`](../BOOTSTRAP.md), the campaign
router, this file and the repository can do the work without conversation
context. In-repo campaigns keep orders as gitignored `TODO_<PROGRAM>_NN.md`
files next to their router (`../CONVENTIONS.md` §3); the sections below are
required in this order, and the acceptance checklist **is** the definition of
done — nothing more, nothing less.

## The template

```markdown
# TODO_<PROGRAM>_NN — <title>

Router: `TODO_<PROGRAM>.md`. **Binding: D<n>, D<m>.** **Depends on <orders>.**

Read first: <the specific files, with the functions and line references
that matter, whose conventions the new code must match; restate any
context the executor cannot infer>.

## Goal

<One or two sentences: the observable end state, not the activity.>

## Design

<The intended shape of the change: module boundaries, data shapes, error
surfaces, edge rules, and the reasoning behind any non-obvious choice.
Decisions made here are made — an executor extends them, it does not
relitigate them. Where the order carries a diagnosis (a bug's root cause,
failures sharing one fix), put it here in full with the concrete input and
the expected-vs-actual output.>

## Files

<The files to create or modify, with one clause each on what changes.>

## Steps

1. <Ordered, verifiable steps, each small enough to test; `npm test`
   between batches so a regression is attributable. Step 0 is
   "re-measure" whenever an earlier order moved this order's target.>
2. …

## Acceptance checklist

- [ ] <Behavioral assertions, each independently checkable — exact test
      names, exact outputs, exact error codes.>
- [ ] Full gate green — `npm run site:gate` (`../CONVENTIONS.md` §2),
      with the counts from every stage in the record, plus whatever this
      order names.
- [ ] Session record written (`TODO_<PROGRAM>_NN_RECORD.md`); router
      ledger updated.
```

## A real one, restated

The order below was executed by a fresh session from the bootstrap alone;
its record is the filled example in [`session-record.md`](session-record.md).
The chat client it covered has since left the workspace, and the retry
arithmetic it pinned lives in `@jarenjs/core/retry` today, so the order
and its record are restated against that module and its suite: every
file, suite and command they name exists, while the decisions are the
original order's and the record's figures are its run's. Its final
checklist item names the gate commands of its own day — the aggregate
`npm run site:gate` above is what a new order writes.

```markdown
# TODO_EXAMPLE_01 — cover the Retry-After HTTP-date branch of the retry helpers

Router: `TODO_EXAMPLE.md`. **Binding: none.** **Depends on nothing.**

Read first: `packages/core/src/retry.js` (`parseRetryAfter`, and the
`ai-compat` policy of `backoffDelay`, which caps a server's wait at
`maxMs`) and `test/core/schedule.test.js` (the `shared retry policies`
suite — match its conventions exactly).

## Goal

The retry helpers' `Retry-After` handling is proven for both forms the
header takes: delta-seconds, and the HTTP-date form (`Retry-After: Wed,
21 Oct 2026 …`), which one new test pins.

## Design

Extend the existing `shared retry policies` suite with one test: a
`retry-after` value that is an HTTP-date a known distance in the future,
read by `parseRetryAfter` at the current clock. The delay must derive
from the date (allow scheduling slack: assert a range, not an exact
value) and must respect the `maxMs` cap of the `ai-compat` policy when
the date is far away. No source changes — this is a coverage work
order; if the test exposes a bug, STOP and record it as a divergence
instead of patching the module here.

## Files

- `test/core/schedule.test.js` — one new `it(...)` in the
  `shared retry policies` suite. Nothing else.

## Steps

1. Read the two named files.
2. Add the test: `parseRetryAfter(new Date(Date.now() + 3000)
   .toUTCString())` → a delay in `[1500, 3000]` (HTTP-date resolution is
   one second and the clock moves between header construction and
   parsing; the floor proves the date was used — the jitterless computed
   backoff would be 500).
3. Add the cap case: a date ~60 s out through `backoffDelay({ policy:
   'ai-compat', maxMs: 4000 }, 1, …)` → a delay of exactly `4000`.
4. Run the gate.

## Acceptance checklist

- [ ] `npm run test:core` passes with exactly one new test in
      `shared retry policies`.
- [ ] The new test fails if the HTTP-date branch of `parseRetryAfter` is
      removed (verified once locally by temporarily breaking it).
- [ ] Full gate green: `npm run lint` 0/0, `npm test`,
      `npm run website:build`, `npm run benchmark:coverage` 0 findings.
- [ ] Session record written (`TODO_EXAMPLE_01_RECORD.md`).
```
