# RFC 5546 scheduling examples

Sixteen of the iTIP examples of RFC 5546 §4
(https://www.rfc-editor.org/rfc/rfc5546.txt), iCalendar Transport-Independent
Interoperability Protocol: one or more of each method (PUBLISH, REQUEST,
REPLY, ADD, CANCEL, REFRESH, COUNTER, DECLINECOUNTER) and of each component
(VEVENT, VFREEBUSY, VTODO, VJOURNAL). `rfc5546-<section>-<n>.ics` is the
section's nth calendar. An RFC's text does not change once published, so
the URL is the revision; the copyright terms are those of
`../ical-rfc/PROVENANCE.md`.

How each block was copied (the procedure of `../ical-rfc/PROVENANCE.md`):
the lines from `BEGIN:VCALENDAR` to the matching `END:VCALENDAR` at the
same indent, the block's indent removed (a deeper indent, the RFC's fold,
kept as the continuation's leading space), the page breaks inside a block
(form feed, running header and footer, blank lines) removed; CRLF after
every line. Every block is a whole calendar; nothing is added.

The expected answers in `../../ical-itip.test.js` were derived by hand from
RFC 5546 §3's restriction tables for each method and component, and from
RFC 5545's value grammar, never from the code under test. Where an example
breaks either, the example is kept as written and its expected answer says
so:

- §4.2.1's DTEND `19970701T2100000Z` has seven time digits: the event's
  data is withheld (`ICAL1018`); the message is read.
- §4.2.9's first ATTENDEE, `ATTENDEE;CUTYPE=INDIVIDUAL;mailto:a@example.com`,
  has a semicolon for its colon: a parameter that is not NAME=VALUE, which
  stops the read (`ICAL1003`).
- §4.3.2's free/busy REQUEST ends at `19970701T200000`, which is not UTC,
  as RFC 5545 §3.6.4 requires of a VFREEBUSY's DTEND: the message is
  withheld (`ICAL1018`).
- §4.7.1's REFRESH holds four ATTENDEEs where §3.2.6 takes exactly one
  (`ICAL1027`), and its DTSTAMP `19970603T094000` is not UTC, which RFC 5545
  §3.8.7.2 requires: the message is withheld (`ICAL1018`).

## Hand-written violating cases (`violating-*.ics`)

Not from the RFC: four calendars written by hand, each breaking rows of
RFC 5546 §3's tables that one message can be checked against, with the
scheduling report each must answer derived from the table rows they
break (`../../ical-itip.test.js`, "the hand-written violating cases"):

- `violating-add.ics`: METHOD:ADD, a VEVENT with `SEQUENCE:0` (§3.2.4:
  "MUST be greater than 0") and a second VEVENT (§3.2.4 takes one) —
  `ICAL1028 SEQUENCE`, `ICAL1027 VEVENT`.
- `violating-cancel.ics`: METHOD:CANCEL, `STATUS:CONFIRMED` (§3.2.5:
  "MUST be set to CANCELLED"), DTEND beside DURATION ("If present, DTEND
  MUST NOT be present"), two UIDs ("All must have the same UID") —
  `ICAL1028 STATUS`, `ICAL1027 DURATION`, `ICAL1028 UID`.
- `violating-reply.ics`: METHOD:REPLY, a `5.1` REQUEST-STATUS in one
  VEVENT and a `2.0` in the other (§3.6 rule 2A), and `2;Success`, no
  status code of RFC 5545 §3.8.8.3's `1*DIGIT 1*2("." 1*DIGIT)` —
  `ICAL1028 REQUEST-STATUS` twice.
- `violating-late-method.ics`: METHOD:CANCEL after the first VEVENT,
  where RFC 5545 §3.6 places the calendar's properties before its
  components — `ICAL1029` in the read's own report, and both VEVENTs
  read as CANCEL messages.
