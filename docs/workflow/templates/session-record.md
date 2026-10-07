# Session record — the template, then a real one

A session record is written once, after the work is green, by the session
that executed a work order. It is the evidence: numbers, not adjectives —
test counts, lint result, audit summary, any benchmark figure the order's
acceptance names — plus what was decided, what was left, and what the next
session must know. In-repo campaigns keep it as the gitignored
`TODO_<PROGRAM>_NN_RECORD.md` beside the order (`../CONVENTIONS.md` §3); the
router's status ledger is updated in the same session.

## The template

```markdown
# Session record — TODO_<PROGRAM>_NN <title> (<date>)

## Summary

<What shipped, in the past tense, three to six sentences. Lead with the
outcome; name the user-observable behavior, not the diff.>

## Files

<Every file created/modified/deleted, one line each: path — what
changed and why it had to.>

## Decisions & divergences

<Choices the work order left open and how they were settled; every
divergence from the order's design with its reason. "None" is a valid,
meaningful entry. A conflict with a router D-number is recorded here
and NOT resolved unilaterally. Include the drop list: what was
investigated and found unfounded, one line each (what, why not), so
the next session does not repeat it.>

## Test & benchmark output

<The gate results, pasted, one line or row per stage of `npm run site:gate`:
lint result, test counts, the build, the coverage-audit summary, the figure
count, the document and design sweeps, the browser matrix — plus any
benchmark numbers the acceptance names, and the packaging pair if exports
moved. Numbers, never "all green".>

## Open issues

<Anything discovered but deliberately not done: follow-up candidates,
latent bugs found in neighboring code, spec drift. Each with enough
context that a future session needs no archaeology.>

## Handoff

<Only when a next session depends on this one; otherwise "None".
Everything here must be actionable without this session's context:
the state of the program the router's ledger cannot carry ("order 03
landed but its acceptance item 3 is deferred into 05"); open follow-ups,
file-anchored (path, what is pending, why it waited — "must do next"
kept apart from "backlog"); cross-package contracts a later order must
honor (new exports another package will consume, format changes awaiting
a dependent update); and the traps the next executor cannot see coming
(flaky-looking tests that are real failures, generated artifacts that
must be regenerated together, invariants that break silently).>
```

## A real one, restated

The record the fresh session wrote for the example order in
[`work-order.md`](work-order.md), restated with it against
`@jarenjs/core/retry`: the files, suite and commands are today's, the
decisions and every figure are the original run's.

```markdown
# Session record — TODO_EXAMPLE_01 cover the Retry-After HTTP-date branch of the retry helpers (2026-07-25)

## Summary

The retry helpers' `Retry-After` HTTP-date handling is now pinned by a
test: a `toUTCString()` date three seconds out, read by `parseRetryAfter`
at the current clock, yields a delay in `[1500, 3000]` (derived from the
date — the jitterless computed backoff would be 500), and a date sixty
seconds out under `backoffDelay`'s `ai-compat` policy with `maxMs: 4000`
yields a delay of exactly `4000`. The test was proven load-bearing by
mutation: with the `Date.parse` branch of `parseRetryAfter` temporarily
removed it was the only failing test in the suite; restored, everything
is green. No bug surfaced in the helpers — the HTTP-date branch behaves
as specified, so the divergence-stop clause was never triggered. The
full gate ran clean except for four pre-existing dead-function findings
in the coverage audit that this work order's file constraint forbids
resolving (see Decisions & divergences).

## Files

- `test/core/schedule.test.js` — added one `it('honors a Retry-After
  HTTP-date, capped by maxMs when the date is far off')` to the
  `shared retry policies` suite; the work order's sole in-scope file.
- `TODO_EXAMPLE_01_RECORD.md` — this record (created).
- `packages/core/src/retry.js` — temporarily mutated twice (HTTP-date
  branch of `parseRetryAfter` removed for the checklist's kill-check,
  then restored exactly); net unchanged by this session.

## Decisions & divergences

- Both cases from Steps 2 and 3 live in the single new `it(...)`: the
  acceptance checklist demands exactly one new test, and the neighboring
  delta-seconds test already packs its plain and capped cases into one
  `it` — the new test mirrors that convention, placed directly after it.
- The date case asserts an `assert.ok` range `[1500, 3000]` (scheduling
  slack per the work order); the cap case asserts `strictEqual(delay,
  4000)` exactly, since `Math.min` with `maxMs` is deterministic.
- DIVERGENCE (checklist item 3, coverage clause): `npm run
  benchmark:coverage` reports `0 file(s) + 4 function(s)` dead-code
  findings, not the 0 findings the checklist names. All four are
  pre-existing in the working tree's prior uncommitted work, proven by
  A/B: the audit was re-run with the new test temporarily removed and
  reported the identical four functions (a new test can only add
  executed functions, never unhit one). The work order's Files clause
  ("one new `it(...)`… Nothing else") and Design clause ("No source
  changes") forbid the extra tests or source removals that resolving
  them would take, so per the bootstrap's conflict rule they are
  recorded here rather than resolved unilaterally. Every other gate is
  fully green.

## Test & benchmark output

- `npm run test:core` — 67 tests, 67 pass, 0 fail (12 suites). New test
  `ok 4 - honors a Retry-After HTTP-date, capped by maxMs when the date
  is far off` inside `ok 5 - shared retry policies`; exactly one `it`
  added to that suite.
- Kill-check: with `const date = Date.parse(raw); return
  Number.isNaN(date) ? undefined : Math.max(0, date - now);` removed
  from `parseRetryAfter`, `npm run test:core` → `# fail 1`, the failing
  test being the new one and the suite line `not ok 5 - shared retry
  policies`; branch restored → 67/67 green again.
- `npm run lint` — 0 errors, 0 warnings.
- `npm test` — 4363 tests, 4331 pass, 0 fail, 32 skipped, 799 suites
  (duration_ms ≈ 7344).
- `npm run website:build` — ✓ 278 modules transformed, built in 1.56s
  (pre-existing font-URL "resolved at runtime" notes only).
- `npm run benchmark:coverage` — Functions executed: 2992/2996 (99.9%);
  Dead-code findings: 0 file(s) + 4 function(s), all four in code the
  working tree carried uncommitted. Identical output with and without
  the new test.

## Open issues

- The four dead-function findings above predate this session and belong
  to the tree's uncommitted prior work (none of the four exist at HEAD).
  Resolving them needs its own scoped decision per the audit's rule: two
  want a retry test that uses the real timer-based sleep and an abort
  mid-backoff without injecting `sleep` (every current retry test
  injects a recording stub); the other two each want either a test that
  exercises them or removal if obsolete.
- The date-case range `[1500, 3000]` tolerates up to ~1.5 s of combined
  HTTP-date truncation and clock movement; on a pathologically stalled
  machine (>1.5 s between header construction and parsing) the floor
  could false-fail. Accepted as specified by the work order.

## Handoff

None — no next order depends on this one; the open issues above are
backlog.
```
