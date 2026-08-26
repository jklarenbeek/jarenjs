# `@jarenjs/core/series`

The temporal kernel: one meaning for an instant, one meaning for an
interval, and the set algebra over them. A roster, a calendar, an event
log, an availability view and a telemetry graph each rebuild the same
loops today — "does this overlap", "where is the free time", "what is
covered", "which events are live right now" — and this is the module
that answers them once.

Two constraints shape it, the same two the calendar kernel is built on.
**There is no type**: an instant is epoch milliseconds or an RFC 3339
string, a sample is `{ at, value }`, an interval is `{ start, end }` —
all of them JSON already, so they survive a patch, a schema, a pointer,
a stored document and a wire reply unchanged. And **there is no `now`**:
every bound is data, and an operation that needs a window and was given
none derives it from its own input, never from the clock. Import the
barrel (`@jarenjs/core/series`) or a single module.

## Normalization — `normalize.js`

`toEpoch(value)` is the one door: a finite number passes through, a
valid RFC 3339 string becomes the instant it names. A full-date reads as
UTC midnight. Three things are `TypeError` rather than a guess — a
full-time (`'09:30:00Z'` names no day), an offset-less date-time
(`'2026-01-01T09:30:00'` names no instant without a zone, and there is
no implicit machine zone here), and a `Date` object.

`normalizeSeries(rows, {at, value}?)` and
`normalizeIntervals(rows, {start, end}?)` convert a whole collection
once and sort it. Both take a **selector** per member — a property name
or a function — so rows spelled `on`, `recorded_at` or `from`/`to` are
read where they are rather than rewritten first. Each result is a
shallow copy of its source row with the canonical members written over
it, so nothing a caller attached is lost.

Three rules make the result safe to build on:

- **A row is never dropped.** A member that cannot become a finite
  instant is a refusal naming the row (`row 4172, at: …`), not a
  silently shorter answer.
- **The sort is stable.** Rows sharing an instant come out in input
  order, and *all* of them are present: a duplicate instant is two
  readings in the same millisecond, not a key collision.
- **A value may be absent, but only explicitly.** `null` is a measured
  gap and survives; `undefined`, a string or a `NaN` is a defect.

`lowerBoundTime(rows, at, key?)` and `upperBoundTime(rows, at, key?)`
are the binary cuts a normalized array is then read through — together
they bracket the rows *at* an instant, which is what a duplicate-tolerant
as-of has to read.

## Interval algebra — `interval.js`

Every interval is **half-open**, `[start, end)`: it holds its start and
not its end. So a day ends exactly where the next begins, nothing is
counted twice at a boundary, and two intervals that touch do **not**
overlap — back-to-back bookings are not a double booking. An interval
that is empty (`[t, t)`), reversed or not finite is refused at the point
it was written.

| Function | Answers |
|---|---|
| `containsInstant(interval, at)` | is this instant inside — `start <= at < end` |
| `overlapsInterval(a, b)` | do they share an instant (touching does not) |
| `intersectInterval(a, b)` | the span they share, or `null` |
| `mergeIntervals(list, {adjacent}?)` | the union, as the fewest disjoint spans |
| `subtractIntervals(from, remove)` | the set difference; a cut through the middle splits |
| `gapsWithin(list, window?)` | the uncovered spans |
| `coverageOf(list, window?)` | milliseconds covered, an instant counted once |
| `findSlots(availability, spec)` | where a fixed-width span fits |

Merging is the one place "touching does not overlap" is not the answer
a caller wants, which is why `mergeIntervals` **joins touching spans by
default**: availability asks whether there is continuous cover, and
09:00–13:00 plus 13:00–17:00 is continuous cover. The other reading is
real too — a handover is two shifts, not one — and it is spelled
`{ adjacent: false }`, so nothing has to guess. Overlapping spans join
under both settings.

`gapsWithin` and `coverageOf` take an optional window. Without one they
work inside the hull of the intervals themselves, because the only other
default would be a clock. Passing the window explicitly is what reports a
missing *edge*: an empty morning is only a gap once the caller says the
day starts at nine. `coverageOf` returns milliseconds, so the ratio is
the caller's own division:
`coverageOf(shifts, day) / (day.end - day.start)`.

`findSlots(availability, { duration, step? })` merges availability, then
walks each window from its own start in `step` increments (default: back
to back), keeping every span that still ends inside. `duration` and
`step` are fixed widths — milliseconds, or a fixed ISO 8601 duration
(`'PT30M'`); a calendar duration (`P1M`) is refused rather than called
thirty days. It is enumeration, not scheduling: choosing among the
answers, weighing preferences and assigning people is a solver's job,
deliberately not this one.

Merge, subtract, gaps and slots return bare `{ start, end }` records. A
span welded out of three source rows belongs to none of them, and
carrying one of their identities forward would be a claim the data does
not support.

## The index — `interval-index.js`

`createIntervalIndex(items, selectors?)` builds once and answers many:
`index.at(instant)` for the spans holding an instant,
`index.overlapping(start, end)` for the spans sharing one with a window.
Results are the caller's **own rows**, ascending by start and — for rows
sharing a start — in the order they arrived, in a fresh array each time.

Sorting by start is not enough, and the reason is the whole design. A
binary search finds where a query falls among the starts, but a span that
began a year earlier and has not ended yet sits far to the *left* of that
neighbourhood and still overlaps — a conference week among hourly
meetings is exactly that span, and an index that merely cuts around the
query loses it while looking plausible. So the index carries a second
array: the prefix maximum end, non-decreasing by construction and
therefore binary-searchable too. The first position where it passes the
query's start is the first position where anything can still be live.

A query is two binary cuts and a walk between them — O(log n + k) — with
no pass over the array and no per-query sort. It is **static**: the
bounds are copied into flat typed arrays at build time, so a query reads
no source object at all, and a row mutated afterwards cannot change what
the index answers.

```javascript
import { createIntervalIndex, mergeIntervals, gapsWithin, findSlots } from '@jarenjs/core/series';

const shifts = [
  { from: '2026-03-02T09:00:00Z', to: '2026-03-02T13:00:00Z', who: 'ada' },
  { from: '2026-03-02T13:00:00Z', to: '2026-03-02T17:00:00Z', who: 'grace' },
];
const index = createIntervalIndex(shifts, { start: 'from', end: 'to' });
index.at('2026-03-02T13:00:00Z');        // [grace] — half-open: the handover belongs to one shift

const cover = shifts.map((s) => ({ start: s.from, end: s.to }));
mergeIntervals(cover);                    // one span, 09:00–17:00: touching is continuous cover
gapsWithin(cover, { start: '2026-03-02T08:00:00Z', end: '2026-03-02T18:00:00Z' });
                                          // the hour before and the hour after
findSlots(cover, { duration: 'PT30M' });  // sixteen half-hour slots, one straddling the handover
```

## Not here

Calendar-width buckets, resampling and fill policies, rolling windows,
as-of joins and downsampling are the layer above this one. So are named
time zones (a zone provider is injected, never bundled), recurrence
grammars (RRULE, iCalendar), and any kind of scheduling solver. This
module supplies the algebra those are built from, and nothing that needs
a clock, a locale or a zone database to be correct.
