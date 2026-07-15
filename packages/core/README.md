# @jarenjs/core

The zero-dependency foundation of [Jaren](https://github.com/jklarenbeek/jarenjs). Everything the validator, the formats package and the forms package are built on lives here — type guards, Unicode-aware string handling, a large text-validation toolbox, number range helpers, fixed-point and vector math, and a JSON module implementing the JSON addressing standards, including a compiling JSONPath engine.

None of it depends on JSON Schema: every module can be used standalone in any JavaScript project.

## Modules

| Import | Contents |
|---|---|
| `@jarenjs/core` | type guards and getters (`isStringType`, `isObjectClass`, `getIntegerType`, ...) |
| `@jarenjs/core/array` | array helpers (`isUniqueArray`, `getUniqueArray`, `includesAll`, ...) |
| `@jarenjs/core/object` | deep equality (`equalsDeep`, JSON-only `equalsJson`), map/set merging |
| `@jarenjs/core/string` | Unicode string helpers (`countCodePoints`, `compareCodePoints`, ...), cached regex compilation |
| `@jarenjs/core/scan` | char-code constants and predicates for recursive-descent parsers |
| `@jarenjs/core/number` | boolean/number/integer coercion helpers (`isIntishType`, ...) |
| `@jarenjs/core/integer` | `int8` ... `uint64` ranges and validators |
| `@jarenjs/core/float` | `float16` ... `float64` constants, validators, increment/decrement |
| `@jarenjs/core/bigint` | bigint helpers (`BigInt_min`, `BigInt_MinMax`, ...) |
| `@jarenjs/core/dates` | RFC 3339 / ISO 8601 date-time parsing and validation |
| `@jarenjs/core/text` | text validators: emails, hostnames, IPs, URIs/IRIs, UUIDs, punycode, ... |
| `@jarenjs/core/math` | int32/float64 math and 2D/3D vector classes |
| `@jarenjs/core/json` | JSON validation, JSON Pointer (RFC 6901), JSONPath (RFC 9535) |

Deep imports work too (`@jarenjs/core/text/email`, `@jarenjs/core/json/path`, `@jarenjs/core/math/vec2f64`, ...).

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

## JSON utilities

`@jarenjs/core/json` implements the three JSON addressing standards next to each other:

| Standard | Functions |
|---|---|
| JSON validation | `isValidJSON`, `isValidJSONCheap` (a fast "definitely not JSON" pre-test) |
| JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)) | `parseJsonPointer`, `getValueByJsonPointer`, `isValidJSONPointer`, `isValidJSONPointerUriFragment` |
| Relative JSON Pointer | `parseRelativeJsonPointer`, `resolveRelativePointer`, `isValidRelativeJSONPointer`, `resolveDataRef` |
| JSONPath ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)) | `compileJSONPath`, `queryJSONPath`, `parseJSONPath`, `isValidJSONPathStrict` |

### JSON Pointer

Pointers resolve a single location; relative pointers resolve from a location inside the document (used by the validator's `data`/`$data` keywords):

```javascript
import { getValueByJsonPointer, resolveRelativePointer } from '@jarenjs/core/json';

const doc = { limits: { min: 2, max: 9 }, value: 5 };

getValueByJsonPointer(doc, '', '/limits/min');      // { value: 2, found: true }
resolveRelativePointer(doc, '/value', '1/limits');  // { value: { min: 2, max: 9 }, found: true }
resolveRelativePointer(doc, '/limits/min', '0#');   // { value: 'min', found: true } (member name)
```

## The JSONPath compiler

JSONPath selects *many* locations: a query like `$.store.book[?@.price < 10].title` describes a whole nodelist. The `json/path.js` module implements the complete RFC 9535 specification as a two-stage compiler, mirroring the philosophy of the schema validator: **parse and decide everything once, then run a specialized function**.

```javascript
import { compileJSONPath } from '@jarenjs/core/json';

const query = compileJSONPath('$.store.book[?@.price < 10].title');

query(data);   // ['Sayings of the Century', 'Moby Dick']
query(other);  // compiled once, reusable on any document
```

### Compiled query API

`compileJSONPath(source)` throws a `JSONPathSyntaxError` (with `source` and `position` properties) on invalid queries and returns a function with helpers attached:

| Call | Returns |
|---|---|
| `query(data)` / `query.values(data)` | array of matched values, in document order |
| `query.first(data)` | the first matched value, or `undefined` |
| `query.exists(data)` | `true` when at least one node matches |
| `query.nodes(data)` | array of `{ path, value }` pairs with normalized paths |
| `query.paths(data)` | array of normalized paths (RFC 9535 §2.7), e.g. `$['store']['book'][0]['title']` |
| `query.source` | the original query string |
| `query.ast` | the parsed query AST (deeply frozen) |

For one-off queries there is `queryJSONPath(source, data)`, which keeps a cache of compiled queries (512 entries, FIFO), and `isValidJSONPathStrict(source)` for a boolean grammar check — this is what the `json-path` format in [`@jarenjs/formats`](../formats) uses.

### Supported syntax

Everything in RFC 9535, with no extensions and no omissions:

| Construct | Example |
|---|---|
| root / current node | `$` — `@` inside filter expressions |
| name selector | `$.store`, `$['two words']`, `$["é"]` |
| wildcard | `$.store.*`, `$[*]` |
| index (negative from end) | `$[0]`, `$[-1]` |
| array slice | `$[1:3]`, `$[5:]`, `$[::2]`, `$[::-1]` |
| child segment, multi-selector | `$[0, 3]`, `$['a', 'b', *]` |
| descendant segment | `$..author`, `$..[0]`, `$..*` |
| filter selector | `$[?@.price < 10]`, `$[?(@.a && !@.b)]` |
| comparisons | `== != < <= > >=` with `Nothing`-aware semantics |
| logical operators | `&&`, `\|\|`, `!`, parentheses |
| function extensions | `length()`, `count()`, `match()`, `search()`, `value()` |

The parser is strict about everything the RFC is strict about: leading zeros, `-0`, integer bounds (±2⁵³−1), whitespace placement, lone surrogates, string escape rules, and the *well-typedness* of function expressions — `$[?length(@)]` (a value used as a test) and `$[?@[*] == 1]` (a non-singular query in a comparison) are compile-time errors, as the spec demands.

### Filter semantics worth knowing

- **`Nothing` is not `null`.** A missing member and a member whose value is `null` are different things: `$[?@.a == null]` only matches nodes where `a` exists *and* is `null`. Two missing values compare equal (`$[?@.absent1 == @.absent2]` is `true`). The sentinel is exported as `JSONPATH_NOTHING` for advanced integrations.
- **`==` is deep structural equality**; numbers compare mathematically (`1 == 1.0`).
- **`<` orders numbers and strings only**, and strings are ordered by Unicode scalar value (code points), not by UTF-16 code units.
- **`match()`/`search()` take I-Regexp** ([RFC 9485](https://www.rfc-editor.org/rfc/rfc9485.html)) patterns, validated against the complete I-Regexp grammar — lookarounds, backreferences, lazy quantifiers and multi-character escapes like `\d` make the function yield `false`, as the spec requires. Literal patterns are compiled to a `RegExp` once at query-compile time; dynamic patterns get a per-callsite cache. Unescaped `^`/`$` behave as anchors, matching the RFC's own ECMAScript translation and the official compliance test suite.

### Architecture and performance

The compiler works in two stages:

1. A single-pass, character-level recursive-descent **parser** produces an AST and enforces the full grammar.
2. The **compiler** turns each segment into a specialized closure — selector kind, index sign, slice bounds logic, literal regexes and comparison operators are all resolved before the first document is seen. No `eval`, no `new Function`, CSP-safe.

Fast paths fall out of this design: singular queries (`$.a.b[3]`) compile to a direct property walk with zero allocations; existence tests in filters skip nodelist construction; normalized-path production is compiled lazily so value-only queries never pay for path strings.

Measured on Node (see `node benchmark/jsonpath.js --profile --scale` in the repository, which compares against [json-p3](https://www.npmjs.com/package/json-p3)):

| Query shape | Throughput |
|---|---|
| singular `$.store.book[2].title` | ~22M queries/s (45 ns) |
| filter `$.store.book[?@.price < 10].title` | ~4M queries/s |
| regexp filter with literal `match()` | ~3M queries/s |
| descendant `$..price` | ~2M queries/s |
| compile | ~1–2 µs per query |

Conformance: **all 703 tests** of the official [JSONPath Compliance Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite) pass, including the normalized-path assertions (the suite is a git submodule at `benchmark/jsonpath-suite/`).

### Roadmap

Ideas we consider interesting or necessary for the JSON module, roughly in order of appetite:

- [ ] **JSON transformation compiler** — an XSLT-like engine: declarative templates whose selectors are JSONPath queries, compiled once into a `transform(data)` function. `query.ast` and the internal segment compilers are the intended building blocks.
- [ ] **Compiled JSON Pointers** — give `pointer.js` the `path.js` treatment: `compileJSONPointer('/a/b')` returning a specialized getter instead of parsing and walking on every call. Would directly speed up the validator's `data`/`$data` keywords.
- [ ] **Write operations** — `set`/`insert`/`remove` at a pointer, a normalized path, or every node a JSONPath query selects; the write side of the query compiler, with a copy-on-write mode.
- [ ] **JSON Patch (RFC 6902) and JSON Merge Patch (RFC 7396)** — apply and structural diff, built on compiled pointers; a diff that emits JSON Patch doubles as a change feed for [`@jarenjs/forms`](../forms).
- [ ] **Custom JSONPath function extensions** — a registry per RFC 9535 §2.4 with declared parameter/return types, so user functions (`sum()`, `min()`, `starts_with()`, ...) get the same compile-time well-typedness checks as the built-ins.
- [ ] **Lazy iteration** — `query.iterate(data)` as a generator yielding nodes on demand, plus early-exit `first()`/`exists()` for non-singular queries (they currently materialize the full nodelist).
- [ ] **Filter optimizer** — hoist `$`-absolute comparables out of filter loops (they are invariant for a whole query run but are currently re-resolved per candidate node), and fuse adjacent singular segments.
- [ ] **Normalized path ↔ JSON Pointer bridge** — convert singular queries and normalized paths to RFC 6901 pointers and back, so the three addressing standards compose.
- [ ] **Canonical JSON (RFC 8785 / JCS)** — deterministic serialization for hashing and signing.
- [ ] **Optional codegen backend** — compile hot queries to source via `new Function` where CSP allows, reusing the same AST and semantics; the closure compiler stays the default.

## Development

Unit tests live in `test/core/` at the repository root (`npm run test:core`); the JSONPath tests in `test/core/json/path.test.js` are built from the RFC's own examples. This package's internals are described in its own [ARCHITECTURE](./ARCHITECTURE.md) document; see the repository [README](../../README.md) and [ARCHITECTURE](../../ARCHITECTURE.md) for the validator-wide picture, and `benchmark/jsonpath.js` for the JSONPath compliance/performance harness.
