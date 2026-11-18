# RFC 7953 availability corpus

The VAVAILABILITY examples of RFC 7953 (https://www.rfc-editor.org/rfc/rfc7953.txt),
Calendar Availability: the three of §3.1 and the calendars of Appendix A
and Appendix B, which §5.1.1 and §5.1.2 evaluate. An RFC's text does not
change once published, so the URL is the revision. The RFCs' copyright
notice makes their Code Components available under the Simplified BSD
License (IETF Trust Legal Provisions §4.e); it does not say whether an
example block is one.

How each block was copied (the procedure of `../ical-rfc/PROVENANCE.md`):
the lines from its BEGIN to the matching END at the same indent, the
block's indent removed, the page breaks inside a block (form feed,
running header and footer, blank lines) removed; CRLF after every line.
The §3.1 examples are fragments: each is wrapped in `BEGIN:VCALENDAR`,
`VERSION:2.0`, `PRODID:-//jarenjs//RFC 7953 example//EN` and
`END:VCALENDAR`, the only lines not in the RFC; example 3's three
VAVAILABILITY components are one file. The Appendix calendars are whole.

## The expected spans (`expected.json`)

Derived by hand from the data of each file and the RFC's rules, never
from the code under test: §3.1 (inside a VAVAILABILITY's period, time is
BUSY-UNAVAILABLE except where an AVAILABLE says free), §4 (a higher
PRIORITY overrides a lower one inside its period; 1 is the highest, 0 or
none the lowest) and §5 step 3, with America/Montreal on UTC-4 until
2011-11-06T06:00Z and UTC-5 after, America/Denver on UTC-6 until
2011-11-06T08:00Z. A span is `[start, end, state, busyType, layers]`: an
instant pair in UTC, `available`, `busy` (with its type) or `unknown`,
and the VAVAILABILITY UIDs that decide it. Time outside every
VAVAILABILITY is `unknown` (no layer claims it); §5 step 1 starts a
free-busy request from free, so `outside` lists what a lowest-ranked
open available layer turns it into.

Where the RFC's prose or tables disagree with its own data, the data
decides, and the case says so:

- §5.1.1 asks for "Monday, 6th November 2011": that day is a Sunday, and
  the day Montreal leaves daylight time (25 hours). Its step-3 row (free
  08:00-18:00) is a Monday's, so it is pinned on Monday 2011-11-07; on
  2011-11-06 itself the Monday-to-Friday AVAILABLE makes nothing free,
  and the Appendix A meeting (12:00-14:00 EST, 17:00Z-19:00Z) is its
  step 4.
- §5.1.2's step 4 puts the meeting on Monday 2011-10-24; Appendix B's
  VEVENT is on 2011-11-06. Its step-3.P1 row is pinned on 2011-10-24
  (free 10:00-20:00 Montreal, 08:00-18:00 Denver); step 4 is not.
- §3.1 example 2's AVAILABLE "Friday from 9:00 to 12:00" starts
  2011-10-06, a Thursday, with FREQ=WEEKLY: it is free on Thursdays,
  inside the Monday-to-Thursday hours, and Friday is BUSY-UNAVAILABLE.
- Appendix B's SUMMARYs say 9:00 to 17:00; the times are 08:00-18:00.
- Several AVAILABLE DTSTARTs fall on a day their BYDAY rule does not
  make (2011-10-02, 2011-10-23 and 2011-10-30 are Sundays), whose
  recurrence set RFC 5545 §3.8.5.3 leaves undefined; no case's span
  reaches one of those starts.

## The BUSYTYPE cases (hand-written)

None of the RFC's examples carries a BUSYTYPE, so two files are written
by hand, every time in UTC (no zone data decides them):

- `busytype-equal-priority.ics`: two VAVAILABILITY components of
  PRIORITY:3 on 2026-11-02, `busy-a` 06:00Z-20:00Z with
  BUSYTYPE:BUSY-TENTATIVE and an AVAILABLE 09:00Z-17:00Z, `busy-b`
  08:00Z-22:00Z with BUSYTYPE:BUSY and an AVAILABLE 12:00Z-19:00Z.
- `busytype-priority.ics`: on 2026-11-03, `avail-base` (no PRIORITY, no
  BUSYTYPE: the default BUSY-UNAVAILABLE, §3.2) over the whole day with an
  AVAILABLE 09:00Z-17:00Z; `avail-hold`, PRIORITY:1, BUSYTYPE:BUSY-TENTATIVE,
  13:00Z-15:00Z with no AVAILABLE; `avail-lab`, PRIORITY:0, BUSYTYPE:BUSY,
  16:00Z-18:00Z with no AVAILABLE.

Their spans follow from §3.1 (inside a period, the time outside its
AVAILABLEs is busy of its BUSYTYPE, §3.2), §4's priorities, and §4's
order for one PRIORITY: "the overlapping busy time type is determined by
the following order: BUSY > BUSY-UNAVAILABLE > BUSY-TENTATIVE". Where an
AVAILABLE of one component meets the other's busy time at one PRIORITY,
§4 leaves the result to their creator; the tie is busy, as for the
examples above, and names only the busy component.
