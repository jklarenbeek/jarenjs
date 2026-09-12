# @jarenjs/json

Saved formulas and reviewed plans compose with injected query providers and authoritative command settlement. The [adoption ledger](../../docs/ADOPTION-EVIDENCE.md) records qualified scopes; unresolved trusted originals remain preserved for application review.

The JSON addressing, query, and stylesheet standards of [Jaren](https://github.com/jklarenbeek/jarenjs), compiled: JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)), a JSONPath engine ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)) that passes the complete official compliance suite, the **Jaren JSON Query format** — a declarative query-and-transformation language with XQuery 3.1 semantics whose queries are themselves JSON documents — and **JSLT**, a recursive template-dispatch layer over that same stack. Everything follows the same architecture: parse and decide once, then run a specialized closure. No `eval`, no `new Function`, CSP-safe, zero runtime dependencies beyond the [`@jarenjs/core`](../core) foundation.

None of it depends on JSON Schema: every module can be used standalone in any JavaScript project.

## Modules

| Import | Contents |
|---|---|
| `@jarenjs/json` | the addressing and query modules below (`jslt`/`jtlt`/`xquery` are subpath-only) |
| `@jarenjs/json/basic` | JSON, JSON Pointer and JSONPath string validation |
| `@jarenjs/json/pointer` | the JSON Pointer and Relative JSON Pointer compiler |
| `@jarenjs/json/patch` | JSON Patch and JSON Merge Patch: compiled apply + structural diff |
| `@jarenjs/json/write` | compiled write operations: set/insert/remove at pointers, normalized paths, or every JSONPath match |
| `@jarenjs/json/path` | the JSONPath compiler |
| `@jarenjs/json/query` | the Jaren JSON Query engine |
| `@jarenjs/json/jslt` | the Jaren JSLT stylesheet compiler and dispatcher |
| `@jarenjs/json/jtlt` | the Jaren JTLT template compiler — JSON to text/XML |
| `@jarenjs/json/xquery` | the XQuery text front-end for the query engine |
| `@jarenjs/json/node` | **Node only** — `loadDocument`, the document loader the suite's CLIs share: a `.json` file or a pure module (`.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`) whose `default` or named export is the document or a pen builder; the only subpath that imports a Node builtin, never re-exported from the root |

## JSON utilities

`@jarenjs/json` implements the JSON addressing standards next to each other:

| Standard | Functions |
|---|---|
| JSON validation | `isValidJSON`, `isValidJSONCheap` (a fast "definitely not JSON" pre-test) |
| JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)) | `compileJSONPointer`, `parseJSONPointer`, `parseJSONPointerPath`, `isValidJSONPointer`, `isValidJSONPointerUriFragment` |
| Relative JSON Pointer | `compileRelativeJSONPointer`, `parseRelativeJSONPointer`, `compileDataRef`, `isValidRelativeJSONPointer` |
| JSON Patch ([RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902)) | `compileJSONPatch`, `applyJSONPatch`, `createJSONPatch`, `isValidJSONPatch`, `JsonPatchCompileError`, `JsonPatchRuntimeError` |
| JSON Merge Patch ([RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396)) | `compileMergePatch`, `applyMergePatch`, `createMergePatch` |
| Write operations | `compileJSONPointerSetter`/`Inserter`/`Remover`, `compileJSONPathSetter`/`Inserter`/`Remover`, one-shot `setAtJSONPointer`, `removeAtJSONPath`, ..., `JsonWriteError` |
| Addressing bridge | `jsonPointerFromJSONPath`, `jsonPathFromJSONPointer` |
| JSONPath ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)) | `compileJSONPath`, `queryJSONPath`, `parseJSONPath`, `isValidJSONPathStrict`, `isValidJSONPathSegments` |
| Canonical JSON ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)) | `canonicalizeJson`, `JsonCanonicalizeError` |
| Jaren JSON Query | `compileJsonQuery`, `queryJson`, `JsonQueryCompileError`, `JsonQueryRuntimeError` |
| Jaren JSLT | `compileJsltStylesheet`, `transformJson`, `JsltCompileError`, `JsltRuntimeError` |
| Jaren JTLT | `compileJtltStylesheet`, `renderText`, `validateJtltTemplate`, `JtltCompileError`, `JtltRuntimeError` |

### JSON Pointer

Pointers address a single location. Like every other engine in this package they are compiled, not interpreted: `compileJSONPointer(pointer)` parses once (strict RFC 6901, throwing a `JSONPointerSyntaxError` with `source` and `position` on bad input), pre-decodes every member name, pre-parses every array index, and returns a getter specialized by segment count. Resolving allocates nothing and returns `JSONPOINTER_NOTHING` — the same sentinel as `JSONPATH_NOTHING` — when the pointer addresses no location:

```javascript
import { compileJSONPointer, JSONPOINTER_NOTHING } from '@jarenjs/json';

const doc = { limits: { min: 2, max: 9 }, value: 5 };

const getMin = compileJSONPointer('/limits/min');
getMin(doc); // 2
getMin({});  // JSONPOINTER_NOTHING
```

Relative pointers resolve from a location inside the document, given as an RFC 6901 pointer string. The relative part (level count, `#` form, trailing segments) compiles once; per call only the location varies. This is the hot path of the validator's `data`/`$data` keywords, where the ref is a schema constant known at schema-compile time:

```javascript
import { compileRelativeJSONPointer } from '@jarenjs/json';

const getLimits = compileRelativeJSONPointer('1/limits');
getLimits(doc, '/value'); // { min: 2, max: 9 }

const getName = compileRelativeJSONPointer('0#');
getName(doc, '/limits/min'); // 'min' (the member name of the location)
```

The `#` form has two modes, chosen once at compile time, because the spec's
answer and the fast answer are not the same thing. Relative JSON Pointer says
`#` yields the member *name* for an object member and the *index* — a number —
for an array element, and telling those apart means looking at the container:

```javascript
const asString = compileRelativeJSONPointer('0#');                        // default
const asNumber = compileRelativeJSONPointer('0#', { hashIndex: 'number' });

asString({ a: ['x', 'y'] }, '/a/1'); // '1'  — string, answered from the path alone
asNumber({ a: ['x', 'y'] }, '/a/1'); // 1    — number, the draft's answer
asNumber({ o: { 1: 'v' } }, '/o/1'); // '1'  — a member named "1" is still a name
```

`hashIndex: 'string'` is the default and never touches the document, which is
what keeps it a string operation of tens of nanoseconds; it is also what the
validator's `$data` keyword has always seen, so `{"$data": "0#"}` compared
against a number-typed keyword gets a string. `hashIndex: 'number'` walks to the
parent of the location to check whether it is an array, and falls back to the
string when that parent cannot be reached — nothing proves a position is an
index. An unknown mode is a `TypeError` at compile time rather than a silent
fallback. `compileDataRef` forwards the option.

Neither mode verifies the location itself exists: the caller passes a location
it actually reached. The root has no name, so `0#` there is
`JSONPOINTER_NOTHING` and stays distinguishable from the member a document can
genuinely name `''`.

`compileDataRef(ref)` compiles the union the validator accepts — `''` for the data root, a leading `/` for an absolute pointer, a leading digit for a relative one — deciding the dispatch once at compile time. On a realistic `$data` workload the compiled resolvers are 4–20x faster than the interpretive resolver they replaced, and beat the `jsonpointer` npm package on every scenario (`npm run benchmark:jsonpointer`, 2026-07-17: absolute pointers 12–16x, relative pointers 4–16x, `compileDataRef` dispatch 7–20x).

The write-side encode is there too: `encodeJSONPointerSegment(key)` escapes one reference token (`~` → `~0`, `/` → `~1`), `decodeJSONPointerSegment(token)` is its inverse for one token (decoding `~1` before `~0`, so a member named `~1` survives the round trip), and `formatJSONPointer(segments)` is the inverse of `parseJSONPointer`.

`parseJSONPointerPath(pointer)` is the typed variant: it returns
`(string|number)[]`, narrowing canonical array indexes to numbers
(`'/items/0/id'` → `['items', 0, 'id']`) while leaving anything RFC 6901 does
not make an index — `01`, `1e0`, `-`, `1abc` — a string. RFC 6901 has no
types, so the classification is lexical rather than resolved against a
document, using the same index rule the pointer compiler uses. This is the
path shape error reporters and diffing tools expect, so it pairs directly
with a validation error's `instancePath`.

### JSON Patch and JSON Merge Patch

Partial updates follow the same compile-once discipline. `compileJSONPatch(patch)` validates an [RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902) patch document once (`JsonPatchCompileError`, `JP0xxx`, with a `docPath` pointing into the *patch* document), pre-parses every `path`/`from` through the RFC 6901 parser and specializes one closure per operation. Applying is **copy-on-write**: the input document is never mutated, untouched subtrees are shared by reference with the result, and application is atomic — a failing operation (`JsonPatchRuntimeError`, `JP2xxx`, carrying both the patch `docPath` and the target `dataPath`) leaves nothing behind, exactly as RFC 6902 section 5 requires. The engine passes the complete official [json-patch-tests](https://github.com/json-patch/json-patch-tests) suite:

```javascript
import { compileJSONPatch, applyJSONPatch, createJSONPatch } from '@jarenjs/json';

// compile once, apply many times (hot path)
const apply = compileJSONPatch([
  { op: 'test', path: '/version', value: 5 },
  { op: 'replace', path: '/user/name', value: 'Bob' },
  { op: 'add', path: '/user/tags/-', value: 'admin' },
]);
const next = apply(doc); // doc is untouched; unchanged subtrees are shared

// one-shot
applyJSONPatch(doc, patch);

// structural diff: a change feed for @jarenjs/forms and friends
applyJSONPatch(a, createJSONPatch(a, b)); // deep-equals b
```

Because an application only clones the spine it writes through — and clones it once, no matter how many operations touch the same region — the compiled applier beats the usual clone-and-interpret shape by 5–170x depending on document size (`npm run benchmark:jsonpatch`). Two options tune the copy discipline, mirroring JSLT's `share`/`fresh` dispositions: `values: 'fresh'` deep-copies inserted operation values per application (the default `'share'` inserts them by reference, so treat results as immutable), and `mutate: true` patches in place for the last bit of speed at the cost of atomicity.

`createJSONPatch(source, target)` trims each array's deep-equal common prefix and suffix and pairs the rest up index-wise, which is linear and already minimal for in-place edits and head/tail insertions — but turns a mid-array insertion into a run of per-index replaces. `createJSONPatch(source, target, { arrayDiff: 'minimal' })` aligns the changed middle instead, so the insertion is one `add`:

```javascript
const before = [{ id: 1 }, { id: 2 }, { id: 3, n: 0 }];
const after = [{ id: 1 }, { id: 9 }, { id: 2 }, { id: 3, n: 1 }];

createJSONPatch(before, after);
// 4 ops: replace /1/id, replace /2/id, remove /2/n, add /3

createJSONPatch(before, after, { arrayDiff: 'minimal' });
// 2 ops: add /1 {id:9}, replace /3/n 1
```

The alignment minimizes the patch itself (edit distance with substitutions — *not* a longest common subsequence, which maximizes kept elements and so pays a delete plus an insert on a permutation where one rewrite would do), and therefore never takes more steps than the default. It stays opt-in because it is O(m·n) in the length of the changed middle; past a fixed budget a single array falls back to the linear diff, so the option can never make a large diff quadratic. Both modes reproduce `target` exactly.

A third option makes the engine a **change feed**: `changes: true` specializes the applier to return `{ doc, changes }`, where `changes` holds one JSON Pointer per successful write, in application order. The reported pointers are *invalidation-sound* — object writes, array replaces and appends report the written location itself; shifting array inserts and removes report the parent array; a root write reports `''` — which is exactly the primitive dirty-path consumers (view re-rendering in `@jarenjs/app`, rule dependency memoization in `@jarenjs/forms`) need. `test` operations report nothing, and the option costs nothing when off: the tracking branch is compiled out of the applier.

[RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396) merge patches ride the same machinery: `compileMergePatch(patch)` pre-splits the patch into remove/set/merge plans, and applying is identity-preserving — a merge that changes nothing returns the target by reference, so it doubles as a cheap change detector. `createMergePatch(source, target)` emits the merge patch (with the RFC's documented `null`-member representability caveat), and `applyMergePatch(doc, patch)` is the one-shot form.

### Write operations

When a whole patch document is more ceremony than the job needs, the standalone write operations expose the same copy-on-write core directly — `set`, `insert` and `remove`, compiled once per target:

```javascript
import {
  compileJSONPointerSetter, removeAtJSONPointer,
  compileJSONPathSetter, removeAtJSONPath,
} from '@jarenjs/json';

// a target is an RFC 6901 pointer, a normalized path, or ANY singular
// query — '/store/book/0/title', "$['store']['book'][0]['title']" and
// '$.store.book[-1].title' (negative = from the end) all compile
const setZip = compileJSONPointerSetter('/address/zip');
const next = setZip(doc, '10999');   // doc untouched, spine cloned once

setZip(doc, (old) => old ?? '10115'); // setters take updater functions

// ...or write at EVERY node a JSONPath query selects
const addVat = compileJSONPathSetter('$..price');
addVat(doc, (price) => price * 1.21);
removeAtJSONPath(doc, '$.store.book[?@.price > 20]');
```

Set replaces (creating a missing final member; `/arr/-` appends), insert has RFC 6902 `add` semantics (array elements shift right), remove deletes with shift. The query-selected writers deduplicate matched locations and apply them in **reverse document order**, independent of selector order (including reversed unions and negative-step slices), so multiple removals or inserts in one array — and nested matches — compose without index bookkeeping, and matching nothing is a no-op that returns the input. Everything is copy-on-write with an in-place `{ mutate: true }` escape hatch; failures (`JsonWriteError`, `JW0001`/`JW2xxx` with the target as `dataPath`) leave the input untouched.

The addressing bridge rounds this out: `jsonPointerFromJSONPath(singularQuery)` and `jsonPathFromJSONPointer(pointer)` convert between the two location languages (digit tokens become index selectors — RFC 6901's one-token-two-forms ambiguity, resolved by convention), so pointers, normalized paths and query results compose freely.

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
| `query.iterate(data)` | a generator yielding matched values on demand, in document order |
| `query.nodes(data)` | array of `{ path, value }` pairs with normalized paths |
| `query.paths(data)` | array of normalized paths (RFC 9535 §2.7), e.g. `$['store']['book'][0]['title']` |
| `query.source` | the original query string |
| `query.ast` | the parsed query AST (deeply frozen) |

For one-off queries there is `queryJSONPath(source, data)`, which keeps a cache of compiled queries (512 entries, FIFO), and `isValidJSONPathStrict(source)` for a boolean grammar check — this is what the `json-path` format in [`@jarenjs/formats`](../formats) uses.

`first`, `exists` and `iterate` are one lazy walk: they stop at the first node they need instead of building the whole nodelist, so `q.first(doc)` on `$.items[?@.price < 10].name` over 10 000 items costs about 2 µs where `q.values(doc)` costs about 240 µs. Nothing is buffered along the way — a filter evaluates its predicate only until one passes, and a descendant segment abandons the walk mid-subtree.

#### Custom function extensions

`compileJSONPath(source, { pathFunctions })` registers function extensions ([RFC 9535 §2.4](https://www.rfc-editor.org/rfc/rfc9535.html#name-function-extensions)) alongside the five built-ins. An entry declares its parameter and result types, which is what lets the parser type-check call sites the same way it checks `length()` or `match()`:

```js
const pathFunctions = {
  is_even: {
    params: ['value'],      // 'value' | 'nodes' | 'logical'
    returns: 'logical',
    evaluate: (v) => typeof v === 'number' && v % 2 === 0,
  },
};

const q = compileJSONPath('$.items[?is_even(@.n)].n', { pathFunctions });
q({ items: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] }); // [2, 4]
```

A `value` parameter arrives as a JSON value or `JSONPATH_NOTHING`, a `nodes` parameter as an array of the selected values, a `logical` parameter as a boolean — and a `logical` parameter accepts the full filter grammar at the call site, so `both(@.a > 1, !@.b)` parses. A name that would redefine a built-in is rejected (§2.4.1), and a malformed registry raises a `TypeError`.

The same option reaches everywhere a path string is embedded: the JSONPath-addressed writers, `compileJsonQuery`, and JSLT match paths and rule bodies. The `json-path` and `json-path-segments` string formats deliberately do **not** see it — a format is a property of the string, so it has to mean the same thing in every schema regardless of which extensions a host installed.

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

### Conformance and performance

Conformance: **all 703 tests** of the official [JSONPath Compliance Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite) pass, including the normalized-path assertions (the suite is a git submodule at `benchmark/jsonpath-suite/`).

Measured with `node benchmark/jsonpath.js --profile --scale -i 3000` (2026-07-17, Node v24.14.0, 1000-item synthetic document, vs [json-p3](https://www.npmjs.com/package/json-p3) 2.2.2):

| Query shape | Jaren | vs json-p3 |
|---|---|---|
| singular `$.items[42].name` | 189 ns (~5M queries/s) | 4.9x |
| wildcard `$.items[*].id` | 31.2 µs | 12.1x |
| slice `$.items[100:200].id` | 4.4 µs | 9.5x |
| filter `$.items[?@.price < 10].name` | 38.9 µs | 8.7x |
| regexp filter `$.items[?match(@.name, "item-1.*")].id` | 38.8 µs | 14.3x |
| descendant `$..value` | 210.0 µs | 81.8x |
| mean over all 456 CTS queries | 151 ns | 18.7x |
| compile | ~2.4 µs per query | — |

## The Jaren JSON Query language

JSONPath answers "which nodes?"; it cannot join, group, aggregate or reshape. The Jaren JSON Query format is the next layer: a query-and-transformation language with the semantics of **XQuery 3.1** — sequences, FLWOR, effective boolean value, existential comparisons — and a surface syntax that is **JSON itself**, the way an XSLT stylesheet is an XML document. Navigation leaves are RFC 9535 JSONPath strings.

The language contract is the specification in [docs/QUERY-FORMAT.md](./docs/QUERY-FORMAT.md); this section is the tour.

```javascript
import { compileJsonQuery } from '@jarenjs/json';

const query = compileJsonQuery({
  $for: { b: '$.store.book[*]' },
  $where: { $lt: ['$b.price', 10] },
  $orderby: '$b.price',
  $return: { title: '$b.title', price: '$b.price' },
});

query(data);
// [ { title: 'Sayings of the Century', price: 8.95 },
//   { title: 'Moby Dick', price: 8.99 } ]
```

### Three rules

Every JSON value is an expression under three rules — there is no rule four:

1. **Objects** partition by their keys. All keys `$`-prefixed → an **operator phrase** from a closed vocabulary (`{"$lt": [a, b]}`, the FLWOR phrase, ...). No key `$`-prefixed → a **map constructor**: keys are literal member names, values are evaluated. Mixed → compile error.
2. **Strings** starting with `$` are **queries**: a complete RFC 9535 JSONPath (`"$.store.book[*]"`), or a variable-rooted path (`"$b.title"`). `"$$x"` escapes to the literal string `"$x"`; any other string is itself.
3. **Scalars** (`42`, `true`, `null`) are literals; **arrays** are array constructors whose element sequences flatten, XQuery-style.

Escape hatches: `{"$const": v}` quotes any value verbatim; `{"$map": [[keyExpr, valExpr], ...]}` constructs objects with computed keys. That is the entire encoding.

### The degenerate query is a JSONPath string

A bare JSONPath string is a complete query document, so the on-ramp from "I use JSONPath" to "I need a join" is a one-liner at each step:

```javascript
import { queryJson } from '@jarenjs/json';

queryJson('$.store.book[?@.price < 10].title', data);
// [ 'Sayings of the Century', 'Moby Dick' ]
```

### Joins

Cross-variable predicates — the thing path filters fundamentally cannot express — are a `$where` away (this is the spec's example A.3):

```javascript
queryJson({
  $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
  $where: { $eq: ['$b.isbn', '$r.isbn'] },
  $orderby: '$b.price',
  $return: { title: '$b.title', stars: '$r.stars' },
}, data);
// [ { title: 'Moby Dick', stars: 4 },
//   { title: 'The Lord of the Rings', stars: 5 } ]
```

Books without an `isbn` drop out on their own: `$b.isbn` evaluates to the empty sequence and an existential `$eq` over an empty sequence is `false`.

### Grouping

XQuery 3.1 `group by` semantics: grouping keys become singleton variables, every other variable rebinds to the sequence of its values across the group (spec example A.4):

```javascript
queryJson({
  $for: { b: '$.store.book[*]' },
  $groupby: { genre: '$b.category' },
  $return: { genre: '$genre', count: { $count: '$b' }, avg: { $avg: '$b.price' } },
}, data);
// [ { genre: 'reference', count: 1, avg: 8.95 },
//   { genre: 'fiction', count: 3, avg: 14.99 } ]
```

### The FLWOR phrase

One phrase carries the whole pipeline. Clauses apply in **fixed semantic order regardless of JSON key order** (JSON key order is not interoperable, so it never carries meaning here); exotic interleavings nest phrases:

| Key | Value | Presence |
|---|---|---|
| `$fold` | one accumulator binding `{ name: initExpr }` | at least one of `$fold`/`$for`/`$let` |
| `$for` | iteration bindings `{ name: source, ... }`, extended form `{ "$in": expr, "$at": "i" }` | at least one of `$fold`/`$for`/`$let` |
| `$let` | sequence bindings (no iteration) | at least one of `$fold`/`$for`/`$let` |
| `$as` | schema assertions on this phrase's bindings | optional |
| `$where` | tuple filter (effective boolean value) | optional |
| `$groupby` | grouping-key bindings | optional |
| `$orderby` | key spec or list: `{ "$key": e, "$dir": "desc", "$empty": "greatest" }` | optional |
| `$count` | variable name for the 0-based tuple index | optional |
| `$return` | the result expression per surviving tuple | required |

Semantic order: `$fold → $for → $let → $as → $where → $groupby → $orderby → $count → $return`. Quantifiers are their own two-key phrases: `{"$some": bindings, "$satisfies": expr}` / `{"$every": ...}`, with short-circuit evaluation.

**`$fold` turns the phrase into a reduction.** The accumulator's initial value is evaluated once, `$return` names its next value per surviving tuple, and the phrase evaluates to the final accumulator instead of the collected sequence. This is how the language gets a general fold without the JSON encoding needing to spell a *function value* — the accumulator is a binding, not a lambda parameter. It composes with the rest, so `$orderby` folds over sorted tuples and `$groupby` updates once per group:

```js
queryJson({
  $fold: { total: 0 },
  $for: { b: '$.store.book[*]' },
  $where: { $lt: ['$b.price', 10] },
  $return: { $add: ['$total', '$b.price'] },
}, bookstore); // 17.939999999999998 — every number is an IEEE double (D1)
```

Grouping and sorting buffer their input before `$return` updates the
accumulator: earlier clauses see its initial value. Put accumulator-dependent
`$let` expressions inside `$return` when reducing sorted/grouped tuples.
`limits.sequenceItems` also bounds each sequence-valued accumulator.
Materialized `$range` values are capped at 1,000,000 items before allocation;
direct iteration remains allocation-free. Bounds must be safe integers.

Because `$get` is a real dynamic lookup, a fold over typed segments (string object names, numeric array indexes) is a cursor walk, not a parser for RFC 6901 pointer strings: `{"$fold": {"cur": "$.doc"}, "$for": {"seg": "$.path[*]"}, "$return": {"$get": ["$cur", "$seg"]}}`.

**Extended `$for` bindings** cover the two remaining XQuery iteration shapes. `{"$in": e, "$allowing-empty": true}` is outer-join iteration: when the source yields no tuple, one tuple is emitted with the variable bound to the empty sequence (position `-1` if `$at` is present), so the enclosing row survives. `{"$in": e, "$window": "tumbling"|"sliding", "$size": n, "$step": m}` iterates runs instead of items — a tumbling window *partitions* the stream, so its short final window is kept; a sliding window is a fixed-width moving view, so only full windows are emitted.

```js
queryJson({
  $for: { w: { $in: '$[*]', $window: 'sliding', $size: 3 } },
  $return: { $avg: '$w' },
}, [1, 2, 3, 4, 5]); // [2, 3, 4] — a 3-point moving average
```

The operator library (104 operators: comparisons, IEEE-double arithmetic, logic, strings with I-Regexp `$match`/`$search`/`$replace`, aggregates, sequence tools like `$distinct`/`$subsequence`/`$range`, type predicates and casts, `$coalesce`, the RFC 3339 date family, the spatial family, `$similarity` and the time-series family) is cataloged in [QUERY-FORMAT.md §8](./docs/QUERY-FORMAT.md#8-operators).

**Extending the vocabulary (host opt-in).** The 104 are closed, but a host can add more the way `@jarenjs/validate` gains formats from `@jarenjs/formats`: `createJsltRegistry().use(mathPack).use(financePack)` composes packs of pure `@jarenjs/core` functions into a compiler, so `{ "$sqrt": "$.variance" }` and `{ "$npv": ["$.rate", "$.cashflows[*]"] }` work in a stylesheet, a bare query, and `@jarenjs/linq` — while a document compiled *without* the registry still rejects them. Aggregators fold a `seq` operand to an array before the pure call. See [JSLT-FORMAT.md §13](./docs/JSLT-FORMAT.md#13-registered-operators-host-opt-in-non-normative).

**Dates are RFC 3339 strings** ([§8.13](./docs/QUERY-FORMAT.md#813-dates-and-times)): `$is-date`/`$is-time`/`$is-datetime`/`$is-duration` test the lexical forms, `$year`…`$seconds` and `$offset` read components *lexically, in the value's own offset* (so "group by month" means what you expect), `$week`/`$week-year`/`$quarter`/`$weekday` add the derived calendar fields, and `$epoch`/`$datetime` convert to and from epoch milliseconds — the one place a value is shifted to UTC, and therefore the way to compare instants across offsets. There is deliberately no `current-dateTime`: a compiled query is cached by document identity and saved as a rule, so it must answer the same for the same input forever.

Dates also *move*. `$date-add`/`$date-sub` shift by an ISO 8601 duration or by an amount and a unit, `$start-of`/`$end-of` truncate to a calendar unit, `$date-diff` counts whole units, and `$date-format` renders through a Unicode LDML pattern compiled once with the query. Three rules keep it predictable: the **lexical form is preserved** (a date stays a date, and a date-time keeps its own offset instead of being normalized to UTC); **month arithmetic clamps**, so 31 January plus a month is 28 February — with `$date-diff` counting to match, so adding its answer back never overshoots; and **an operation needing a half the value has not got is refused**, so adding hours to a date, or asking a time for its end of month, is a `JQ2001` rather than an invented answer. Fractions apply where they convert exactly: `P1.5D` is thirty-six hours on a date-time, half a month is refused.

```js
queryJson({
  $for: { e: '$[*]' },
  $groupby: { w: { '$start-of': ['$e.on', 'week'] } },
  $orderby: ['$w'],
  $return: { week: '$w', count: { $count: '$e' } },
}, [{ on: '2026-01-05' }, { on: '2026-01-08' }, { on: '2026-01-20' }]);
// [{ week: '2026-01-05', count: 2 }, { week: '2026-01-19', count: 1 }]
```

Bucketing by week is the shape components alone cannot express, because a week boundary is arithmetic rather than a field. Patterns stay locale-independent — `MMMM` and `EEEE` are rejected rather than silently rendered in English — because localized text belongs to the presentation layer, not to a query.

**Geography is GeoJSON** ([§8.14](./docs/QUERY-FORMAT.md#814-spatial)), for the same reason dates are RFC 3339 strings: it is what the document already holds. Thirteen of the 104 operators are spatial — eight measurements and predicates, five conversions — and JSLT and JTLT inherit every one. Operands are a bare `[longitude, latitude]` position, a geometry, a `Feature` or a `FeatureCollection`, and wrappers unwrap for you. `$distance`, `$area` and `$length` answer in metres on the WGS 84 sphere — never planar, because a Euclidean answer over raw degrees is wrong by two thirds over a kilometre at Dutch latitudes. `$within` tests containment, `$bbox`/`$centroid` measure, and `$bbox-intersects` is named for exactly what it tests, since an `$intersects` that compared only boxes would be a lie the first time two L-shapes shared one.

```js
queryJson({
  $for: { c: '$.cities[*]' },
  $where: { $within: ['$c.at', '$.region'] },
  $orderby: [{ $key: { $distance: ['$c.at', '$.centre'] } }],
  $return: '$c.name',
}, data); // a spatial filter and a spatial sort, in the language's own clauses
```

**Geography goes in and out as the text the world already speaks.** `$geo-parse` reads Well-Known Text — what PostGIS, SpatiaLite, GEOS, JTS and every `ST_AsText` emit — and `$geo-text` writes it back, so a WKT column becomes measurable in one expression and a result leaves as something a spatial database reads. `$geohash-bounds` turns a cell string back into the `Polygon` it covers, and `$geo-simplify` reduces a value **for storage and transport**: the same structure and properties with fewer positions, rings still closed, so it can be kept or sent as-is.

Getting a CSV of coordinates in needs **no code and no operator** — it is a stylesheet. `parseCsv(text, { headers: true, typed: true })` then one rule:

```js
compileJsltStylesheet([{
  match: '$',
  body: {
    type: 'FeatureCollection',
    features: [{
      $for: { r: '$[*]' },
      $return: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: ['$r.lon', '$r.lat'] },
        properties: { name: '$r.name', pop: '$r.pop' },
      },
    }],
  },
}]);
```

The one trap: `coordinates` and `features` take the **array constructor** (the brackets, §3.4), never `$seq` — a two-item *sequence* in member position is `JQ2001`, because a sequence is not an array.

A geohash is a string, so **bucketing and tiling** need no operator: `$groupby` over `$substring` groups by cell and an index over the hash is a spatial index. **Proximity is different**, and a prefix test is not it — two points ten metres apart can differ in the *first* character of their cell, so a single prefix misses a neighbour at every cell boundary. `$geohash-neighbours` gives the nine-cell probe a correct proximity query needs; narrow it with `$distance` when an exact radius matters. The whole recipe, end to end, is in [HOWTO](../../docs/HOWTO.md#getting-geographic-data-in-and-out).

### Similarity, and why there is no `$knn`

An embedding is an array of numbers, which a JSON document can already hold, so
the language needs exactly one operator to compare two of them
([§8.15](./docs/QUERY-FORMAT.md#815-vectors)):

```javascript
queryJson({ $similarity: [[3, 4], [4, 3]] }, {}); // 0.96
```

`$similarity` is cosine, in [-1, 1], higher-is-better. One metric, because a
stored vector is normally normalized and cosine, the dot product and Euclidean
distance then rank the same candidates in the same order — a second metric
would buy a different number for the same answer. An operand that is not an
array of numbers is `JQ2001`; two vectors that cannot be compared — different
widths, empty, or carrying a component a computation made non-finite — answer
**empty**, so a document never carries a score nobody computed. Nothing is
padded or truncated to make a comparison possible.

"The k most similar" needs no keyword either: it is an ordering and a window,
and both already exist.

```javascript
queryJson({ $subsequence: [{
  $for: { m: '$.memories[*]' },
  $orderby: [
    { $key: { $similarity: ['$m.embedding', '$query'] }, $dir: 'desc', $empty: 'least' },
    '$m.id',
  ],
  $return: '$m.text',
}, 0, 10] }, data, { query: vector });
```

`$empty: 'least'` under a descending sort puts the rows with no vector **last**
— present in the input, never in the top k, never scored — and the second key
breaks ties by identity, so the same document answers with the same rows every
time it runs. `@jarenjs/linq` spells the whole chain fluently as
`.orderByDescending(m => m.embedding.similarity(q), { empty: 'least' }).take(10)`.

### Time series, in five operators

A series is what a document already holds when something has been measured
repeatedly — records with an instant and a reading — so five operators cover
the questions a `$for` phrase can ask but cannot answer in one pass
([§8.16](./docs/QUERY-FORMAT.md#816-time-series)):

```javascript
queryJson({ $resample: ['$.readings[*]',
  { every: 'PT1H', aggregate: 'mean', fill: 'linear' }] }, data);
// [{ at: 1767225600000, value: 4.5, count: 3600 }, …]
```

`$overlaps` tests two half-open `{start, end}` intervals (touching spans do
*not* overlap), `$time-bucket` labels the bucket an instant falls in,
`$resample` aggregates a series into buckets with an explicit fill policy,
`$rolling` aggregates over a window measured in **time** rather than in rows,
and `$asof` answers "what was current when this happened" for every left row.
Each is a call into [`@jarenjs/core/series`](../core/README.md) and nothing
else — the same kernel a chart and an indexed database read.

The second operand is a **verbatim literal**, not an expression, and that is
what makes it checkable: the width, the aggregate, the fill policy and the row
selectors are read once when the query compiles, so an unknown member, a bad
duration or a wildcard where a selector belongs is `JQ0003` with the near miss
named. Only what the *data* decides — a row that is not a sample, an instant
that names none — is `JQ2001`. A left row with no as-of match keeps
`right: null` and **stays in the answer**: no match is data.

```javascript
queryJson({ $asof: ['$.trades[*]', '$.quotes[*]',
  { by: '$.symbol', direction: 'backward', tolerance: 'PT1M' }] }, data);
```

Instants are epoch milliseconds on both sides; `$epoch` and `$datetime` are the
conversions, and a row that spells its instant elsewhere is read with a
selector (`{ at: '$.on' }`) rather than rewritten first. Calendar widths need a
wall clock: UTC and `{ offset }` need nothing, and a **named zone needs an
injected `zoneProvider`** — this suite bundles no time-zone database, and a
document that asked for one without it is refused rather than quietly answered
in UTC. Nothing here reads a clock: there is no `$now`, for the same reason
§8.13 has no `current-dateTime`.

### External parameters

A variable no phrase binds is an **external**: use is the declaration. The compiled query exposes the collected names and takes bindings at call time:

```javascript
const cheaper = compileJsonQuery({
  $for: { b: '$.store.book[*]' },
  $where: { $le: ['$b.price', '$maxPrice'] },
  $return: '$b.title',
});

cheaper.externals;                    // ['maxPrice']
cheaper(data, { maxPrice: 9 });       // [ 'Sayings of the Century', 'Moby Dick' ]
```

The compiled function also carries `query.first(data, externals)`, `query.exists(data, externals)` and `query.doc` (a frozen copy of the query document). `query.items(data, externals)` preserves sequence item boundaries (including singleton arrays); `createQueryAccumulator` from `@jarenjs/json/query` supplies the same ordered aggregate state to streaming hosts. Results come back as plain JSON: `undefined` for the empty sequence, the item for a singleton, an array for anything longer. `queryJson(doc, data, externals)` is the cached one-call form.

### XQuery semantics, stated deviations

Wherever this format does not explicitly deviate, **XQuery 3.1 defines the behavior** — sequences flatten, comparisons are existential, `$where` takes the effective boolean value, `$groupby` is XQuery `group by`. The deviations are few, numbered, and normative ([QUERY-FORMAT.md §11](./docs/QUERY-FORMAT.md#11-deviations-from-xquery-31)): D1 all numbers are IEEE doubles, D2 `$eq` is deep structural JSON equality, D3 the EBV of an object/array is `true`, D4 `$for` unpacks array items one level, D5 regexes are I-Regexp not XSD, D6 all positions are 0-based, D7 fixed clause order.

> **The two filter dialects.** A filter inside a path string (`"$.a[?@.b == @.c]"`) keeps **RFC 9535 semantics**, where two missing members compare equal (`Nothing == Nothing` is true). The same comparison at query level (`{"$eq": ["$x.b", "$x.c"]}`) keeps **XQuery semantics**, where a comparison over empty sequences is `false`. Both dialects are conformant to their own standard; the spec documents the split in [§5.2](./docs/QUERY-FORMAT.md#52-the-two-filter-dialects) and query variables are deliberately not visible inside path filters — a predicate that needs two variables belongs in `$where`.

### Errors carry a docPath

Compile errors (`JsonQueryCompileError`, codes `JQ0xxx`) and runtime errors (`JsonQueryRuntimeError`, codes `JQ2xxx`) both carry a stable `code` and a `docPath` — an RFC 6901 JSON Pointer **into the query document** locating the offending construct (e.g. `/$where/$eq/1`). Unknown operators come with a "did you mean" suggestion.

### The schema twins

The complete structural grammar of the language is published as JSON Schema, twice:

- [`schemas/jaren-query.schema.json`](./schemas/jaren-query.schema.json) — canonical, draft 2020-12;
- [`schemas/jaren-query.draft-07.schema.json`](./schemas/jaren-query.draft-07.schema.json) — a mechanically derived draft-07 twin.

Both exist because the schema is authored in a draft-neutral keyword subset (no `$ref` siblings, no `unevaluated*`, no tuples), so ecosystems pinned to draft-07 — several structured-output stacks among them — get an identical grammar for one `$defs`→`definitions` rename. Every fixture in the test suite validates under both drafts.

### GeoJSON, fully validated

The same machinery answers a problem the geospatial ecosystem has lived with for years. The [official GeoJSON JSON Schema](https://github.com/geojson/schema) states that it **cannot** express that a linear ring is closed, or that rings follow RFC 7946's right-hand rule — neither is a structural property — so every validator bolts on custom code, and unclosed rings and reversed winding (which makes a renderer fill the entire globe) remain among the commonest defects in real data.

Three artifacts ship here:

- [`schemas/geojson.schema.json`](./schemas/geojson.schema.json) — **portable**: plain draft-neutral JSON Schema, no Jaren extension, usable by any validator;
- [`schemas/geojson.draft-07.schema.json`](./schemas/geojson.draft-07.schema.json) — its mechanically derived draft-07 twin;
- [`schemas/geojson.jaren.schema.json`](./schemas/geojson.jaren.schema.json) — the same grammar plus the two missing invariants, expressed with [`$query`](../validate).

The Jaren artifact is a mechanical *restriction* of the portable one — structurally identical, with a `$query` on the `polygon` and `multiPolygon` definitions — so the two cannot drift, and a consumer without `$query` support still gets the standard grammar. Ring closure is `$eq` of the first and last position; winding is the sign of the shoelace sum, computed with `$fold`:

```javascript
import { JarenValidator } from '@jarenjs/validate';

const unclosed = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
new JarenValidator().compile(portableSchema)(unclosed);  // true  — structurally fine
new JarenValidator().compile(jarenSchema)(unclosed);     // false — the ring never closes
```

The test suite pins six defect classes that slip past structural validation and are caught here, including one buried inside a `FeatureCollection`.

## Generating queries with LLMs

A query language whose entire grammar is one JSON Schema is a natural fit for **constrained decoding** — the structured-output mode of every major LLM API. Hand the schema to the provider and the model cannot emit an unknown operator, a three-argument `$eq`, or a mixed `$`/plain-key object; what remains is validated and compiled in two lines, and every failure carries a `docPath` you can feed back to the model for repair:

```javascript
import { readFile } from 'node:fs/promises';
import { JarenValidator } from '@jarenjs/validate';
import { compileJsonQuery } from '@jarenjs/json';

const schema = JSON.parse(await readFile('packages/json/schemas/jaren-query.schema.json', 'utf8'));

const text = await generate(prompt, schema); // your provider's structured-output call

const isQueryDoc = new JarenValidator().compile(schema);
const doc = JSON.parse(text);
if (!isQueryDoc(doc)) throw new Error('model escaped the schema');
const query = compileJsonQuery(doc);         // JsonQueryCompileError.docPath on the residue
query(data);                                 // JsonQueryRuntimeError.docPath at runtime
```

The validate step is not redundant: provider structured-output implementations support varying JSON Schema subsets regardless of the draft they declare (`patternProperties` and `propertyNames`, which the schema uses for binding names and map constructors, are not universally enforced, and strict modes often reject `oneOf`). Validating locally catches whatever the provider's subset let through.

For those strict subsets each grammar also ships an **LLM profile** — [`jaren-query.llm-profile.schema.json`](./schemas/jaren-query.llm-profile.schema.json) and [`jaren-jslt.llm-profile.schema.json`](./schemas/jaren-jslt.llm-profile.schema.json) — a mechanically derived, pure *relaxation* of the canonical artifact: `patternProperties`, `propertyNames` and asserted `format`s are removed (each restated in the nearest `description`, which the model still reads) and every `oneOf` becomes `anyOf`. That last swap costs no precision: the canonical grammar discriminates its branches by member name — a map constructor has no `$`-prefixed key, every phrase pins its own (`$const`, `$map`, `$call`, `$return`, …) or draws its single key from a disjoint operator enum — so at most one branch can ever match a document, and exactly-one and at-least-one accept the same language. It is also *required* once the name constraints are gone: `oneOf` would then reject `{"$eq": [1, 2]}` for matching two now-overlapping branches. Every canonical-valid document validates under the profile; the reverse is deliberately not guaranteed, which is exactly why the local validate-then-compile step above stays mandatory. Hand the profile to the provider's constrained decoder, validate locally against the canonical schema. (Tangle's `createStructuredOutput` packages this handshake.)

A relaxation, though, is not a *shrink*: restating every removed constraint in a `description` means the JSLT profile is 19,158 characters against the canonical 18,817, and on a small model an oversized `response_format` is the difference between a document and an empty reply. So the JSLT grammar also ships an **authoring profile** — [`jaren-jslt.authoring.schema.json`](./schemas/jaren-jslt.authoring.schema.json), **3,491 characters** — the same mechanical derivation with one more step: the `queryDocument` `$ref` that pulls the entire expression language into the document grammar is left *open*. What survives is the document shape (envelope, rules, match specs, modes); what leaves is the full set of phrase shapes. It is a pure widening of the canonical language, so nothing the engine can run becomes inexpressible, and it is deliberately weaker — a body of pure nonsense decodes under it. That is the trade, and it is only safe because the two authorities after the decoder are unchanged: validate against the canonical schema, then compile. The vocabulary the cut removes belongs in the prompt instead, where Tangle's `operatorCrib` puts it (operator names grouped by arity, ~1.1 kB, read off the query artifact). Tangle's [`createStylesheetAuthor`](https://github.com/jklarenbeek/tangleai/blob/main/packages/jaren/docs/AUTHORING.md) packages the whole handshake.

Query documents are plain JSON, so they travel through the rest of an LLM toolchain as-is: function-call arguments, retrieval filters, audit logs, replay.

## The XQuery text front-end

`@jarenjs/json/xquery` ships `parseXQuery(text)`, a parser for a defined subset of XQuery 3.1 *text* syntax that emits Jaren JSON Query documents — a human authoring syntax and the compatibility bridge that makes W3C QT3 test material runnable against the engine (see `benchmark/qt3-runner.js`, `npm run benchmark:qt3`). It is not a second engine: the output is always a query document, and where the two languages disagree, the JSON format wins. Subset boundaries, the 1-based/0-based adjustment rules and the function mapping table are documented in [docs/XQUERY-FRONTEND.md](./docs/XQUERY-FRONTEND.md).

```javascript
import { compileXQuery } from '@jarenjs/json/xquery';

const q = compileXQuery('for $b in $doc?store?book?* where $b?price lt 10 return $b?title');
q(null, { doc: data }); // [ 'Sayings of the Century', 'Moby Dick' ]
```

## Query benchmark

`npm run benchmark:jsonquery` runs the scenario matrix against [fontoxpath](https://www.npmjs.com/package/fontoxpath) (a real XQuery 3.1 engine in JavaScript — the closest honest comparison) and [jsonata](https://www.npmjs.com/package/jsonata) (the popular practical alternative), asserting result equivalence on every document before timing anything. Each engine runs the same scenario written idiomatically in its own language (`benchmark/adaptors/jsonquery/`).

Measured with `npm run benchmark:jsonquery:profile` (2026-07-27, Node v22.22.2; ratios are that engine's time over Jaren's):

| Scenario | Jaren | fontoxpath 3.34 | jsonata 2.2 |
|---|---|---|---|
| **4-book bookstore** | | | |
| singular access `$b.title` | 451 ns (2.2M/s) | 12.0 µs (27x) | 7.3 µs (16x) |
| filter + project (spec A.2) | 3.6 µs (281k/s) | 60.6 µs (17x) | 26.2 µs (7.4x) |
| join (spec A.3) | 3.4 µs (291k/s) | 102.0 µs (30x) | 96.6 µs (28x) |
| group + aggregate (spec A.4) | 4.4 µs (229k/s) | n/a | 52.6 µs (12x) |
| deep reshape | 2.4 µs (426k/s) | 173.1 µs (74x) | 55.8 µs (24x) |
| **10,000-book bookstore** | | | |
| singular access | 324 ns (3.1M/s) | 9.0 µs (28x) | 4.6 µs (14x) |
| filter + project | 1.33 ms | 343.2 ms (259x) | 70.4 ms (53x) |
| join (measured at 1,000 books) | 331 µs | 1.64 s (4952x) | 1.71 s (5175x) |
| group + aggregate | 2.47 ms | n/a | 37.9 ms (15x) |
| deep reshape | 3.51 ms | 452.0 ms (129x) | 117.0 ms (33x) |
| **compile, µs per query** | 37.4 µs | 562.5 µs (15x) | 118.3 µs (3.2x) |

Honest caveats — what each competitor is optimized for:

- **fontoxpath** is an XML-first XPath/XQuery engine; JSON rides on XDM maps and arrays. The benchmark pre-converts each document to XDM *once, outside the timed loop* (per-call conversion would cost ~12 ms alone at 10k books), and fontoxpath has no public compile-only API, so its compile number is fresh-source evaluation minus cached re-evaluation. It does not implement `group by`. Its engineering effort goes into DOM navigation, buckets and XQuery Update — not JSON throughput.
- **jsonata** is a tree-walking interpreter whose `evaluate()` is async since 2.x; its numbers include that promise overhead because its API imposes it. It is optimized for expressiveness and embeddability, not raw speed.
- **Jaren**'s compile number includes `JSON.parse` of the query text, since the competitors parse text too.
- The join row is the one place these engines are not doing the same work, and the four-digit ratio says so rather than hiding it. fontoxpath and jsonata run it as a naive O(books × ratings) nested loop; Jaren's planner recognizes the uncorrelated equijoin and answers it from a hash table, which is O(books + ratings). At four books that is worth nothing (3.4 µs against 96–102 µs, the same 28–30x as every other small-document row); at 1,000 books it is the whole difference. Read the 4,952x as "different algorithm", not "faster engine" — and note the rewrite is declined whenever it would be observable (a `$as`, a `$let`, a correlated probe side), in which case Jaren runs the same nested loop they do. The row stays capped at 1,000 books because raising it would grow their cost quadratically and Jaren's linearly, measuring the cap instead of the engines.
- The 4-book `singular` cell reads slower than the 1,000-book one (451 ns vs 335 ns) run to run. That is JIT/IC noise across the cell sequence, not a real cost curve; pinning it down is a `--cell-order` shuffle on the roadmap.

## JSLT — declarative JSON transformation

JSLT adds XSLT-style recursive template dispatch without adding another data language: **match = JSONPath, type = JSON Schema, produce = Jaren queries**. A rule can select by position, by shape, or by both; a schema is therefore a pattern, compiled through the same type-test hook as `$valid`/`$assert`/`$as`. The normative contract is [JSLT-FORMAT.md](./docs/JSLT-FORMAT.md).

The small-but-important use case is a surgical override. Unmatched containers recurse into their children and return the original object when every child is unchanged, so unrelated subtrees remain shared:

```javascript
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

const applyVat = compileJsltStylesheet([
  { match: '$..price', body: { $mul: ['$', 1.21] } },
]);

const input = {
  catalog: { books: [{ title: 'A', price: 10 }] },
  meta: { publisher: 'N' },
};
const output = applyVat(input);
// output.catalog.books[0].price === 12.1
// output.meta === input.meta
```

Modes walk the same source through independent rule sets. Here the root applies the section list once as a table of contents and once as rendered body content:

```javascript
const renderGuide = compileJsltStylesheet({
  $jslt: '0.1',
  rules: [
    {
      match: '$',
      body: {
        toc: [{ $apply: ['$.sections[*]', 'toc'] }],
        body: [{ $apply: ['$.sections[*]', 'render'] }],
      },
    },
    {
      mode: 'toc',
      match: '$.sections[*]',
      body: { ref: '$.id', label: '$.heading' },
    },
    {
      mode: 'render',
      match: '$.sections[*]',
      body: { anchor: '$.id', text: '$.text' },
    },
  ],
});

renderGuide({
  sections: [{ id: 'intro', heading: 'Introduction', text: 'Start here.' }],
});
// { toc: [{ ref: 'intro', label: 'Introduction' }],
//   body: [{ anchor: 'intro', text: 'Start here.' }] }
```

The brackets around each `$apply` are deliberate: an object member holds one value, while `$apply` returns a sequence. `children: [{ $apply: '$.children[*]' }]` uses the query array-constructor rule to collect that sequence into an array; the bare member form fails when two or more children are produced.

The default unmatched disposition is `share`: unchanged containers retain `===` identity with the input. Use envelope-level `"unmatched": "fresh"` when the caller needs an independently mutable tree; use `"error"` for exhaustive dispatch. Rule-body outputs and path results still follow query-engine sharing semantics.

Shape matches and schema operators need the validator bridge at application wiring time—the JSON package itself remains validator-independent:

```javascript
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const annotateBooks = compileJsltStylesheet([
  {
    match: {
      schema: { type: 'object', required: ['title', 'author'] },
    },
    body: {
      title: '$.title',
      byline: { $concat: ['$.title', ' by ', '$.author'] },
    },
  },
], { compileTypeTest: createTypeTestCompiler() });
```

For render-loop consumers there is one more lever: `compileJsltStylesheet(doc, { memo: true })` memoizes rule outputs by (location, value reference). A compile-time analysis marks every rule whose output provably depends on nothing but the matched value (no `$root`/`$path`/user externals, transitively through `$apply`, and no root references inside match-path filters); those rules return their previous output **by reference** when the same subtree reference shows up at the same location. Across copy-on-write updates an unchanged document transforms in O(1) and a one-field change re-evaluates one spine — the fuel for the `@jarenjs/view` patcher's reference-equality fast path, which is why `@jarenjs/app` compiles every view with it. The cache is two-generational (entries unused for one transform retire), and memoized outputs must be treated as immutable.

The complete stylesheet grammar is published for validators and LLM constrained decoding as [`jaren-jslt.schema.json`](./schemas/jaren-jslt.schema.json) (draft 2020-12) and its mechanically derived [`jaren-jslt.draft-07.schema.json`](./schemas/jaren-jslt.draft-07.schema.json) twin. Rule-body definitions are mechanically copied from the query artifact and extended only with `$apply`, so the query vocabulary stays closed. Provider structured-output implementations still support uneven schema subsets; validate the generated document locally before compiling it, as described in [JSLT-FORMAT Appendix B](./docs/JSLT-FORMAT.md#appendix-b-llm-structured-output-non-normative).

### JSLT benchmark

`npm run benchmark:jslt` asserts result equivalence before timing Jaren against a hand-written recursive JavaScript transform and JSONata's transform operator. Measured with `npm run benchmark:jslt:profile` (2026-07-17, Node v24.14.0; competitor ratios are competitor time over Jaren):

| Scenario | Jaren JSLT | native JS | jsonata 2.2 |
|---|---:|---:|---:|
| **4-book bookstore** | | | |
| identity (`share`) | 81 ns | 2.04 µs (25.3x) | 14.60 µs (180x) |
| surgical prices | 9.15 µs | 1.09 µs (0.12x) | 90.13 µs (9.8x) |
| reshape + modes | 8.70 µs | 431 ns (0.050x) | n/a |
| fresh schema annotation | 3.50 µs | 911 ns (0.26x) | 136.92 µs (39.1x) |
| **10,000-book bookstore** | | | |
| identity (`share`) | 24 ns | 3.41 ms (143,482x) | 13.52 ms (569,663x) |
| surgical prices | 23.17 ms | 2.00 ms (0.086x) | 152.48 ms (6.6x) |
| reshape + modes | 20.01 ms | 137.36 µs (0.007x) | n/a |
| fresh schema annotation | 6.40 ms | 1.73 ms (0.27x) | 277.33 ms (43.4x) |
| **document-independent** | | | |
| compile, per stylesheet | 33.16 µs | n/a | 70.50 µs (2.1x) |

The identity row is the sharing fast path: Jaren returns the input reference in O(1), while native and JSONata deep-copy. On actual transformations, hand-written JavaScript is 3.4–143x faster because it is bespoke code with no matcher, rank table, mode, schema, or error machinery—the honest cost of the abstraction. Jaren is 6.6–45x faster than JSONata where the transform operator can express the scenario; reshape+modes is `n/a`, not silently replaced by a different JSONata feature. JSONata 2.x timings include its required promise overhead and transform-copy cost. Scaled prices are rounded to cents because JSONata's copy normalizes long binary decimal tails and these scenarios do not sort. fontoxpath is excluded because it has XPath/XQuery but no XSLT dispatcher; Saxon-JS is excluded as a heavyweight SEF/XSLT toolchain for this benchmark workspace.

## JTLT — template-driven text output

The [JTLT pen](../linq/docs/JTLT-PEN.md) authors portable templates. The
[published grammar](./schemas/jaren-jtlt.schema.json) and its
[draft-07 twin](./schemas/jaren-jtlt.draft-07.schema.json) check structure;
`validateJtltTemplate(doc, options)` returns compiler diagnostics as `{ valid, errors }`.

JSLT transforms JSON into JSON. JTLT points the same dispatcher at **text**: a template is a JSLT-shaped rule document whose bodies are *segment lists* — literal text, interpolated queries, and `$apply` splices — and whose result is a string. It is the T4/XSLT-`method="text"` analogue of this stack, and like the XQuery module it is a **front-end, not a second engine**: `compileJtltStylesheet` desugars the template into an ordinary JSLT 0.1 stylesheet (inspectable as `render.stylesheet`) and serializes the dispatched result, so dispatch, modes, conflict resolution and schema matching are inherited, not reimplemented. The normative contract is [JTLT-FORMAT.md](./docs/JTLT-FORMAT.md); this section is the tour.

```javascript
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';

const listBooks = compileJtltStylesheet([
  { match: '$', body: ['# Books\n', { $apply: '$.store.book[*]' }] },
  { match: '$.store.book[*]', body: ['- ', '$.title', ' (', '$.price', ')\n'] },
]);

listBooks(data);
// '# Books\n' +
// '- Sayings of the Century (8.95)\n' +
// '- Sword of Honour (12.99)\n' + ...
```

Segments follow the query format's own string rules: a string is literal text unless it starts with `$` (a query expression, interpolated), and `"$$x"` escapes the literal text `"$x"`. Objects are operator phrases evaluated as expressions; three forms are special at segment level: `{ "$apply": ... }` splices the dispatched output of other rules in place, `{ "$raw": e }` interpolates without escaping, and `{ "$json": e }` embeds data as `JSON.stringify` text. Sequence-valued interpolations join with a single space (the XSLT `value-of` separator default), the empty sequence renders nothing, and interpolating an object or array is a runtime error that names the offending segment — dispatch into containers with `$apply` instead.

The envelope's `output` member selects the serialization method. `"text"` (the default) writes everything raw; `"xml"` escapes interpolated data while literal template text stays raw markup — the XSLT/T4 contract exactly:

```javascript
const toXml = compileJtltStylesheet({
  $jtlt: '0.1',
  output: 'xml',
  rules: [
    { match: '$', body: ['<books>', { $apply: '$.store.book[*]' }, '</books>'] },
    { match: '$.store.book[*]', body: ['<book title="', '$.title', '"/>'] },
  ],
});

toXml(data);
// '<books><book title="Sayings of the Century"/>...</books>'
// interpolated data is XML-escaped; literal markup passes through raw
```

Unmatched nodes follow the XSLT built-in template rules, restated for JSON: containers apply templates to every child in document order, atoms emit their (method-escaped) string value — so `{ $apply: '$.title' }` doubles as a value-of with rule-override capability. A matchless rule replaces that default; `priority` conflicts resolve exactly as in JSLT, with the band at and below `-1e307` reserved for the built-ins. Modes, schema matches (via `options.compileTypeTest`), user externals and the reserved `$root`/`$path` parameters all work as in JSLT. Compile and runtime errors carry stable `TL`-prefixed codes and a `docPath` into the **template** document (engine errors are remapped from the compiled stylesheet back to the author's source). `renderText(template, data, externals?)` is the cached one-call form.

## Roadmap

Open work lives in the repository-wide [ROADMAP](../../docs/ROADMAP.md), under the remaining `@jarenjs/json` sections. Function values are deliberately outside the JSON item model: use FLWOR for map/filter/fold and projection ordering, with named host functions and collations for host extensions.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.json-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/json` | JavaScript | declared |
| `@jarenjs/json/basic` | JavaScript | declared |
| `@jarenjs/json/canonical` | JavaScript | declared |
| `@jarenjs/json/node` | JavaScript | declared |
| `@jarenjs/json/pointer` | JavaScript | declared |
| `@jarenjs/json/path` | JavaScript | declared |
| `@jarenjs/json/patch` | JavaScript | declared |
| `@jarenjs/json/write` | JavaScript | declared |
| `@jarenjs/json/query` | JavaScript | declared |
| `@jarenjs/json/jslt` | JavaScript | declared |
| `@jarenjs/json/jtlt` | JavaScript | declared |
| `@jarenjs/json/xquery` | JavaScript | declared |
| `@jarenjs/json/schemas/geojson.draft-07.schema.json` | schema | — |
| `@jarenjs/json/schemas/geojson.jaren.schema.json` | schema | — |
| `@jarenjs/json/schemas/geojson.schema.json` | schema | — |
| `@jarenjs/json/schemas/jaren-jslt.authoring.schema.json` | schema | — |
| `@jarenjs/json/schemas/jaren-jslt.draft-07.schema.json` | schema | — |
| `@jarenjs/json/schemas/jaren-jslt.llm-profile.schema.json` | schema | — |
| `@jarenjs/json/schemas/jaren-jslt.schema.json` | schema | — |
| `@jarenjs/json/schemas/jaren-jtlt.draft-07.schema.json` | schema | — |
| `@jarenjs/json/schemas/jaren-jtlt.schema.json` | schema | — |
| `@jarenjs/json/schemas/jaren-query.authoring.schema.json` | schema | — |
| `@jarenjs/json/schemas/jaren-query.draft-07.schema.json` | schema | — |
| `@jarenjs/json/schemas/jaren-query.llm-profile.schema.json` | schema | — |
| `@jarenjs/json/schemas/jaren-query.schema.json` | schema | — |
| `@jarenjs/json/package.json` | metadata | — |
| `@jarenjs/json/formula` | JavaScript | declared |
| `@jarenjs/json/formula/batch` | JavaScript | declared |
| `@jarenjs/json/formula/migrate` | JavaScript | declared |
| `@jarenjs/json/rules` | JavaScript | declared |
<!--/fact-->

## Development

Unit tests live in `test/json/` at the repository root (`npm run test:json`); the JSONPath tests are built from the RFC's own examples, the query and JSLT tests from their normative fixtures (each schema corpus validates against both artifact drafts), and every example in this README runs in `test/json/readme-examples.test.js`. This package's internals are described in its own [ARCHITECTURE](./ARCHITECTURE.md) document. Benchmarks (all documented in the [benchmark workspace README](../../benchmark/README.md)): `benchmark/jsonpath.js` (JSONPath compliance + performance), `benchmark/jsonpointer.js` (compiled pointers vs the interpretive resolver and the `jsonpointer` npm package), `benchmark/jsonquery.js` (query engine vs fontoxpath/jsonata), `benchmark/jslt.js` (stylesheet engine vs native JS/JSONata), `benchmark/qt3-runner.js` (W3C QT3 scorecard through the XQuery front-end). See the repository [README](../../README.md) and [ARCHITECTURE](../../docs/ARCHITECTURE.md) for the monorepo picture.

## Saved formulas and reviewed plans

`./formula`, `./formula/batch`, `./formula/migrate` and `./rules` compile saved JSON Query profiles, bounded per-cell outcomes, explicit source migrations and immutable reviewed plans. Schema/helper versions and current command authority are explicit. See [FORMULA-FORMAT](docs/FORMULA-FORMAT.md) for the normative contract and measured refusals.
