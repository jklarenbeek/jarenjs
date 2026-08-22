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

## A real one, as executed

The order below was executed by a fresh session from the bootstrap alone;
its record is the filled example in [`session-record.md`](session-record.md).
It is reproduced as written, so its final checklist item names the gate
commands of its own day — the aggregate `npm run site:gate` above is what
a new order writes.

```markdown
# TODO_EXAMPLE_01 — cover the Retry-After HTTP-date branch of the chat client

Router: `TODO_EXAMPLE.md`. **Binding: none.** **Depends on nothing.**

Read first: `packages/ai/src/client.js` (the `retryAfterMs` helper and
the retry loop in `createChatClient`) and `test/ai/client.test.js` (the
`ai — the retry policy` suite and its `scriptedClient` harness — match
its conventions exactly).

## Goal

The retry policy's `Retry-After` handling is tested for delta-seconds
values only; the HTTP-date form (`Retry-After: Wed, 21 Oct 2026 …`) is
implemented but unproven. One new test pins it.

## Design

Extend the existing `ai — the retry policy` suite with one test using
the suite's own `scriptedClient` helper: a 429 response whose
`retry-after` header is an HTTP-date a known distance in the future,
followed by a success. The recorded backoff delay must derive from the
date (allow scheduling slack: assert a range, not an exact value) and
must respect the `maxMs` cap when the date is far away. No source
changes — this is a coverage work order; if the test exposes a bug,
STOP and record it as a divergence instead of patching the client here.

## Files

- `test/ai/client.test.js` — one new `it(...)` in the retry-policy
  suite. Nothing else.

## Steps

1. Read the two named files.
2. Add the test: 429 with `retry-after: new Date(Date.now() + 3000)
   .toUTCString()` then success → one recorded delay in `[1500, 3000]`
   (HTTP-date resolution is one second and the clock moves between
   header construction and parsing; the floor proves the date was used
   — the jitterless computed backoff would be 500).
3. Add the cap case: a date ~60 s out with `maxMs: 4000` → recorded
   delay exactly `4000`.
4. Run the gate.

## Acceptance checklist

- [ ] `npm run test:ai` passes with exactly one new test in
      `ai — the retry policy`.
- [ ] The new test fails if the HTTP-date branch of `retryAfterMs` is
      removed (verified once locally by temporarily breaking it).
- [ ] Full gate green: `npm run lint` 0/0, `npm test`,
      `npm run website:build`, `npm run benchmark:coverage` 0 findings.
- [ ] Session record written (`TODO_EXAMPLE_01_RECORD.md`).
```
