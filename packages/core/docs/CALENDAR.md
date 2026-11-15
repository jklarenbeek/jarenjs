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

## Codes

Every refusal is a `CalendarError` (a `CodedError` from
`@jarenjs/core/errors`) whose `code` is one of `CALENDAR_CODES` and whose
`docPath` names the argument at fault (`/parts/day`, `/zone`,
`/provider`, `/policy`). A refusal that wraps a provider's own throw
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

## Not here

Temporal value kinds, binding a floating time to a zone, recurrence and
availability build on this layer and are not in it yet. Zone data is
never bundled: the provider is the caller's, and an instant is only as
right as the tzdata the host runs, which is why every resolution names
its provider's revision.
