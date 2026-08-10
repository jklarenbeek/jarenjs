# Session record — WO-EXAMPLE cover the Retry-After HTTP-date branch of the chat client (2026-07-25)

## Summary

The chat client's `Retry-After` HTTP-date handling is now pinned by a
test: a 429 whose `retry-after` header is a `toUTCString()` date three
seconds out produces one recorded backoff delay in `[1500, 3000]`
(derived from the date — the jitterless computed backoff would be 500),
and a date sixty seconds out under `retry: { maxMs: 4000 }` produces a
delay of exactly `4000`. The test was proven load-bearing by mutation:
with the `Date.parse` branch of `retryAfterMs` temporarily removed it
was the only failing test in the suite; restored, everything is green.
No bug surfaced in the client — the HTTP-date branch behaves as
specified, so the divergence-stop clause was never triggered. The full
gate ran clean except for four pre-existing dead-function findings in
the coverage audit that this work order's file constraint forbids
resolving (see Decisions & divergences).

## Files

- `test/ai/client.test.js` — added one `it('honors a Retry-After
  HTTP-date, capped by maxMs when the date is far off')` to the
  `ai — the retry policy` suite, using the suite's own `scriptedClient`
  helper; the work order's sole in-scope file.
- `docs/workflow/examples/SESSION-RECORD-example.md` — this record (created).
- `packages/ai/src/client.js` — temporarily mutated twice (HTTP-date
  branch of `retryAfterMs` removed for the checklist's kill-check, then
  restored exactly); net unchanged by this session.

## Decisions & divergences

- Both scripted scenarios from Steps 2 and 3 live in the single new
  `it(...)`: the acceptance checklist demands exactly one new test, and
  the neighboring delta-seconds test already packs its plain and capped
  cases into one `it` — the new test mirrors that convention, placed
  directly after it.
- The date case asserts `delays.length === 1` plus an `assert.ok` range
  `[1500, 3000]` (scheduling slack per the work order); the cap case
  asserts `deepStrictEqual(delays, [4000])` exactly, since `Math.min`
  with `maxMs` is deterministic.
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

- `npm run test:ai` — 67 tests, 67 pass, 0 fail (12 suites). New test
  `ok 4 - honors a Retry-After HTTP-date, capped by maxMs when the date
  is far off` inside `ok 5 - ai — the retry policy`; exactly one `it`
  added to that suite.
- Kill-check: with `const date = Date.parse(raw); if
  (!Number.isNaN(date)) return Math.max(0, date - Date.now());`
  removed from `retryAfterMs`, `npm run test:ai` → `# fail 1`, the
  failing test being the new one and the suite line `not ok 5 - ai —
  the retry policy`; branch restored → 67/67 green again.
- `npm run lint` — 0 errors, 0 warnings.
- `npm test` — 4363 tests, 4331 pass, 0 fail, 32 skipped, 799 suites
  (duration_ms ≈ 7344).
- `npm run website:build` — ✓ 278 modules transformed, built in 1.56s
  (pre-existing font-URL "resolved at runtime" notes only).
- `npm run benchmark:coverage` — Functions executed: 2992/2996 (99.9%);
  Dead-code findings: 0 file(s) + 4 function(s):
  `packages/ai/src/client.js` `defaultSleep` (line 173) and `abortError`
  (line 192), `packages/ai/src/providers.js` `fetchFn` (line 90),
  `packages/website/src/boundaries/assistant.js` `onReasoning`
  (line 492). Identical output with and without the new test.

## Open issues

- The four dead-function findings above predate this session and belong
  to the tree's uncommitted prior work (none of the four exist at HEAD).
  Resolving them needs its own scoped decision per the audit's rule:
  `defaultSleep`/`abortError` want a retry test that uses the real
  timer-based sleep and an abort mid-backoff without injecting `sleep`
  (every current retry test injects a recording stub); `fetchFn`
  (providers.js line 90) and `onReasoning` (website assistant boundary
  line 492) each want either a test that exercises them or removal if
  obsolete.
- The date-case range `[1500, 3000]` tolerates up to ~1.5 s of combined
  HTTP-date truncation and clock movement; on a pathologically stalled
  machine (>1.5 s between header construction and parsing) the floor
  could false-fail. Accepted as specified by the work order.
