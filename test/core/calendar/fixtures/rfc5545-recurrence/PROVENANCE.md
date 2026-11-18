# Vendored RFC 5545 recurrence examples

`examples.json` holds every example of RFC 5545 section 3.8.5.3 ("Recurrence
Rule"), one row per RRULE: where an example gives two equivalent rules ("or"),
each is its own row. For each row:

- `title`, `dtstart`, `rrule`, `result` and `exdate` are copied from the RFC
  text. `result` is the RFC's own list, with its line breaks folded into
  spaces.
- The DAILY, WEEKLY, MONTHLY and YEARLY rows also carry `expected`. This is
  the RFC's `result` written out one occurrence per entry as a local time
  with the offset the RFC names (EDT `-04:00`, EST `-05:00`). They also carry
  a `horizon` in UTC that ends the open-ended ("forever", "...") examples
  where the RFC's list stops. The MONTHLY and YEARLY lists were parsed
  mechanically from each row's `result` text: its `(YEAR ... EDT|EST)`
  groups, month names, day lists and ranges, at the DTSTART's 09:00.
- The HOURLY and MINUTELY rows carry no `expected` (other readers of this
  file select the rows that do); `rrule-rfc.test.js` writes their lists
  out by hand from `result`.
- `errata` notes a verified erratum that touches a row.

Source: [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545), "Internet
Calendaring and Scheduling Core Object Specification (iCalendar)", B.
Desruisseaux, Ed., September 2009, section 3.8.5.3. The text was
fetched from `https://www.rfc-editor.org/rfc/rfc5545.txt` (SHA-256
`c256f809479d98aa23d71bbd1658b3800ea9f13f41ca56e59c8d2de1b31cbfcb`). The
examples were selected by their `FREQ` mechanically, not by hand.

Errata consulted (https://www.rfc-editor.org/errata/rfc5545):

- 4271 (verified) replaces the section 3.3.10 sentence that dropped
  nonexistent local times. Such times are read as section 3.3.5 reads an
  explicit time; the expansion's `rfc5545` policy does this.
- 1913 and 3779 (verified) correct the section 3.3.10 sentence on a YEARLY
  rule's ordinal BYDAY: it counts within the month when BYMONTH is present
  and within the year when it is not (the "Every 20th Monday of the year"
  row).
- 3747 (verified, editorial) redraws the section 3.3.10 expand/limit table;
  its cells are unchanged.
- 3883 (verified) corrects the UNTIL of the HOURLY "every 3 hours" example
  to `19970902T210000Z` (17:00 EDT). The RFC's list (09:00, 12:00, 15:00) is
  the corrected rule's; the rule as printed ends at 13:00 EDT.
- 5872, 5920 and 6212 (rejected) leave their examples as printed. The
  "Every Friday the 13th" row keeps its EXDATE of its own DTSTART, so its
  list starts in 1998.

## Licence

Copyright (c) 2009 IETF Trust and the persons identified as the document
authors. All rights reserved.

The RFC is subject to BCP 78 and the IETF Trust's Legal Provisions Relating to
IETF Documents (https://trustee.ietf.org/license-info) in effect on the date of
its publication. The RRULE and DTSTART lines are Code Components extracted
from the document, and they are provided under the Simplified BSD License
below, as section 4.e of the Trust Legal Provisions requires:

> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> - Redistributions of source code must retain the above copyright notice, this
>   list of conditions and the following disclaimer.
> - Redistributions in binary form must reproduce the above copyright notice,
>   this list of conditions and the following disclaimer in the documentation
>   and/or other materials provided with the distribution.
> - Neither the name of Internet Society, IETF or IETF Trust, nor the names of
>   specific contributors, may be used to endorse or promote products derived
>   from this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
> ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
> LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
> INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
> CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
> ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

To refresh: re-fetch the text, check the hash, re-select the rows by
`FREQ`, and re-parse the MONTHLY and YEARLY `result` lines.
