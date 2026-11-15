# Generated MONTHLY and YEARLY occurrences (python-dateutil)

`occurrences.json` holds 3000 MONTHLY and YEARLY recurrence rules, each with
the occurrence starts a second, independent implementation gives for it:
`dateutil.rrule` from [python-dateutil](https://github.com/dateutil/dateutil)
2.9.0 (`2.9.0.post0`). Only the generated JSON is vendored here: no dateutil
code, and no test runs Python. The generator script is not part of the tree,
because it needs dateutil; it is described below so that it can be rewritten,
and its SHA-256 was
`000f814b096b33147e3083a37cad8c723b636a62c781c5bc8ed9643564690f8a`.

## Format

Each case is `[rrule, dtstart, horizonEnd, offsets]`:

- `rrule` is RRULE text (MONTHLY or YEARLY; COUNT, UNTIL or neither; INTERVAL;
  BYMONTH, BYWEEKNO, BYYEARDAY, BYMONTHDAY, BYDAY with and without ordinals,
  BYSETPOS, BYHOUR, BYMINUTE, BYSECOND, WKST; negative indexes).
- `dtstart` is a floating time (`YYYY-MM-DDTHH:MM:SS`) or a date
  (`YYYY-MM-DD`), and `horizonEnd` is of the same kind.
- `offsets` are the starts in `[dtstart, horizonEnd)`, in seconds from
  `dtstart`, in order. The list is complete for that horizon.

## How it was generated

- `random.Random(20261115)` draws each rule, using only the part combinations
  RFC 5545 section 3.3.10 allows for its FREQ (no BYWEEKNO outside YEARLY, no
  BYYEARDAY with MONTHLY, no ordinal BYDAY with BYWEEKNO, BYSETPOS only with
  another BY part, COUNT or UNTIL but not both). 15% of the cases are date
  rules; the others are floating.
- DTSTART is synchronised with its rule. A seeded time between 1995 and 2035
  is drawn, and DTSTART is the rule's first occurrence at or after it, within
  40 years. dateutil leaves out a DTSTART that its rule does not make, while
  RFC 5545 counts it as the first occurrence; a synchronised DTSTART is the
  first occurrence under both readings. 965 drawn rules had no occurrence in
  those 40 years and were not kept.
- The horizon is 2 to 8 years from DTSTART (times INTERVAL for YEARLY, at most
  60). A list is cut at 25 starts, and its horizon then ends at the 26th.
- dateutil walks a rule with no further occurrence up to year 9999. The
  generator bounds that one check, through a copy of the `datetime` module
  that only `dateutil.rrule` sees, at the year after the horizon. No
  occurrence before that year changes.
- It drew 4199 rules to keep 3000.

## Divergences left out

Where dateutil and RFC 5545 disagree, the RFC text wins. Every rule of these
four classes was left out by its shape, before generation, whether or not its
list differed:

| Class | Left out | dateutil | RFC 5545 |
|---|---|---|---|
| A YEARLY BYWEEKNO with no BYDAY, BYMONTHDAY or BYYEARDAY | 89 | makes all seven days of each numbered week | §3.3.10: "Information, not contained in the rule, necessary to determine the various recurrence instance start time and dates are derived from the Start Time": the weekday is DTSTART's |
| A YEARLY BYWEEKNO with INTERVAL above 1 or BYSETPOS | 106 | puts a numbered week's days in their calendar year, so a week 1 that starts in December, or a week 53 that ends in January, belongs to the neighbouring year's period | §3.3.10: BYWEEKNO lists "weeks of the year", and week 1 is the first week with at least four days of that year: all its days are that year's |
| A YEARLY BYWEEKNO naming week 52 or 53, either sign | 9 | does not count a negative week back into a week 1 that starts in the previous December (its source notes "TODO: Check -numweeks for next year"); and it can read the first days of January as week 53 of a year that has 52 weeks (`BYWEEKNO=53;BYDAY=SA,SU` from 2020-12-28 gives 2022-01-01 and 2022-01-02) | §3.3.10: week 1 is "the first week that contains at least four (4) days in that calendar year", and "-1 represents the last week of the year"; a year has week 53 only when its weeks reach it |
| A BYDAY mixing plain and ordinal weekdays (`BYDAY=1TH,FR,3FR`) | 30 | keeps a day only when it passes both the plain and the ordinal entries | §3.3.10: BYDAY is "a COMMA-separated list of days of the week", each value selecting its days |

The RFC answers of these classes are pinned by the test tree's own
day-walking oracle and by worked cases, not by this file.

## Licence

python-dateutil is distributed under the BSD 3-Clause License (all code) and
the Apache License 2.0 (contributions after 2017-12-01): "Copyright (c)
2003-2011 - Gustavo Niemeyer, Copyright (c) 2012-2014 - Tomi Pieviläinen,
Copyright (c) 2014-2016 - Yaron de Leeuw, Copyright (c) 2015- - Paul Ganssle,
Copyright (c) 2015- - dateutil contributors". This file holds its output, not
its code.

To refresh: rewrite the generator from the description above, run it under the
same dateutil version and seed, and compare its cases with this file.
