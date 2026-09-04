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

**Every specification is closed.** `resampleSeries`, `rollingSeries`,
`asOfJoin`, `downsampleSeries`, `findSlots` and `mergeIntervals` each
publish the members they admit — `RESAMPLE_MEMBERS`, `ROLLING_MEMBERS`,
`ASOF_MEMBERS`, `DOWNSAMPLE_MEMBERS`, `SLOTS_MEMBERS`, `MERGE_MEMBERS`
— and anything else is a `TypeError` naming the near miss. `minPeriod`
for `minPeriods` accepted and ignored is a window with no minimum and a
plausible number; `timezone` for `zone` is the quiet fall back to UTC
that the clock's own refusal exists to prevent. The query language
reads these same lists (§8.16), minus `provider`, which is a pair of
functions and therefore not something a document can carry.

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

## The clock — `zone.js`

Where a calendar boundary falls depends on a wall clock, and a wall
clock that is not UTC is data this suite refuses to bundle: a tzdb is
megabytes that go stale on a government's timetable, a Temporal
polyfill is a runtime dependency, and reading the host's zone is the
hidden clock this kernel exists without. So `resolveClock(options)` is a
**seam**:

| options | the clock |
|---|---|
| *(nothing)* | UTC. Nothing to configure, and no local time is ever ambiguous |
| `{ offset: -300 }` | minutes east of UTC, constant. Exact integer arithmetic |
| `{ zone, provider }` | the caller's tzdb, in whatever form they already have one |

A provider answers two questions, and the second is the hard one:
`toParts(epoch, zone)` is the wall clock at an instant, and
`toEpoch(parts, zone, disambiguation)` is the instant at a wall clock —
hard because a local time is not a function of the clock. On a
spring-forward day 02:30 never happens; on a fall-back day it happens
twice. `disambiguation` is `'reject'` (the default: an error, not an
hour nobody notices), `'earlier'` or `'later'`. Asking for a named zone
with no provider is a refusal, never a quiet fall back to UTC — which is
right for Amsterdam for none of the year and *looks* right for eight
months of it.

The seam is crossed, not closed. `@jarenjs/locales/intl-zones` ships
`createIntlZoneProvider()`, a provider over the host's own ICU data —
the one copy of the tzdb that is already installed and already
maintained — that a caller passes as `provider`. It is opt-in and on
its own subpath, because ICU output moves between hosts and may not be
anyone's default; it never reads the host's own zone, because every
call names its zone and there is no default that asks the process
where it is; and it answers a gap and a fold exactly, proved by a
transition corpus rather than by examples. Nothing about the seam
moves: this kernel still bundles no zone data and reaches for no
`Intl`, a named zone with no provider is still a refusal, and a host
with a tzdb of its own still passes that instead. The provider's own
document is [`@jarenjs/locales`' README](../../locales/README.md).

## Buckets, resampling and fill — `bucket.js`

Two questions that are always asked together and are not the same
question. **Bucketing** is "which span does this instant fall in", and
it is arithmetic. **Filling** is "what does a span with no readings
say", and it is a policy. An average over an empty hour is not zero, and
it is not yesterday's average, and it is not nothing.

`compileBuckets(spec, options?)` validates a ladder once —
`compileBuckets('PT15M')`, or `{ every, origin }` — and returns
`floor`, `startOf`, `indexOf` and the shape it resolved to. Boundaries
come in two flavours, and the difference is physical:

- **fixed** — `PT15M`, `PT1H`, `P1D`, or a number of milliseconds. The
  boundary is `origin + k × width`, integer arithmetic all the way down,
  and it *floors*, so an instant before 1970 lands in its own bucket
  rather than the one after it.
- **calendar** — `P1M`, `P1Y`, and a whole number of days *on a named
  zone*. A month has no width, so the boundary is walked by the calendar
  kernel from the anchor; on a named zone a day that the clock changed
  on is 23 or 25 hours long, and a ladder multiplying by 86,400,000
  would drift off local midnight for the rest of the year.

A width that mixes the two families (`P1MT1H`) is refused: a month and
an hour share no boundary. The default `origin` is local
`1970-01-01T00:00:00` **on the clock**, so a daily bucket in `+02:00`
falls on local midnight rather than on UTC's.

`resampleSeries(rows, spec)` returns ascending `{ at, value, count }`
labelled at each bucket's **start**. `count` is the number of source
rows — duplicates and measured gaps included — so it is the honest
denominator of what was *seen*. All six value aggregates (`sum`, `mean`,
`min`, `max`, `first`, `last`) skip `null` readings, so `value` is
`null` exactly when there was nothing to measure and `count` says
whether that was because nobody reported or because everybody reported a
gap. `aggregate: 'count'` returns that row count as the value.

With no `start`/`end` the window is the data's own — the bucket holding
the first sample through the bucket holding the last — because the only
other default would be a clock. Pass them when an empty *edge* matters.

The five fill policies decide what an **empty** bucket says, and nothing
else; a bucket that held rows and no numbers reports `null`, because
that is a measurement:

| fill | an empty bucket |
|---|---|
| `omit` | is not emitted — the default: a gap is not a row |
| `null` | is emitted as `null` |
| `zero` | is emitted as `0` |
| `locf` | repeats the last value before it |
| `linear` | is interpolated between its two neighbours |

Neither `locf` nor `linear` invents a value at the leading edge, and
`linear` needs a value on **both** sides. To seed one, widen the window
until the earlier reading falls inside it: the seed is then a bucket
with data, which is the only anchor either policy will extrapolate from.

## Rolling windows — `rolling.js`

`rollingSeries(rows, spec)` aggregates over a *duration* rather than a
count of rows, which is the whole point: sixty rows of a sensor
reporting every second is a minute, and sixty rows of a sensor that
dropped half its readings is two minutes. One of those is a
specification.

The window is `(at − width, at]` — exactly `width` wide, holding the
current instant and not the one a full width behind it. Two samples at
one instant share that window and therefore share an answer: a span of
time is a function of the instant it ends at, not of which simultaneous
reading arrived first. `minPeriods` is how many source rows the window
must hold before a value is reported at all.

The complexity is per aggregate and is structural rather than hopeful:
`sum`/`mean`/`count` carry a running total, `min`/`max` use a monotone
deque, and `first`/`last` are two pointers that only move forward. A
carried total is not a fresh sum in the last bits when the values are
not exactly representable — that is what carrying one costs, and the
suite's corpora use exact binary fractions so the difference is zero and
equality is the check.

## As-of joins — `asof.js`

`asOfJoin(left, right, spec?)` answers "what was the price when this
trade printed" for two series that share a timeline and nothing else.
One record per left row, in the left series' order, unmatched included
as `{ left, right: null, distance: null }` — a join that quietly returns
fewer rows than it was given is how a report loses the events nothing
explained.

| direction | the right row chosen |
|---|---|
| `backward` | the last one at or before the left instant (default) |
| `forward` | the last one at or after it |
| `nearest` | whichever is closer; a tie chooses `backward` |

At an equal instant the **last** right-side row wins in every direction,
because duplicates are two readings and "as of" means the later one. A
`nearest` tie chooses backward because a value already observed is
evidence and one that has not been is a forecast. `tolerance` is the
furthest a match may be; beyond it there is no match, not a distant one.
`key` joins within groups — the right side is partitioned **once**, and
no left row ever filters it.

## Downsampling — `downsample.js`

A hundred thousand points on a line eight hundred pixels wide is a
hundred and twenty five points per pixel. `downsampleSeries(rows, spec)`
supplies `lttb` (largest-triangle-three-buckets: keeps the shape a
reader recognizes) and `minmax` (keeps the envelope exactly), and
reports `{ points, sourceCount, renderedCount, method }` so a consumer
can always say how much of the data it is looking at.

Three rules stop either from lying. **A gap is never bridged** — the
series is cut at every run of `null`s, each run keeps a marker, and each
segment is sampled on its own budget. **The ends stay** — and a series
ending in gaps keeps its last instant as that run's marker, so the
rendered domain still reaches the end of the data. **An impossible
target is refused** — those markers and endpoints are the minimum a
faithful picture needs, and a prettier lie is worse than a `RangeError`
naming the number.

```javascript
import { resampleSeries, rollingSeries, asOfJoin, downsampleSeries } from '@jarenjs/core/series';

resampleSeries(readings, { every: 'PT1H', aggregate: 'mean', fill: 'linear' });
resampleSeries(readings, { every: 'P1M', zone: 'Europe/Amsterdam', provider });
rollingSeries(readings, { width: 'PT5M', aggregate: 'max', minPeriods: 3 });
asOfJoin(trades, quotes, { direction: 'nearest', tolerance: 'PT1S', key: 'symbol' });
downsampleSeries(readings, { target: 2000 });   // → { points, sourceCount, renderedCount, method }
```

## What it costs

Measured by `benchmark/series.js` over <!--fact:series.corpus-->100,000 samples at 1-second spacing, Node v24.19.0<!--/fact-->,
which gates every timing on equivalence first: no number below is printed
unless the kernel answered the identical rows the references did.

The kernel is not the ceiling and does not claim to be. A one-pass loop
written for one question validates nothing, normalizes nothing and
returns a bare pair. Against those loops the kernel costs <!--fact:series.kernelVsCeiling-->3.3× the one-pass bucket loop and 6.0× the one-pass ring sum<!--/fact-->,
and against the vocabulary a consumer had instead it is <!--fact:series.kernelVsQuery-->76.7× faster than the generic query bucket and 78.5× faster than the labelled count window<!--/fact-->.

<!--fact:series.kernelTable-->
| operation | median | rows | against | what that is | ratio |
|---|---:|---:|---:|---|---:|
| `resampleSeries`, 60 s buckets | 1.6 ms | 1,667 | 0.47 ms | one-pass loop | 3.3× |
| `resampleSeries`, + linear fill | 1.1 ms | 1,657 | 1 ms | the same buckets, omitting | 1.1× |
| `rollingSeries`, 60 s window | 7.6 ms | 100,000 | 1.3 ms | one-pass ring sum | 6.0× |
| `asOfJoin`, one left row per 100 | 1.7 ms | 1,000 | 1.7 ms | one index read per row | 1.0× |
| `downsampleSeries`, lttb, gap corpus | 1.7 ms | 2,000 | 1.9 ms | the same line with no holes in it | 0.9× |
<!--/fact-->

A row that loses stays in, and the two shapes of the same join are published side by side rather than the flattering one alone. <!--fact:series.asofShape-->The as-of join costs 19.7× a handful of index reads, and narrows to 1.0× the same join once there is one left row per hundred right ones — still the statement's win, published as one. The reason is the shape rather than the engine: a b-tree pays per probe, and a sorted walk pays for the whole right side whether it was asked one question or a thousand.<!--/fact-->

And the seam has a price that this corpus cannot charge it. <!--fact:series.zoneCost-->Walking every boundary through the shipped Intl zone provider costs 1.1× the integer ladder over an identical answer — a handful of ICU reads against the whole ladder, since the benchmark corpus spans 28 hours and holds two daily boundaries. What the suite gates is that the provider is consulted per boundary rather than per sample.<!--/fact-->

## Not here

Named time zones are injected, never bundled — the provider over host
ICU lives opt-in in `@jarenjs/locales`, not here; recurrence grammars
(RRULE, iCalendar) and any kind of scheduling solver are somebody else's
layer. This module supplies the algebra those are built from, and
nothing that needs a clock, a locale or a zone database to be correct.
