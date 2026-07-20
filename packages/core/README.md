# @jarenjs/core

The zero-dependency foundation of [Jaren](https://github.com/jklarenbeek/jarenjs). Everything the validator, the formats package and the forms package are built on lives here — type guards, Unicode-aware string handling, a large text-validation toolbox, number range helpers, and fixed-point and vector math.

None of it depends on JSON Schema: every module can be used standalone in any JavaScript project.

## Modules

| Import | Contents |
|---|---|
| `@jarenjs/core` | type guards and getters (`isStringType`, `isObjectClass`, `getIntegerType`, ...) |
| `@jarenjs/core/array` | array helpers (`isUniqueArray`, `getUniqueArray`, `includesAll`, ...) |
| `@jarenjs/core/object` | deep equality (`equalsDeep`, JSON-only `equalsJson`), map/set merging |
| `@jarenjs/core/string` | Unicode string helpers (`countCodePoints`, `compareCodePoints`, ...), cached regex compilation, the suite's content fingerprint `hashContent` and `kebabCase` |
| `@jarenjs/core/scan` | char-code constants and predicates for recursive-descent parsers |
| `@jarenjs/core/color` | pure color math (`lerpColor` — hex `#rrggbb` interpolation) |
| `@jarenjs/core/number` | boolean/number/integer coercion helpers (`isIntishType`, ...) |
| `@jarenjs/core/integer` | `int8` ... `uint64` ranges and validators |
| `@jarenjs/core/float` | `float16` ... `float64` constants, validators, increment/decrement |
| `@jarenjs/core/bigint` | bigint helpers (`BigInt_min`, `BigInt_MinMax`, ...) |
| `@jarenjs/core/dates` | RFC 3339 / ISO 8601 date-time parsing and validation |
| `@jarenjs/core/text` | text validators: emails, hostnames, IPs, URIs/IRIs, UUIDs, punycode, ... |
| `@jarenjs/core/math` | int32/float64 math and 2D/3D vector classes; the interpolation-correct linear `remap` |
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

Grouped by file: `email` (RFC 5321 + internationalized addresses), `host` (hostnames, IDN hostnames, IPv4/IPv6, MAC, URI/URL/IRI and references, URI templates), `identifiers` (UUID, GUID, C/HTML/CSS identifiers), `iregexp` (I-Regexp / RFC 9485 validation and translation to `RegExp`: `isValidIRegexp`, `compileIRegexp`), `base64`, `basic` (alpha, numeric, hex, web colors), `misc` (ISBN-10/13, ISO 3166 country codes, IBAN), `i18n` (Unicode script tests and IDNA context checks) and a complete `punycode` implementation.

## Dates, numbers and math

- `dates` — RFC 3339 date/time/date-time validation and parsing into `Date` (leap years and month lengths included), ISO 8601 durations, and the more lenient ISO date-time forms.
- `integer`/`float`/`bigint` — range constants and validators for every fixed-width type from `int8` to `uint64` and `float16` to `float64`, including float increment/decrement in representable steps.
- `math` — asm.js-style typed math (`Int32`, `Float64`) and vector classes (`Vec2i32`, `Vec2f64`, `Vec3f64`) with a fast integer sine approximation.

## JSON addressing standards

The JSON addressing and query standards — JSON validation helpers, JSON Pointer (RFC 6901), the compiling JSONPath engine (RFC 9535), and the Jaren JSON Query language with its XQuery front-end — live in [`@jarenjs/json`](../json). This package supplies their foundations: the char-code scanner (`@jarenjs/core/scan`), `equalsJson` deep equality, code-point ordering, and the I-Regexp (RFC 9485) toolbox.

## Development

Unit tests live in `test/core/` at the repository root (`npm run test:core`). This package's internals are described in its own [ARCHITECTURE](./ARCHITECTURE.md) document; see the repository [README](../../README.md) and [ARCHITECTURE](../../ARCHITECTURE.md) for the monorepo picture, and the [ROADMAP](../../ROADMAP.md) for planned work.
