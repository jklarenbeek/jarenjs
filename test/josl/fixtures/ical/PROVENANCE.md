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
