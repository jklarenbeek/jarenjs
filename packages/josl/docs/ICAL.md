# `@jarenjs/josl/ical`

An iCalendar (RFC 5545) writer over the values of
[`@jarenjs/core/calendar`](../../core/docs/CALENDAR.md): single events,
recurring events (a series with its rule, extra dates, excluded dates and
overrides) and free/busy spans. Every time is written by its kind, and a
zoned time is written only under a zone mode the caller names. Nothing
outside the documented subset is written raw: an unknown member, property
or component is refused with a code.

```js
import { stringifyIcal } from '@jarenjs/josl/ical';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const provider = createIntlZoneProvider({ revision: '2026e' }); // the tzdata your hosts run
const text = stringifyIcal({
  prodId: '-//Example//Staff rota//EN',
  components: [{
    type: 'event', uid: 'early-shift',
    start: { kind: 'zoned', date: '2026-03-02', time: '07:00', zone: 'Europe/Amsterdam' },
    duration: 'PT8H', policy: 'rfc5545', summary: 'Early shift',
  }],
}, { zones: 'utc', provider, runtime: { now: () => Date.parse('2026-03-01T12:00:00Z') } });
text.split('\r\n')[6]; // 'DTSTART:20260302T060000Z'
```

The writer reads no clock of its own and no host zone: a component's
DTSTAMP is its own `dtstamp` or the injected runtime's `now()` (floored to
the second, read once per writer), and a zoned value resolves through the
provider the options or the runtime name.

## Two writers, one emitter

- `stringifyIcal(calendar, options)` returns the whole calendar as a
  string.
- `createIcalWriter(options)` writes it one component at a time:
  `options.prodId` and `options.method` are the calendar's head, written at
  once; `write(component)` adds a component (an event's overrides with it);
  `end()` adds `END:VCALENDAR` and returns the calendar, or `''` when an
  `onChunk(chunk)` sink took every chunk.

Both render each component whole and check every limit before emitting it.
A refusal closes the writer (`ICAL3018` afterwards); what a sink already
received is a head and whole components with no `END:VCALENDAR`, so an
unfinished calendar never reads as a complete one.

## The model

The schema twin is [`schemas/jaren-josl-ical.schema.json`](../schemas/jaren-josl-ical.schema.json)
(`$id` `https://jarenjs.dev/schemas/jaren-josl-ical/0.1`). It sits beside
the writer rather than beside the calendar values because the component
names it holds (event, free/busy) are iCalendar's, and the calendar layer
stays free of them. It `$ref`s the temporal and recurrence-rule schemas of
`@jarenjs/core`; register both first.

```ts
type Calendar = { prodId: string, method?: 'publish', components: Component[] };

type Event = {
  type: 'event', uid: string, dtstamp?: Instant,
  start: TemporalValue,                  // date, floating, utc, zoned or date-range
  end?: TemporalValue, duration?: string, // one of them; end is exclusive
  policy?: 'rfc5545' | 'later' | 'reject', // how a zoned start or end resolves
  summary?: string, description?: string, location?: string,
  status?: 'tentative' | 'confirmed' | 'cancelled', sequence?: number,
};

type RecurringEvent = {
  type: 'event', series: Series | SeriesDefinition, dtstamp?: Instant,
  summary?: string, description?: string, location?: string,
  status?: 'tentative' | 'confirmed' | 'cancelled',
};

type FreeBusy = {
  type: 'freebusy', uid: string, dtstamp?: Instant, start?: Instant, end?: Instant,
  periods: { start: Instant, end: Instant, fbtype?: 'busy' | 'free' | 'busy-unavailable' | 'busy-tentative' }[],
};

type Instant = number /* epoch ms */ | { kind: 'utc', instant: string };
```

- A recurring event's `series` is a value `defineSeries` returned, or its
  JSON definition (`{ uid, sequence?, revision?, base?, rdates?, exdates?,
  overrides? }`, with `base` as `compileRecurrence` takes it), compiled by
  the writer. Its uid, sequence, times and policy are the series'.
- Every VEVENT of a series (the master and each moved slot's) carries the
  event's summary, description, location and status. An override's
  `payload` is the caller's own data and is not written; neither is the
  series' `revision`.
- `end` is exclusive, as DTEND is; a date start takes a date end, a
  floating start a floating end, and a utc or zoned start a utc or zoned
  end. A `24:00` end is the next midnight.
- `duration` is an RFC 5545 duration, written in the grammar's canonical
  spelling (`PT1H5S` is written `PT1H0M5S`). A date start lasts whole
  days or weeks.

## Times by kind

| Kind | Written as |
|---|---|
| `utc` | `DTSTART:20260302T080000Z` |
| `date` | `DTSTART;VALUE=DATE:20260302` |
| `floating` | `DTSTART:20260302T090000` (no TZID: RFC 5545 floating time) |
| `zoned` | under `zones: 'utc'`, the UTC instant the value resolves to |
| `date-range` | `DTSTART;VALUE=DATE` and `DTEND;VALUE=DATE` (exclusive) |

iCalendar counts whole seconds: a time with a fraction of a second is
refused (`ICAL3006`), never truncated.

### `zones: 'utc'`

The only zone mode in this release. A zoned value is converted to its UTC
instant through the provider - the same instant `toUtc` answers - and
written with `Z`; no TZID and no VTIMEZONE are written. That conversion is
the documented meaning of the mode, so the output records nothing more.

- A single event's zoned value resolves under the event's `policy`
  (`ICAL3010` without one). A zoned start with a duration of nominal days
  ends at the same wall clock those days later, in its zone, plus the
  exact time, written as a UTC DTEND.
- A series' values resolve under the series' policy.
- A zoned value with no zones mode is `ICAL3008`; with no provider,
  `ICAL3009`.

**A zoned recurring series is never written as a UTC start with its
rule.** The rule's meaning is the zone's wall clock: written from a UTC
DTSTART, every occurrence after an offset change would move by the
change. Such a series is expanded over the caller's `horizon` instead (a
half-open `[start, end)` of utc values or epoch milliseconds) and written
as its occurrences: DTSTART is the first slot, each further slot an RDATE
(`RDATE;VALUE=PERIOD` where its length differs from the first's, as a
day's length does across an offset change), and each moved slot a VEVENT
with the RECURRENCE-ID of its original instant. Without a horizon the
series is refused (`ICAL3011`). The written calendar holds the horizon's
occurrences only.

## Series

| Series | Written as |
|---|---|
| date, floating or utc, with a rule | DTSTART; DURATION or DTEND; RRULE (`formatRRule`); an RDATE per extra date (`VALUE=PERIOD` for a period), the first given per slot; an EXDATE per excluded date and per cancelled slot; a VEVENT with RECURRENCE-ID per moved slot |
| zoned, with a rule | expanded over the horizon, as above |
| any kind, no rule | the occurrences it makes, as above, over the span its own dates cover |

Two shapes of a rule series are written so that every reader reads the
series' own set, not the shape the RFC leaves open:

- **A period on a slot the rule also makes.** The series gives that slot
  the period's length; two RDATE/RRULE instances on one start would leave
  the length to the reader. The slot is written as its own VEVENT
  (RECURRENCE-ID and DTSTART the slot, DTEND the period's end) instead.
- **A start the rule does not make** (DTSTART Tuesday, `BYDAY=MO`). The
  calendar layer counts DTSTART as the first occurrence, as RFC 2445 did;
  RFC 5545 leaves that set undefined. DTSTART is also written as an RDATE,
  which every reader keeps, and a COUNT is written as the UNTIL of the last
  occurrence it makes, so a reader that counts from the rule alone ends in
  the same place.

What is refused rather than written wrong:

- an expansion that stops at a limit (`ICAL3012`, with its counts),
  including the one-slot questions asked of a rule above: never a calendar
  holding part of the series;
- a series with no occurrence to write (`ICAL3013`);
- two slots of a zoned series that resolve to one UTC instant (`ICAL3014`),
  which a UTC calendar cannot tell apart;
- an override whose slot the series never makes (`ICAL3015`), which a
  reader would take for an event of its own;
- an override over this and future occurrences (`ICAL3016`);
- a period of dates as an extra date, or a slot of dates whose length
  differs from the first's (`ICAL3017`): an RDATE period runs between
  date-times.

The recurrence rules the calendar layer enumerates are DAILY and WEEKLY;
a series of another frequency is refused there (`ICAL3005`, its
`JY0020` the cause).

## Free/busy

A VFREEBUSY lists plain spans of instants, `FREEBUSY;FBTYPE=...:start/end`,
in ascending order of start. Free/busy periods are UTC by the RFC, so a
date, floating or zoned span is refused (`ICAL3017`).

## Wire rules

- Lines end in CRLF.
- A line folds before it passes 75 octets (the leading space of a
  continuation counts), never inside a UTF-8 code point.
- TEXT (SUMMARY, DESCRIPTION, LOCATION, UID, PRODID) escapes `\`, `;`
  and `,` and writes every line break as `\n`. A control character other
  than a tab, or a lone surrogate, is refused (`ICAL3004`), never
  replaced.
- Every parameter written is a fixed token (`VALUE=DATE`, `VALUE=PERIOD`,
  `FBTYPE=...`); none needs quoting.
- `method` is `'publish'` or absent: the scheduling methods need
  organizers and attendees, which are outside the subset.

## Limits

Each limit defaults to `Infinity`, takes a positive integer, and is
checked before the component that would cross it is emitted. A crossing
is a `JoslLimitError` with the limit's code; the calendar is never
returned truncated.

| Option | Code | Counts |
|---|---|---|
| `maxOctets` | `ICAL2001` | octets of the calendar, line breaks and `END:VCALENDAR` included |
| `maxComponents` | `ICAL2002` | VEVENT and VFREEBUSY components, each override's VEVENT among them |
| `maxRdates` | `ICAL2003` | RDATE values, given and expanded |

An expansion also runs under the calendar layer's limits (`limits`, the
`RECURRENCE_LIMITS` defaults when absent).

## Codes

`IcalError` is a coded error: `code`, `reason`, and `docPath`, a JSON
pointer into the calendar (`/components/2/summary`); `stringifyIcal` and
`createIcalWriter` give the same pointer for the same component. A refusal
of the calendar layer is wrapped as `ICAL3005` with the `CalendarError` as
`cause`.

| Code | Meaning |
|---|---|
| `ICAL3001` | the calendar or a component is not an object of the documented model, or lacks a member it requires |
| `ICAL3002` | a member or component type outside the documented subset; it is refused, never written raw |
| `ICAL3003` | a member holds a value of a form it does not take |
| `ICAL3004` | text holds a control character or a lone surrogate, which iCalendar cannot carry |
| `ICAL3005` | the calendar layer refused a value, rule or series; its CalendarError is the cause |
| `ICAL3006` | a time carries a fraction of a second; iCalendar counts whole seconds and nothing is truncated |
| `ICAL3007` | an end is not after its start, is of another kind, or comes with a duration |
| `ICAL3008` | a zoned value and no zones mode chosen |
| `ICAL3009` | a zoned value and no zone provider, in the options or the runtime |
| `ICAL3010` | a zoned value of a single event and no policy to resolve it |
| `ICAL3011` | a zoned recurring series and no horizon |
| `ICAL3012` | a series expansion stopped at a limit; nothing is written truncated |
| `ICAL3013` | a series makes no occurrence to write |
| `ICAL3014` | two slots of a zoned series resolve to one UTC instant |
| `ICAL3015` | an override names a slot the series never makes |
| `ICAL3016` | an override over this and future occurrences is not written in this mode |
| `ICAL3017` | a value iCalendar cannot spell here |
| `ICAL3018` | the writer has ended or refused, and takes no more components |

## Capability matrix

| Component or property | Written |
|---|---|
| VCALENDAR: VERSION, PRODID | supported |
| METHOD | `PUBLISH` only |
| VEVENT: UID, DTSTAMP, DTSTART, DTEND, DURATION | supported |
| VEVENT: SUMMARY, DESCRIPTION, LOCATION, STATUS, SEQUENCE | supported |
| VEVENT: RRULE | DAILY and WEEKLY, for date, floating and utc series |
| VEVENT: RDATE (DATE, DATE-TIME, PERIOD), EXDATE, RECURRENCE-ID | supported (no RANGE) |
| VFREEBUSY: UID, DTSTAMP, DTSTART, DTEND, FREEBUSY with FBTYPE | supported |
| TZID, VTIMEZONE | not written: `zones: 'utc'` converts |
| VAVAILABILITY, AVAILABLE | not in this release |
| VTODO, VJOURNAL, VALARM, ATTENDEE, ORGANIZER, X- properties | refused |
| Reading iCalendar | not in this release |
