# Hand-derived ends of moved occurrences and RDATE periods

`ends.json` lists zoned starts in `Europe/Amsterdam` and `America/New_York`
with an end, a duration (RFC 5545 §3.3.6) or both, and the end instant and
wall clock each must have. Every expected value was derived by hand from one
row of `../zone-transitions/transitions.json` (the zdump transition table,
see its PROVENANCE.md), named in `change`, and the offsets before and after
it; nothing in them was computed by the code under test or by the host's ICU.
`derivation` gives the arithmetic.

The rules applied:

- A wall clock that exists has the one offset in force there. One in a fold
  (it happens twice) takes the earlier offset under `rfc5545` and the later
  under `later`; one in a gap is read with the offset before the change
  (RFC 5545 erratum 4271, §3.3.5).
- A duration's weeks and days are added to the start's wall clock, which is
  then resolved; its hours, minutes and seconds are added to that instant
  (RFC 5545 §3.3.6: "The duration of a week or a day depends on its position
  in the calendar ... the exact duration of hours, minutes and seconds").
- The end wall clock is the one the end instant reads, under the offset in
  force at it.

The rows used (instant of the change, offset before, offset after, minutes
east of UTC): Amsterdam `2026-03-29T01:00:00Z` +60 to +120 and
`2026-10-25T01:00:00Z` +120 to +60; New York `2026-03-08T07:00:00Z` -300 to
-240 and `2026-11-01T06:00:00Z` -240 to -300. The test checks that each row
named is in the transition table.
