# @jarenjs/json

The JSON addressing standards of [Jaren](https://github.com/jklarenbeek/jarenjs) — JSON validation helpers, JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)), and a compiling JSONPath engine ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)) — built on the zero-dependency [`@jarenjs/core`](../core) foundation.

None of it depends on JSON Schema: every module can be used standalone in any JavaScript project.

## Modules

| Import | Contents |
|---|---|
| `@jarenjs/json` | everything below |
| `@jarenjs/json/basic` | JSON, JSON Pointer and JSONPath string validation |
| `@jarenjs/json/pointer` | JSON Pointer and Relative JSON Pointer parsing and resolution |
| `@jarenjs/json/path` | the JSONPath compiler |

## JSON utilities

`@jarenjs/json` implements the three JSON addressing standards next to each other:

| Standard | Functions |
|---|---|
| JSON validation | `isValidJSON`, `isValidJSONCheap` (a fast "definitely not JSON" pre-test) |
| JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)) | `parseJsonPointer`, `getValueByJsonPointer`, `isValidJSONPointer`, `isValidJSONPointerUriFragment` |
| Relative JSON Pointer | `parseRelativeJsonPointer`, `resolveRelativePointer`, `isValidRelativeJSONPointer`, `resolveDataRef` |
| JSONPath ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)) | `compileJSONPath`, `queryJSONPath`, `parseJSONPath`, `isValidJSONPathStrict` |

### JSON Pointer

Pointers resolve a single location; relative pointers resolve from a location inside the document (used by the validator's `data`/`$data` keywords):

```javascript
import { getValueByJsonPointer, resolveRelativePointer } from '@jarenjs/json';

const doc = { limits: { min: 2, max: 9 }, value: 5 };

getValueByJsonPointer(doc, '', '/limits/min');      // { value: 2, found: true }
resolveRelativePointer(doc, '/value', '1/limits');  // { value: { min: 2, max: 9 }, found: true }
resolveRelativePointer(doc, '/limits/min', '0#');   // { value: 'min', found: true } (member name)
```

## The JSONPath compiler

JSONPath selects *many* locations: a query like `$.store.book[?@.price < 10].title` describes a whole nodelist. The `path.js` module implements the complete RFC 9535 specification as a two-stage compiler, mirroring the philosophy of the schema validator: **parse and decide everything once, then run a specialized function**.

```javascript
import { compileJSONPath } from '@jarenjs/json';

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

## Roadmap

Ideas we consider interesting or necessary for this package, roughly in order of appetite:

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

Unit tests live in `test/json/` at the repository root (`npm run test:json`); the JSONPath tests in `test/json/path.test.js` are built from the RFC's own examples. See the repository [README](../../README.md) and [ARCHITECTURE](../../ARCHITECTURE.md) for the validator-wide picture, and `benchmark/jsonpath.js` for the JSONPath compliance/performance harness.
