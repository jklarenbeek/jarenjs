# `@jarenjs/core/dates`

The calendar kernel. Two constraints shape everything in it. **There is
no date type**: a date is an RFC 3339 *string* (lexical, interchange) or
*epoch milliseconds* (arithmetic) — both already JSON items — never a
wrapper object. And **there is no `now`**: the current instant enters as
data (an app effect, an external), never as a hidden read, so everything
here is pure and cacheable. Locale names live in `@jarenjs/locales`; the
kernel itself is locale-free. Import the barrel (`@jarenjs/core/dates`)
or a single module.

## Lexical layer — `rfc3339.js`

Validation: `isDateOnlyRFC3339`, `isTimeOnlyRFC3339`,
`isDateTimeRFC3339` (strict RFC 3339 — an offset is required), and the
lenient ISO twins `isValidISODateTime` / `isValidISOTime` (offset
optional — what HTML's `datetime-local` control emits). Leap years and
month lengths are checked, not just shape.

Parsing: `parseRFC3339Parts(str)` → a flat **parts** record
`{year, month, day, hours, minutes, seconds, offset}`. Absent fields are
`-1` sentinels; `offset` is minutes east of UTC, `0` for `Z` and `null`
when the string carried none. The inverse is `formatRFC3339Parts(parts)`
(round-trips the offset). `epochOfRFC3339Parts(parts)` → epoch ms: a
date-only reads as UTC midnight, an offset shifts to its instant, and a
time-only has **no** instant — it returns `NaN` rather than inventing a
day. `getDateTypeOf*` variants produce a `Date` for callers that want
one; `isDateType` / `isDateishType` classify values.

## Calendar arithmetic — `civil.js`

Proleptic Gregorian math over **integer day numbers** (Howard Hinnant's
civil-days algorithm — no `Date`, no timezone, no DST edge):
`daysFromCivil(y, m, d)` ⇄ `civilFromDays(z)`, `weekdayFromDays` /
`isoWeekdayFromDays`, `isLeapYear`, `daysInMonth`, `dayOfYear`,
`quarterOfYear`, `isoWeekOfYear` (returns `{year, week}` — the ISO week
year is not the calendar year at the edges), `partsFromEpoch(ms, offset)`.

`addToParts(parts, amount, unit)`, `startOfParts`, `endOfParts` over
`DATE_UNITS` (`year`…`millisecond`, plus `quarter` and `week`; weeks
start Monday, per ISO). **Month math clamps**: 31 Jan + 1 month =
28 Feb, which is what makes add and diff behave as inverses in the
query operators built on this.

Two refusals keep those answers honest, both `TypeError`:

- **A unit reads a half, and a value may not carry it.** `year` through
  `day` read the calendar; `hour` through `millisecond` read the clock.
  Adding hours to a full-date, adding a day to a full-time, or
  truncating either to the unit it has not got has no answer to give.
  `day` and coarser truncations are the boundary both forms have, so
  `startOfParts` / `endOfParts` of a `day` on a full-time is midnight and
  `23:59:59.999`.
- **A fraction is a quantity only where it converts exactly.** A
  fractional fixed-width amount becomes whole milliseconds — `1.5 day` is
  thirty-six hours, and needs a value with a clock to land on. A
  fractional calendar unit is refused unless it lands on a whole month:
  half a year is six months, half a month is nothing.

## Time-axis ticks — `ticks.js`

`niceTimeStep(span, count)` picks the `[unit, amount]` a domain should be
read in — from 1/5/15/30 seconds and minutes through 1/3/6/12 hours, 1/2
days, 1/2 weeks and 1/3/6 months, then whole years on the 1/2/5 × 10^k
ladder, so a millennial domain steps by centuries rather than running out
of axis. `axisTicksTime(min, max, count)` lays the boundaries down: each
tick is a multiple of the step's own amount, so an axis reads
`1850 1900 1950 2000` rather than offsets from wherever the data began.
Below a second the calendar has nothing to say and the numeric ladder
answers instead. The chart component re-exports both rather than
carrying its own copy.

## Durations — `duration.js`

`parseDuration('P3DT4H')` — ISO 8601 duration decomposition into
`{negative, years, months, weeks, days, hours, minutes, seconds}`
(the boolean twin `isValidDuration` lives in `rfc3339.js` with the
other format testers). The load-bearing distinction is
`isFixedDuration(parts)`: days and smaller are a fixed millisecond span
(`durationToMs`), while years and months are **calendar** units whose
length depends on where they land — those go through
`addDuration(dateParts, duration, sign)`, which applies the clamping
month math. `monthsBetween(from, to)` is the calendar diff.

## Formatting — `format.js`

`compileDateFormat(pattern, names?)` compiles an
[LDML](https://unicode.org/reports/tr35/tr35-dates.html#Date_Format_Patterns)
pattern (`'yyyy-MM-dd HH:mm'`, quoted literals included) into a
formatter **once**, instead of re-scanning the pattern per call — the
same two-stage shape as every other compiler in the suite. Numeric and
ISO tokens work bare; name tokens (`MMMM`, `EEE`, `a`) require a
`names` provider, which is where `@jarenjs/locales` plugs in — the
kernel ships no month names, so server-rendered output stays
byte-stable across Node/ICU versions.
`compileDateLocale(pack).names` is that provider: five arrays (12 months
wide and short, 7 weekdays wide and short from Sunday, the two day-period
markers), read once out of a locale pack's own msgids and frozen, so a
pattern compiled against them costs no lookup per date.

## Not here

`Temporal` is deliberately not a dependency (it is not in this repo's
Node ≥ 24 baseline); the string/number representation is exactly what
`Temporal.Instant.from()` consumes, so the kernel can delegate
internally later without a surface change. Relative-time phrasing and
month-name catalogs are `@jarenjs/locales`' job — including the decision
that a relative phrase is handed its signed amount rather than working
one out, which is the same "no `now`" rule this kernel keeps; `formatMinimum`/
`formatMaximum` bound comparison lives in `@jarenjs/formats`; time
*axes* (charts) and date *controls* (forms) consume this kernel from
their own packages.
