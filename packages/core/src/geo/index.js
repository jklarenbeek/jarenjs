//@ts-check

//#region @jarenjs/core/geo
// The suite's spatial kernel. There is no geometry type: the
// representation is GeoJSON (RFC 7946), whose positions are
// `[longitude, latitude]` arrays and whose rings are arrays of those —
// already JSON items, so they are patchable, schema-checkable and
// addressable by pointer and path. A wrapper class would break all four,
// the same way it does for dates.
//
// Everything here therefore takes plain numbers and plain arrays. A
// Polygon's `coordinates` IS an array of rings, so a function that takes
// a ring takes GeoJSON without needing to know the `type` discriminator;
// walking a tagged geometry belongs to the layer above.
//
//   angle.js       the degree↔radian factors the trigonometry shares
//   predicates.js  robust orientation — the sign every test rests on
//   distance.js    great-circle measurement over the WGS 84 sphere
//   ring.js        ring closure, winding, area and containment
//   bbox.js        bounding boxes: the cheap half of every spatial test
//   geohash.js     the string encoding that needs no new vocabulary
//   geojson.js     the one layer that knows the `type` discriminator
//   valid.js       the one-call structural judgment (rings must close)
//   wkt.js         a validity tester for the databases' text encoding
//   index-tree.js  a static packed-Hilbert box index for spatial joins
//   mercator.js    the projection out, for anything that draws a map
//   simplify.js    dropping the vertices that land on the same pixel
//
// RFC 7946 removed coordinate-reference-system support and mandates WGS
// 84 in decimal degrees, so there is deliberately no SRID table and no
// reprojection *in*: conformance removes the need rather than an
// omission hiding it. The one projection that does exist goes the other
// way — a sphere has to become a rectangle before anyone can look at it
// — and it comes with the rule that keeps the two apart: **never
// measure on a projected coordinate.** `geometryArea` and
// `haversineDistance` work on the sphere; `projectMercator` is for
// drawing, and a Mercator "area" is off by a factor of fourteen at
// Greenland.

export * from './predicates.js';
export * from './distance.js';
export * from './ring.js';
export * from './bbox.js';
export * from './geohash.js';
export * from './geojson.js';
export * from './valid.js';
export * from './wkt.js';
export * from './index-tree.js';
export * from './mercator.js';
export * from './simplify.js';

//#endregion
