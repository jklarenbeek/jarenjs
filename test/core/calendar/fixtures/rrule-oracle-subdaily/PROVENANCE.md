# Generated SECONDLY, MINUTELY and HOURLY occurrences (python-dateutil)

`occurrences.json` holds 600 SECONDLY, MINUTELY and HOURLY recurrence rules,
each with the occurrence starts a second, independent implementation gives for
it: `dateutil.rrule` from [python-dateutil](https://github.com/dateutil/dateutil)
2.9.0 (`2.9.0.post0`). Only the generated JSON is vendored here: no dateutil
code, and no test runs Python. The generator script is not part of the tree,
because it needs dateutil; it is described below so that it can be rewritten,
and its SHA-256 was
`7e8aa4a8f163aa6ba9074eb1411c52b47c72bc7ea6a9548cbdbc5d44d05c05cb`.

## Format

Each case is `[rrule, dtstart, horizonEnd, offsets]`:

- `rrule` is RRULE text (SECONDLY, MINUTELY or HOURLY; COUNT, UNTIL or
  neither; INTERVAL; BYSECOND, BYMINUTE, BYHOUR, BYDAY without ordinals,
  BYMONTHDAY, BYYEARDAY, BYMONTH, BYSETPOS; negative indexes).
- `dtstart` is a floating time (`YYYY-MM-DDTHH:MM:SS`), or a utc one with a
  trailing `Z` (187 cases), and `horizonEnd` is of the same kind.
- `offsets` are the starts in `[dtstart, horizonEnd)`, in seconds from
  `dtstart`, in order. The list is complete for that horizon.

dateutil steps a naive wall clock. That is what a floating rule steps, and
what a utc rule steps too (UTC has no change of offset), so one list serves
both kinds.

## How it was generated

- `random.Random(20261118)` draws each rule: its FREQ, then each of BYSECOND,
  BYMINUTE, BYHOUR, BYDAY, BYMONTHDAY, BYYEARDAY and BYMONTH with chance 0.3
  (signed values with chance 0.35 for BYMONTHDAY and BYYEARDAY), BYSETPOS
  with chance 0.3 when another BY part is drawn (positions within one
  period's set, sometimes one past its end), INTERVAL 1 half the time and
  otherwise one of 2, 3, 5, 7, 10, 13, 15, 25, 30, 45 or 90, and COUNT, UNTIL
  or neither. These are the combinations RFC 5545 section 3.3.10 allows for a
  sub-daily FREQ: no BYWEEKNO, no ordinal BYDAY, BYSETPOS only with another
  BY part, COUNT or UNTIL but not both. 30% of the cases are utc.
- DTSTART is synchronised with its rule. A seeded time between 1995 and 2035
  is drawn, and DTSTART is the rule's first occurrence at or after it, within
  800 days. dateutil leaves out a DTSTART that its rule does not make, while
  RFC 5545 counts it as the first occurrence; a synchronised DTSTART is the
  first occurrence under both readings.
- The horizon is 3 to 6 days from DTSTART for SECONDLY, 40 to 80 days for
  MINUTELY and 800 to 1600 days for HOURLY. A list is cut at 25 starts, and
  its horizon then ends at the 26th. Each dateutil walk is bounded by an UNTIL
  at the horizon (dateutil otherwise walks a rule with no further occurrence
  up to year 9999); no start before the horizon changes.
- It drew 746 rules to keep 600. Left out: 28 with no occurrence within 800
  days of the seeded time; 47 that dateutil refuses as an empty set
  (`ValueError`: an INTERVAL that never reaches a BYHOUR, BYMINUTE or
  BYSECOND value, such as `FREQ=HOURLY;INTERVAL=30;BYHOUR=2` from 00:00); and
  71 that dateutil did not finish within 3 seconds (rules whose limits rarely
  meet, such as BYMONTHDAY with BYYEARDAY, and BYSETPOS positions a period
  rarely fills). The empty-set class is pinned by a worked case in
  `rrule-subdaily.test.js` (DTSTART only, under its limits).

## Zoned walks across a change of offset

dateutil is naive, so it is not an oracle for a zoned rule whose wall clock
crosses a change of offset. `rrule-subdaily.test.js` pins those cases by a
table derived by hand from the zdump transitions in
`../zone-transitions/transitions.json` (IANA 2026e), each generated wall clock
read with the offset in force, a time in a gap with the offset before the
change (RFC 5545 erratum 4271, section 3.3.5), and a time in a fold with the
earlier offset (`rfc5545`) or the later one (`later`):

| Zone, change | Rule | Derivation |
|---|---|---|
| Europe/Amsterdam, 2026-03-29T01:00Z, +60 to +120 | `FREQ=HOURLY` from 00:00 | wall clocks 02:00-03:00 never happen; 02:00 read at +60 is 01:00Z, the instant 03:00 reads at +120 |
| Europe/Amsterdam, 2026-10-25T01:00Z, +120 to +60 | `FREQ=HOURLY` from 00:00 | 02:00-03:00 happen twice; 02:00 is 00:00Z at +120 (`rfc5545`) or 01:00Z at +60 (`later`); 01:00Z is no generated wall clock's earlier instant |
| America/New_York, 2026-03-08T07:00Z, -300 to -240 | `FREQ=MINUTELY;INTERVAL=30;COUNT=6` from 01:00 | 02:00 and 02:30 never happen; at -300 they are 07:00Z and 07:30Z, the instants 03:00 and 03:30 read at -240 |
| America/New_York, 2026-11-01T06:00Z, -240 to -300 | `FREQ=MINUTELY;INTERVAL=30;COUNT=5` from 00:30 | 01:00 and 01:30 happen twice; at -240 they are 05:00Z and 05:30Z; 02:00 at -300 is 07:00Z |
| Australia/Lord_Howe, 2026-04-04T15:00Z, +660 to +630 | `FREQ=MINUTELY;INTERVAL=15;COUNT=6` from 01:00 | 01:30-02:00 happen twice; 01:30 at +660 is 14:30Z; 02:00 at +630 is 15:30Z |
| Australia/Lord_Howe, 2026-10-03T15:30Z, +630 to +660 | `FREQ=MINUTELY;INTERVAL=15;COUNT=5` from 01:45 | 02:00-02:30 never happen; 02:00 and 02:15 at +630 are 15:30Z and 15:45Z, the instants 02:30 and 02:45 read at +660 |
| Pacific/Apia, 2011-12-30T10:00Z, -600 to +840 | `FREQ=HOURLY;INTERVAL=6;COUNT=6` from 2011-12-29 18:00 | all of 2011-12-30 never happens; its 00:00, 06:00, 12:00 and 18:00 at -600 are 10:00Z, 16:00Z, 22:00Z and 04:00Z, the instants 2011-12-31's own times read at +840 |

## Licence

python-dateutil is distributed under the BSD 3-Clause License (all code) and
the Apache License 2.0 (contributions after 2017-12-01): "Copyright (c)
2003-2011 - Gustavo Niemeyer, Copyright (c) 2012-2014 - Tomi Pieviläinen,
Copyright (c) 2014-2016 - Yaron de Leeuw, Copyright (c) 2015- - Paul Ganssle,
Copyright (c) 2015- - dateutil contributors". This file holds its output, not
its code.

To refresh: rewrite the generator from the description above, run it under the
same dateutil version and seed, and compare its cases with this file.
