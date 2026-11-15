# `@jarenjs/josl/ical`

An iCalendar (RFC 5545) writer and reader over the values of
[`@jarenjs/core/calendar`](../../core/docs/CALENDAR.md): single events,
recurring events (a series with its rule, extra dates, excluded dates and
overrides) and free/busy spans. Every time is written by its kind, and a
zoned time is written only under a zone mode the caller names. Nothing
outside the documented subset is written raw: an unknown member, property
or component is refused with a code. The reader reads the same subset
back, canonical mode: what lies outside it is reported, never silently
interpreted ([Reading](#reading)).

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

The recurrence rules the calendar layer enumerates are DAILY, WEEKLY,
MONTHLY and YEARLY; a series of a sub-daily frequency is refused there
(`ICAL3005`, its `JY0020` the cause).

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

The writer's limits; the reader's are under [Reader limits](#reader-limits).
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

## Reading

```js
import { parseIcal } from '@jarenjs/josl/ical';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Staff rota//EN',
  'BEGIN:VEVENT', 'UID:early-shift', 'DTSTART;TZID=Europe/Amsterdam:20260302T070000', 'DURATION:PT8H',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM',
  'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
const { calendar, report } = parseIcal(text, { provider: createIntlZoneProvider({ revision: '2026e' }) });
calendar.components[0].start; // { kind: 'zoned', date: '2026-03-02', time: '07:00:00', zone: 'Europe/Amsterdam' }
report.unsupported[0].path;   // '/VCALENDAR/VEVENT[0]/VALARM[0]' (code ICAL1013)
```

- `parseIcal(text, options)` reads a whole calendar, as a string or as
  UTF-8 octets, and returns `{ calendar: { prodId, method?, components },
  report }`.
- `createIcalReader(options)` reads it from chunks: `feed(chunk)` returns
  the components the chunk completed, `end()` returns `{ calendar,
  report }` with the components still held.
- `iterateIcal(chunks, options)` pulls an async (or plain) iterable of
  chunks and yields `{ type: 'component', component }` per component, then
  `{ type: 'end', calendar: { prodId, method? }, report }`; `signal`
  aborts between chunks, and a consumer that stops early closes the
  source once.

All three run one engine. A single event or a free/busy component is
handed over as soon as its END is read. A recurring event's overrides may
come anywhere in the file, so a series and its overrides are held until
the input ends and then handed over in the order their series began. The
reader takes no clock: a component without a DTSTAMP has none.

### The syntax layer

Content lines are read as octets. A line is unfolded at CRLF plus one
space or tab before it is decoded, so a fold an exporter placed inside a
UTF-8 sequence reads whole; each unfolded line must then be UTF-8
(`ICAL1001`). A chunk may end anywhere, inside a UTF-8 sequence, a CRLF,
a fold or an escape, without changing what is read. A bare line feed is
read as CRLF and reported (`ICAL1010`), as the CSV reader reads `\n` and
`\r\n` alike; a carriage return no line feed follows is refused
(`ICAL1004`). A byte order mark at the start and empty lines are skipped.
Names are read case-insensitively; parameter values may be quoted, and a
quoted value may hold `:`, `;` and `,` (RFC 6868 caret escapes are not
decoded). Every diagnosis carries the physical `line` the content starts
on and its path, such as `/VCALENDAR/VEVENT[2]/DTSTART` (components are
counted per name inside their parent, from 0).

### Times by kind

| Written | Read as |
|---|---|
| `DTSTART:20260302T080000Z` | `utc` |
| `DTSTART;VALUE=DATE:20260302` | `date` |
| `DTSTART:20260302T090000` | `floating` |
| `DTSTART;TZID=Europe/Amsterdam:20260302T090000` | `zoned`, when the TZID is an IANA name the provider knows; a single event gets `policy: 'rfc5545'` |
| `DTSTART;VALUE=DATE` with `DTEND;VALUE=DATE` | `date-range` |

A TZID that is not an IANA name (a Windows zone name, a prefixed name, an
offset), that the provider does not know, or that arrives with no
provider withholds its component (`ICAL1019`): a zone is never guessed. A
VTIMEZONE is reported and not compiled in this release (`ICAL1014`); a
TZID that names an IANA zone resolves through the provider, whatever the
VTIMEZONE of that name says. A DTEND at its DTSTART is read as no end,
which a time without one has.

### Series

A VEVENT with an RRULE or an RDATE is a recurring event; its `series` is
a value `defineSeries` returned. The rule is compiled by
`compileRecurrence`, so DAILY, WEEKLY, MONTHLY and YEARLY are read, and a
sub-daily rule withholds its event with the calendar layer's `JY0020` as
the cause. RDATE (DATE, DATE-TIME, PERIOD) and EXDATE are read as extra
and excluded dates; an RDATE of DTSTART says nothing DTSTART does not,
and is left out. Without a rule, DTSTART and every RDATE are the
occurrences, each as long as the event. A VEVENT with the series' UID and
a RECURRENCE-ID is an override: STATUS:CANCELLED makes it a cancelled
slot, any other a moved one. An override with no DTEND or DURATION lasts
what such an event lasts (nothing for a time, a day for a date), so its
end is written out where that differs from the slot's length. An
override's SUMMARY, DESCRIPTION, LOCATION, STATUS, SEQUENCE or DTSTAMP
that differs from its series' is reported (`ICAL1016`); the series' value
is kept. RANGE=THISANDFUTURE is kept as data and reported (`ICAL1015`);
expanding it is refused (`JY0021`).

### The report

Everything outside the subset is an entry of `report.unsupported`, in the
order read: `{ code, name, path, line, reason }`, with `withheld: true`
when its whole component is left out of the model and `cause` (the
calendar layer's code, reason and path) when that layer refused.
`report.counts` counts the entries by code; past `maxReported` entries are
counted, not listed (`report.omitted`).

- Left out, the rest read: a property (`ICAL1011`: X- properties,
  ATTENDEE, ORGANIZER, CATEGORIES, METHOD other than PUBLISH, ...), a
  parameter (`ICAL1012`: LANGUAGE, ALTREP, X- parameters, ...), a
  component with everything inside it (`ICAL1013`: VTODO, VJOURNAL,
  VALARM, VAVAILABILITY, X- components), a VTIMEZONE (`ICAL1014`).
- Withheld: a component that lacks or repeats a property (`ICAL1017`), a
  value not of its property's form or kind (`ICAL1018`), an unresolved
  TZID (`ICAL1019`), a refusal of the calendar layer (`ICAL1020`), an
  override no series claims or a second series of one UID (`ICAL1021`),
  and what would change when the event occurs that this release does not
  read (`ICAL1022`: EXRULE, EXDATE with no rule, a zoned length placed
  only by the zone's offsets).

`strict: true` refuses at the first entry, with the entry's code. Text the
reader cannot follow is refused in either mode (`ICAL1001`-`ICAL1009`).

### Reader limits

Each limit defaults to `Infinity`, takes a positive integer, and is
checked as the octets that cross it arrive: a crossing is a
`JoslLimitError` with the limit's code and the line, and nothing past it
is read.

| Option | Code | Counts |
|---|---|---|
| `maxOctets` | `ICAL2001` | octets of input |
| `maxComponents` | `ICAL2002` | components, every BEGIN inside the calendar |
| `maxLineOctets` | `ICAL2004` | octets of one unfolded content line |
| `maxParameters` | `ICAL2005` | parameters of one content line |
| `maxDepth` | `ICAL2006` | nesting of components, the calendar counted as 1 |
| `maxProperties` | `ICAL2007` | properties of one component |

`maxReported` bounds the entries the report lists. A series is held
until the end, so `maxComponents` and `maxProperties` bound what the
reader holds.

## Codes

`IcalError` is a coded error: `code`, `reason`, and `docPath`. The
writer's `docPath` is a JSON pointer into the calendar
(`/components/2/summary`); `stringifyIcal` and `createIcalWriter` give the
same pointer for the same component, and a refusal of the calendar layer
is wrapped as `ICAL3005` with the `CalendarError` as `cause`. The reader's
`docPath` is the path in the text (`/VCALENDAR/VEVENT[2]/DTSTART`), with
the physical `line`.

| Code | Meaning |
|---|---|
| `ICAL1001` | the input is not UTF-8, or a string holds a lone surrogate |
| `ICAL1002` | a content line is not NAME *(;PARAM) : VALUE, or BEGIN or END names no component |
| `ICAL1003` | a parameter is not NAME=VALUE *(,VALUE), or a quoted value is not closed where it ends |
| `ICAL1004` | a control character other than a tab, or a carriage return no line feed follows |
| `ICAL1005` | an END names a component other than the one open |
| `ICAL1006` | the input ends inside a component |
| `ICAL1007` | content outside the calendar: before BEGIN:VCALENDAR, after its END, or a calendar inside a calendar |
| `ICAL1008` | the calendar is not iCalendar 2.0 in the Gregorian scale: VERSION or PRODID missing, repeated or other |
| `ICAL1009` | the reader has ended or stopped, and takes no more input |
| `ICAL1010` | reported: a bare line feed, read as CRLF |
| `ICAL1011` | reported: a property outside the subset, left out |
| `ICAL1012` | reported: a parameter outside the subset, its property read without it |
| `ICAL1013` | reported: a component outside the subset, left out with everything inside it |
| `ICAL1014` | reported: a VTIMEZONE, not compiled in this release |
| `ICAL1015` | reported: an override over this and future occurrences, kept as data |
| `ICAL1016` | reported: an override's property differs from its series', whose value is kept |
| `ICAL1017` | withheld: a component lacks a property it requires, repeats one, or holds two that exclude each other |
| `ICAL1018` | withheld: a value is not of the form or kind its property takes here |
| `ICAL1019` | withheld: a TZID that names no IANA zone the provider knows, or no provider |
| `ICAL1020` | withheld: the calendar layer refused a value, rule or series (cause attached) |
| `ICAL1021` | withheld: an override with no series of its UID, or a second series of one UID |
| `ICAL1022` | withheld: what changes when the event occurs and this release does not read (EXRULE, EXDATE with no rule, a zoned length) |
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

| Component or property | Written | Read |
|---|---|---|
| VCALENDAR: VERSION, PRODID | supported | supported (VERSION 2.0) |
| CALSCALE | not written | GREGORIAN; any other refused (`ICAL1008`) |
| METHOD | `PUBLISH` only | `PUBLISH`; any other reported (`ICAL1011`) |
| VEVENT: UID, DTSTAMP, DTSTART, DTEND, DURATION | supported | supported |
| VEVENT: SUMMARY, DESCRIPTION, LOCATION, STATUS, SEQUENCE | supported | supported |
| VEVENT: RRULE | DAILY, WEEKLY, MONTHLY and YEARLY, for date, floating and utc series | DAILY, WEEKLY, MONTHLY and YEARLY, every kind; sub-daily withheld (`ICAL1020`, `JY0020`) |
| VEVENT: RDATE (DATE, DATE-TIME, PERIOD), EXDATE, RECURRENCE-ID | supported (no RANGE) | supported; RANGE=THISANDFUTURE kept and reported (`ICAL1015`) |
| VEVENT: EXRULE | not written | withheld (`ICAL1022`) |
| VFREEBUSY: UID, DTSTAMP, DTSTART, DTEND, FREEBUSY with FBTYPE | supported | supported |
| TZID | not written: `zones: 'utc'` converts | an IANA name the provider knows; any other withheld (`ICAL1019`) |
| VTIMEZONE | not written | preserved (later): reported, not compiled (`ICAL1014`) |
| VAVAILABILITY, AVAILABLE | not in this release | reported (`ICAL1013`) |
| VTODO, VJOURNAL, VALARM, X- components | refused | reported (`ICAL1013`) |
| ATTENDEE, ORGANIZER, X- and other properties | refused | reported (`ICAL1011`) |
| LANGUAGE, ALTREP, X- and other parameters | not written | reported (`ICAL1012`) |
