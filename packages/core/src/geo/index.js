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
//   predicates.js  robust orientation — the sign every test rests on
//   distance.js    great-circle measurement over the WGS 84 sphere
//   ring.js        ring closure, winding, area and containment
//   bbox.js        bounding boxes: the cheap half of every spatial test
//   geohash.js     the string encoding that needs no new vocabulary
//   geojson.js     the one layer that knows the `type` discriminator
//   index-tree.js  a static packed-Hilbert box index for spatial joins
//
// RFC 7946 removed coordinate-reference-system support and mandates WGS
// 84 in decimal degrees, so there is deliberately no SRID table and no
// reprojection here: conformance removes the need rather than an
// omission hiding it. A projection *out* (Web Mercator, for drawing) is
// a rendering concern and belongs with the renderer.

export * from './predicates.js';
export * from './distance.js';
export * from './ring.js';
export * from './bbox.js';
export * from './geohash.js';
export * from './geojson.js';
export * from './index-tree.js';

//#endregion
