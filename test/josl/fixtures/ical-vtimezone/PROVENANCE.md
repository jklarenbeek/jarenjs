# RFC 5545 VTIMEZONE examples

`rfc5545-vtimezone-1.ics` to `rfc5545-vtimezone-5.ics` are the five
VTIMEZONE components of the example in RFC 5545 section 3.6.5 ("Time Zone
Component"), in the order the RFC gives them, one file each:

1. every rule for New York City since 1967 (STANDARD and DAYLIGHT
   observances with UNTIL, RDATE and open RRULEs);
2. New York City by DTSTART alone (valid from March 2007 to March 2008);
3. New York City's current rules by RRULE, with TZURL;
4. a fictitious zone whose DAYLIGHT rule ends (UNTIL 1998);
5. the same fictitious zone with a second DAYLIGHT rule from 1999.

Source: [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545), "Internet
Calendaring and Scheduling Core Object Specification (iCalendar)", B.
Desruisseaux, Ed., September 2009. The text was fetched from
`https://www.rfc-editor.org/rfc/rfc5545.txt` (SHA-256
`c256f809479d98aa23d71bbd1658b3800ea9f13f41ca56e59c8d2de1b31cbfcb`, the
revision `test/core/calendar/fixtures/rfc5545-recurrence` was taken from).
Each block was cut mechanically from `BEGIN:VTIMEZONE` to
`END:VTIMEZONE`: the RFC's seven-space indent removed, its page headers
and footers dropped, lines ended in CRLF. No other edit. The RFC's
copyright notice makes its Code Components available under the
Simplified BSD License (IETF Trust Legal Provisions §4.e).
