---
package: "@jarenjs/core"
card:
  title: Core utilities
  blurb: >-
    The kernel every other package reaches for: type guards, grapheme-aware
    Unicode strings, a large text-validation toolbox, RFC 3339 date
    arithmetic on strings and epoch milliseconds, a GeoJSON-native spatial
    kernel with exact orientation predicates, and asm.js-style int32/float64
    math.
---

Everything underneath, usable standalone: type guards, grapheme-aware Unicode
strings, a large text-validation toolbox (emails, hostnames, IRIs, punycode,
I-Regexp), RFC 3339 date-time parsing, fixed-width numeric ranges, a char-code
scanner toolkit and asm.js-style int32/float64 math.

Two kernels are worth naming separately because the whole suite reaches for
them. `@jarenjs/core/dates` is calendar arithmetic on RFC 3339 strings and
epoch milliseconds — there is deliberately no date type, because a wrapper
class would stop a value being patchable, schema-checkable and
pointer-addressable — with LDML formatting, a locale-free civil-date core, and
clamping month math that makes add and diff inverses.

```js
import { addToParts, formatRFC3339Parts, compileDateFormat } from '@jarenjs/core/dates';
import { haversineDistance, geohashEncode, pointInPolygon } from '@jarenjs/core/geo';

haversineDistance(4.9041, 52.3676, 2.3522, 48.8566);  // 429861.98 m
geohashEncode(4.9041, 52.3676, 6);                    // 'u173zt'
```

`@jarenjs/core/geo` is the spatial kernel, and its representation is GeoJSON
itself (RFC 7946) rather than a geometry class — positions are [lon, lat]
arrays, a Polygon’s coordinates IS an array of rings. It carries Shewchuk
adaptive-precision orientation predicates (an exact sign, which is what
containment and winding actually rest on), great-circle distance and area on
the sphere, ring closure and winding, geohash, a Hilbert-packed static R-tree
behind the query engine’s spatial joins, and — for drawing only — Web Mercator
with Douglas-Peucker simplification. Never measure on a projected coordinate:
area and distance stay on the sphere, and the projection exists so a map chart
can be drawn.
