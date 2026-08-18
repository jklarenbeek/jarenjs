# @jarenjs/core

The zero-dependency foundation of [Jaren](https://github.com/jklarenbeek/jarenjs). Everything the rest of the suite is built on lives here — type guards, Unicode-aware string handling, a large text-validation toolbox, number range helpers, fixed-point and vector math, the calendar kernel, the spatial kernel, the message-catalog compiler, unit/currency conversion and a finance library.

None of it depends on JSON Schema: every module can be used standalone in any JavaScript project.

## Modules

| Import | Contents |
|---|---|
| `@jarenjs/core` | type guards and getters (`isStringType`, `isObjectClass`, `getIntegerType`, ...) |
| `@jarenjs/core/array` | array helpers (`isUniqueArray`, `getUniqueArray`, `includesAll`, ...) |
| `@jarenjs/core/object` | deep equality (`equalsDeep`, JSON-only `equalsJson`), the `isJsonObject` and deep `isJsonValue` predicates, `__proto__`-safe `setObjectMember`, `deepFreeze`, map/set merging |
| `@jarenjs/core/string` | Unicode string helpers (`countCodePoints`, `compareCodePoints`, ...), cached regex compilation, the suite's one content hash (`fnv1a` and the `hashContent` fingerprint over it) and `kebabCase` |
| `@jarenjs/core/cache` | the bounded LRU (`createBoundedCache`), the reference-keyed `createWeakCache`, and `createSemanticCache` — keyed by what a value IS, for caches whose entries decide a result |
| `@jarenjs/core/chunk` | cutting a value down to size: `sizeOf` (the suite's one size rule — a string is its length, anything else its JSON), `excerpt`, `truncate`, and `chunkText` by size, line or separator with offsets that locate a piece in its source |
| `@jarenjs/core/scan` | char-code constants and predicates for recursive-descent parsers |
| `@jarenjs/core/message` | the message template/catalog compiler shared by the validator and the form layer |
| `@jarenjs/core/color` | pure color math (`lerpColor` — hex `#rrggbb` interpolation) |
| `@jarenjs/core/number` | boolean/number/integer coercion helpers (`isIntishType`, ...) |
| `@jarenjs/core/integer` | `int8` ... `uint64` ranges and validators |
| `@jarenjs/core/float` | `float16` ... `float64` constants, validators, increment/decrement |
| `@jarenjs/core/bigint` | bigint helpers (`BigInt_min`, `BigInt_MinMax`, ...) |
| `@jarenjs/core/dates` | RFC 3339 / ISO 8601 validation, plus the calendar kernel: integer date arithmetic, compiled formatting, durations |
| `@jarenjs/core/geo` | the spatial kernel over GeoJSON: robust orientation, great-circle measurement, rings, bounding boxes, geohash, GeoJSON/WKT validity, a packed-Hilbert box index, Web Mercator and Douglas-Peucker simplification |
| `@jarenjs/core/text` | text validators: emails, hostnames, IPs, URIs/IRIs, UUIDs, punycode, ... |
| `@jarenjs/core/math` | int32/float64 math and 2D/3D vector classes; the linear `remap` and unit-interval `clamp01` |
| `@jarenjs/core/finance` | zero-dependency finance/trading formulas: TVM, cash flow, amortization, interest, depreciation, bonds, technical indicators, returns/risk |
| `@jarenjs/core/convert` | pure deterministic quantity conversion: affine dimensional units and rate-table currency |

Deep imports work too (`@jarenjs/core/text/email`, `@jarenjs/core/math/vec2f64`, `@jarenjs/core/finance/tvm`, ...).

## Strings and Unicode

`@jarenjs/core/string` counts string length the way JSON Schema expects — by grapheme cluster, not UTF-16 code units — without paying for `Intl.Segmenter` unless the string actually needs it:

```javascript
import { getStringLength, isAsciiString, createRegExp } from '@jarenjs/core/string';

getStringLength('hello', true);       // 5  (ASCII fast path: str.length)
getStringLength('héllo', true);       // 5  (surrogate-aware code point count)
getStringLength('👨‍👩‍👧‍👦', true); // 1  (grapheme segmentation, only when clusters can form)
getStringLength('👨‍👩‍👧‍👦');       // 11 (default: plain UTF-16 length)

createRegExp('^\\p{L}+$');            // cached, unicode-flagged RegExp
```

## Text validation

`@jarenjs/core/text` is a validation toolbox that backs the [`@jarenjs/formats`](../formats) package but stands on its own — every function takes a string and returns a boolean, with cheap common-case fast paths before comprehensive parsing:

```javascript
import { isValidEmail, isValidIdnHostname, isValidIPv6, isValidUriTemplate } from '@jarenjs/core/text';

isValidEmail('"joe bloggs"@example.com'); // true (RFC 5321, quoted-string form)
isValidIdnHostname('실례.테스트');          // true (IDNA contextual rules included)
isValidIPv6('::ffff:192.168.0.1');        // true
isValidUriTemplate('/users{/id}{?q}');    // true (RFC 6570)
```

Grouped by file: `email` (RFC 5321 + internationalized addresses), `host` (hostnames, IDN hostnames, IPv4/IPv6, MAC, URI/URL/IRI and references, URI templates), `identifiers` (UUID, GUID, C/HTML/CSS identifiers), `iregexp` (I-Regexp / RFC 9485 validation and translation to `RegExp`: `isValidIRegexp`, `compileIRegexp`), `base64`, `basic` (alpha, numeric, hex, web colors), `misc` (ISBN-10/13, ISO 3166 country codes, ISO 13616 IBAN including its MOD 97-10 check digits), `i18n` (Unicode script tests and IDNA context checks) and `punycode` (the RFC 3492 codec, `punycodeEncode`/`punycodeDecode`, plus the domain-level `domainToASCII`/`domainToUnicode`).

`host` answers `uri`, `uri-reference`, `iri` and `iri-reference` from one character-code scanner: RFC 3987 is RFC 3986 with the unreserved class widened by `ucschar` and `iprivate` admitted in the query, so both grammars are the same walk with one flag. That is what makes every URI an IRI by construction rather than by coincidence.

## Dates, numbers and math

- `dates` — RFC 3339 date/time/date-time validation and parsing (leap years and month lengths included), the more lenient ISO date-time forms, and the suite's calendar kernel: proleptic Gregorian arithmetic over integer day numbers (`addToParts`, `startOfParts`, `endOfParts` — month math clamps, so 31 Jan plus a month is 28 Feb), ISO 8601 duration decomposition, and `compileDateFormat`, which turns an LDML pattern into a formatter once instead of re-scanning it per call. Dates stay JSON: an RFC 3339 string or epoch milliseconds, never a wrapper object. Locale names live in `@jarenjs/locales`, so a pattern needing `MMMM` takes a names provider. The full module reference is [docs/DATES.md](./docs/DATES.md).
- `integer`/`float`/`bigint` — range constants and validators for every fixed-width type from `int8` to `uint64` and `float16` to `float64`, including float increment/decrement in representable steps.
- `math` — asm.js-style typed math (`Int32`, `Float64`) and vector classes (`Vec2i32`, `Vec2f64`, `Vec3f64`) with a fast integer sine approximation; reference in [docs/MATH.md](./docs/MATH.md).

## Geospatial

`@jarenjs/core/geo` is the suite's spatial kernel, and its representation is GeoJSON itself ([RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946)) rather than a geometry class: positions are `[longitude, latitude]` arrays, a `Polygon`'s `coordinates` *is* an array of rings, so every value stays a plain JSON item — patchable, schema-checkable, addressable by pointer and path. RFC 7946 fixes the coordinate system to WGS 84, so there is no SRID table and no reprojection *in*; the one projection that exists goes *out*, for drawing.

```javascript
import {
  orient2d, haversineDistance, ringWinding, bboxOf,
  geohashEncode, isValidWkt, createBboxIndex,
} from '@jarenjs/core/geo';

orient2d(0, 0, 1, 0, 0, 1);                    // > 0 — counter-clockwise, exactly
haversineDistance(4.9041, 52.3676, 2.3522, 48.8566); // 429_862 m (Amsterdam–Paris)
ringWinding([[0,0],[1,0],[1,1],[0,1],[0,0]]);  // 1 — an RFC 7946 exterior ring
bboxOf({ type: 'Polygon', coordinates: [[[4,52],[5,52],[5,53],[4,52]]] }); // [4, 52, 5, 53]
geohashEncode(4.9041, 52.3676, 5);             // 'u173z' — a string, so a prefix test is proximity
isValidWkt('POINT (4.9041 52.3676)');          // true — strict ISO 19125 grammar

const index = createBboxIndex(regions.map(bboxOf));       // packed-Hilbert, build once
for (const i of index.search(...bboxOf(point))) confirm(regions[i]); // candidates, then the exact test
```

Three design decisions carry the module:

- **Orientation is computed exactly** (Shewchuk's adaptive predicates): a naive floating-point determinant returns the *wrong sign* on near-collinear input, which makes containment contradict itself. Every ring winding and point-in-polygon answer rests on this sign, and the deliberate cost is on the [benchmark page](https://jklarenbeek.github.io/jarenjs/#/benchmarks?suite=geo).
- **Measurement is spherical, drawing is projected, and the two never mix.** A Euclidean norm on raw degrees is 64% wrong over 1 km at Dutch latitudes, so `haversineDistance`/`sphericalRingArea` work on the sphere (`equirectDistance` is the cheap screening form for rejecting candidates first), while `projectMercator`/`fitMercator` and `simplifyLine`/`simplifyRing` exist for renderers — never measure on a projected coordinate.
- **Validity is a separate concern from traversal.** `eachPosition`, `bboxOf`, `centroidOf` and friends measure without judging; `isValidGeoJson` (structure plus the ring closure a JSON Schema provably cannot express), `isValidWkt` and `isValidGeohash` are the one-call judgments that back the `geoFormats` group in [`@jarenjs/formats`](../formats), next to the full GeoJSON meta-schema artifacts in [`@jarenjs/json`](../json).

The spatial query operators (`$distance`, `$within`, `$geohash`, spatial joins over the box index) live in the query engine in [`@jarenjs/json`](../json); the streaming map chart that draws a FeatureCollection with bounded memory lives in [`@jarenjs/charts`](../../components/charts). The full module reference is [docs/GEO.md](./docs/GEO.md).

## Messages

`@jarenjs/core/message` is the template/catalog compiler behind the validator's uniform error messages and the form layer's labels — msgid plus parameters in, rendered text out, so every message is translatable by swapping a catalog ([`@jarenjs/locales`](../locales) ships eleven language packs over it):

```javascript
import { compileMessageTemplate, compileMessageCatalog } from '@jarenjs/core/message';

const t = compileMessageTemplate('must be {comparison} {limit}');
t({ comparison: '>=', limit: 18 });   // 'must be >= 18'
```

## Units, currency and finance

- `convert` — pure, deterministic quantity conversion over a registry of affine dimensional units (`convert(1, 'nmi', 'km')` → `1.852`; dimensions include length, area, volume, mass, temperature, time, speed, pressure, energy, angle and more, with `unitsOf`/`dimensionOf` for discovery). Currency is rate-table based: rates come in as data, never from a network call inside this package. Reference in [docs/CONVERT.md](./docs/CONVERT.md).
- `finance` — zero-dependency finance and trading formulas grouped by file: `tvm` (`pmt(0.05/12, 360, 250000)` → `-1342.05`, plus `fv`/`pv`/`nper`/`rate`), `cashflow` (NPV/IRR), `amortization`, `interest`, `depreciation`, `bond`, `returns` (returns and risk measures) and `indicators` (SMA/EMA/WMA, MACD, RSI, Bollinger bands — windowed values pad with `null` until the window fills, so outputs align with inputs). Reference in [docs/FINANCE.md](./docs/FINANCE.md).

## JSON addressing standards

The JSON addressing and query standards — JSON validation helpers, JSON Pointer (RFC 6901), the compiling JSONPath engine (RFC 9535), and the Jaren JSON Query language with its XQuery front-end — live in [`@jarenjs/json`](../json). This package supplies their foundations: the char-code scanner (`@jarenjs/core/scan`), `equalsJson` deep equality, code-point ordering, and the I-Regexp (RFC 9485) toolbox.

## Development

Unit tests live in `test/core/` at the repository root (`npm run test:core`). This package's internals are described in its own [ARCHITECTURE](./ARCHITECTURE.md) document, with per-module references under [docs/](./docs/) (`MATH`, `CONVERT`, `FINANCE`, `DATES`, `GEO`); see the repository [README](../../README.md) and [ARCHITECTURE](../../docs/ARCHITECTURE.md) for the monorepo picture, and the [ROADMAP](../../docs/ROADMAP.md) for planned work.
