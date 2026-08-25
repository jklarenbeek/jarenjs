# `@jarenjs/core/geo`

The spatial kernel. **There is no geometry type**: the representation is
GeoJSON ([RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946)) —
positions are `[longitude, latitude]` arrays, a `Polygon`'s `coordinates`
IS an array of rings — so every value stays a plain JSON item: patchable,
schema-checkable, addressable by pointer and path. RFC 7946 fixes the
coordinate system to WGS 84 and removed CRS support, so there is no SRID
table and no reprojection *in*; the one projection goes *out*, for
drawing. Import the barrel (`@jarenjs/core/geo`) or a single module.

The rule that keeps the module honest: **never measure on a projected
coordinate.** Measurement is spherical; Mercator exists for renderers.

## Robust orientation — `predicates.js`

`orient2d(ax, ay, bx, by, cx, cy)` — which side of the line a→b point c
lies on, with an **exactly correct sign** (Shewchuk's adaptive-precision
arithmetic; a cheap filter first, the exact path only when the
determinant is too close to zero to trust). A naive determinant returns
the *wrong sign* on near-collinear input, which makes containment
contradict itself. `orient2dFast` is the naive form, exported for
callers that provably do not care. Every winding and containment answer
in this module rests on this sign; its cost is the deliberate
point-in-polygon loss on the benchmark page (<!--bm:geo.pip2000-->0.5×<!--/bm--> against
Turf at 2000 vertices, kept on purpose). Every loss the kernel carries is
published in [ARCHITECTURE](../ARCHITECTURE.md), derived from the committed
measurement: <!--bm:geo.losses-->three rows lose to a rival: point in polygon (2000-vertex) at 0.5× (turf), bounding box (2000-vertex) at 0.9× (turf), index build (100k boxes) at 0.8× (flatbush)<!--/bm-->.

## Distance — `distance.js`

Spherical, on the IUGG mean radius (`EARTH_RADIUS` = 6 371 008.8 m). A
Euclidean norm on raw degrees is 64% wrong over 1 km at 52°N, so the
planar shortcut does not exist here. `haversineDistance` (<0.5%
anywhere) is the answer; `equirectDistance` (0.02% at 430 km, 12.4%
intercontinentally, a few multiply-adds) is the *screening* form for
rejecting candidates before the real test. Also `initialBearing`,
`destinationPoint`, `lineLength(positions)`. The ellipsoid is
deliberately not modelled.

`circleBounds(lon, lat, metres)` answers the `[west, south, east,
north]` box a "nearer than r" test can be seeked with — the shape a
range index needs before the exact distance runs. Its longitude bounds
are **not** the circle's due-east and due-west points: the circle
reaches its extreme meridians where it runs tangent to them, which is
`asin(sin δ / cos φ)` from the centre and 0.4 % further than a 90°
bearing travels at 80°N over 100 km. A box built from four bearings is
too small, and a pre-filter that is too small drops matching rows
silently. It answers `null` when the circle reaches a pole (there is no
longitude bound to give), and it does not wrap west/east into
`[-180, 180]` — a circle spanning the antimeridian answers a west below
-180, which is how a caller detects the case RFC 7946 asks producers to
cut.

## Rings — `ring.js`

`isRingClosed`, `ringSignedArea` (shoelace over `orient2d` terms —
the *sign* is the point), `ringWinding` (1 = counter-clockwise, the
RFC 7946 exterior convention), `sphericalRingArea` (m², spherical
excess), `pointInRing` / `pointInPolygon` (even-odd rule, boundary
counts as inside, exact predicate per crossing).

## Boxes — `bbox.js` + `index-tree.js`

`bboxOfPositions`, `bboxIntersects`, `bboxContains`, `bboxUnion` —
`[west, south, east, north]` arrays, writable straight into a
document's `bbox` member. `createBboxIndex(boxes)` packs a **static**
Hilbert R-tree into flat typed arrays (no per-node objects; the Hilbert
distance is the bit-parallel transform): `search()` returns *candidate*
indexes — box overlap is necessary, never sufficient, so a caller
confirms each candidate with the exact test. Null entries index as
never-matching, keeping positions aligned with the caller's array.
Build and probe are level with Flatbush (`npm run benchmark:geo`; the
table lives in [ARCHITECTURE](../ARCHITECTURE.md)).

**A box is refused rather than made too small.** `bboxOfPositions` and
`bboxOf` answer `null` for an empty input *and* whenever any position
they are asked to bound has a non-finite coordinate — they never skip
the position and bound the rest. A narrowing loop would drop it
silently (every comparison against `NaN` is false) and return a finite,
plausible box that does not contain its input, and a candidate filter
built on such a box loses matching entries with nothing to show for it.
`null` is the answer every caller already handles.

**Boxes do not cross the antimeridian.** RFC 7946 §3.1.9 tells producers
to cut a geometry at ±180° rather than let it span the line, and the
kernel follows that posture instead of re-joining what a producer split:
`bboxOf` of an uncut geometry with positions either side of the line
returns a box spanning the globe the *wrong* way (`[-179, 0, 179, 0]` for
two points four degrees apart), and `circleBounds` answers a west below
−180 rather than wrapping, which is how a caller detects the case. Cut
the geometry as the RFC asks and every box, containment test and index
probe is right; there is no flag, because a box that meant "the short way
round" for some values and "the long way" for others would be worse than
one rule.

**Traversal is not validation.** `containsPosition`, `geometryArea` and
the rest walk whatever rings they are given and treat a ring as closed
whether or not its last position repeats its first — the same reading
every implementation makes. A ring `isValidGeoJson` refuses (unclosed,
too short) therefore still measures; judgment is one call away and is not
duplicated inside every walk.

## GeoJSON traversal — `geojson.js`

The one layer that reads the `type` discriminator; every function takes
a bare position, a geometry, a Feature or a collection. `eachPosition`,
`positionsOf`, `bboxOf`, `geometryOf`, `geometryArea` (exterior minus
holes), `geometryLength`, `centroidOf` (vertex mean, not center of
mass), `containsPosition`, `geoDistance` (between representative
positions), `ringsClosed`. Nothing here validates — malformed input
yields null or 0 — because judgment lives one module over.

## Validity — `valid.js`, `geohash.js`

The one-call judgments backing the `geoFormats` group in
`@jarenjs/formats`:

- `isValidGeoJson(value)` — structure per type, positions of 2–3
  numbers inside WGS 84 bounds, and **every ring closed** — the
  invariant a JSON Schema provably cannot express. The shallow twin of
  the meta-schema artifacts in `@jarenjs/json`, which locate failures
  and (via `$query`) also check winding.
- `isValidGeohash(hash)` — non-empty, lowercase base-32 alphabet.

## Well-Known Text — `wkt.js`

The round trip with the text encoding every spatial database emits.
`wktToGeoJson(text)` returns a geometry or `null`; `geoJsonToWkt(value,
options?)` returns a string or `null`; `isValidWkt(text)` answers
yes-or-no. **All three are one grammar walk**: each scan function takes
a sink that is absent for the predicate and present for the parser, so
the format tester allocates nothing and the two entry points cannot
drift. A committed corpus asserts `isValidWkt(s) === (wktToGeoJson(s)
!== null)` for every entry, malformed half included — a divergence is a
failing test.

The grammar is strict ISO 19125: the seven tags and no others,
`Z`/`M`/`ZM` modifiers (unmodified accepts 2 or 3 coordinates, as
PostGIS does), coordinate counts consistent with the modifier and with
the geometry's first point, rings of four or more positions that close,
`EMPTY`, and no text before or after.

Four rules decide what a lenient converter loses:

- **`EMPTY` is an empty coordinate array**, not `null`: `POINT EMPTY` →
  `{ type: 'Point', coordinates: [] }`. Unparseable and validly empty
  are different answers.
- **`Z` is kept and `M` is dropped.** RFC 7946 §3.1.1 defines a
  position's third element as altitude; a WKT measure is not one, so
  writing it there would be a lie. `POINT ZM (1 2 3 4)` → `[1, 2, 3]`,
  `POINT M (1 2 3)` → `[1, 2]`. The measure is discarded, and it is
  discarded on purpose.
- **The parser does not judge ranges.** `POINT (999 999)` parses;
  `isValidGeoJson` is the value gate, and duplicating it here would make
  the two entry points disagree.
- **A value that cannot be written is not written approximately.**
  `geoJsonToWkt` answers `null` for a non-finite coordinate, and writes
  numbers with the shortest round-tripping spelling (`String(n)`, what
  `JSON.stringify` uses) — never a fixed precision, which would silently
  move the point.

`geoJsonToWkt` accepts what the traversal layer accepts: a Feature
writes its geometry, a FeatureCollection a `GEOMETRYCOLLECTION` of its
features' geometries, a bare position a `POINT`. `options.dim` is 2 (the
default) or 3; at 3 a geometry whose every position carries a third
element gets a `Z` modifier, and anything else is written 2D with the
third elements dropped, because one WKT geometry carries one modifier
for all of its coordinates. The decision is made per tagged geometry, so
a `GEOMETRYCOLLECTION` may mix 2D and 3D members — invalid WKT is never
emitted.

**One direction round-trips and the other does not.**
`wktToGeoJson(geoJsonToWkt(g))` returns `g`, and that is asserted over
the whole corpus. `geoJsonToWkt(wktToGeoJson(s)) === s` is false in
general and is not claimed: whitespace, the `M` measure and number
spelling are all normalized.

## Geohash — `geohash.js`

`geohashEncode(lon, lat, precision)`, `geohashDecode`, `geohashBounds`,
`geohashCellSize`, `geohashNeighbours`. A geohash is a **string**, so it
needs no new vocabulary anywhere: bucketing is grouping on a substring,
tiling is a prefix, and a sorted index over the hash is a spatial index.
**A prefix is bucketing, not proximity.** Two points ten metres apart can
differ in the *first* character of their cell, so a single-prefix "near
here" misses a neighbour at every cell boundary; the proximity probe is
`geohashNeighbours` — the cell and its eight neighbours, in reading order
(north-west first, the cell itself in the middle, fewer past a pole) —
followed by the exact distance on what survives. Cells are not equal-area
(2.4× between the equatorial and polar bands), and a cell is never a
distance.

## Drawing — `mercator.js` + `simplify.js`

`projectMercator(lon, lat)` → unit square, y growing southward
(screen order); latitude clamps at `MERCATOR_MAX_LAT` (±85.051129°).
`unprojectMercator` inverts; `fitMercator(bbox, aspect)` fits a
geographic box into the unit square **without distorting aspect** (the
spare room becomes margin — stretching is how maps look wrong).
`simplifyLine` / `simplifyRing` are iterative Douglas-Peucker;
endpoints always survive so a ring stays closed, and a ring that would
drop below four positions is returned unsimplified rather than
degenerate.

## Not here

The thirteen spatial *query operators* — the eight measurements and
predicates (`$bbox`, `$area`, `$length`, `$centroid`, `$distance`,
`$within`, `$bbox-intersects`, `$geohash`) and the five conversions
(`$geo-parse`, `$geo-text`, `$geohash-bounds`, `$geohash-neighbours`,
`$geo-simplify`), plus index-screened spatial joins — live in the query
engine of `@jarenjs/json` (QUERY-FORMAT §8.14), and `@jarenjs/linq`
spells every one of them; the GeoJSON meta-schema artifacts live in
`@jarenjs/json/schemas`; derived spatial index columns and the two-stage
pushdown live in `@jarenjs/db`; the map chart and its bounded-memory
streaming accumulator live in `@jarenjs/charts`. Overlay operations
(union/intersection/difference/buffer) are deliberately absent — see the
ROADMAP.
