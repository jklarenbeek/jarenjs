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
point-in-polygon loss on the benchmark page.

## Distance — `distance.js`

Spherical, on the IUGG mean radius (`EARTH_RADIUS` = 6 371 008.8 m). A
Euclidean norm on raw degrees is 64% wrong over 1 km at 52°N, so the
planar shortcut does not exist here. `haversineDistance` (<0.5%
anywhere) is the answer; `equirectDistance` (0.02% at 430 km, 12.4%
intercontinentally, a few multiply-adds) is the *screening* form for
rejecting candidates before the real test. Also `initialBearing`,
`destinationPoint`, `lineLength(positions)`. The ellipsoid is
deliberately not modelled.

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

## GeoJSON traversal — `geojson.js`

The one layer that reads the `type` discriminator; every function takes
a bare position, a geometry, a Feature or a collection. `eachPosition`,
`positionsOf`, `bboxOf`, `geometryOf`, `geometryArea` (exterior minus
holes), `geometryLength`, `centroidOf` (vertex mean, not center of
mass), `containsPosition`, `geoDistance` (between representative
positions), `ringsClosed`. Nothing here validates — malformed input
yields null or 0 — because judgment lives one module over.

## Validity — `valid.js`, `wkt.js`, `geohash.js`

The one-call judgments backing the `geoFormats` group in
`@jarenjs/formats`:

- `isValidGeoJson(value)` — structure per type, positions of 2–3
  numbers inside WGS 84 bounds, and **every ring closed** — the
  invariant a JSON Schema provably cannot express. The shallow twin of
  the meta-schema artifacts in `@jarenjs/json`, which locate failures
  and (via `$query`) also check winding.
- `isValidWkt(text)` — strict ISO 19125 grammar: seven tags, `Z`/`M`/
  `ZM` modifiers (unmodified accepts 2 or 3 coordinates, as PostGIS
  does), consistent counts, closed rings, `EMPTY`, no surrounding text.
- `isValidGeohash(hash)` — non-empty, lowercase base-32 alphabet.

## Geohash — `geohash.js`

`geohashEncode(lon, lat, precision)`, `geohashDecode`, `geohashBounds`,
`geohashCellSize`, `geohashNeighbours`. A geohash is a **string**, so it
needs no new vocabulary anywhere: proximity is a prefix test, bucketing
is grouping on a substring, and a sorted index over the hash is a
spatial index. Cells are not equal-area and neighbours can straddle a
cell edge — use `geohashNeighbours` for boundary-safe proximity, and
never as a distance.

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

Spatial *query operators* (`$distance`, `$within`, `$bbox-intersects`,
`$centroid`, `$geohash`, index-screened spatial joins) live in the
query engine of `@jarenjs/json` (QUERY-FORMAT §8.14); the GeoJSON
meta-schema artifacts live in `@jarenjs/json/schemas`; the map chart
and its bounded-memory streaming accumulator live in `@jarenjs/charts`.
Overlay operations (union/intersection/buffer) are deliberately absent
— see the ROADMAP.
