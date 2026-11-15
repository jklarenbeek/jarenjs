# `@jarenjs/core/calendar`

The calendar layer above the zone seam. A wall clock in a named zone is
not a function of the clock: on a spring-forward day an hour never
happens, and on a fall-back day an hour happens twice. The seam's
`toEpoch(parts, zone, disambiguation)` answers one number for both, or
`NaN` when told to refuse, so a caller cannot tell which case it met.
This module **classifies first** — the local time exists, falls in a
*gap* or falls in a *fold*, with every instant it names — and only then
applies a **policy the caller names**. There is no default policy: an
implicit choice is the one that goes wrong unnoticed.

It carries no zone data and reads no clock of its own. Every zone
question goes to an injected provider (`@jarenjs/locales/intl-zones`
is the opt-in one over the host's ICU), and "now" is the injected
runtime's `now()`. The host's own zone is never read.

```js
import { classifyLocal, resolveLocal, isZone, assertZone, todayIn } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider({ revision: '2026e' }); // the tzdata your hosts run
```

## The provider seam

A provider is the `ZoneProvider` of `@jarenjs/core/series` — `toParts`
and `toEpoch` — plus two optional members this layer reads:

| Member | Answers |
|---|---|
| `candidates(parts, zone)` | `{ candidates, offsets? }`: the instants that carry the wall clock, ascending, each `{ instant, offsetMinutes }` with the offset in force there. One is a time that exists, two a fold; none is a gap, and then `offsets: { before, after }` are the offsets in force either side of the change. A fold carries `offsets` too. |
| `identity` | `{ name, revision }`: which zone data answers, recorded on every resolution |

`createIntlZoneProvider({ zones, revision })` implements both from the
probe `toEpoch` already runs, so the two cannot disagree; `toEpoch`
itself is unchanged. Its `identity` is `{ name: 'intl', revision }`,
where `revision` is what the caller passed or `'unrecorded'` — the
provider never reads or invents one. A provider without `candidates`
still serves the series kernel; classification refuses it (`JY0004`)
rather than guessing through `toEpoch`. A provider without `identity`
is recorded as `{ name: 'unrecorded', revision: 'unrecorded' }`.

## Parts

A local time is `{ year, month, day, hours, minutes, seconds }`:
year 0 to 9999, month 1 to 12, a day the month has, hours 0 to 23,
minutes 0 to 59, and seconds from 0 up to but not including 60, with at
most a millisecond fraction. Absent time members are `0`. Anything else
is refused (`JY0007`) **before** the provider is asked: the thirtieth of
February reads back as another wall clock exactly as a gap does, and a
policy must never "resolve" it. `24:00`, a leap second and a fraction
past the millisecond are refused, never rolled over or rounded. Any
other member — an `offset` a provider's `toParts` reported, say — is
not read; the zone decides the offset.

## `classifyLocal(parts, zone, provider)`

```js
classifyLocal({ year: 2026, month: 3, day: 29, hours: 2, minutes: 30 }, 'Europe/Amsterdam', provider);
// { kind: 'gap', candidates: [], offsets: { before: 60, after: 120 } }

classifyLocal({ year: 2026, month: 10, day: 25, hours: 2, minutes: 30 }, 'Europe/Amsterdam', provider);
// { kind: 'fold',
//   candidates: [{ instant: <2026-10-25T00:30:00Z>, offsetMinutes: 120 },
//                { instant: <2026-10-25T01:30:00Z>, offsetMinutes: 60 }],
//   offsets: { before: 120, after: 60 } }
```

`kind` is `'exists'`, `'gap'` or `'fold'`; `candidates` holds one, zero
or two instants; `offsets` is present for a gap and a fold. Every answer
is frozen.

## Policies

| Policy | Gap (never happens) | Fold (happens twice) |
|---|---|---|
| `rfc5545` | read with the offset **before** the change: the time moves forward by the gap's length | the **earlier** instant |
| `later` | as `rfc5545` | the **later** instant |
| `reject` | refused, `JY0002` | refused, `JY0003` |

A time that exists has one instant, and every policy answers it.
`rfc5545` is the rule RFC 5545 §3.3.5 gives for recurrence; `later`
is the rule the PostgreSQL documentation states for reading a
`timestamptz` (Appendix B.1, "Handling of Invalid or Ambiguous
Timestamps": a nonexistent time takes the offset from before the
change, an ambiguous one the offset from after it). The seam's
`disambiguation` names (`'earlier'`) are not policies here and are
refused (`JY0005`).

## `resolveLocal(parts, zone, { provider, policy })`

Returns `{ instant, resolution }`, where `resolution` is
`{ kind, policy, zone, offsetMinutes, provider: { name, revision } }`:
the case the local time was in, the policy that decided it, and the
offset in force **at the returned instant** — for a gap, the offset
after the change, because the wall clock moved forward. A caller that
stores an instant can store its resolution beside it, and recompute
when the provider's revision changes.

Worked examples, in neutral domains:

- **A shop that opens at 02:30 on the night clocks go forward**
  (Amsterdam, 2026-03-29). 02:30 never happens there: the clock jumps
  from 02:00 at +01:00 to 03:00 at +02:00.
  `rfc5545` and `later` both answer `2026-03-29T01:30:00.000Z` — 03:30
  on the wall, as far past the gap as 02:30 stood into it — with
  `offsetMinutes: 120`. `reject` throws `JY0002`:
  `2026-03-29T02:30:00 never happens in 'Europe/Amsterdam': the clock moves from +01:00 to +02:00`.
- **An appointment at 02:30 on the night clocks go back**
  (Amsterdam, 2026-10-25). 02:30 happens at +02:00 and again at +01:00.
  `rfc5545` answers the first, `2026-10-25T00:30:00.000Z`
  (`offsetMinutes: 120`); `later` the second,
  `2026-10-25T01:30:00.000Z` (`offsetMinutes: 60`); `reject` throws
  `JY0003`.
- **A 30-minute change** (Lord Howe Island, 2026-10-04). The clock goes
  from 02:00 at +10:30 to 02:30 at +11:00, so 02:00 is a gap half an
  hour wide: `rfc5545` answers `2026-10-03T15:30:00.000Z`, 02:30 on the
  wall.
- **A skipped day** (Apia, 2011-12-30). The zone moved across the date
  line: 2011-12-29 24:00 at -10:00 became 2011-12-31 00:00 at +14:00,
  and every time on 2011-12-30 is one gap a day wide. A staff roster
  shift at 12:00 that day resolves under `rfc5545` to
  `2011-12-30T22:00:00.000Z`, which is 12:00 on 2011-12-31.

## `isZone(name, provider)` and `assertZone(name, provider)`

`isZone` answers whether the provider knows the name (`false` for a
non-string or an empty one); `assertZone` returns the name or throws
`JY0001` naming it. Both ask the provider through `toParts`, so they
answer what that zone data accepts: the Intl provider also accepts a
link name (`US/Eastern`), a case variant (`europe/amsterdam`) and, on
hosts whose `Intl` does, a fixed offset such as `+01:00`. Neither says
a name is the canonical one.

## `todayIn(zone, { runtime, provider })`

The civil date in a zone at the runtime clock's instant, as
`YYYY-MM-DD`. The instant is `runtime.now()` (a fixed clock in a test,
the platform's by default), and the provider is `provider` or else the
runtime's `zoneProvider`. At `2026-01-01T10:30:00Z` it is `'2026-01-01'`
in `Pacific/Apia` (23:30 at +13:00) and `'2025-12-31'` in
`Pacific/Pago_Pago` (23:30 at -11:00).

## Temporal values

```js
import {
  dateValue, floatingValue, utcValue, zonedValue, dateRangeValue, parseTemporal,
  bindFloating, toUtc, shiftCivil, splitByCivilDay,
} from '@jarenjs/core/calendar';
```

A calendar time is one of five kinds, each plain frozen JSON that
survives storage and transport as written. No kind is collapsed into
another to make an operation easier: a floating time stays floating
until a caller binds it to a zone.

| Kind | JSON | Constructor |
|---|---|---|
| date | `{ kind: 'date', date: 'YYYY-MM-DD' }` | `dateValue(date)` |
| floating | `{ kind: 'floating', date, time: 'HH:MM[:SS[.fff]]' }` | `floatingValue(date, time, { bound })` |
| utc | `{ kind: 'utc', instant: 'YYYY-MM-DDTHH:MM:SS[.fff]Z' }` | `utcValue(instant)` — a string, or epoch milliseconds |
| zoned | `{ kind: 'zoned', date, time, zone }` | `zonedValue(date, time, zone, { bound, provider })` |
| date-range | `{ kind: 'date-range', start, end }`, `end` exclusive | `dateRangeValue(start, endInclusive)` |

`dateRangeValue` takes the last day the way people write it and stores
the day after, so no caller writes the +1:
`dateRangeValue('2026-07-01', '2026-07-14')` is
`{ kind: 'date-range', start: '2026-07-01', end: '2026-07-15' }`.
`utcValue(epochMs)` spells the instant with three fraction digits
(`utcValue(Date.parse('2026-03-29T01:30:00Z'))` is
`{ kind: 'utc', instant: '2026-03-29T01:30:00.000Z' }`); a string is
kept as written. `zonedValue` checks the zone against `provider` when
one is passed; otherwise the zone must be a non-empty name, and whether
the provider knows it is learned when the value is resolved.
`parseTemporal(json, { bound, provider })` reads an object or its JSON
text, checks it as its kind's constructor does, refuses any member
beyond the kind's own and a date range that does not end after it
starts, and answers a new frozen value.

**`24:00` is the end of a day**, so it is admitted only where a value is
an end bound: pass `{ bound: 'end' }` (`24:00`, or `24:00:00` with up
to three zero fraction digits). A value standing alone, or at a
start, is refused with its own code (`JY0008`). Nothing is rounded,
truncated or rolled over: a seconds value of 60 is `JY0009`, a fraction
past the millisecond is `JY0010` (a value carries milliseconds; a
caller that keeps microseconds keeps its own fraction), an offset or `Z`
on a floating or zoned time is `JY0011` (a floating time has none, and
a zoned time takes its zone's), and a day the calendar does not have,
such as `2026-02-30`, is `JY0012`.

The schema twin is
`@jarenjs/core/schemas/calendar/temporal.schema.json`, `$id`
`https://jarenjs.dev/schemas/jaren-core/calendar/temporal/0.1`. Its root
reads a value standing alone or at a start; `#/$defs/end` reads an end
bound. Every constructor's answer validates against it, and each
refusal above fails in the definition named after its code
(`endOfDayAtStart`, `leapSecond`, `subMillisecond`, `offsetOnWallTime`,
`calendarDate`, …). Two refusals are the constructors' alone, because a
schema cannot say them: a zone the provider does not know, and a date
range that does not end after it starts.

## `bindFloating(value, { zone, source, provider, policy })`

Binding gives a zone-less value (a date, floating or date-range value)
the zone the caller names, and records where that zone came from.
`source` is the caller's own short token (`'location'`, `'tenant'`,
`'explicit'`); it is recorded as given, or as `'unrecorded'`. The
policy is required, as for `resolveLocal`.

| Value | Answer |
|---|---|
| floating | `{ kind: 'instant', value: <the zoned value>, instant, binding: { zone, source }, resolution, provider }` |
| date | `{ kind: 'span', value, start, end, binding, resolution: { start, end }, provider }`: the half-open day `[start, end)` |
| date-range | the same span, from the first day's start to the end day's |
| any, with `zone` absent or `null` | `{ kind: 'unresolved', reason: 'no-zone', value }` |

Instants are epoch milliseconds. **With no zone the answer is
`unresolved`, never a throw**, and nothing else is read: no provider, no
policy, never the host's zone, and never UTC. A zone that is given but
is not a non-empty name is still `JY0001`. A utc or zoned value names
its own instant and is refused here (`JY0013`); `toUtc` answers it.
Every resolved answer carries `provider: { name, revision }`, so a
caller can store which zone data produced an instant.

**A day is the span from its first instant to the next day's first
instant**, each found from that day's midnight. It is never midnight
plus 24 hours, so a spring-forward day is 23 hours long, a fall-back
day 25, and a half-hour change makes 23.5- and 24.5-hour days. A day
starts at the first instant whose wall clock reads that date. When
midnight falls in a gap, that is the instant the clock jumps past it;
when a fold opens at midnight, it is the first of the two midnights,
because the repeated hour reads the same date both times. Neither case
consults the policy. Only a fold that carries the clock back across
midnight, to the day before, gives a day two candidate starts: the
policy picks one there (`rfc5545` the first, `later` the second), and
`reject` refuses it (`JY0003`). A closing `24:00` is the next day's
start, found the same way.

Worked examples, in neutral domains:

- **A shop's hours on the night clocks go forward.** The shop opens at
  09:00 and closes at 24:00, wherever it is. Bound to its location,
  Amsterdam, on 2026-03-29, it opens at `2026-03-29T07:00:00.000Z` and
  closes at `2026-03-29T22:00:00.000Z`: 15 hours, and the day itself is
  23 (`2026-03-28T23:00:00.000Z` to `2026-03-29T22:00:00.000Z`).
  On 2026-10-25 the day is 25 hours.

  ```js
  const at = { zone: 'Europe/Amsterdam', source: 'location', provider, policy: 'rfc5545' };
  bindFloating(floatingValue('2026-03-29', '09:00'), at).instant;                                   // 07:00Z
  bindFloating(floatingValue('2026-03-29', '24:00', { bound: 'end' }), { ...at, bound: 'end' }).instant; // 22:00Z
  bindFloating(floatingValue('2026-03-29', '09:00'), { zone: null });
  // { kind: 'unresolved', reason: 'no-zone', value: { kind: 'floating', date: '2026-03-29', time: '09:00' } }
  ```

- **A leave period** of 2026-07-01 to 2026-07-14 inclusive, bound to a
  tenant's zone (Amsterdam), spans `2026-06-30T22:00:00.000Z` to
  `2026-07-14T22:00:00.000Z`.
- **A skipped day.** Apia's 2011-12-30 is an empty span under every
  policy: start and end are both `2011-12-30T10:00:00.000Z`.

## `toUtc(value, ctx)` and `shiftCivil(value, { days }, ctx)`

`toUtc` answers what a value names in UTC, by kind: a utc value is its
own instant (`{ kind: 'instant', value, instant }`, with no provider or
policy needed); a zoned value is resolved in its own zone under
`ctx.policy` (a zone in `ctx` is not read for it); a date, floating or
date-range value is bound to `ctx.zone` as `bindFloating` binds it, and
is `unresolved` without one.

- **An appointment at 02:30 on the night clocks go back**, stored as
  `zonedValue('2026-10-25', '02:30', 'Europe/Amsterdam')`: `toUtc` under
  `rfc5545` answers `2026-10-25T00:30:00.000Z`, under `later`
  `2026-10-25T01:30:00.000Z`, and under `reject` it throws `JY0003`.

`shiftCivil` moves a value by whole civil days (the same wall clock on
another day, not a multiple of 24 hours) and answers what `toUtc`
answers for the moved value; the answer's `value` is the moved value. A
moved time that lands in a gap or fold is resolved under the policy,
and keeps the wall clock it was written with. A utc value moves by
24-hour days. A day count that is not a whole number is `JY0014`.

- **A staff roster shift repeated weekly.** The shift at 02:30 on
  Sunday 2026-03-22 in Amsterdam, moved 7 days, is
  `{ kind: 'zoned', date: '2026-03-29', time: '02:30', zone: 'Europe/Amsterdam' }`.
  That time is in the gap, so under `rfc5545` it resolves to
  `2026-03-29T01:30:00.000Z` with `resolution.kind: 'gap'`.

## `splitByCivilDay(interval, { zone, provider, policy, maxDays })`

It splits a half-open interval of instants, `{ start, end }` in epoch
milliseconds, at a zone's civil-day boundaries. The answer is
`[{ date, start, end }]` in order, and its pieces tile the interval
exactly. Each day's boundaries are found as `bindFloating` finds them,
so the days are as long as the zone made them. A skipped day has no
instant and gives no piece. `maxDays` (default 36600) bounds the walk,
and an interval that spans more days is refused (`JY0014`), as is one
that is not two whole numbers with `start <= end`. The zone is required
here (`JY0001`), because an interval of instants has no zone-less form.

- **A night shift across the fall-back change, split for payroll.**
  The shift runs from `2026-10-24T20:00:00Z` to `2026-10-25T06:00:00Z`,
  22:00 to 07:00 on the wall in Amsterdam. It splits into
  `{ date: '2026-10-24' }` with 2 hours and `{ date: '2026-10-25' }`
  with 8. The second piece is 8 elapsed hours for 7 on the wall (00:00
  to 07:00), because the clock went back an hour at 03:00.
- **Across Apia's skipped day**, `2011-12-29T10:00:00Z` to
  `2011-12-31T10:00:00Z` splits into 2011-12-29 (24 hours) and
  2011-12-31 (24 hours). There is no 2011-12-30.

## Recurrence

A recurrence is a start, a length and an RFC 5545 rule (RRULE). It is
compiled once and expanded inside a half-open horizon `[start, end)`,
under a budget that every step of the walk is charged to. The answer is
either complete, or incomplete with the limit that stopped it and exact
counts. This release reads and checks the whole RRULE grammar for every
frequency, and enumerates DAILY, WEEKLY, MONTHLY and YEARLY rules. A valid
SECONDLY, MINUTELY or HOURLY rule is refused by name (`JY0020`). It never
compiles into a rule that quietly returns no occurrences.

```js
import { compileRecurrence, expandRecurrence, floatingValue, dateValue } from '@jarenjs/core/calendar';

const standup = compileRecurrence({
  dtstart: floatingValue('2026-01-05', '09:00'),
  duration: 'PT15M',
  rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12',
});
const { status, occurrences, counts } = expandRecurrence(standup, {
  horizon: [dateValue('2026-01-01'), dateValue('2026-02-01')],
});
// status 'complete'; 12 occurrences, the first
// { recurrenceId: '2026-01-05T09:00:00',
//   start: { kind: 'floating', date: '2026-01-05', time: '09:00:00' },
//   end: { kind: 'floating', date: '2026-01-05', time: '09:15:00' } }
```

### `compileRecurrence({ dtstart, duration | dtend, rrule, wkst?, policy? })`

- **`dtstart`** is a date, floating, utc or zoned value on a whole
  second. RRULE counts in seconds, so a fraction is refused (`JY0013`).
  DTSTART is always the first occurrence: RFC 5545 §3.3.10 says it
  "always counts as the first occurrence", whether or not the rule's
  parts would make it.
- **The length** is one of two forms, not both:
  - `duration`: an RFC 5545 duration (`P1W`, `P2D`, `PT1H30M`,
    `P1DT2H`). Its weeks and days are nominal and its hours, minutes and
    seconds are exact, so a zoned `P1D` lasts 23 hours across
    spring-forward and `PT24H` lasts 24.
  - `dtend`: a value of the start's kind. Its distance from `dtstart` is
    exact.

  With neither, a date lasts one day and a time lasts none. A date
  start takes whole days or weeks only.
- **`rrule`** is RRULE text (`'FREQ=WEEKLY;BYDAY=MO'`, with or without
  `RRULE:`, in any case and part order) or its JSON form. The JSON form
  uses the part names as keys: `{ FREQ: 'WEEKLY', BYDAY: ['MO'] }`, with
  numbers as numbers, BYDAY entries as `'MO'`, `'1MO'` or `'-1FR'`, and
  UNTIL as a temporal value. The compiled rule's `rrule` is its
  canonical JSON:
  - lists are sorted, without repeats;
  - `INTERVAL=1` and `WKST=MO`, the defaults, are left out.

  `formatRRule(rule)` writes the same rule as canonical text, with FREQ
  first. It takes text, JSON or a compiled recurrence. The schema twin is
  `@jarenjs/core/schemas/calendar/rrule.schema.json`, and its UNTIL
  refers to the temporal schema.
- **`wkst`** sets WKST when the rule does not. If both give it and they
  differ, the call is refused (`JY0017`).
- **`policy`** resolves a zoned rule's local times. It defaults to
  `rfc5545`, the RFC's own rule: RFC 5545 erratum 4271 reads a generated
  time that does not exist as §3.3.5 reads an explicit one. The same
  policy resolves the DTSTART occurrence and, in a series, its RDATEs and
  moved starts.

**The grammar is checked in full, for every frequency.** The checks run
in a fixed order, so one rule always names the same fault:

1. Each part's spelling, range and sign, part by part in canonical
   order.
2. The parts that do not go together.
3. The parts that do not go with the start.
4. The frequency.

Every refusal carries the part and list index as its `docPath`, so the
third BYMONTHDAY value is `rrule.BYMONTHDAY[2]` in text and JSON alike.

| Rule | Code |
|---|---|
| an unknown, empty or misspelled part; no FREQ | `JY0015` |
| BYSECOND 0-59 (60, a leap second, is `JY0009`); BYMINUTE 0-59; BYHOUR 0-23; BYMONTH 1-12, all unsigned | `JY0016` |
| BYMONTHDAY ±1-31, BYYEARDAY ±1-366, BYWEEKNO ±1-53, BYSETPOS ±1-366, a BYDAY ordinal ±1-53; never 0 | `JY0016` |
| INTERVAL and COUNT are positive whole numbers | `JY0016` |
| a part given twice | `JY0017` |
| COUNT with UNTIL | `JY0018` |
| BYWEEKNO with any FREQ but YEARLY | `JY0018` |
| BYYEARDAY with DAILY, WEEKLY or MONTHLY | `JY0018` |
| BYMONTHDAY with WEEKLY | `JY0018` |
| an ordinal BYDAY (`1MO`) with any FREQ but MONTHLY or YEARLY, or with BYWEEKNO | `JY0018` |
| BYSETPOS without another BY part | `JY0018` |
| BYHOUR, BYMINUTE or BYSECOND with a date start | `JY0018` |
| UNTIL of the wrong kind: date for a date start, floating for a floating start, utc for a utc or zoned start | `JY0019` |
| a valid rule whose FREQ this release does not enumerate | `JY0020` |

### `expandRecurrence(compiled, { horizon, limits?, provider? })`

The answer is
`{ status: 'complete' | 'incomplete', occurrences, counts: { emitted, work, providerCalls }, limit? }`.
Each occurrence is `{ recurrenceId, start, end }`, with `start` and
`end` (exclusive) of the rule's kind:

- **`recurrenceId`** is the start the rule generated, before any zone
  resolution, in one spelling per kind: `2026-01-05`,
  `2026-01-05T09:00:00`, or `2026-01-05T09:00:00Z` for a utc rule. It
  is the same under every policy and provider revision, and a series
  keys its EXDATEs and overrides by it.
- **A utc rule's occurrence** adds `instants: { start, end }` in epoch
  milliseconds.
- **A zoned rule's occurrence** adds `instants`, the `resolution` of
  its start (as `resolveLocal` answers it) and the provider's identity. Its `start` is the wall clock
  the instant reads. So a 02:30 rule on 2026-03-29 in Amsterdam keeps
  `recurrenceId: '2026-03-29T02:30:00'` and starts at `03:30:00`
  (`2026-03-29T01:30:00.000Z`) under `rfc5545` and `later`. Under
  `reject` it refuses the expansion with `JY0002`. On 2026-10-25 the
  same rule starts at `00:30Z` under `rfc5545` and at `01:30Z` under
  `later`.

**The horizon.** It is of the rule's kind:

| Rule | Horizon bounds |
|---|---|
| date | date values |
| floating | floating or date values |
| utc or zoned | utc values or epoch milliseconds |

An occurrence that started before the horizon and is still going at its
start is included. One that ends exactly at the start is not. An empty
occurrence at the start is included, and the end is exclusive.

**Kinds.** A floating or date rule expands without a zone and stays
floating: one rule serves places in different zones. Binding an
occurrence to a zone is the caller's step, with `bindFloating`. A zoned
rule needs `provider` (with `candidates` and `toParts`). Under `reject`,
a generated time refuses only when the answer would hold it; a gap or
fold outside the horizon does not. A rule given with `dtend` resolves its
DTSTART and DTEND to measure its length, and those refuse wherever they
fall.

**COUNT and UNTIL keep their meaning for the whole rule.** COUNT counts
from DTSTART, so a horizon after the tenth occurrence of `COUNT=10` is
complete and empty. A zoned rule's UTC UNTIL is compared as an instant.

**The walk.** It runs one period at a time: a day for DAILY, a week
that starts on WKST for WEEKLY, a month for MONTHLY and a year for
YEARLY (see below). BYSETPOS picks from each period's
set before DTSTART is applied, so WKST changes what
`FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU` makes. Without COUNT every period
answers the same whatever came before it, so the walk jumps straight to
the first period that can reach the horizon. With COUNT it walks from
DTSTART and charges every step. A day the month does not have, such as
`BYMONTHDAY=30` in February, is skipped and not counted, never clamped.
An occurrence whose end passes 9999-12-31, the last day a value can
name, has no spelling. The walk stops there with `status: 'incomplete'`
and `limit: 'calendar-end'`, so a short list never reads as complete.

**MONTHLY and YEARLY.** A period is a month or a year. With BYWEEKNO it
is the run of weeks the year numbers, from its week 1 to the next year's
week 1, so a week 1 that starts in December belongs to the next year.
Every day of the period is examined. It is a candidate when it passes
every BY part the rule has, the parts RFC 5545 §3.3.10 calls expanding
and limiting alike:

- BYMONTH, BYMONTHDAY and BYYEARDAY name the day's own month, its day of
  the month and its day of the year. A negative value counts from the
  end: `BYMONTHDAY=-1` is the last day of each month.
- BYWEEKNO numbers the year's weeks. Week 1 is the first week, starting
  on WKST, with at least four days of the year, and -1 is the last. A
  year has a week 53 only when its weeks reach it.
- BYDAY is a list, and each value selects: `MO` is every Monday and `1MO`
  the first. The ordinal counts within the month, for MONTHLY and for
  YEARLY with BYMONTH, and within the year for YEARLY without BYMONTH
  (RFC 5545 errata 1913 and 3779). Beside BYMONTHDAY or BYYEARDAY it
  limits them: `FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13` is every Friday the
  13th.
- What the rule leaves out comes from DTSTART. MONTHLY with no BYMONTHDAY
  or BYDAY keeps DTSTART's day of the month. YEARLY with no BYYEARDAY,
  BYMONTHDAY or BYDAY keeps DTSTART's weekday under BYWEEKNO, and
  otherwise its day of the month and, with no BYMONTH, its month.
- A date the period does not have is skipped, never clamped or moved.
  `FREQ=MONTHLY` from 31 January makes 31 March next, and `FREQ=YEARLY`
  from 29 February makes only leap years.
- INTERVAL counts months or years from DTSTART's own month or calendar
  year.

Every day of a period is charged, so a rule that never matches, such as
`FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30`, costs one step per day walked and
ends under its limits.

A zoned answer is in order of instant, not of wall clock. A time a gap
moved forward can start after a later wall clock does: in Amsterdam on
2026-03-29, 02:40 moves to 01:40Z while 03:10 starts at 01:10Z. The walk
never stops on such a time. Once it has enough occurrences it stops at
once, unless it has resolved such a time: then it walks three more days
of wall clocks before ordering, and a limit reached there leaves the
answer incomplete. Two generated times that resolve to one instant
are kept as two occurrences with their own ids, such as 02:30 moved onto
a generated 03:30.

**Options.** Every call here refuses a member it does not read
(`JY0014`, at the member's path), so `policy` or `zone` on an expansion,
or a limit outside `limits`, is an error rather than ignored.

**The limits.** Every limit stops the walk with `status: 'incomplete'`,
the occurrences found before it in order, and its name in `limit`. Any
limit left out takes `RECURRENCE_LIMITS`.

| Limit | Default | Counts |
|---|---|---|
| `maxOccurrences` | 10000 | occurrences returned |
| `maxWork` | 1000000 | candidate steps: 1 for DTSTART, 1 per day examined (every day of a MONTHLY or YEARLY period), 1 per start time generated on a day that passes |
| `maxProviderCalls` | 100000 | calls to the provider's `candidates` and `toParts` |
| `maxHorizonDays` | 36600 | days of horizon walked; a longer horizon is cut there |

`limit` can also be `'calendar-end'`, which is not a limit the caller
sets: an occurrence's end passes 9999-12-31.

### `nextOccurrences(compiled, from, n, { limits?, provider? })`

This is `expandRecurrence` over `maxHorizonDays` from `from`, stopped
after `n`, so it is the same engine. It is complete when it found `n`
or the rule ended. Otherwise it is incomplete with the limit that
stopped it, or `maxHorizonDays` when the horizon ran out first. A rule
that never matches therefore ends in a limit, not a hang:
`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30` or
`FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30` under `{ maxWork: 10000 }` stops
with `limit: 'maxWork'` and `work: 10000`.

## Series

`defineSeries({ uid, sequence?, revision?, base, rdates?, exdates?, overrides? })`
reads one recurring series and freezes it:

- **`base`** is a compiled recurrence, or `null`.
- **`rdates`** are values of the base's kind, or periods
  `{ start, end }`.
- **`exdates`** are values of the base's kind.
- **`overrides`** are
  `{ recurrenceId, status: 'moved' | 'cancelled', start?, end?, payload?, range? }`,
  one per recurrenceId. A moved override names its new `start`, and its
  `end` or the slot's own length. `payload` is carried on the moved
  occurrence and never read.

All values share one kind, and a zoned series one zone.

`expandSeries(series, { horizon, limits?, provider? })` reads its
options as `expandRecurrence` does. It also takes a list of series of
one kind, under one shared budget, and adds `orphans: { count, ids }` to
the answer. The occurrences are in order of start, each with the
series' `uid`, its `seriesRevision` when it has one, and `moved: true`
and `payload` when an override moved it.

**Precedence, in order:**

1. Union the base occurrences and RDATEs, deduplicated by `recurrenceId`. When both produce one, the RDATE's explicit duration wins.
2. Remove EXDATEs.
3. Apply overrides by `recurrenceId`. A cancelled occurrence disappears. A moved one keeps its `recurrenceId` but gets the new start and end, and is reported with `moved: true`.

**Overrides and the horizon.** An override is looked up by its slot.
The engine does not walk the whole series to find it. A slot outside the
horizon that was moved into it appears, and the rule is asked about
that one wall clock to confirm it makes the slot. A slot inside the
horizon that was moved out disappears.

**Orphans.** An override whose slot the series never makes, or whose
slot an EXDATE removed, is listed in `orphans`. It is never applied and
never dropped silently.

**Refusals and budget.** An override with
`range: 'THISANDFUTURE'` is kept by `defineSeries` and refused by
`expandSeries` (`JY0021`). Every RDATE costs one step of `maxWork`. An
incomplete series answer holds only the series that finished before the
limit. A slot whose end passes 9999-12-31 is left out, and the answer is
`incomplete` with `limit: 'calendar-end'`; the other slots stay.

## `weeklyPattern({ days, wkst? })`

`weeklyPattern` turns weekly hours into floating series, one
`FREQ=WEEKLY;BYDAY=…` series per distinct `[from, to)` slot, each named
`weekly:<from>-<to>`. It serves seven booleans, seven-slot opening hours
and per-weekday rules alike. A day (`mon` … `sun`) is one of:

- `true`: the whole day;
- `false` or absent: none of it;
- a list of `[from, to]` times, where `to` may be `24:00`, the end of the
  day.

Expand the list with `expandSeries` over floating or date bounds, then
bind each occurrence with `bindFloating`.

```js
import { weeklyPattern, expandSeries, dateValue } from '@jarenjs/core/calendar';

const hours = weeklyPattern({
  days: { mon: [['09:00', '17:30']], tue: [['09:00', '17:30']], sat: [['10:00', '24:00']], sun: false },
});
const week = expandSeries(hours, { horizon: [dateValue('2026-03-02'), dateValue('2026-03-09')] });
// three occurrences; Saturday's ends { kind: 'floating', date: '2026-03-08', time: '00:00:00' }
```

## Availability

Availability is a stack of prioritized **layers** evaluated over a
half-open horizon. A layer can be opening hours, a holiday closure, a
busy event or an absence. The answer cuts the horizon into spans that
are `available`, `busy` (with a busy type) or `unknown` (with a reason),
and each span names the layers that decided it.

**Unknown is never free.** Nothing is available unless a layer says so.
Time no layer claims is unknown, and so is time a layer could only place
with data it was not given.

```js
import {
  evaluateAvailability, availabilityOf, freeBusy, findAvailableSlots,
  weeklyPattern, dateValue, dateRangeValue, utcValue,
} from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider({ revision: '2026e' });
const staff = evaluateAvailability([
  { id: 'hours', priority: 5, mode: 'available', source: 'contract', revision: '12',
    series: weeklyPattern({ days: { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']] } }) },
  { id: 'leave', priority: 1, mode: 'busy', busyType: 'busy-unavailable', source: 'leave',
    spans: [dateRangeValue('2026-03-03', '2026-03-03')] },
], {
  horizon: [utcValue('2026-03-02T00:00:00Z'), utcValue('2026-03-09T00:00:00Z')],
  zone: 'Europe/Amsterdam', zoneSource: 'location', provider, policy: 'rfc5545',
});
// Monday 08:00Z-16:00Z available (hours); Tuesday in Amsterdam
// (02T23:00Z-03T23:00Z) busy (leave); the rest unknown, reason 'default'

availabilityOf(staff, { start: utcValue('2026-03-02T09:00:00Z'), end: utcValue('2026-03-02T12:00:00Z') }).state;
// 'available'
```

### `evaluateAvailability(layers, { horizon, zone?, zoneSource?, provider?, policy?, limits?, default? })`

A layer is `{ id, priority, mode, busyType?, series | spans, bounds?, source, revision? }`:

| Member | Reads |
|---|---|
| `id` | a non-empty name, unique in the stack |
| `priority` | RFC 7953's PRIORITY, 0-9: 1 is the highest, 9 the lowest numbered, and 0 (undefined) is below them all |
| `mode` | `'available'` or `'busy'`: what the layer's spans are |
| `busyType` | a busy layer's kind of busy: `'busy'` (the default), `'busy-unavailable'` or `'busy-tentative'` |
| `series` | a series `defineSeries` returned, or the list `weeklyPattern` returns |
| `spans` | explicit spans: `{ start?, end? }` (an end left out or `null` is open), a date value or a date-range value |
| `bounds` | `[start?, end?)` clipping the layer, either end open; on an available layer it also claims the whole period (below) |
| `source` | the caller's provenance token, carried in `layers` and never read |
| `revision` | the caller's revision of the layer's data, echoed on every span the layer decides |

A bound or span end is epoch milliseconds or a temporal value. A date
reads as its first instant, and a floating or date value needs the zone.

**Precedence.** At each instant the claims of the highest rank decide.
Among equal ranks busy beats unknown, which beats available, so a tie
never opens time. Of several busy layers at one rank, the strongest
type is shown (`busy-unavailable`, then `busy`, then `busy-tentative`),
and every one is named.

**What a layer claims.** `bounds` decides it:

| Layer | Claims |
|---|---|
| without `bounds` | only its spans. The time between them falls through to the layers below, or the default |
| `available`, with `bounds` | its whole bounded period, as an RFC 7953 VAVAILABILITY does: its spans are available, and the rest of the period is busy (`busy-unavailable`) at its rank, sourced to it |
| `busy`, with `bounds` | only its spans, as busy. Its gaps inside the bounds claim nothing and fall through |

So "available Monday to Friday 09:00-17:00 during this contract" with the
contract's dates as `bounds` means not available at other times in that
period, even over a lower layer that says otherwise; a higher layer
still wins. Leave `bounds` out to let the gaps fall through. `bounds: []`
(both ends open) claims the whole horizon. Nested bounded layers of
different ranks each decide inside their own period.

**What makes time unknown.** Each source keeps its own `reason`:

| Reason | When |
|---|---|
| `default` | no layer claims the time. `default: 'busy'` makes it busy (`busy-unavailable`) instead; there is no `'available'` default |
| `no-zone` | a floating or date layer was evaluated without a zone. Its spans name no instant, so every instant within a day of their wall clock is unknown (no offset reaches a day). A floating or date bound without a zone leaves the same day-wide fringe, where a bounded available layer is unknown whether or not a span covers it |
| `incomplete` | a series expansion stopped at a limit. Only a prefix the expansion proves complete is kept; from there, less a day for a wall-clock series, to the end of the layer's reach is unknown |

When two layers of one rank leave a span unknown for different reasons,
`no-zone` is named.

**Binding and expansion.**

- Open bounds are clipped to the horizon before any interval operation.
- A floating or date layer binds through `bindFloating` to `zone` under
  `policy`, recording `zoneSource` (`'unrecorded'` when not said). A
  span that a gap turns backwards, such as 02:50-03:10 on Amsterdam's
  spring day under `rfc5545`, covers nothing and is not refused.
- A floating or date series is expanded a day past each end of the
  horizon, then bound occurrence by occurrence.
- A utc or zoned series expands from its own instants (a zoned one
  through `provider`).
- `limits` are the `RecurrenceLimits` of every expansion, one budget per
  layer.

**The answer:**

| Member | Holds |
|---|---|
| `horizon` | `{ start, end }` in epoch milliseconds |
| `spans` | ascending `{ start, end, state, busyType?, sources: [{ id, revision? }], reason? }`, tiling the horizon, with no two neighbours alike |
| `complete` | `true` when no layer's expansion stopped |
| `provider` | the provider's `{ name, revision }`, or `null` without one |
| `binding` | `{ zone, source }`, or `null` without a zone |
| `default` | `'unknown'` or `'busy'` |
| `layers` | per layer: `{ id, revision?, source, status, limit?, counts }`, where `counts` are its expansions' (a re-proved prefix included) |
| `counts` | `{ layers, spans, available, busy, unknown, emitted, work, providerCalls }` |

`source`, `revision`, `provider` and `complete` are what a cache needs
to tell whether a stored answer still holds. The answer is plain JSON:
the readers below also take one that went through `JSON.parse`.

### `availabilityOf(result, interval)`

This asks whether all of `{ start, end }` (epoch milliseconds or utc
values) is available. One unknown or busy instant makes it not:

- `state` is `'available'` only when every instant is. It is `'busy'`
  when any instant is busy, and `'unknown'` otherwise. Time outside the
  evaluated horizon is unknown with `reason: 'outside-horizon'`.
- `reasons` lists every span of the interval that is not available,
  clipped to it.
- `sources` names the layers that decided the answer: the available
  ones when it is available, and those behind `reasons` otherwise.

### `freeBusy(result, { reveal? })`

This projects an answer to RFC 5545 free/busy periods:

| State | FBTYPE |
|---|---|
| available | `free` |
| busy | its busy type |
| unknown | `busy-unavailable`, counted in `unknownCount` (runs of unknown time) |

- No layer id, source, revision or reason is included, and neighbours of
  one type are joined, so the seam between two layers is not shown.
- `reveal: 'none'` shows every period that is not free as `busy`.
- Periods fall on whole seconds. A second two periods share goes to the
  busier one, so rounding never shows time freer than it is.

The answer `{ start, end, periods, unknownCount }` feeds the VFREEBUSY
writer of `@jarenjs/josl/ical` directly:

```js
import { stringifyIcal } from '@jarenjs/josl/ical';

const { unknownCount, ...period } = freeBusy(staff);
stringifyIcal({ prodId: '-//Example//Rota//EN', components: [{ type: 'freebusy', uid: 'staff-fb', ...period }] });
```

### `findAvailableSlots(result, { duration, step?, alignment?, limits? })`

This is `findSlots` over the **available** spans only, so a slot never
overlaps unknown or busy time:

- Touching available spans are one window, so a slot may cross midnight
  or the seam between two layers.
- Each window is walked from its first start in `step` increments. The
  default step is `duration` (back to back), or `alignment` when one is
  given.
- With `alignment`, every start is a multiple of it counted from the
  epoch (UTC), and `step` must be a multiple of it.
- Widths are milliseconds or fixed ISO 8601 durations (`'PT30M'`).
- A search that would pass `limits.maxSlots` (`AVAILABILITY_LIMITS`:
  10000) stops there and is `incomplete` with `limit: 'maxSlots'`.

The answer is `{ status, slots, counts: { emitted }, limit? }`. Choosing
among the candidates is a solver's job, not this function's.

## Codes

Every refusal is a `CalendarError` (a `CodedError` from
`@jarenjs/core/errors`) whose `code` is one of `CALENDAR_CODES` and whose
`docPath` names the argument at fault (`/parts/day`, `/zone`,
`/provider`, `/policy`, `/time`, `/value/date`, `/options/source`).
The parts `resolveLocal` reads keep their one code, `JY0007`, for every
fault; the codes from `JY0008` on name the faults of a temporal value's
text, and the codes from `JY0015` on the faults of a recurrence rule and
a series, whose `docPath` names the rule part and list index
(`rrule.BYMONTHDAY[2]`). A refusal that wraps a provider's own throw
carries it as `cause`. A malformed `runtime`, or a clock that answers no
finite instant, is the runtime's own `TypeError`.

| Code | Meaning |
|---|---|
| `JY0001` | the zone is not a non-empty name the provider knows |
| `JY0002` | the local time falls in a gap and the policy is reject |
| `JY0003` | the local time falls in a fold and the policy is reject |
| `JY0004` | the provider lacks a member this call needs, or answered it in a shape the seam does not define |
| `JY0005` | the policy is not one of rfc5545, later or reject |
| `JY0006` | no policy was given, and resolution has no default |
| `JY0007` | the local time is not a civil date and time of day this layer reads |
| `JY0008` | a time of 24:00 names the end of a day and is admitted only on an end bound |
| `JY0009` | a seconds value of 60 (a leap second) is not admitted |
| `JY0010` | a fraction past the millisecond is refused, never truncated |
| `JY0011` | a wall-clock time carries no offset or Z; a floating time has none and a zoned time takes its zone's |
| `JY0012` | the date is not a civil date from 0000-01-01 to 9999-12-31 |
| `JY0013` | the value is not a temporal value of a form and kind this call takes |
| `JY0014` | an option is not of the form this call takes |
| `JY0015` | the recurrence rule is not RRULE text or its JSON form: an unknown or empty part, no FREQ, or a value spelled wrong |
| `JY0016` | a recurrence rule part holds a value outside its range or with a sign it does not take |
| `JY0017` | a recurrence rule part is given twice |
| `JY0018` | a recurrence rule part does not go with the frequency, the start or another part |
| `JY0019` | the recurrence end (UNTIL) is not of the kind the start requires |
| `JY0020` | the frequency is valid RRULE but is not enumerated in this release; only DAILY, WEEKLY, MONTHLY and YEARLY are |
| `JY0021` | an override that ranges over this and future occurrences is kept as data but refused for expansion |

## Not here

- **Frequencies.** The sub-daily frequencies (SECONDLY, MINUTELY and
  HOURLY) are read and checked but not enumerated (`JY0020`).
- **Series.** RANGE=THISANDFUTURE is kept but not expanded (`JY0021`).
  An RDATE or EXDATE of a zoned series names the series' zone, never
  another zone or a utc value.
- **Availability.** VAVAILABILITY is not read or written; a layer is
  the caller's own JSON. Availability is evaluated, never stored.
- **Storage.** No temporal value is stored by a database here; a caller
  stores the JSON forms above.
- **Zone data.** It is never bundled. The provider is the caller's, and
  an instant is only as right as the tzdata the host runs, which is why
  every resolution names its provider's revision.
