# RFC 5545 examples, hand-authored

`rfc5545-examples.ics` is written by hand from the examples of RFC 5545
(https://www.rfc-editor.org/rfc/rfc5545), not by the writer:

- the VCALENDAR head of section 4 (`PRODID:-//xyz Corp//NONSGML PDA
  Calendar Version 1.0//EN`), with VERSION first;
- the first, second and fourth VEVENT examples of section 3.6.1;
- the third VFREEBUSY example of section 3.6.4.

Edits, so the file is what the writer's subset spells: CLASS, CATEGORIES,
TRANSP, ORGANIZER and URL (outside the subset) are removed, and each
FREEBUSY carries `FBTYPE=BUSY`, the RFC's default, which the writer always
writes. Lines end in CRLF; `.gitattributes` keeps the bytes as they are.

The other `.ics` files here are the writer's own output, reviewed line by
line and regenerated with `JAREN_UPDATE_GOLDENS=1`.

# Reader fixtures

The reader reads every `.ics` file here. The files below are its own; they
are written as bytes by a small script (not the writer), so each line end,
fold and octet is exactly as listed.

`rfc5545-section4-meeting.ics`, `rfc5545-section4-interop.ics` and
`rfc5545-section4-todo.ics` are the second, third and fourth iCalendar
objects of RFC 5545 §4 (https://www.rfc-editor.org/rfc/rfc5545.txt), one
calendar each: compared line for line with the RFC's plain text (its
seven-space indent removed), with no difference, so its folds stay where
the RFC shows them. Edits: line ends in CRLF only. The RFC's copyright
notice makes its Code Components available under the Simplified BSD
License (IETF Trust Legal Provisions §4.e); it does not say whether an
example block is one, as for `rfc5545-examples.ics` above.

The `exporter-*.ics` files are constructed for this repository (MIT, as
the rest of it) to show what common calendar exporters write. No file
exported by a real product is vendored. Each mimics a shape such files carry:

- `exporter-groupware.ics`: Windows zone names in TZID with a VTIMEZONE
  of that name, X- properties of the server, LANGUAGE parameters, a quoted
  CN holding a comma, a VALARM, and a DESCRIPTION folded every 75 octets
  without regard to code points (padded with dots so that a fold falls
  inside a UTF-8 sequence).
- `exporter-webcal.ics`: IANA TZIDs with a VTIMEZONE of the same name,
  X-WR-CALNAME and X-WR-TIMEZONE, a weekly series with an EXDATE, a moved
  slot and a cancelled slot (STATUS:CANCELLED on its RECURRENCE-ID
  VEVENT), an all-day event as DTSTART and DTEND of dates, attendees, and
  a DESCRIPTION holding emoji and CJK folded by octets as above.
- `exporter-desktop.ics`: CALSCALE, a monthly zoned series, a structured
  location whose quoted parameters hold `:`, `,` and `;`, folded with a
  tab, a floating event, a VALARM with its own X- properties, a VTODO.
