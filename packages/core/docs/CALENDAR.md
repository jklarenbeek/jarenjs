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

## Codes

Every refusal is a `CalendarError` (a `CodedError` from
`@jarenjs/core/errors`) whose `code` is one of `CALENDAR_CODES` and whose
`docPath` names the argument at fault (`/parts/day`, `/zone`,
`/provider`, `/policy`, `/time`, `/value/date`, `/options/source`).
The parts `resolveLocal` reads keep their one code, `JY0007`, for every
fault; the codes from `JY0008` on name the faults of a temporal value's
text. A refusal that wraps a provider's own throw
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

## Not here

Recurrence and availability build on this layer and are not in it
yet, and no temporal value is stored by a database here: a caller stores
the JSON forms above. Zone data is
never bundled: the provider is the caller's, and an instant is only as
right as the tzdata the host runs, which is why every resolution names
its provider's revision.
