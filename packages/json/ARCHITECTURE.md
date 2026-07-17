# @jarenjs/json Architecture

This document describes the internals of `@jarenjs/json` for contributors: the JSON Pointer compiler, the RFC 9535 JSONPath compiler, the Jaren JSON Query engine with its XQuery text front-end, and the JSLT stylesheet dispatcher layered over the query compiler. The user-facing story is in the [README](./README.md); the language contracts are [docs/QUERY-FORMAT.md](./docs/QUERY-FORMAT.md) and [docs/JSLT-FORMAT.md](./docs/JSLT-FORMAT.md).

Everything here follows the house architecture of the schema validator (see [`packages/validate/ARCHITECTURE.md`](../validate/ARCHITECTURE.md)): **two-stage compilers** — parse and normalize once into an AST, then compile the AST into specialized closures with every decidable decision made at compile time. No `eval`, no `new Function` (CSP-safe), no allocation on hot paths, monomorphic closures wherever the engine can arrange it.

## Module map

| File | Purpose |
|------|---------|
| `src/basic.js` | string validation for JSON, JSON Pointer, JSONPath (`isValidJSON`, `isValidJSONPointer`, `isValidJSONPathStrict`, ...) |
| `src/pointer.js` | the RFC 6901 + Relative JSON Pointer compiler (`compileJSONPointer`, `compileRelativeJSONPointer`, `compileDataRef`) and the write-side encode (`encodeJSONPointerSegment`, `formatJSONPointer`) |
| `src/patch.js` | JSON Patch (RFC 6902) + JSON Merge Patch (RFC 7396): compiled copy-on-write appliers and the structural diffs |
| `src/path.js` | the JSONPath compiler: parser, nodes-mode compilers (normalized paths), public API |
| `src/segments.js` | package-internal runtime segment machinery shared by `path.js` and the query engine (not exported) |
| `src/query/errors.js` | `JsonQueryCompileError` / `JsonQueryRuntimeError` with `code` + `docPath` |
| `src/query/runtime.js` | the tagged sequence representation (`EMPTY` / raw item / `Seq`), EBV, `stableKeyString` |
| `src/query/normalize.js` | query document → frozen AST: all `JQ0xxx` checks, scopes, slots, externals, cardinality |
| `src/query/compile.js` | AST → closures: expressions, FLWOR tuple streams, quantifiers |
| `src/query/operators.js` | the operator registry: all §8 operators as one `name → {params, result, compile}` table |
| `src/query/index.js` | public API: `compileJsonQuery`, `queryJson`, result unwrapping, caches |
| `src/jslt/stylesheet.js` | frozen stylesheet normalization: closed shapes, modes, dispositions, priorities |
| `src/jslt/dispatch.js` | match/body compilation, lazy path pre-passes, ranked dispatch, built-in rules |
| `src/jslt/errors.js` | `JsltCompileError` / `JsltRuntimeError` with `code` + stylesheet `docPath` |
| `src/jslt/index.js` | public API: `compileJsltStylesheet`, `transformJson`, result unwrapping, cache variants |
| `src/xquery/parse.js` | the XQuery text front-end: `parseXQuery(text)` → query document |
| `src/xquery/index.js` | `parseXQuery`, `compileXQuery`, `XQuerySyntaxError` |

Dependency direction: `basic.js` stands alone; `pointer.js` shares only the `NOTHING` sentinel and the array-index scanner from `segments.js`; `patch.js` builds on the pointer parser and the same two segment helpers; `path.js` builds on `segments.js`; the query engine builds on `segments.js` (paths) and `runtime.js`; JSLT consumes the query normalizer/compiler through its package-internal extension point and the nodes-mode segment runner; the XQuery front-end emits query documents and depends only on the JSON format, never on engine internals. `@jarenjs/core` supplies char-code scanning, `equalsJson`, code-point helpers and I-Regexp compilation. JSON Schema remains an injected predicate hook: `@jarenjs/validate/query` may wire into query/JSLT, but this package never imports the validator.

## The two-stage pipeline

All compilers in this package have the same shape:

```
source ──[stage 1: parse / normalize]──► frozen AST ──[stage 2: compile]──► closure tree ──► run(data)
```

Stage 1 owns *all* static errors: the JSONPath parser is a single-pass, character-level recursive-descent parser (the `fail(message, position)` idiom, `JSONPathSyntaxError`), and the query normalizer raises every `JQ0xxx` compile error with a `docPath`. Stage 2 never re-checks structure; it specializes: selector kinds, slice bound arithmetic, comparison operators, literal regexes, operator arities and cardinality fast paths are all resolved before the first document is seen. A compiled query closes over nothing mutable and is reusable across documents and calls.

### JSON Pointer: segment-count specialization

`pointer.js` follows the pipeline in miniature. The strict parsers (`parseJSONPointer`, `parseRelativeJSONPointer`) are single-pass char-code scanners with a lazy-decode fast path: an escape-free segment is a direct slice, and only segments containing `~` build a decoded string. The compilers pre-decode every member name and pre-parse every array index (one segment, two forms — RFC 6901 lets `"2"` address both a `"2"` member and array element 2), then specialize the getter by segment count (0 = identity, 1 and 2 = unrolled hops, N = a loop over parallel name/index arrays). A relative pointer trims its level count off the runtime location by scanning **backwards** for the N-th `/` — no split, no arrays — and resolution returns the `NOTHING` sentinel shared with `segments.js`, so pointer and JSONPath results compose. Nothing is allocated on any resolution path.

### JSON Patch: compiled operations over copy-on-write

`patch.js` runs the pipeline over *two* documents: the patch compiles once, the data document is what varies per call. Stage 1 (`compileJSONPatch`) owns all `JP0xxx` errors — operation shapes, unknown ops, pointer syntax (wrapping the `JSONPointerSyntaxError` as `cause`), the move `from`-is-prefix-of-`path` rule — each with a `docPath` into the patch document. Every `path`/`from` is pre-parsed into decoded member names alongside pre-scanned array indexes (the pointer compiler's one-token-two-forms rule), with the last token split off for the mutating operations, and each operation becomes one closure with its error strings pre-bound.

Stage 2 is a copy-on-write interpreter of those closures. An application carries `{root, owned}` where `owned` is the set of nodes this application created: the first write along a path shallow-clones the spine from the root and registers the clones; later writes find the spine in the set and mutate in place. Consequences: the input is never touched (RFC 6902's atomic-application requirement costs nothing — a failing op just abandons the state), untouched subtrees are shared with the result (the JSLT `share` discipline), and k operations through one region cost one spine copy. `copy` deep-clones its source only when the subtree contains owned nodes (otherwise the inserted alias could be mutated through by a later operation); `mutate: true` sets `owned = null` (everything owned, nothing cloned) and then forces per-application deep copies of inserted values, since in-place results must not share structure with the patch document. Object member writes go through the `setMember`/`__proto__` discipline of the query engine, and the object shallow clone relies on spread's `CreateDataProperty` semantics for the same reason.

`test` and `copy`-reads never clone — they run a plain pre-compiled walk against the current root. The merge-patch side (`compileMergePatch`) pre-splits each patch level into remove/set/merge plans and applies them identity-preservingly: a level that changes nothing returns its target by reference, which makes a no-op merge return the input document itself. The structural diffs (`createJSONPatch`, `createMergePatch`) share `equalsJson`; the array diff trims the deep-equal common prefix/suffix and recurses index-wise over the overlap — linear and minimal for in-place edits and head/tail insertions, correct-but-larger for mid-array reorderings (an LCS mode is future work).

### JSONPath: parser, segments, two output modes

`path.js` keeps the grammar (strict RFC 9535: leading-zero rules, integer bounds, filter well-typedness) and the public API. The runtime machinery lives in `segments.js` so the query engine can reuse it: `compileSingularGetter` (the zero-allocation property-walk for singular queries), `compileSegmentV`/`descendV` (values-mode segment closures), `compileExists` (existence tests that skip nodelist construction), the filter expression compilers, and the `NOTHING` sentinel (exported publicly as `JSONPATH_NOTHING`).

Values mode is the default and the fast path; nodes mode (normalized paths for `query.nodes()`/`query.paths()`) is compiled **lazily on first use**, so value-only queries never pay for path-string production.

## The query engine

### The sequence representation

XQuery evaluates everything to a *sequence*, but JSON arrays are themselves items, so the representation must never confuse "a sequence of three numbers" with "an array of three numbers". The engine uses a tagged representation (`runtime.js`) that also makes the overwhelmingly common singleton case allocation-free:

| Sequence | Representation |
|---|---|
| empty `()` | the exported `EMPTY` symbol |
| singleton | the raw item itself — no wrapper ("singleton ≡ item", spec §2.1) |
| two or more items | a `Seq` instance wrapping a flat items array |

`Seq`s are always flat (never contain `Seq`, `EMPTY`, or fewer than two items); all construction goes through `seqOf`/`appendItem`, which maintain the invariant. The representation **never escapes the module**: `index.js` maps results to plain JSON (`EMPTY` → `undefined`, singleton → the item, `Seq` → its items array).

### Cardinality analysis

At normalize time every AST node gets a static cardinality upper bound: `ZERO`, `ONE` (exactly one item), `OPT` (zero or one), or `MANY`. Literals, constructors, comparisons, logic and `$concat` are `ONE`; singular paths are `OPT`; non-singular paths, `$for`/`$groupby` phrases and `$range` are `MANY`; arithmetic joins its operands (`ONE` only when all operands are `ONE`, because empty propagates). The compiler consumes the bounds everywhere a general code path can collapse into a specialized one — see [Where the fast paths are](#where-the-fast-paths-are).

### Frames and slots

Variables never live in dictionaries. Normalization runs a single slot allocator over every binding site (`$for`, `$let`, `$at`, `$count`, `$groupby` names, quantifier bindings) *and* every external parameter; evaluation allocates **one flat frame array** per call, with slot 0 holding the input document and externals written once up front (`UNBOUND` sentinel for missing ones, checked at reference time → `JQ2006`).

Scoping is entirely compile-time: a linked chain of `{name, slot, card, parent}` records. Shadowing is chain order; a nested phrase extends the chain and owns fresh slots. Compiled variable references address their slot by constant index — no lookup, no closure-captured environments.

### FLWOR: streaming clauses, blocking clauses, liveness

A FLWOR phrase compiles to a chain of nested `(frame, out) → void` closures. **There are no tuple objects**: a tuple *is* the current state of the frame slots. Clauses apply in the spec's fixed semantic order (`$for → $let → $where → $groupby → $orderby → $count → $return`) regardless of JSON key order.

Streaming clauses never materialize the tuple stream:

- `$for` iterates its source sequence (with the spec's D4 one-level array unpacking), rebinding its slot per tuple; multiple bindings nest left-to-right and may be correlated. The `$at` positional form keeps a per-activation 0-based counter.
- `$let` writes its slot once per surrounding tuple.
- `$where` gates the chain on the effective boolean value.
- `$count` numbers surviving tuples through its own frame slot (reset per phrase evaluation — safe because a phrase cannot re-enter within one frame).

`$groupby` and `$orderby` are **barriers** — they must see the whole stream — but they snapshot only the **live** slots. At normalize time `collectReadSlots` walks the downstream AST ( `$orderby` keys, `$return`) and intersects the phrase's binding slots with what is actually read:

- `$orderby` runs a Schwartzian sort: each surviving tuple appends a `[key₁, ..., keyₙ, snapshot]` row, `Array.prototype.sort` (stable) compares precomputed keys, then the snapshots replay into the frame. Key type errors (`JQ2005`) are raised eagerly at key evaluation; empty keys order per `$empty` (least/greatest as ±∞ before direction).
- `$groupby` accumulates a `Map` from a composite `stableKeyString` key to the group, in first-appearance order; grouping-key variables rebind to the key values, every other live variable rebinds to the *sequence* of its values across the group's tuples.

Quantifier phrases (`$some`/`$every`) compile to early-exit loop nests over the same binding machinery — the first witnessing (or failing) tuple ends evaluation, and later runtime errors are never raised.

### `stableKeyString`

Grouping, `$distinct` and the `$orderby` machinery need a total, deterministic equality that deep-equal JSON values agree on. `stableKeyString(value)` (runtime.js) serializes: strings via `JSON.stringify` (escape discipline guarantees no raw control characters, so `U+0000` safely separates composite keys), numbers bare with `-0` → `'0'` and `NaN`/`Infinity` by name, object keys sorted by code units, arrays and objects in JSON shape. Consequences worth knowing: `NaN` groups with `NaN` (the XQuery grouping rule; `$eq`'s relation — used by `$index-of` — matches nothing for `NaN`), and the two relations differ *only* there. This function is also the natural seed for the roadmap's canonical-JSON (RFC 8785) item.

### The operator registry

All 58 §8 operators live in one table in `operators.js` — the query-language analogue of `path.js`'s `FUNCTIONS` table:

```javascript
'$substring': {
  params: { kinds: ['expr', 'expr', 'expr'], min: 2 }, // shapes checked uniformly by normalize.js
  result: (cards) => ...,                              // static cardinality from argument cardinalities
  compile: (gets, args, docPath) => ...,               // the specialized closure
}
```

`normalize.js` validates every arity and value shape from the table (`JQ0003`), so no operator re-checks its own structure; unknown `$`-keys get a Levenshtein "did you mean" suggestion (`JQ0002`, compile-time error path only). `compile` receives the argument getters *and* the frozen argument AST nodes — that is how `$exists`/`$empty` compile to existence-only tests and how literal `$match`/`$search`/`$replace` patterns become precompiled `RegExp`s at query-compile time. The `raw`/`name` parameter kinds are reserved mechanism for the JSON-Schema-as-type-system operators (`$valid`/`$assert`).

The escape hatches `$const` and `$map` stay outside the registry (they are §3.5 encoding rules, not operators). Note the deliberate import cycles (`operators.js ↔ normalize.js/compile.js` for cardinality helpers and `compileExistsTest`): all cross-module bindings are referenced only inside functions, never at module-evaluation time, so any of the three modules works as the ESM entry point.

### Errors: the `docPath` philosophy

Every error — compile (`JQ0xxx`) and runtime (`JQ2xxx`) — carries a stable `code` and a `docPath`: an RFC 6901 JSON Pointer **into the query document**, not into the data. `{"$where": {"$eq": ["$b.isbn", 42]}}` fails *at* `/$where/$eq/1`. The placement rules: operand-typed errors (`JQ2001`) point at the offending operand; operator-condition errors (`JQ2002` division by zero) point at the operator key; `$orderby` key errors point at the key spec. The pointer is machine-usable — an LLM repair loop or an editor can navigate straight to the offending construct. Compile-time closures pre-bind their `docPath` strings, so the error path costs nothing until an error actually throws.

## Where the fast paths are

The performance culture is the same as the JSONPath compiler's — specialization decided at compile time, guided by the cardinality analysis:

- **Singular paths** (`$.a.b[3]`, `$b.title`) compile to a direct property-walk getter — zero allocations, no segment loop.
- **Singleton ≡ item**: the sequence representation adds no wrapper for the 1-item case, which is nearly every expression in a typical query.
- **Degenerate `{$let, $return}` phrases** compile to a direct closure chain with no tuple accumulator (the `let` node keeps its own compiler).
- **Cardinality-specialized constructors**: map members and array elements that are statically `ONE` compile to direct assignment/push; only `MANY`/`OPT` positions pay for `appendItem` flattening.
- **Item vs existential comparisons**: when both sides are statically `ONE`, `$eq`/`$lt`/... compile to a single item comparison — the O(n·m) existential double loop exists only where sequences are possible.
- **Existence tests never materialize**: `$exists`/`$empty` over a path compile to `compileExists` (first hit wins), and `$where` over a bare path tests emptiness without building a nodelist.
- **Guard-free arithmetic**: `ONE`-card operands skip the empty-propagation branches.
- **Literal regexes** (`$match`/`$search`/`$replace`, and path filters) are compiled to `RegExp` at query-compile time; dynamic patterns get a per-callsite monomorphic cache.
- **Barriers snapshot only live slots** (`collectReadSlots` liveness), so a sort key that `$return` ignores is never copied per tuple.
- **Short-circuiting is universal**: `$and`/`$or`/`$if`/`$coalesce`/quantifiers evaluate nothing after the deciding operand.
- **Compiled-query caches**: `queryJson` keeps a `WeakMap` for object documents (identity) and a FIFO-512 map for string documents — the same pattern as `queryJSONPath`.
- **Flat frames**: variable access is `frame[slot]` with a constant index; no scope objects at runtime.

Known non-fast-path: the `$where` equijoin is a naive nested loop (see the `//#region roadmap: FLWOR optimizer` note in `compile.js` — hash joins and filter hoisting are future work, and the benchmark's join scenario tracks it honestly).

## The JSLT dispatcher

### Stylesheet model and rank tables

`compileJsltStylesheet` first makes an independent deep-frozen copy, then `stylesheet.js` normalizes the two top-level forms into closure-free data. Every rule has its document pointer, mode, body, normalized match record and resolved numeric priority; absent priorities become the three fixed defaults (path+schema `1`, one condition `0`, unconditional `-1`). Rules partition into modes and sort once by `(priority descending, source index descending)`, so later equal-ranked rules win without runtime comparison logic. Envelope and rule vocabularies are closed here, before path/schema/body compilation starts.

`dispatch.js` compiles each source rule once, then builds each runtime mode as parallel ranked arrays: path bit/ordinal, schema predicate, body evaluator and source rule index. Modes with at most 32 path rules use one signed bit mask per location (ordinal 31 is valid); larger modes use `Set` membership. The arrays keep the hot scan monomorphic and avoid allocating match records per dispatched value.

### Lazy per-mode path pre-pass

Path matching is positional, so each mode evaluates its compiled match paths against the immutable input root at most once per transform call, and only if that mode is reached with a located value (location-less dispatch can never match a path rule, so it never pays for a pre-pass). Rules sharing one match-path string share one compiled query, and each distinct query enumerates the input once per transform call however many modes reference it (the TOC/render idiom). The pre-pass is one map from normalized path to a match entry: matched locations hold their rule bits/ordinals directly, and every proper ancestor of a match holds a spine entry carrying both its own match and the set of child keys (decoded member names / element indexes) that continue toward a deeper match. Pre-passes live in the transform context by mode id—never on the compiled stylesheet—so repeated calls observe mutated/replaced input data and cannot leak document state across calls.

That one entry is also the pruning index: a single hash lookup answers "does a rule match here", "can one match below", and "through which children". In `share` mode, a mode containing only path rules returns any located subtree without an entry immediately, and the built-in rebuild at a spine location dispatches only the children in the entry's key set—every other child is copied by reference without even constructing its normalized path string.

### Query frames and `$apply`

Rule bodies use the ordinary query normalizer/compiler with one injected extension entry, `$apply`; the core registry and published query schema remain unchanged. The extension normalizes the selector as an expression, freezes the static target mode, records every referenced mode for table construction, and compiles through the query engine's own cardinality/sequence machinery.

Every compiled body extends the query frame by exactly three numeric slots after `normalized.frameSize`: current normalized location, dispatch depth, and the transform context — keeping every frame access an indexed element load. The transform context carries the root, per-rule external arrays and the lazy mode pre-passes without consuming query-visible slots; the all-unbound external resolution is precomputed at compile time, so calls without user bindings allocate nothing per transformation. Reserved externals `root` and `path` are detected among the normalizer's external records and populated per dispatch; user externals are deduplicated globally, resolved once per transformation, then projected into each rule's frame slots.

When an `$apply` selector is a path rooted at the current item or reserved `root`, its compiled AST exposes that fact. The extension runs the shared nodes-mode segments from the current normalized location, preserving paths into nested dispatch; every other selector evaluates through its ordinary getter and produces location-less items. Result sequences concatenate through `appendItem`/`seqOf`, exactly like every query operator.

### Built-in rules, sharing and error boundaries

The built-in `share`/`fresh` walkers implement query constructor semantics: empty child results omit object members/array elements, multi-item array children splice, and a multi-item object member raises JT2002. `share` tracks whether any child changed and returns the original container when none did; `fresh` always returns the rebuilt container. Empty `share` stylesheets specialize further to `(data) => data`, which is the O(1) identity row in `benchmark/jslt.js`. Rebuilding defines an own `__proto__` member explicitly, avoiding prototype mutation.

Compilation wraps only errors crossing a language boundary: invalid match paths become JT0003 with the JSONPath cause, a missing type-test hook is JT0006 while hook rejection or a non-function result is JT0005, and `JsonQueryCompileError` from a body becomes JT0007 with the inner pointer composed under `/body`. At runtime, a rule body wraps `JsonQueryRuntimeError` once as JT2004; an existing `JsltRuntimeError` from nested `$apply` passes through unchanged. Dispatch depth is checked before each recursive call, and a host `RangeError` from a deep synchronous chain is converted to JT2001 so the public API never leaks an engine stack overflow.

## The XQuery text front-end

`xquery/parse.js` is a char-code recursive-descent parser for a defined subset of XQuery 3.1 *text* syntax that emits query documents — it is a **front-end, not a second engine**. Design rules:

- The output is always a valid query document (every emission validates against the schema); where XQuery and the JSON format disagree, the JSON format's semantics win, and the mapping is documented per-construct in [docs/XQUERY-FRONTEND.md](./docs/XQUERY-FRONTEND.md).
- Constructs outside the subset fail with stable `unsupported ...` messages (`XQuerySyntaxError` with `source`/`position`), which is what lets the QT3 harness (`benchmark/qt3-runner.js`) classify tens of thousands of suite cases mechanically.
- Positional 1-based/0-based mismatches (XQuery vs D6) follow one rule: **positional inputs are adjusted at parse time** (`?N` lookups, `fn:substring` starts), **positional outputs are not** (`$at`, `count`, `fn:index-of` results surface 0-based).

## Testing and benchmarks

Unit tests live in `test/json/` at the repository root (`npm run test:json`): `path.test.js` from the RFC's own examples, `query/` per engine layer (normalize, expressions, FLWOR, operators, API), `query-format.test.js` and `jslt-format.test.js` validating every fixture against **both** schema twins plus asserting both mechanical derivations, `jslt/` for stylesheet/dispatch behavior and the normative examples, `xquery/` for the front-end, and `readme-examples.test.js` executing the README's examples verbatim.

Benchmarks (all in `benchmark/`, competitor libraries are devDependencies of that workspace only): `jsonpath.js` runs the official JSONPath compliance suite (703/703) and per-query profiles vs json-p3; `jsonquery.js` runs the query scenario matrix vs fontoxpath and jsonata; `jslt.js` runs identity/surgical/modes/schema-annotation transforms vs native JS and JSONata; both transformation tools assert result equivalence before timing; `qt3-runner.js` scores the W3C QT3 suite through the XQuery front-end against a committed baseline with zero unattributed failures. House rule: when touching hot code, run the relevant benchmark before and after, and report the numbers.
