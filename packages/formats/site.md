---
package: "@jarenjs/formats"
card:
  title: Format validators
  blurb: >-
    One canonical name → predicate registry for the string, numeric,
    date-time, addressing and geospatial formats, shared by the validator
    and the form model so the two can never drift.
engines:
  - key: formats
    suite: formats
    perf: >-
      every format both engines implement, checked for agreement before it
      is timed
---

All standard string formats plus many extras (iban, isbn10, mac, color…),
numeric formats (int8…uint64, float16…float64), the JSON addressing formats and
the geospatial formats (geohash, wkt, and geojson — which applies to objects
and enforces the ring closure a schema alone cannot) — one canonical name →
predicate registry shared by the validator and forms, so the two can never
drift.

```js
import { stringFormats, numberFormats, dateTimeFormats, geoFormats } from '@jarenjs/formats';
jaren.addFormats(stringFormats).addFormats(numberFormats).addFormats(dateTimeFormats).addFormats(geoFormats);
```
