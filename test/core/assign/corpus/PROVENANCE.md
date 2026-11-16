# The assignment quality corpus

Every instance here is **synthetic** and generated in this repository from a
seed. Nothing is copied from elsewhere, and no third-party data is included.

## What it holds

- **The 30 tiny instances** of `../oracle/instances.js` (`tinyInstance(1..30)`):
  at most 4 resources and 5 tasks, scored by the eight reference rules.
- **Ten seeded domains** from `domains.js`, each at a small size (3 resources
  and 4 tasks, or 2 resources and 5 days for `days`, redrawn until the oracle
  can enumerate every list, at most 20,000) and a medium size (8 resources
  and 24 tasks, or 4 resources and 10 days):
  - `overlaps`
  - `availability` (busy rows, and availability that leaves tasks uncovered)
  - `attributes` (skills)
  - `gaps`
  - `rolling` (a 24-hour window opening at each task's start, scored by the
    corpus rule `../rules/rolling.js`)
  - `days` (one task a day across a spring-forward and a fall-back change of
    the clock in Europe/Amsterdam, scored by the four day rules)
  - `coverage`
  - `fairness`
  - `locks` (a published list with hard and soft locks, some on a resource
    that is now busy)
  - `repair` (a published list after one resource was withdrawn)

The ids, seeds and sizes are fixed in `run.js` (`corpusInstances`). The day
domain reads zone offsets only through the vendored transition table
`test/core/calendar/fixtures/zone-transitions/transitions.json` (see its own
provenance) and the fixture provider over it.

## How it is checked

`../corpus.test.js` solves every instance with every strategy that applies:

- `exhaustive` within `SOLVE_LIMITS`;
- `construct`, unseeded and seeded;
- `local`, unseeded, seeded with restarts, and under a three-move budget;
- `auto`.

It holds each answer to `../oracle/validate.js`, which reads raw JSON through
the oracle's own files and imports no engine module. Where the oracle can
enumerate an instance, the complete search's proof (status, best score and
bound) must be what `exhaustive` answers.

## Public benchmark sets

**None is included.** No public rostering or timetabling benchmark set was
adapted for this corpus, because none was reviewed whose licence was found to
clearly permit redistribution in this repository. A set added later must carry
its licence, its upstream path and revision, and its own independent
validator here, with its expected scores unchanged.
