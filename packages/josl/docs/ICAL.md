# `@jarenjs/josl/ical`

An iCalendar (RFC 5545) writer and reader over the values of
[`@jarenjs/core/calendar`](../../core/docs/CALENDAR.md): single events,
recurring events (a series with its rule, extra dates, excluded dates and
overrides) and free/busy spans. Every time is written by its kind, and a
zoned time is written only under a zone mode the caller names. Nothing
outside the documented subset is written raw: an unknown member, property
or component is refused with a code. The reader reads the same subset
back, canonical mode: what lies outside it is reported, never silently
interpreted ([Reading](#reading)). Foreign iCalendar can also be edited
without losing what lies outside the subset: a lossless read keeps the
syntax tree, and `patchIcal` re-emits every octet no edit reaches
unchanged ([Editing](#editing-lossless)).

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
type Calendar = { prodId: string, method?: Method, components: Component[] };

type Method = 'publish' | 'request' | 'reply' | 'add' | 'cancel' | 'refresh' | 'counter' | 'declinecounter';

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

type Availability = {                    // RFC 7953 VAVAILABILITY
  type: 'availability', uid: string, dtstamp?: Instant,
  start?: TemporalValue, end?: TemporalValue, // utc or zoned; either left out is open
  priority?: number,                     // 0-9: 1 the highest, 0 (or none) the lowest
  busyType?: 'busy' | 'busy-unavailable' | 'busy-tentative', // BUSYTYPE: the period outside its AVAILABLEs
  summary?: string, description?: string, location?: string,
  available: { series: Series | SeriesDefinition, dtstamp?: Instant,
    summary?: string, description?: string, location?: string }[], // each AVAILABLE, utc or zoned
};

type Message = {                         // one RFC 5546 scheduling component
  type: 'message', component?: 'event' | 'todo' | 'journal' | 'freebusy',
  uid?: string, dtstamp?: Instant, sequence?: number,
  recurrenceId?: TemporalValue, range?: 'THISANDFUTURE',
  organizer?: Person, attendees?: Person[],
  requestStatus?: { code: string, description?: string, data?: string }[],
  status?: string, start?: Instant, end?: Instant, // start/end: a VFREEBUSY's span
  cancellation?: object, event?: Event | RecurringEvent, suggested?: Event | RecurringEvent,
};

type Person = { address: string /* a cal-address URI */, name?: string, partstat?: string, role?: string,
  cutype?: string, rsvp?: boolean, delegatedTo?: string[], delegatedFrom?: string[], sentBy?: string };

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
| `zoned` | under `zones: 'utc'`, the UTC instant the value resolves to; under `zones: 'embed'`, `DTSTART;TZID=Europe/Amsterdam:20260302T090000` and a VTIMEZONE |
| `date-range` | `DTSTART;VALUE=DATE` and `DTEND;VALUE=DATE` (exclusive) |

iCalendar counts whole seconds: a time with a fraction of a second is
refused (`ICAL3006`), never truncated.

### `zones: 'utc'`

A zoned value is converted to its UTC
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

### `zones: 'embed'`

A zoned value is written as its wall clock with `TZID=` (quoted where the
name holds `;`, `:` or `,`). Before the first component that uses a zone,
the writer adds that zone's VTIMEZONE, once per writer. The VTIMEZONE is
`vtimezoneFor(zone, { provider, horizon })` of the calendar layer, over
the writer's `horizon` widened by two days each way. A compiled
definition places a wall clock only a day clear of its ends, so the
widening lets a time at either edge of the horizon read back:

- the widened horizon's start is an onset of its own;
- every change of offset the provider makes inside it is an RDATE onset
  of a STANDARD or DAYLIGHT observance;
- `TZUNTIL` (RFC 7808) is at the widened end, so a reader never
  stretches the definition past what the provider said.

By default every onset is an RDATE. With `onsets: 'rrule'`, a run of
three or more onsets of one observance in consecutive years, on the same
weekday of the same month at the same time - the nth (`BYDAY=2SU`) or the
last (`BYDAY=-1SU`) - is written as one observance with DTSTART its first
onset and `RRULE:FREQ=YEARLY;BYMONTH;BYDAY` (RFC 5545 §3.6.5), with a UTC
UNTIL at its last onset where the rule would go on inside the definition
(New York's 2007 change: the old rules end, the new ones start). Onsets no
such run covers (a historic change, Apia's skipped day, the Sydney 2000
change) stay RDATEs. The writer compiles the rewritten definition and
keeps the RDATE form if its transitions differ in any way. Each
observance's runs are written as rules only in the choice that is
shortest, so the RRULE form is never longer than the RDATE form: over
decades of a yearly rule it is much shorter, and over a few years, or for
a zone with no change (UTC), it is the RDATE form itself. The tests read each written
VTIMEZONE back with no provider and compare its offsets with the
writer's provider at every change of New York, Amsterdam, Lord Howe, Apia
and UTC from 2000 to 2040. A VTIMEZONE counts toward `maxOctets` but not
toward `maxComponents` or `maxRdates`.

```js
import { compileRecurrence, defineSeries, utcValue, zonedValue } from '@jarenjs/core/calendar';

const text = stringifyIcal({ prodId: '-//Example//Rota//EN', components: [{ type: 'event', series: defineSeries({
  uid: 'standup', base: compileRecurrence({ dtstart: zonedValue('2026-03-02', '09:00:00', 'America/New_York'),
    duration: 'PT15M', rrule: 'FREQ=WEEKLY;BYDAY=MO' }) }) }] },
{ zones: 'embed', provider, horizon: [utcValue('2026-01-01T00:00:00Z'), utcValue('2028-01-01T00:00:00Z')] });
// BEGIN:VTIMEZONE … TZID:America/New_York … TZUNTIL:20280103T000000Z … END:VTIMEZONE
// DTSTART;TZID=America/New_York:20260302T090000 / DURATION:PT15M / RRULE:FREQ=WEEKLY;BYDAY=MO
```

- **A zoned recurring series keeps its rule** under the RFC's policy
  (`rfc5545`). It is written as DTSTART;TZID and RRULE, with every
  RDATE, EXDATE and RECURRENCE-ID in the same zone, so each occurrence
  is the zone's wall clock. A COUNT the rule needs rewritten becomes a
  UTC UNTIL, as RFC 5545 §3.3.10 asks of a zoned start. A series under
  `later` or `reject` is written by its occurrences, as under `'utc'`.
- **A single event's zoned time** is its wall clock where the event's
  policy picks the instant RFC 5545's rule picks. In a fold under
  `later` it picks another instant, so it is written as that UTC
  instant. A zoned start with a duration keeps its DURATION.
- Without a horizon, any zoned value is refused (`ICAL3019`). A zoned
  time outside the horizon is refused too (`ICAL3020`): its VTIMEZONE
  says nothing there.
- An occurrence of a rule that runs past the horizon resolves past
  TZUNTIL. The reader of this module then asks its provider for an IANA
  name and refuses any other name. Choose a horizon that covers the
  series' life.

Read back with `parseIcal(text, { provider })`, the calendar's series
expand through `zones.provider` to the original provider's occurrences
and instants over the horizon. The tests prove this for New York,
Amsterdam, Lord Howe, Apia and UTC.

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
  the same place. Whether the rule makes its start is asked of the rule
  started whole periods earlier on what DTSTART gives it: its weekday
  (DAILY, WEEKLY), its day of the month and month (MONTHLY, YEARLY, stepped
  back by month index past any month without that day, a 31st or 29
  February), or with BYWEEKNO its weekday and week-year (400 years or a
  multiple earlier, where the calendar repeats). So a start the rule makes
  is written once, with its rule as given, COUNT and all. A BYWEEKNO rule
  whose INTERVAL and 400 have a least common multiple past the calendar's
  10000 years (every 27 years), or any rule whose INTERVAL nears 10000
  years, is asked one INTERVAL of days earlier instead, and may be written
  in this longer form although its rule makes its start; it reads back to
  the same set.

What is refused rather than written wrong:

- an expansion that stops at a limit (`ICAL3012`, with its counts),
  including the one-slot questions asked of a rule above: never a calendar
  holding part of the series;
- a series with no occurrence to write (`ICAL3013`);
- two slots of a zoned series that resolve to one UTC instant (`ICAL3014`),
  which a UTC calendar cannot tell apart;
- an override whose slot the series never makes (`ICAL3015`), which a
  reader would take for an event of its own;
- an override over this and future occurrences that names its own
  slot's length (an `end` or `duration`) in a series with an RDATE period,
  where a later slot (a rule's or a period's) has another (`ICAL3016`):
  RECURRENCE-ID;RANGE carries a length to later slots only where it
  changes its own slot's (RFC 5545 §3.8.4.4), so a range of its slot's own
  length leaves each later slot its own. A range without a length, or
  one that changes its slot's, is written, and a later period keeps its
  own length or takes the range's exactly as the calendar layer gives it;
- a period of dates as an extra date, or a slot of dates whose length
  differs from the first's (`ICAL3017`): an RDATE period runs between
  date-times.

Every frequency from SECONDLY to YEARLY is written with its rule; a
sub-daily frequency on a date start is refused by the calendar layer
(`ICAL3005`, its `JY0018` the cause).

An override over this and future occurrences (`range: 'THISANDFUTURE'`)
of a series written with its rule is its slot's VEVENT with
`RECURRENCE-ID;RANGE=THISANDFUTURE` (a cancelled one with
STATUS:CANCELLED); a one-slot override after it with no end of its own
gets the DURATION the range gives. A series written by its occurrences
writes them as the calendar layer expands the ranges.

Under `zones: 'embed'` an RDATE or EXDATE of a zoned series that is utc
or in another zone is written as itself: `EXDATE:20260309T080000Z`,
`RDATE;TZID=America/New_York:20260304T090000` (with that zone's
VTIMEZONE); a period whose ends are in two zones is written as two UTC
instants.

## Free/busy

A VFREEBUSY lists plain spans of instants, `FREEBUSY;FBTYPE=...:start/end`,
in ascending order of start. Free/busy periods are UTC by the RFC, so a
date, floating or zoned span is refused (`ICAL3017`).

## Availability (VAVAILABILITY)

An `availability` component is an RFC 7953 VAVAILABILITY: a period
(`start`, `end`; either left out is open), a `priority`, and its
AVAILABLE components, each a utc or zoned series written as a recurring
event's VEVENTs are (RRULE, RDATE, EXDATE, and an override as an
AVAILABLE with a RECURRENCE-ID). The reader reads it back into the same
model, and `availabilityLayers(components)` turns each one into a layer
of `evaluateAvailability` (`@jarenjs/core/calendar`):

```js
import { availabilityLayers, parseIcal } from '@jarenjs/josl/ical';
import { evaluateAvailability } from '@jarenjs/core/calendar';

const { calendar, zones } = parseIcal(text, { provider });
const answer = evaluateAvailability(availabilityLayers(calendar.components), {
  horizon: [Date.parse('2011-10-24T04:00:00Z'), Date.parse('2011-10-25T04:00:00Z')],
  provider: zones.provider, policy: 'rfc5545',
});
// RFC 7953 Appendix B: busy-unavailable to 14:00Z, available to 00:00Z (08:00-18:00 in Denver,
// the PRIORITY:1 period over the base one), busy-unavailable after
```

- The layer is bounded by the period (`bounds`, an open end `null`), so
  inside it time is available where an AVAILABLE says so and busy
  elsewhere (§3.1), of the component's BUSYTYPE (`busyType`;
  busy-unavailable when it has none, §3.2); a higher PRIORITY decides
  inside its own period over a lower one (§4); 0 or none is the lowest.
  Where two of one PRIORITY are both busy, the stronger type shows, in
  §4's order BUSY > BUSY-UNAVAILABLE > BUSY-TENTATIVE.
- Time outside every VAVAILABILITY is `unknown`, as time no layer claims
  always is. §5 starts a free-busy request from free: a lowest-ranked
  layer `{ id, priority: 0, mode: 'available', spans: [{}], source }`
  beside these says so.
- Two VAVAILABILITY components of one PRIORITY that overlap, where an
  AVAILABLE of one meets the other's busy time: §4 leaves the result to
  their creator; the tie is busy (a tie never opens time), where §5's
  example procedure marks it free.
- Under `zones: 'utc'` a zoned recurring AVAILABLE is written as its
  occurrences over the horizon, so its VAVAILABILITY's period must lie
  inside the horizon (`ICAL3022` otherwise: past the horizon the read
  would say busy-unavailable where the model says available); under
  `zones: 'embed'` it keeps its RRULE.
- Withheld (`ICAL1025`): a BUSYTYPE other than BUSY, BUSY-UNAVAILABLE
  and BUSY-TENTATIVE (an iana-token or x-name: §3.2 gives it no meaning,
  so the time outside its AVAILABLEs has no type), and AVAILABLE times
  both UTC and zoned (one layer's series are of one kind). A DATE or floating time is
  withheld (`ICAL1018`): RFC 7953 §3.1 takes UTC or zoned DATE-TIMEs.

## Scheduling (iTIP)

A calendar's `method` is any of RFC 5546's eight. With a METHOD, the
read answers `scheduling: { method, messages, report }` beside the model:

- `messages` holds one message per VEVENT, VTODO, VJOURNAL or VFREEBUSY:
  its `uid`, `dtstamp`, `sequence`, `recurrenceId` (and `range`), its
  `organizer` and `attendees` (`{ address, name?, partstat?, role?,
  cutype?, rsvp?, delegatedTo?, delegatedFrom?, sentBy? }`, a REPLY's
  answer being its attendee's `partstat`), its `requestStatus`, its
  `status`, and a VFREEBUSY's `start` and `end`. A CANCEL carries
  `cancellation`, the series model's own: `{ recurrenceId, status:
  'cancelled', range? }` for an instance, `{ status: 'cancelled' }` for
  the whole event. An ADD carries the `event` it adds and a COUNTER the
  `suggested` event it makes, each an event of the model, for the host to
  apply, accept or decline.
- PUBLISH and REQUEST components (and PUBLISH and REPLY VFREEBUSYs) are
  calendar data, also read into `calendar.components` as without a
  method. Every other method's components are messages only, so a host
  that keeps `components` never keeps a REPLY, CANCEL or COUNTER as an
  event; what such a message does not read is reported (`ICAL1011`,
  `ICAL1013`).
- `report` checks each component against RFC 5546 §3's restriction table
  for its method: a property or subcomponent the table requires and the
  component lacks (`ICAL1026`), one it excludes or takes fewer times, a
  component the method does not take, or more of a kind than it takes
  (`ICAL1027`). The tables' comments that one message answers are
  checked too: a value outside what a comment allows (`ICAL1028`: an
  ADD's SEQUENCE of 0, a CANCEL's STATUS other than CANCELLED, a
  COUNTER's VEVENT STATUS outside CONFIRMED, TENTATIVE and CANCELLED, a
  REQUEST-STATUS that is no status code of RFC 5545 §3.8.8.3's syntax and
  class 1 to 5 with its description, two classes of REQUEST-STATUS in one
  component, a 5.xx or 3.xx in one component beside another class in
  another (§3.6), components of more than one UID where the table says
  "All components MUST have the same UID", a STANDARD or DAYLIGHT
  DTSTART not in local time), DTEND or DUE beside DURATION and an
  observance's RDATE beside its RRULE (`ICAL1027`), and a VALARM's
  DURATION without REPEAT or the reverse, a TZID no VTIMEZONE of the
  message defines, and a VTIMEZONE without STANDARD or DAYLIGHT
  (`ICAL1026`). A comment that needs the message it answers (an UID,
  ORGANIZER or SEQUENCE that "MUST echo" the original's, the attendee
  replying, a RECURRENCE-ID only of a recurring event) is the host's; a
  "MAY be one of" is no requirement; a CANCEL without STATUS is no entry. A VFREEBUSY's times are UTC as the read
  always takes them (`ICAL1018` otherwise). The entries are reported,
  never dropped content, and apart from `report.unsupported`: `strict`
  refuses none of them, and `strictScheduling: true` refuses at the
  first, with its code.
- A METHOD after the first component is misplaced (RFC 5545 §3.6 puts
  the calendar's properties before its components): it is reported
  (`ICAL1029`, so `strict` refuses it) and applied to the whole
  calendar, `parseIcal` reading the text again with it from the start.
  `createIcalReader` and `iterateIcal` have handed the components before
  it out already: under PUBLISH or REQUEST (and a VFREEBUSY's REPLY)
  those are calendar data either way and are read without their messages
  and table checks, which the entry says; under any other method they
  were read as calendar data where they are messages, and the read is
  refused (`ICAL1008`).
- The writer writes `method` as METHOD, and a `message` component as its
  component (`event` or `suggested` written as the event, with the
  message's lines in each of its VEVENTs). Under any method but PUBLISH,
  each component is checked against its method's table and the comments
  above, and the calendar's components against the counts, kinds, UID
  and REQUEST-STATUS classes the tables allow: the component that breaks
  either is refused where it is written (`ICAL3021`; an ADD's second
  VEVENT, say). The writer's own VTIMEZONEs are counted and define
  their TZIDs; their observances are the calendar layer's. A PUBLISH
  calendar's events, which carry no ORGANIZER here, are written as
  before.

The organizer's and attendees' state machine (which SEQUENCE is current,
whether a REPLY or COUNTER applies, applying a CANCEL to a stored series,
delegation) and the transport (iMIP mail, CalDAV scheduling) are the
host's: this codec reads and writes the messages' data, nothing more.

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
- `method` is one of RFC 5546's eight, or absent (Scheduling, above).

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
| `DTSTART;TZID=Europe/Amsterdam:20260302T090000` | `zoned`, when a VTIMEZONE read before it defines the TZID or it is an IANA name the provider knows; a single event gets `policy: 'rfc5545'` |
| `DTSTART;VALUE=DATE` with `DTEND;VALUE=DATE` | `date-range` |

A TZID withholds its component (`ICAL1019`) when no VTIMEZONE read
before it defines it and it is not an IANA name the provider knows
(a Windows zone name, a prefixed name, an offset), or when it arrives
with no provider. A zone is never guessed. A DTEND at its DTSTART is
read as no end, which a time without one has.

### VTIMEZONE

A VTIMEZONE is compiled into a zone provider as soon as it is read. Its
STANDARD and DAYLIGHT observances (DTSTART, TZOFFSETFROM, TZOFFSETTO,
RRULE, RDATE) are mapped onto the calendar layer's zone definition and
compiled by `compileVtimezone` (see `@jarenjs/core` docs/CALENDAR.md).

- The compilation runs over `zoneHorizon` (default 1900-01-01 to
  2100-01-01) under `zoneLimits`.
- TZUNTIL ends it early. LAST-MODIFIED, TZURL, TZNAME and COMMENT are
  read without changing an instant.
- Other properties, parameters and components inside it are reported, as
  everywhere else.

`vtimezone` chooses which definition a TZID the file defines resolves
through:

- `'embedded'`, the default, is RFC 5545's rule: the file's definition is
  authoritative for the file, and a name only the file knows (a Windows
  zone name) resolves.
- `'provider'` uses the caller's zone data. A stale exporter cannot then
  move an instant, but the file is read otherwise than it says, and a
  name only the file defines is withheld as before.

Either way, a definition of an IANA name is compared with the caller's
provider over the span the file's values use it. The comparison samples
a week apart and both sides of every change the definition makes, and
runs on to the horizon's end for a recurring series. Where they differ
it is reported (`ICAL1023`, naming the first instant and both offsets,
and the source used), never silently picked.

The result carries `zones` beside `calendar` and `report`, as do
`reader.end()` and `iterateIcal`'s end item:

- `zones.provider` is what the calendar's zoned values resolve through:
  each compiled definition for its TZID (under `'embedded'`), the
  caller's provider for every other name. Pass it to `expandSeries`,
  `toUtc` or `evaluateAvailability`.
- `zones.compiled` holds every compiled definition by TZID.
- `zones.undeclared` lists the TZIDs used that no VTIMEZONE defines.
  RFC 5545 asks for one; such a TZID resolves through the provider and
  is not refused, under `strict` too.

`reader.provider` is the same provider, live while the input is fed.

Before its earliest onset, past TZUNTIL or past the horizon, a
definition says nothing. A value the file names there is reported
(`ICAL1024`). The provider answers it when it knows the IANA name;
otherwise resolving it refuses (`JY0024`). The RFC's §4 meeting example
is such a case: its VTIMEZONE starts in October 1998, and its event is
in March.

A VTIMEZONE is reported and its TZID resolves as an undefined one does
(`ICAL1014`) when:

- it cannot be read or compiled (no TZID or observance, a misspelt
  offset, two onsets at one instant with different offsets: the
  calendar layer's refusal is the cause);
- it is a second one of a TZID (the first is kept).

A limit that stops a compilation is reported too (`ICAL1014`), and the
definition answers only as far as it got.

A VTIMEZONE must come before the components that use it, as exporters
write it: a TZID that only a later VTIMEZONE defines, and that the
provider does not know, is withheld.

### Series

A VEVENT with an RRULE or an RDATE is a recurring event; its `series` is
a value `defineSeries` returned. The rule is compiled by
`compileRecurrence`, so every frequency from SECONDLY to YEARLY is read.
RDATE (DATE, DATE-TIME, PERIOD) and EXDATE are read as extra and excluded
dates, each with its own TZID (or UTC), which may differ from DTSTART's; an RDATE of DTSTART says nothing DTSTART does not,
and is left out. Without a rule, DTSTART and every RDATE are the
occurrences, each as long as the event: a DURATION from each one's own
start, a DTEND by the exact time between DTSTART and it (RFC 5545
§3.8.5.3). A zoned length, an RDATE period's `start/duration` among them,
is read as the end it gives (the days on the wall clock, then the time
exactly, through the file's zones), or as `duration`, which the calendar
layer reads exactly, where that end lies in the second pass of a repeated
hour, which a zoned end does not name. A VEVENT with the series' UID and
a RECURRENCE-ID is an override: STATUS:CANCELLED makes it a cancelled
slot, any other a moved one. An override with no DTEND or DURATION lasts
what such an event lasts (nothing for a time, a day for a date), so its
end is written out where that differs from the slot's length (an RDATE
period's own on its slot; under an override over this and future
occurrences that changes its own slot's length, the length that range
gives). A zoned override's own DURATION is read as a zoned length is,
above. A range carries its DTEND or DURATION to later slots only where it
changes its own slot's length (RFC 5545 §3.8.4.4); a range of its own
slot's length is read without one, so each later slot keeps its own. An override's SUMMARY, DESCRIPTION, LOCATION, STATUS, SEQUENCE or DTSTAMP
that differs from its series' is reported (`ICAL1016`); the series' value
is kept. RANGE=THISANDFUTURE is read into the series, which the
calendar layer expands: the override's slot and every later one move by
its distance and take its length.

The read's `zones.provider` lists the compiled definitions' changes of
offset (`offsetChanges`), so a SECONDLY or MINUTELY zoned series asks it
once per wall-clock hour before its horizon rather than once per time.
For a TZID it routes to the caller's provider it answers that
provider's own list (`createIntlZoneProvider` from
`@jarenjs/locales/intl-zones` has one); for a caller's provider that
lists none it answers one entry at the span's start, and the walk
resolves that span time by time.

### The report

Everything outside the subset is an entry of `report.unsupported`, in the
order read: `{ code, name, path, line, reason }`, with `withheld: true`
when its whole component is left out of the model and `cause` (the
calendar layer's code, reason and path) when that layer refused.
`report.counts` counts the entries by code; past `maxReported` entries are
counted, not listed (`report.omitted`).

- Left out, the rest read: a property (`ICAL1011`: X- properties,
  ATTENDEE and ORGANIZER of an event, CATEGORIES, a METHOD outside RFC
  5546, ...), a parameter (`ICAL1012`: LANGUAGE, ALTREP, X- parameters,
  ...), a component with everything inside it (`ICAL1013`: VTODO,
  VJOURNAL, VALARM, X- components), a VTIMEZONE that cannot be
  compiled (`ICAL1014`), a definition that disagrees with the provider
  (`ICAL1023`) or does not reach a value (`ICAL1024`).
- Withheld: a component that lacks or repeats a property (`ICAL1017`), a
  value not of its property's form or kind (`ICAL1018`), an unresolved
  TZID (`ICAL1019`), a refusal of the calendar layer (`ICAL1020`), an
  override no series claims or a second series of one UID (`ICAL1021`),
  and what would change when the event occurs that this release does not
  read (`ICAL1022`: EXRULE, EXDATE with no rule, a series of extra dates
  whose DTEND lies in another zone than its DTSTART).

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

## Editing (lossless)

```js
import { parseIcal, patchIcal } from '@jarenjs/josl/ical';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Shop//EN',
  'BEGIN:VEVENT', 'UID:stock-count', 'DTSTAMP:20260301T000000Z',
  'DTSTART;TZID=Europe/Amsterdam:20260302T090000', 'DTEND;TZID=Europe/Amsterdam:20260302T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Stock count', 'X-SHOP-AISLE:3',
  'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
const { tree } = parseIcal(text, { mode: 'lossless', provider: createIntlZoneProvider({ revision: '2026e' }) });
const edited = patchIcal(tree, [
  { op: 'retitle', uid: 'stock-count', summary: 'Stock count, aisle 3' },
  { op: 'cancel', uid: 'stock-count', recurrenceId: '2026-03-09T09:00:00' },
]);
edited.split('\r\n').slice(9, 12);
// ['SUMMARY:Stock count\\, aisle 3', 'X-SHOP-AISLE:3', 'EXDATE;TZID=Europe/Amsterdam:20260309T090000']
```

`parseIcal(text, { mode: 'lossless' })` reads as the canonical mode does
(the same `calendar`, `report` and `zones`) and also returns `tree`: the
input's octets and every component and property of the calendar over
them. A property carries its name (upper case), parameters and value as
written, and `from`/`to`, the octets of its own lines - the folded
spelling, its folds and line break included; a component carries
`from`/`head` (its BEGIN line), `tail`/`to` (its END line), its
properties and its children in the order read. X- and IANA properties,
parameters and components, VALARMs, VTIMEZONEs, the order of everything,
CRLF and bare LF line ends, a byte order mark and empty lines are in it
exactly as written. Only `parseIcal`, which holds the whole input, reads
in this mode; `createIcalReader` and `iterateIcal` take `mode:
'canonical'` only.

`patchIcal(tree, edits)` returns the calendar with the edits applied: a
string when a string was read, octets when octets were. With no edits it
is the input. Each edit names its event by `uid` and, for one occurrence
of a series, its slot by `recurrenceId`, spelled as an occurrence spells
it (`2026-03-02`, `2026-03-02T09:00:00`, `2026-03-02T08:00:00Z`).

| Edit | What it writes |
|---|---|
| `{ op: 'retitle', uid, recurrenceId?, summary }` | SUMMARY of the event, or of the occurrence's own VEVENT: the line replaced, or added; `null` removes it |
| `{ op: 'describe', uid, recurrenceId?, description }` | DESCRIPTION, the same way |
| `{ op: 'relocate', uid, recurrenceId?, location }` | LOCATION, the same way |
| `{ op: 'move', uid, recurrenceId, start, end? \| duration?, dtstamp? }` | the occurrence's own VEVENT gets the new DTSTART (and DTEND or DURATION); with none, a new VEVENT copied from the series' (every line but RRULE, RDATE, EXDATE and EXRULE, its VALARMs with it), with RECURRENCE-ID, the new times and, given `dtstamp`, a new DTSTAMP |
| `{ op: 'cancel', uid, recurrenceId? }` | STATUS:CANCELLED on the event, or on the occurrence's own VEVENT; an occurrence with none gets an EXDATE |
| `{ op: 'exdate', uid, recurrenceId }` | an EXDATE on the series |
| `{ op: 'remove', uid, recurrenceId? }` | the event's lines (every VEVENT of its UID), or the occurrence's own VEVENT's, which returns the occurrence to its series' form |
| `{ ..., component: 'todo' \| 'journal' }` | `retitle`, `describe`, `relocate` (VTODO only) and `remove` of the VTODO or VJOURNAL of that UID (and RECURRENCE-ID), as written: the model does not read them |
| `{ ..., alarm: n }` | the nth VALARM (from 0, in file order) of the event, occurrence or VTODO: `describe` (a string: DISPLAY and EMAIL alarms need one) and `remove` |
| `{ op: 'trigger', uid, recurrenceId?, component?, alarm, trigger }` | the VALARM's TRIGGER value, a duration such as `-PT15M`, its parameters (RELATED=END) kept; an absolute TRIGGER is refused (`ICAL4013`) |

Every octet no edit reaches is the input's own. An edit writes whole
content lines and only its own:

- a replaced line (SUMMARY, DESCRIPTION, LOCATION, STATUS, DTSTAMP,
  DTSTART, DTEND, DURATION) keeps its name and parameters as written and
  its line break; only the value is new, escaped as TEXT where it is text
  and folded at 75 octets. A DTEND that takes a DURATION's place, or the
  reverse, is a new property and spelled anew; a new override's DTSTART,
  DTEND, DURATION and DTSTAMP keep the series' names and parameters;
- an inserted line takes the line break of the line it follows, after the
  component's last property (an EXDATE after the last EXDATE, a new
  override after the last VEVENT of its UID); times are spelled in the
  series' kind (`VALUE=DATE`, the series' TZID, or `Z`);
- a copied line stays octets, so a fold inside a UTF-8 sequence is copied
  as it was;
- an excluded or cancelled occurrence cancelled again, or a property
  removed that is not there, writes nothing.

Each edit is checked against the model the same read produced, and every
edit is planned before anything is emitted, so a refusal returns nothing:

- a slot must be one the series makes (asked of the calendar layer), of
  an event the read did not withhold, and an occurrence's own VEVENT one
  the read took into its series (`ICAL4006` otherwise);
- a move's times are of the series' kind and zone, in whole seconds;
- a RANGE=THISANDFUTURE override is read into its series and expanded:
  a later occurrence is edited as any other (one moved with no end of its
  own ends by the range's length, not the series' DURATION a copy would
  carry). A move of the range's own slot is a new DTSTART of the range,
  and so a new shift of every later slot (RFC 5545 §3.8.4.4). A cancel or
  EXDATE of it is an EXDATE of the slot beside the range, which stays as
  written: the EXDATE removes that one slot (§3.8.5.1) and every later
  one keeps the range's changes. A range on a slot the series never
  makes applies nowhere, so excluding its slot is refused (`ICAL4004`).
  Its text and its removal are edits like any other;
- a text with an alternate representation (ALTREP), a property held more
  than once, and an EXDATE over an occurrence's own VEVENT would lose or
  contradict content (`ICAL4007`);
- every edit reads the input as it was read: two that reach one line, one
  occurrence, or an event another removes are refused (`ICAL4010`); read
  the output again to edit further;
- the output is read once more under the options the tree was read with,
  and an edit after which that read would withhold an event it held
  before is refused (`ICAL4012`): an occurrence of a date series moved
  with a `duration` of hours, say, which the canonical read withholds.

## Codes

`IcalError` is a coded error: `code`, `reason`, and `docPath`. The
writer's `docPath` is a JSON pointer into the calendar
(`/components/2/summary`); `stringifyIcal` and `createIcalWriter` give the
same pointer for the same component, and a refusal of the calendar layer
is wrapped as `ICAL3005` with the `CalendarError` as `cause`. The reader's
`docPath` is the path in the text (`/VCALENDAR/VEVENT[2]/DTSTART`), with
the physical `line`. `patchIcal`'s `docPath` points into its edits
(`/edits/1/recurrenceId`); a text, a fraction of a second or an end it
refuses carries the writer's code for it (`ICAL3004`, `ICAL3006`,
`ICAL3007`, `ICAL3003` for a malformed duration).

| Code | Meaning |
|---|---|
| `ICAL1001` | the input is not UTF-8, or a string holds a lone surrogate |
| `ICAL1002` | a content line is not NAME *(;PARAM) : VALUE, or BEGIN or END names no component |
| `ICAL1003` | a parameter is not NAME=VALUE *(,VALUE), or a quoted value is not closed where it ends |
| `ICAL1004` | a control character other than a tab, or a carriage return no line feed follows |
| `ICAL1005` | an END names a component other than the one open |
| `ICAL1006` | the input ends inside a component |
| `ICAL1007` | content outside the calendar: before BEGIN:VCALENDAR, after its END, or a calendar inside a calendar |
| `ICAL1008` | the calendar is not iCalendar 2.0 in the Gregorian scale: VERSION or PRODID missing, repeated or other; or a streaming read meets a METHOD after components it read as calendar data that the METHOD makes messages |
| `ICAL1009` | the reader has ended or stopped, and takes no more input |
| `ICAL1010` | reported: a bare line feed, read as CRLF |
| `ICAL1011` | reported: a property outside the subset, left out |
| `ICAL1012` | reported: a parameter outside the subset, its property read without it |
| `ICAL1013` | reported: a component outside the subset, left out with everything inside it |
| `ICAL1014` | reported: a VTIMEZONE that cannot be compiled, a second one of a TZID, or one a limit stopped |
| `ICAL1015` | Retired, no longer raised: an override over this and future occurrences is read into its series and expanded |
| `ICAL1016` | reported: an override's property differs from its series', whose value is kept |
| `ICAL1017` | withheld: a component lacks a property it requires, repeats one, or holds two that exclude each other |
| `ICAL1018` | withheld: a value is not of the form or kind its property takes here |
| `ICAL1019` | withheld: a TZID that names no IANA zone the provider knows, or no provider |
| `ICAL1020` | withheld: the calendar layer refused a value, rule or series (cause attached) |
| `ICAL1021` | withheld: an override with no series of its UID, or a second series of one UID |
| `ICAL1022` | withheld: what changes when the event occurs and this release does not read (EXRULE, EXDATE with no rule, a series of extra dates whose DTEND lies in another zone than its DTSTART) |
| `ICAL1023` | reported: a VTIMEZONE of an IANA name and the provider give other offsets over the span the file uses it |
| `ICAL1024` | reported: a value lies outside what the VTIMEZONE of its TZID covers |
| `ICAL1025` | withheld: a VAVAILABILITY the availability layers cannot hold as RFC 7953 reads it (a BUSYTYPE other than BUSY, BUSY-UNAVAILABLE or BUSY-TENTATIVE, AVAILABLE times both UTC and zoned) |
| `ICAL1026` | scheduling report: a component lacks a property or subcomponent RFC 5546 §3 requires of it under the calendar's METHOD |
| `ICAL1027` | scheduling report: a component holds a property or subcomponent its method's table excludes, or more of one than it takes; or the method takes no such component, or fewer of a kind |
| `ICAL1028` | scheduling report: a value outside what a comment of its method's table allows (a SEQUENCE, a STATUS, a REQUEST-STATUS code or its class, one UID, a local DTSTART) |
| `ICAL1029` | METHOD follows a component, where RFC 5545 §3.6 places it before them; `parseIcal` applies it to the whole calendar (a streaming read refuses one whose components are messages, `ICAL1008`) |
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
| `ICAL3016` | an override over this and future occurrences that names its own slot's length, in a series with an RDATE period, for later slots of another length |
| `ICAL3017` | a value iCalendar cannot spell here |
| `ICAL3018` | the writer has ended or refused, and takes no more components |
| `ICAL3019` | `zones: 'embed'` and no horizon for a zone's VTIMEZONE |
| `ICAL3020` | a zoned time outside the horizon its VTIMEZONE covers |
| `ICAL3021` | under a METHOD other than PUBLISH, a component its method's RFC 5546 table would not take, or one after which the calendar's components break the tables' counts, kinds, UID or REQUEST-STATUS classes |
| `ICAL3022` | under `zones: 'utc'`, a zoned recurring AVAILABLE whose VAVAILABILITY period the horizon does not hold |
| `ICAL4001` | an edit is not one of the documented edits, or a member of it has a form it does not take |
| `ICAL4002` | no VEVENT holds the UID, or the occurrence, an edit names |
| `ICAL4003` | more than one VEVENT could be the one an edit names |
| `ICAL4004` | the event is not recurring, its series makes no such occurrence, or a moved occurrence is excluded or cancelled |
| `ICAL4005` | Retired, no longer raised: a cancel or EXDATE of the slot of an override over this and future occurrences is an EXDATE beside the range |
| `ICAL4006` | the read withheld the event, or the occurrence's own VEVENT, so the occurrence cannot be checked |
| `ICAL4007` | the edit would lose content: a property held more than once, a text with an alternate representation, an occurrence with its own VEVENT |
| `ICAL4008` | a moved occurrence's start or end is not of its series' kind and zone |
| `ICAL4009` | a move gives no end, and the length is held by a DTEND the new start would leave behind |
| `ICAL4010` | two edits reach one property or occurrence, or an event another edit removes |
| `ICAL4011` | the tree is not one `parseIcal` returned under `mode: 'lossless'` |
| `ICAL4012` | the edited calendar would not read back with every event an edit reached and kept |
| `ICAL4013` | a VALARM's TRIGGER is an absolute time, which a duration does not replace |

## Capability matrix

Every component, property and parameter of RFC 5545, the properties and
parameters RFC 7986 adds and the two RFC 7808 adds, with what the
writer, the canonical reader and the lossless editor do with each. The
reader's column is tested name by name (`test/josl/ical-matrix.test.js`):
a calendar holding only that name is read and its code asserted. Under
*Lossless*, *preserved* means re-emitted as written by `patchIcal`.

| Component, property or parameter | Written | Read | Lossless |
|---|---|---|---|
| `VCALENDAR` | supported | supported | preserved |
| `VEVENT` | supported | supported | preserved; the component `patchIcal` edits |
| `VFREEBUSY` | supported | supported | preserved |
| `VTIMEZONE`, `STANDARD`, `DAYLIGHT` | `zones: 'embed'` | compiled; one that cannot be is reported (`ICAL1014`) | preserved |
| `VAVAILABILITY`, `AVAILABLE` | supported (`type: 'availability'`, RFC 7953) | supported; a BUSYTYPE other than BUSY, BUSY-UNAVAILABLE or BUSY-TENTATIVE, or AVAILABLE times both UTC and zoned, withheld (`ICAL1025`) | preserved |
| `VTODO`, `VJOURNAL`, X- and IANA components | refused (`ICAL3002`); a VTODO or VJOURNAL scheduling message written (`type: 'message'`) | reported (`ICAL1013`); under a METHOD also read as a message | preserved; a VTODO or VJOURNAL retitled, described, relocated (VTODO) or removed by `component` |
| `VALARM` | refused (`ICAL3002`) | reported (`ICAL1013`) | preserved; copied into a new override; described, re-triggered or removed by `alarm` |
| `VERSION`, `PRODID` | supported | supported, VERSION 2.0 (any other refused, `ICAL1008`) | preserved |
| `CALSCALE` | not written | GREGORIAN; any other refused (`ICAL1008`) | preserved |
| `METHOD` | RFC 5546's eight; a component of any but PUBLISH, and the calendar's components, checked against its method's tables (`ICAL3021`) | RFC 5546's eight, each component checked against its method's table in `scheduling.report` (`ICAL1026`-`ICAL1028`); after the first component reported (`ICAL1029`) and applied; any other reported (`ICAL1011`) | preserved |
| `UID`, `DTSTAMP` | supported | supported | preserved; a new override's DTSTAMP from the edit |
| `DTSTART`, `DTEND`, `DURATION` | supported; an override's or RDATE period's `duration` written as DURATION | supported; a zoned length that ends in a repeated hour's second pass read as `duration` | preserved; written by `move` |
| `SUMMARY`, `DESCRIPTION`, `LOCATION` | supported | supported | preserved; set or removed by `retitle`, `describe`, `relocate` |
| `STATUS` | supported | supported | preserved; written by `cancel` |
| `SEQUENCE` | supported | supported | preserved |
| `RRULE` | SECONDLY to YEARLY, for date (DAILY to YEARLY), floating and utc series, and zoned ones under `zones: 'embed'`; a VTIMEZONE's yearly onsets under `onsets: 'rrule'` | SECONDLY to YEARLY, every kind | preserved |
| `RDATE` | supported (DATE, DATE-TIME, PERIOD, a period by its start and duration); utc or in another zone, written as itself under `zones: 'embed'` | supported, each with its own TZID; a zoned period's duration exactly | preserved |
| `EXDATE` | supported; utc or in another zone, written as itself under `zones: 'embed'` | supported, each with its own TZID; with no rule or RDATE withheld (`ICAL1022`) | preserved; added by `exdate` and `cancel` |
| `RECURRENCE-ID` | supported | supported | preserved; written in a new override |
| `EXRULE` | not written | withheld (`ICAL1022`) | preserved |
| `FREEBUSY` | supported, with FBTYPE | supported | preserved |
| `ATTACH`, `CATEGORIES`, `CLASS`, `COMMENT`, `GEO`, `PERCENT-COMPLETE`, `PRIORITY`, `RESOURCES`, `COMPLETED`, `DUE`, `TRANSP`, `CONTACT`, `RELATED-TO`, `URL`, `CREATED`, `LAST-MODIFIED` | not written | reported (`ICAL1011`) | preserved |
| `ATTENDEE`, `ORGANIZER`, `REQUEST-STATUS` | written in a scheduling message (`type: 'message'`) | reported (`ICAL1011`) in an event; under a METHOD read into its message (`scheduling.messages`) | preserved |
| `ACTION`, `REPEAT`, `TRIGGER` | not written | reported with their VALARM (`ICAL1013`) | preserved; a relative TRIGGER's value set by `trigger` |
| `TZID` (property), `TZOFFSETFROM`, `TZOFFSETTO`, `TZNAME` | `zones: 'embed'` | compiled | preserved |
| `TZURL` | not written | read past, informational | preserved |
| `TZUNTIL` (RFC 7808) | `zones: 'embed'` | compiled: the definition's end | preserved |
| `TZID-ALIAS-OF` (RFC 7808) | not written | reported (`ICAL1011`) | preserved |
| `NAME`, `REFRESH-INTERVAL`, `SOURCE`, `COLOR`, `IMAGE` (RFC 7986, calendar) | not written | reported (`ICAL1011`) | preserved |
| `DESCRIPTION`, `UID`, `URL`, `LAST-MODIFIED`, `CATEGORIES` (RFC 7986, calendar) | not written | reported (`ICAL1011`) | preserved |
| `CONFERENCE` (RFC 7986) | not written | reported (`ICAL1011`) | preserved |
| X- and IANA properties | refused (`ICAL3002`) | reported (`ICAL1011`) | preserved |
| `VALUE`, `TZID` (parameter) | supported | supported | preserved; spelled for every new time |
| `RANGE` | THISANDFUTURE, on a series written with its rule (`ICAL3016` for a range of its own slot's length over later slots of another); expanded otherwise | THISANDFUTURE read into the series and expanded; any other withheld (`ICAL1018`) | preserved; a later occurrence edited as any other; a move of its own slot moves the range, a cancel or EXDATE of it is an EXDATE beside the range |
| `FBTYPE` | supported | supported | preserved |
| `ALTREP` | not written | reported (`ICAL1012`) | preserved; a text edit of its property refused (`ICAL4007`) |
| `LANGUAGE`, `CN`, `CUTYPE`, `DELEGATED-FROM`, `DELEGATED-TO`, `DIR`, `ENCODING`, `FMTTYPE`, `MEMBER`, `PARTSTAT`, `RELATED`, `RELTYPE`, `ROLE`, `RSVP`, `SENT-BY`, `DISPLAY`, `EMAIL`, `FEATURE`, `LABEL`, X- and IANA parameters | not written | reported on a property of the subset (`ICAL1012`) | preserved; a replaced line keeps its parameters |

The vendored RFC examples (`test/josl/fixtures/ical-rfc/`, beside the
section 4 objects and the VTIMEZONE examples) read to the same model in
both modes, give their octets back unchanged from `patchIcal`, and write
canonically to a calendar that writes again to the same octets. One RFC
7986 example (`rfc7986-erratum-conference.ics`, a parameter list ending
in `;:`) is refused (`ICAL1003`), as its grammar requires.
