# Vendored zone transitions

`transitions.json` lists every UTC-offset change from 2000 through 2040 for
`America/New_York`, `Europe/Amsterdam`, `Australia/Lord_Howe`, `Pacific/Apia`
and `UTC` (which has none), as `{ at, before, after }`: the instant of the
change in UTC and the offsets in force before and after it, in minutes east of
UTC. `initialOffset` is the offset in force at 2000-01-01T00:00:00Z.

Source: the [IANA time zone database](https://www.iana.org/time-zones), release
**2026e** (the `northamerica`, `europe` and `australasia` source files), as
compiled into the host's `/usr/share/zoneinfo` and read with
`zdump -v -c 1999,2041 <zone>` (GNU libc 2.43 `zdump`). The rows are the
`zdump` pairs (the last second before a change and the first after it)
written down as instants and offsets; nothing in them was computed by the code
under test or by the host's ICU. Years after 2037 come from each zone's
POSIX rule string, as `zdump` expands it.

The rows were checked by eye against the rules the database states:

- New York: first Sunday in April and last Sunday in October at 02:00 local
  through 2006, second Sunday in March and first Sunday in November from 2007.
- Amsterdam: last Sunday in March and October at 01:00 UTC.
- Lord Howe: a 30-minute change at 02:00 local; daylight time began on
  2000-08-27 for that year's Olympic Games; it ended on the first Sunday
  in April in 2006 and from 2008 on, and has begun on the first Sunday in
  October since 2008.
- Apia: daylight time from 2010-09-26 to 2021-04-04, and the move across the
  date line, when 2011-12-29 24:00 at -10:00 became 2011-12-31 00:00 at +14:00
  (2011-12-30 never happened).

`test/core/calendar/resolve.test.js` builds its oracle from these rows alone:
the offset in force at an instant is the last change at or before it, so a
local time is classified without asking any provider.

To refresh for a later release: run the `zdump` command above for each zone,
transcribe the pairs whose change lies in 2000 to 2040, and update the release
named here. A row that disagrees with the host's ICU is a finding to report,
not a row to edit.
