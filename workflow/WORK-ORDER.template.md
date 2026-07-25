# WO-<X> — <title>

<Self-containment rule: a fresh session holding only BOOTSTRAP.md, the
router, this file and the repo must be able to execute this. Name every
file to read first; restate any context the executor cannot infer.>

## Goal

<One or two sentences: the observable end state, not the activity.>

## Design

<The intended shape of the change: module boundaries, data shapes,
error surfaces, edge rules. Decisions made here are made — an executor
extends them, it does not relitigate them. Reference the router's
D-numbers where they bind this work order.>

## Files

<The files to create or modify, with one clause each on what changes.
"Read first": the neighboring sources/tests whose conventions the new
code must match.>

## Steps

1. <Ordered, verifiable steps. Each step small enough to test.>
2. …

## Acceptance checklist

- [ ] <Behavioral assertions, each independently checkable — exact
      test names, exact outputs, exact error codes.>
- [ ] Full gate green: `npm run lint` 0/0, `npm test`,
      `npm run website:build`, `npm run benchmark:coverage` 0 findings.
- [ ] Session record written (SESSION-RECORD template).
