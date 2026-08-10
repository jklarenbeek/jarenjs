# WO-EXAMPLE — cover the Retry-After HTTP-date branch of the chat client

Self-contained sample work order (the worked example for
`docs/workflow/CONVENTIONS.md`). Read first: `packages/ai/src/client.js`
(the `retryAfterMs` helper and the retry loop in `createChatClient`)
and `test/ai/client.test.js` (the `ai — the retry policy` suite and its
`scriptedClient` harness — match its conventions exactly).

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
- [ ] Session record written to
      `docs/workflow/examples/SESSION-RECORD-example.md`.
