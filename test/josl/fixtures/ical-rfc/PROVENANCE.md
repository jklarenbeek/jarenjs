# RFC example corpus

The iCalendar examples of three RFCs, copied from their plain text:

- RFC 5545 (https://www.rfc-editor.org/rfc/rfc5545.txt), Internet
  Calendaring and Scheduling Core Object Specification;
- RFC 7986 (https://www.rfc-editor.org/rfc/rfc7986.txt), New Properties
  for iCalendar;
- RFC 7808 (https://www.rfc-editor.org/rfc/rfc7808.txt), Time Zone Data
  Distribution Service.

An RFC's text does not change once published, so the URL is the
revision. The RFCs' copyright notice makes their Code Components
available under the Simplified BSD License (IETF Trust Legal Provisions
§4.e); it does not say whether an example block is one.

How each block was copied: the lines from its BEGIN to the matching END
at the same indent, the block's indent removed (a deeper indent, the
RFC's fold, kept as the continuation's leading space); the page breaks
inside a block (form feed, running header and footer, blank lines)
removed; CRLF after every line. The RFC 5545 section 4 objects
`rfc5545-section4-meeting.ics`, `rfc5545-section4-interop.ics` and
`rfc5545-section4-todo.ics` in
`../ical/` and the VTIMEZONE examples in `../ical-vtimezone/` are the
same procedure's output for those blocks, and are not repeated here.

A wrapper is added where the RFC gives a fragment; its lines are named
below and are the only lines not in the RFC:

- *calendar head*: `BEGIN:VCALENDAR`, `VERSION:2.0`,
  `PRODID:-//jarenjs//RFC example wrapper//EN` before the block and
  `END:VCALENDAR` after it;
- *event wrapper* (VALARM and RFC 7986 event examples): `BEGIN:VEVENT`,
  a `UID`, `DTSTAMP` and `DTSTART` before the block and `END:VEVENT` after.

| File | Source | Wrapper |
|---|---|---|
| `rfc5545-3.4-object.ics` | RFC 5545 §3.4, the simple iCalendar object | none |
| `rfc5545-3.6.1-vevent-1.ics`, `rfc5545-3.6.1-vevent-2.ics`, `rfc5545-3.6.1-vevent-3.ics`, `rfc5545-3.6.1-vevent-4.ics` | RFC 5545 §3.6.1, the four VEVENT examples, in order | calendar head |
| `rfc5545-3.6.2-vtodo-1.ics`, `rfc5545-3.6.2-vtodo-2.ics` | RFC 5545 §3.6.2, the two VTODO examples | calendar head |
| `rfc5545-3.6.3-vjournal.ics` | RFC 5545 §3.6.3, the VJOURNAL example | calendar head |
| `rfc5545-3.6.4-vfreebusy-1.ics`, `rfc5545-3.6.4-vfreebusy-2.ics`, `rfc5545-3.6.4-vfreebusy-3.ics` | RFC 5545 §3.6.4, the three VFREEBUSY examples | calendar head |
| `rfc5545-3.6.6-valarm-1.ics`, `rfc5545-3.6.6-valarm-2.ics`, `rfc5545-3.6.6-valarm-3.ics` | RFC 5545 §3.6.6, the three VALARM examples | calendar head and event wrapper (`DTSTART:19970317T133000Z`) |
| `rfc5545-4-object-1.ics` | RFC 5545 §4, the first object | none |
| `rfc5545-4-object-5.ics`, `rfc5545-4-object-6.ics` | RFC 5545 §4, the fifth (VJOURNAL) and sixth (VFREEBUSY) objects | none |
| `rfc7986-properties.ics` | RFC 7986 §5.1 NAME, §5.7 REFRESH-INTERVAL, §5.8 SOURCE, §5.9 COLOR and §5.10 IMAGE examples as calendar properties; then the §5.11 CONFERENCE examples, the §6.1 DISPLAY, §6.2 EMAIL and §6.3 FEATURE examples in a VEVENT | calendar head and event wrapper (`DTSTART:20160301T090000Z`) |
| `rfc7986-erratum-conference.ics` | RFC 7986 §6.4, the LABEL example: as printed its parameter list ends in `;` and its value starts on the next line with `:`, which RFC 5545's grammar does not allow, so the reader refuses it (`ICAL1003`) | calendar head and event wrapper |
| `rfc7808-5.3.1-zone.ics` | RFC 7808 §5.3.1, the response body | VERSION and PRODID after BEGIN:VCALENDAR; every `...` elision line removed |
| `rfc7808-5.3.3-alias.ics` | RFC 7808 §5.3.3, the response body (TZID-ALIAS-OF) | the same |
| `rfc7808-5.3.4-truncated.ics` | RFC 7808 §5.3.4, the response body (TZUNTIL) | the same |

Edits: none beyond the wrappers and the elisions. An RFC 7808 body with
its elisions removed has a VTIMEZONE with no observance; the reader
reports it (`ICAL1014`) and the lossless editor keeps it as written.

Lines end in CRLF; `.gitattributes` keeps the bytes as they are.
