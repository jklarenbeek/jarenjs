# @jarenjs/core

The zero-dependency foundation of [Jaren](https://github.com/jklarenbeek/jarenjs). Everything the rest of the suite is built on lives here — type guards, Unicode-aware string handling, a large text-validation toolbox, number range helpers, fixed-point and vector math, the calendar kernel, the spatial kernel, the vector kernel, the interval kernel, the message-catalog compiler, unit/currency conversion and a finance library.

None of it depends on JSON Schema: every module can be used standalone in any JavaScript project.

## Modules

| Import | Contents |
|---|---|
| `@jarenjs/core` | type guards and getters (`isStringType`, `isObjectClass`, `getIntegerType`, ...) |
| `@jarenjs/core/array` | array helpers (`isUniqueArray`, `getUniqueArray`, `includesAll`, ...) |
| `@jarenjs/core/object` | deep equality (`equalsDeep`, JSON-only `equalsJson`), the `isJsonObject` and deep `isJsonValue` predicates, `__proto__`-safe `setObjectMember`, `deepFreeze`, map/set merging |
| `@jarenjs/core/string` | Unicode string helpers (`countCodePoints`, `compareCodePoints`, ...), regex compilation and repeatable `createRegExpTester` predicates, the suite's one content hash (`fnv1a` and the `hashContent` fingerprint over it) and `kebabCase` |
| `@jarenjs/core/cache` | the bounded LRU with key deletion (`createBoundedCache`), the reference-keyed `createWeakCache`, and `createSemanticCache` — keyed by what a value IS, for caches whose entries decide a result |
| `@jarenjs/core/random` | the suite's one seeded generator (`mulberry32`, pinned sequence, ToUint32 seed) and the draws built on it: `randomInt` over a half-open range, in-place Fisher–Yates `shuffle`, and `drawDistinct` — `k` distinct indices from one stream |
| `@jarenjs/core/runtime` | the runtime record — `createRuntime({ now, uuid, random, zoneProvider })`, frozen, defaulting member for member to the platform's own (`Date.now`, `crypto.randomUUID`, `Math.random`, no zone provider) — that the store (its query deadlines included), the jobs engine, the migration runner, every contract binding and the contract memory ledger take as `runtime`, so a deterministic run is configured once; a subsystem's own explicit option wins over the record, and the record reaches hosts, never query compilation |
| `@jarenjs/core/stats` | descriptive statistics over a sample: `mean`, sample `variance`/`stddev`, the midpoint `median`, and `quantile(values, p, { method })` — `p` on 0..1 under a NAMED rule, `'nearest-rank'` or `'linear'`, because a default would decide silently; an empty sample answers `undefined`, never `0` |
| `@jarenjs/core/async` | `mapConcurrent(items, limit, worker, { signal })` — the bounded ordered asynchronous map: never more than `limit` workers in flight, results in input order, a rejection or an abort stops dispatch and drains the lanes before the map rejects, so nothing is still running when it settles; and `createAwaitedSink(sink)` — the suite's one write serializer: every `write` waits for the previous one to settle (a sink may answer a promise — a socket waiting for `drain`, a stream waiting for the consumer's pull), `end` waits for every write, `abort` rejects what is still queued at once, one failure stops everything behind it, and a synchronous sink stays on a no-promise fast path |
| `@jarenjs/core/chunk` | cutting a value down to size: `sizeOf` (the suite's one size rule — a string is its length, anything else its JSON), `excerpt`, `truncate`, and `chunkText` by size, line or separator with offsets that locate a piece in its source |
| `@jarenjs/core/scan` | char-code constants and predicates for recursive-descent parsers |
| `@jarenjs/core/message` | the message template/catalog compiler shared by the validator and the form layer |
| `@jarenjs/core/color` | pure color math (`lerpColor` — hex `#rrggbb` interpolation) |
| `@jarenjs/core/number` | boolean/number/integer coercion helpers (`isIntishType`, ...) and `isJsonNumberString`, the strict lexical JSON-number predicate shared by query casts and schema normalization; conversion and overflow policy stay with each caller |
| `@jarenjs/core/integer` | `int8` ... `uint64` ranges and validators |
| `@jarenjs/core/float` | `float16` ... `float64` constants, validators, increment/decrement |
| `@jarenjs/core/bigint` | bigint helpers (`BigInt_min`, `BigInt_MinMax`, ...) |
| `@jarenjs/core/dates` | RFC 3339 / ISO 8601 validation, plus the calendar kernel: integer date arithmetic, compiled formatting, durations |
| `@jarenjs/core/geo` | the spatial kernel over GeoJSON: robust orientation, great-circle measurement, rings, bounding boxes, geohash, GeoJSON/WKT validity, a packed-Hilbert box index, Web Mercator and Douglas-Peucker simplification |
| `@jarenjs/core/vector` | the vector kernel over plain arrays: dot, cosine and Euclidean similarity (higher-is-better; a malformed pair scores 0), l2 normalization, the packed little-endian Float32 form and the one shape guard (`isVector`) |
| `@jarenjs/core/series` | the temporal kernel over plain records: instant/sample/interval normalization with a stable sort, half-open `[start, end)` set algebra (overlap, merge, subtract, gaps, coverage, slot enumeration), a static interval index, and the series operations built on them — fixed and calendar buckets with five fill policies, time-width rolling aggregates, as-of joins and gap-aware downsampling, on an injected zone seam |
| `@jarenjs/core/text` | text validators: emails, hostnames, IPs, URIs/IRIs, UUIDs, punycode, ... |
| `@jarenjs/core/math` | int32/float64 math and 2D/3D vector classes; the linear `remap` and unit-interval `clamp01` |
| `@jarenjs/core/finance` | zero-dependency finance/trading formulas: TVM, cash flow, amortization, interest, depreciation, bonds, technical indicators, returns/risk |
| `@jarenjs/core/convert` | pure deterministic quantity conversion: affine dimensional units and rate-table currency |

Deep imports work too (`@jarenjs/core/text/email`, `@jarenjs/core/math/vec2f64`, `@jarenjs/core/finance/tvm`, ...).

## Strings and Unicode

`@jarenjs/core/string` counts string length the way JSON Schema expects — by grapheme cluster, not UTF-16 code units — without paying for `Intl.Segmenter` unless the string actually needs it:

```javascript
import { getStringLength, isAsciiString, createRegExp, createRegExpTester } from '@jarenjs/core/string';

getStringLength('hello', true);       // 5  (ASCII fast path: str.length)
getStringLength('héllo', true);       // 5  (surrogate-aware code point count)
getStringLength('👨‍👩‍👧‍👦', true); // 1  (grapheme segmentation, only when clusters can form)
getStringLength('👨‍👩‍👧‍👦');       // 11 (default: plain UTF-16 length)

createRegExp('^\\p{L}+$');            // unicode-flagged RegExp
const matches = createRegExpTester('/^x/gi');
matches('X'); matches('X');          // true both times; global/sticky state is isolated
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

- `dates` — RFC 3339 date/time/date-time validation and parsing (leap years and month lengths included), the more lenient ISO date-time forms, and the suite's calendar kernel: proleptic Gregorian arithmetic over integer day numbers (`addToParts`, `startOfParts`, `endOfParts` — month math clamps, so 31 Jan plus a month is 28 Feb, and an operation reading a half the value has not got is refused rather than guessed), ISO 8601 duration decomposition, the locale-free time-axis step ladder (`niceTimeStep`, `axisTicksTime`, and `timeTicksEvery` for a step the caller declares) a chart and a timeline both read, and the two-stage pattern compilers `compileDateFormat` and its strict inverse `compileDateParser`, which turn an LDML pattern into a formatter or a parser once instead of re-scanning it per call — the parser refuses trailing input, an impossible civil date, and the tokens that only format because they are derived from a date rather than fields of one. Dates stay JSON: an RFC 3339 string or epoch milliseconds, never a wrapper object. Locale names live in `@jarenjs/locales`, so a pattern needing `MMMM` takes a names provider. The full module reference is [docs/DATES.md](./docs/DATES.md); the interval algebra built on top of it is [`series`](#intervals-and-series).
- `integer`/`float`/`bigint` — range constants and validators for every fixed-width type from `int8` to `uint64` and `float16` to `float64`, including float increment/decrement in representable steps.
- `math` — asm.js-style typed math (`Int32`, `Float64`) and vector classes (`Vec2i32`, `Vec2f64`, `Vec3f64`) with a fast integer sine approximation; reference in [docs/MATH.md](./docs/MATH.md).

## Geospatial

`@jarenjs/core/geo` is the suite's spatial kernel, and its representation is GeoJSON itself ([RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946)) rather than a geometry class: positions are `[longitude, latitude]` arrays, a `Polygon`'s `coordinates` *is* an array of rings, so every value stays a plain JSON item — patchable, schema-checkable, addressable by pointer and path. RFC 7946 fixes the coordinate system to WGS 84, so there is no SRID table and no reprojection *in*; the one projection that exists goes *out*, for drawing.

```javascript
import {
  orient2d, haversineDistance, ringWinding, bboxOf,
  geohashEncode, wktToGeoJson, geoJsonToWkt, createBboxIndex,
} from '@jarenjs/core/geo';

orient2d(0, 0, 1, 0, 0, 1);                    // > 0 — counter-clockwise, exactly
haversineDistance(4.9041, 52.3676, 2.3522, 48.8566); // 429_862 m (Amsterdam–Paris)
ringWinding([[0,0],[1,0],[1,1],[0,1],[0,0]]);  // 1 — an RFC 7946 exterior ring
bboxOf({ type: 'Polygon', coordinates: [[[4,52],[5,52],[5,53],[4,52]]] }); // [4, 52, 5, 53]
geohashEncode(4.9041, 52.3676, 5);             // 'u173z' — a string identifying a cell; use distances for proximity

wktToGeoJson('POINT (4.9041 52.3676)');        // { type: 'Point', coordinates: [4.9041, 52.3676] }
geoJsonToWkt({ type: 'Point', coordinates: [4.9041, 52.3676] }); // 'POINT (4.9041 52.3676)'

const index = createBboxIndex(regions.map(bboxOf));       // packed-Hilbert, build once
for (const i of index.search(...bboxOf(point))) confirm(regions[i]); // candidates, then the exact test
```

Four design decisions carry the module:

- **Orientation is computed exactly** (Shewchuk's adaptive predicates): a naive floating-point determinant returns the *wrong sign* on near-collinear input, which makes containment contradict itself. Every ring winding and point-in-polygon answer rests on this sign, and the deliberate cost is on the [benchmark page](https://jklarenbeek.github.io/jarenjs/#/benchmarks?suite=geo).
- **Measurement is spherical, drawing is projected, and the two never mix.** A Euclidean norm on raw degrees is 64% wrong over 1 km at Dutch latitudes, so `haversineDistance`/`sphericalRingArea` work on the sphere (`equirectDistance` is the cheap screening form for rejecting candidates first), while `projectMercator`/`fitMercator` and `simplifyLine`/`simplifyRing` exist for renderers — never measure on a projected coordinate.
- **Validity is a separate concern from traversal, and a box is refused rather than made too small.** `eachPosition`, `bboxOf`, `centroidOf` and friends measure without judging (a ring is read as closed whether or not it is); a box over any non-finite coordinate is `null`, never a plausible box that misses its input; and boxes never cross the antimeridian — cut the geometry at ±180° as RFC 7946 §3.1.9 asks, and every containment test and index probe is right. `isValidGeoJson` (structure plus the ring closure a JSON Schema provably cannot express), `isValidWkt` and `isValidGeohash` are the one-call judgments that back the `geoFormats` group in [`@jarenjs/formats`](../formats), next to the full GeoJSON meta-schema artifacts in [`@jarenjs/json`](../json).
- **WKT is one grammar walk with two entry points.** `isValidWkt` and `wktToGeoJson` run the *same* scan, parameterized by a sink that is absent for the predicate and present for the parser — so the `wkt` format tester (which runs per value in the validator and per keystroke in the form layer) allocates nothing, and the two cannot drift apart. A committed corpus asserts `isValidWkt(s) === (wktToGeoJson(s) !== null)` for all 181 entries, malformed half included. `geoJsonToWkt` writes the string back, and `wktToGeoJson(geoJsonToWkt(g))` returns `g`; the text direction is *not* claimed, because whitespace, the `M` measure and number spelling are normalized. Against [`wellknown`](https://www.npmjs.com/package/wellknown) the parse is <!--fact:geo.wktParsePoint-->3.1×<!--/fact--> faster on a `POINT` and the yes-or-no answer <!--fact:geo.wktValidatePoint-->5.3×<!--/fact--> — and wellknown *validates less* while being slower, which is the honest framing; the table and every language difference are in [ARCHITECTURE](./ARCHITECTURE.md). The kernel's own losses are published there too, derived from the same run: <!--fact:geo.losses-->three rows lose to a rival: point in polygon (2000-vertex) at 0.5× (turf), bounding box (2000-vertex) at 0.9× (turf), index build (100k boxes) at 0.8× (flatbush)<!--/fact-->.

The spatial query operators (`$distance`, `$within`, `$geohash`, spatial joins over the box index) live in the query engine in [`@jarenjs/json`](../json); the streaming map chart that draws a FeatureCollection with bounded memory lives in [`@jarenjs/charts`](../../components/charts). The full module reference is [docs/GEO.md](./docs/GEO.md).

## Vectors

`@jarenjs/core/vector` is the suite's one home for n-dimensional vector arithmetic — the kernels an embedding is compared, normalized and stored with. As with GeoJSON positions, there is no vector type: a vector is a plain array of finite numbers, `number[]` straight out of JSON or a `Float32Array` straight out of a packed column, so it survives a ledger record, a document store and a wire reply unchanged.

```javascript
import { cosineSimilarity, l2Normalize, packVector, unpackVector, isVector } from '@jarenjs/core/vector';

cosineSimilarity([1, 0], [1, 1]);              // 0.7071… — higher is better, in [-1, 1]
cosineSimilarity([1, 0], [1, 0, 0]);           // 0 — a malformed pair scores 0, never throws
const bytes = packVector(l2Normalize([3, 4])); // Uint8Array of 8 bytes: little-endian binary32
unpackVector(bytes, 2);                        // Float32Array [0.6, 0.8]
isVector([0.1, NaN]);                          // false — the shape guard every consumer shares
```

Three rules, kept by every function so that no caller has to check them again:

- **Higher is better, in every metric.** Cosine answers in [-1, 1], the dot product is unbounded, Euclidean similarity is `1 / (1 + distance)` in (0, 1] — so one descending sort ranks any of them, and nobody remembers which way a metric sorts.
- **A malformed comparison scores 0 and never throws.** Mismatched lengths, an empty vector, a null or a non-finite component answer 0: one bad vector among ten thousand loses the comparison, it does not kill the sweep, and it never poisons a ranking with `NaN`.
- **Refuse, never fix.** `packVector` and `l2Normalize` answer `null` for anything `isVector` refuses, the way a bounding box refuses a position it cannot bound; nothing truncates, pads or zero-fills a vector into the shape it was supposed to have.

The packed form is `4·d` bytes of little-endian binary32 — the value a database column stores; components round to `Math.fround` and come back exactly. Unpacking aligned bytes on a little-endian host is a *view*, not a copy, which is what a sweep over ten thousand fetched rows is paid for by; misaligned bytes (a pooled `Buffer`, an odd offset into a record) and big-endian hosts take the copy path to the same values. The client that produces embeddings — and a deterministic reference embedder for tests — lives in [`@jarenjs/ai`](../ai/README.md#embeddings).

## Intervals and series

`@jarenjs/core/series` is the suite's temporal kernel: one meaning for an interval, one meaning for a sorted series of timestamped readings, the set algebra over them, and the five operations every consumer of a timeline otherwise rebuilds by hand — bucket, fill, roll, join as-of, downsample. As with dates, there is no type — an instant is epoch milliseconds or an RFC 3339 string, a sample is `{ at, value }`, an interval is `{ start, end }` — so every value stays a plain JSON item, and nothing here reads a clock.

```javascript
import { createIntervalIndex, mergeIntervals, gapsWithin, findSlots } from '@jarenjs/core/series';

const shifts = [
  { from: '2026-03-02T09:00:00Z', to: '2026-03-02T13:00:00Z', who: 'ada' },
  { from: '2026-03-02T13:00:00Z', to: '2026-03-02T17:00:00Z', who: 'grace' },
];
const index = createIntervalIndex(shifts, { start: 'from', end: 'to' });
index.at('2026-03-02T13:00:00Z');        // [grace] — half-open, so the handover belongs to one shift

const cover = shifts.map((s) => ({ start: s.from, end: s.to }));
mergeIntervals(cover);                    // one span, 09:00–17:00 — touching IS continuous cover
findSlots(cover, { duration: 'PT30M' });  // sixteen half-hour slots, one straddling the handover
```

```javascript
import { resampleSeries, rollingSeries, asOfJoin, downsampleSeries } from '@jarenjs/core/series';

resampleSeries(readings, { every: 'PT1H', aggregate: 'mean', fill: 'linear' });
resampleSeries(readings, { every: 'P1M', zone: 'Europe/Amsterdam', provider });
rollingSeries(readings, { width: 'PT5M', aggregate: 'max', minPeriods: 3 });
asOfJoin(trades, quotes, { direction: 'nearest', tolerance: 'PT1S', key: 'symbol' });
downsampleSeries(readings, { target: 2000 });   // → { points, sourceCount, renderedCount, method }
```

Seven decisions carry the module:

- **Half-open, everywhere.** `[start, end)` holds its start and not its end, so a day ends exactly where the next begins, a boundary instant belongs to exactly one of two touching intervals, and nothing is counted twice. Touching intervals therefore do *not* overlap — back-to-back bookings are not a double booking — while `mergeIntervals` joins them by default, because availability asks whether there is continuous cover. `{ adjacent: false }` is the other answer, spelled out rather than guessed.
- **A row is never dropped, and a duplicate is never merged away.** A member that cannot become a finite instant is a refusal naming the row, not a silently shorter result; an empty (`[t, t)`), reversed or non-finite interval is refused at the point it was written. The sort is stable, so two readings in the same millisecond keep their input order and both count.
- **Nothing reads a clock.** `gapsWithin` and `coverageOf` derive their window from the input's own hull when given none, because the only other default would be "now" — and an operation that read the clock could not be cached, reproduced or run in a test twice.
- **The index cuts on both ends, and cannot lose a long span.** Sorting by start alone is the bug: a conference week that began before an hourly meeting sits far to the left of that meeting's neighbourhood and still overlaps it. `createIntervalIndex` carries a prefix maximum end beside the starts — non-decreasing, so binary-searchable — and a query becomes two binary cuts and a walk between them, O(log n + k), returning the caller's own rows. It is static: bounds are copied at build time, so a query reads no source object and a row mutated afterwards changes nothing.

- **Bucketing is arithmetic; filling is a policy.** An average over an empty hour is not zero, and it is not yesterday's average, and it is not nothing — it is whichever of `omit | null | zero | locf | linear` the caller asked for, and the aggregate had no opinion. `count` reports source rows (duplicates and measured gaps included) beside every value, so `null` and "nobody reported" are distinguishable. Neither `locf` nor `linear` invents a value at the leading edge.
- **A rolling window is a duration, not a row count.** Sixty rows of a sensor reporting every second is a minute; sixty rows of a sensor that dropped half its readings is two minutes. The window is `(at − width, at]`, so two readings in the same millisecond share it and therefore share an answer. `sum`/`mean`/`count` carry a running total, `min`/`max` use a monotone deque, `first`/`last` are forward-only pointers — the complexity is structural, and the tests count the reads rather than the milliseconds.
- **Time zones are injected, never bundled.** UTC and fixed offsets work with no setup; a named zone takes the caller's own `provider`, because a bundled tzdb is megabytes that go stale on a government's timetable. A local time that never happened, or happened twice, is a refusal unless `disambiguation` says `earlier` or `later`. A sampler never bridges a gap, never moves an end, and refuses a target too small to hold both rather than drawing a prettier line.
- **A specification is closed.** Every kernel that takes one publishes the members it admits, and anything else is a refusal naming the near miss — because `minPeriod` for `minPeriods` quietly ignored is a window with no minimum and a plausible number to show for it, and `timezone` for `zone` is precisely the silent fall back to UTC the injected clock exists to prevent. The query language reads the same lists, minus the `provider`, which is a pair of functions and therefore not something a document can carry.

The kernel is measured against one-pass loops written for one question and against the query vocabulary a consumer had instead, and both ratios are published: it costs about twice a hand-written loop and answers about a hundred times faster than the generic route. Named time zones' data, recurrence grammars and scheduling solvers are deliberately outside it. The full module reference is [docs/SERIES.md](./docs/SERIES.md).

## Messages

`@jarenjs/core/message` is the template/catalog compiler behind the validator's uniform error messages and the form layer's labels — msgid plus parameters in, rendered text out, so every message is translatable by swapping a catalog ([`@jarenjs/locales`](../locales) ships eleven language packs over it):

```javascript
import { compileMessageTemplate, compileMessageCatalog } from '@jarenjs/core/message';

const t = compileMessageTemplate('must be {comparison} {limit}');
// t.parameters is the frozen unique list ['comparison', 'limit'] from this parser.
t({ comparison: '>=', limit: 18 });   // 'must be >= 18'
```

## Units, currency and finance

- `convert` — pure, deterministic quantity conversion over a registry of affine dimensional units (`convert(1, 'nmi', 'km')` → `1.852`; dimensions include length, area, volume, mass, temperature, time, speed, pressure, energy, angle and more, with `unitsOf`/`dimensionOf` for discovery). Currency is rate-table based: rates come in as data, never from a network call inside this package. Reference in [docs/CONVERT.md](./docs/CONVERT.md).
- `finance` — zero-dependency finance and trading formulas grouped by file: `tvm` (`pmt(0.05/12, 360, 250000)` → `-1342.05`, plus `fv`/`pv`/`nper`/`rate`), `cashflow` (NPV/IRR), `amortization`, `interest`, `depreciation`, `bond`, `returns` (returns and risk measures) and `indicators` (SMA/EMA/WMA, MACD, RSI, Bollinger bands — windowed values pad with `null` until the window fills, so outputs align with inputs). Reference in [docs/FINANCE.md](./docs/FINANCE.md).

## JSON addressing standards

The JSON addressing and query standards — JSON validation helpers, JSON Pointer (RFC 6901), the compiling JSONPath engine (RFC 9535), and the Jaren JSON Query language with its XQuery front-end — live in [`@jarenjs/json`](../json). This package supplies their foundations: the char-code scanner (`@jarenjs/core/scan`), `equalsJson` deep equality, code-point ordering, and the I-Regexp (RFC 9485) toolbox.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.core-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/core` | JavaScript | declared |
| `@jarenjs/core/array` | JavaScript | declared |
| `@jarenjs/core/async` | JavaScript | declared |
| `@jarenjs/core/bigint` | JavaScript | declared |
| `@jarenjs/core/cache` | JavaScript | declared |
| `@jarenjs/core/chunk` | JavaScript | declared |
| `@jarenjs/core/color` | JavaScript | declared |
| `@jarenjs/core/dates` | JavaScript | declared |
| `@jarenjs/core/errors` | JavaScript | declared |
| `@jarenjs/core/dates/civil` | JavaScript | declared |
| `@jarenjs/core/dates/duration` | JavaScript | declared |
| `@jarenjs/core/dates/format` | JavaScript | declared |
| `@jarenjs/core/dates/index` | JavaScript | declared |
| `@jarenjs/core/dates/parse` | JavaScript | declared |
| `@jarenjs/core/dates/rfc3339` | JavaScript | declared |
| `@jarenjs/core/dates/ticks` | JavaScript | declared |
| `@jarenjs/core/float` | JavaScript | declared |
| `@jarenjs/core/geo` | JavaScript | declared |
| `@jarenjs/core/geo/angle` | JavaScript | declared |
| `@jarenjs/core/geo/bbox` | JavaScript | declared |
| `@jarenjs/core/geo/distance` | JavaScript | declared |
| `@jarenjs/core/geo/geohash` | JavaScript | declared |
| `@jarenjs/core/geo/geojson` | JavaScript | declared |
| `@jarenjs/core/geo/index` | JavaScript | declared |
| `@jarenjs/core/geo/index-tree` | JavaScript | declared |
| `@jarenjs/core/geo/mercator` | JavaScript | declared |
| `@jarenjs/core/geo/predicates` | JavaScript | declared |
| `@jarenjs/core/geo/ring` | JavaScript | declared |
| `@jarenjs/core/geo/simplify` | JavaScript | declared |
| `@jarenjs/core/geo/valid` | JavaScript | declared |
| `@jarenjs/core/geo/wkt` | JavaScript | declared |
| `@jarenjs/core/vector` | JavaScript | declared |
| `@jarenjs/core/function` | JavaScript | declared |
| `@jarenjs/core/integer` | JavaScript | declared |
| `@jarenjs/core/message` | JavaScript | declared |
| `@jarenjs/core/number` | JavaScript | declared |
| `@jarenjs/core/object` | JavaScript | declared |
| `@jarenjs/core/random` | JavaScript | declared |
| `@jarenjs/core/runtime` | JavaScript | declared |
| `@jarenjs/core/scan` | JavaScript | declared |
| `@jarenjs/core/schema` | JavaScript | declared |
| `@jarenjs/core/series` | JavaScript | declared |
| `@jarenjs/core/series/asof` | JavaScript | declared |
| `@jarenjs/core/series/bucket` | JavaScript | declared |
| `@jarenjs/core/series/downsample` | JavaScript | declared |
| `@jarenjs/core/series/index` | JavaScript | declared |
| `@jarenjs/core/series/interval` | JavaScript | declared |
| `@jarenjs/core/series/interval-index` | JavaScript | declared |
| `@jarenjs/core/series/normalize` | JavaScript | declared |
| `@jarenjs/core/series/rolling` | JavaScript | declared |
| `@jarenjs/core/series/selector` | JavaScript | declared |
| `@jarenjs/core/series/zone` | JavaScript | declared |
| `@jarenjs/core/stats` | JavaScript | declared |
| `@jarenjs/core/string` | JavaScript | declared |
| `@jarenjs/core/text` | JavaScript | declared |
| `@jarenjs/core/text/base64` | JavaScript | declared |
| `@jarenjs/core/text/basic` | JavaScript | declared |
| `@jarenjs/core/text/email` | JavaScript | declared |
| `@jarenjs/core/text/host` | JavaScript | declared |
| `@jarenjs/core/text/i18n` | JavaScript | declared |
| `@jarenjs/core/text/identifiers` | JavaScript | declared |
| `@jarenjs/core/text/index` | JavaScript | declared |
| `@jarenjs/core/text/iregexp` | JavaScript | declared |
| `@jarenjs/core/text/misc` | JavaScript | declared |
| `@jarenjs/core/text/punycode` | JavaScript | declared |
| `@jarenjs/core/text/sse` | JavaScript | declared |
| `@jarenjs/core/math` | JavaScript | declared |
| `@jarenjs/core/math/float64` | JavaScript | declared |
| `@jarenjs/core/math/format` | JavaScript | declared |
| `@jarenjs/core/math/index` | JavaScript | declared |
| `@jarenjs/core/math/int32` | JavaScript | declared |
| `@jarenjs/core/math/mat4` | JavaScript | declared |
| `@jarenjs/core/math/project` | JavaScript | declared |
| `@jarenjs/core/math/solve` | JavaScript | declared |
| `@jarenjs/core/math/vec2f64` | JavaScript | declared |
| `@jarenjs/core/math/vec2i32` | JavaScript | declared |
| `@jarenjs/core/math/vec3f64` | JavaScript | declared |
| `@jarenjs/core/math/word` | JavaScript | declared |
| `@jarenjs/core/finance` | JavaScript | declared |
| `@jarenjs/core/finance/amortization` | JavaScript | declared |
| `@jarenjs/core/finance/bond` | JavaScript | declared |
| `@jarenjs/core/finance/cashflow` | JavaScript | declared |
| `@jarenjs/core/finance/depreciation` | JavaScript | declared |
| `@jarenjs/core/finance/index` | JavaScript | declared |
| `@jarenjs/core/finance/indicators` | JavaScript | declared |
| `@jarenjs/core/finance/interest` | JavaScript | declared |
| `@jarenjs/core/finance/returns` | JavaScript | declared |
| `@jarenjs/core/finance/tvm` | JavaScript | declared |
| `@jarenjs/core/convert` | JavaScript | declared |
| `@jarenjs/core/convert/convert` | JavaScript | declared |
| `@jarenjs/core/convert/currency` | JavaScript | declared |
| `@jarenjs/core/convert/index` | JavaScript | declared |
| `@jarenjs/core/convert/registry` | JavaScript | declared |
| `@jarenjs/core/package.json` | metadata | — |
| `@jarenjs/core/virtual` | JavaScript | declared |
<!--/fact-->

## Development

Unit tests live in `test/core/` at the repository root (`npm run test:core`). This package's internals are described in its own [ARCHITECTURE](./ARCHITECTURE.md) document, with per-module references under [docs/](./docs/) (`MATH`, `CONVERT`, `FINANCE`, `DATES`, `GEO`); see the repository [README](../../README.md) and [ARCHITECTURE](../../docs/ARCHITECTURE.md) for the monorepo picture, and the [ROADMAP](../../docs/ROADMAP.md) for planned work.

See [virtual geometry](docs/VIRTUAL.md) for opt-in constant-work fixed ranges and bounded sparse measured axes.
