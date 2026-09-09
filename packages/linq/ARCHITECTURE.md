# @jarenjs/linq — architecture

The package is three small machines in a row: a **recording proxy**
that turns a JavaScript callback into expression data, an **emitter**
that folds a stage list into one FLWOR query document, and a
**provider seam** that runs that document anywhere. Nothing here
evaluates anything — the query engine in `@jarenjs/json` stays the
only evaluator, which is what makes the same chain mean the same thing
in memory, over a cursor, or pushed into a database.

## The recording proxy (`src/expression.js`)

`captureExpression(fn, roots)` calls the user's callback once with
proxies. Every member access, comparison and operator call is recorded
as plain query-document JSON — never `Function.prototype.toString()`,
which breaks under minification and cannot see closures honestly. The
table of recordable methods (`METHODS`) is null-prototyped so
`constructor` and `toString` read as member access; methods shadow
members by design, with `get('name')` as the escape for collisions and
non-identifier keys. A proxy that escapes its callback (stored and
reused later) is detected by a stack of capture epochs and refused
(`JL0002`) — the emitted document would be nonsense, so the build fails
instead; captures nest, and an enclosing capture's proxy used inside a
nested one is refused by name for the same reason. A root whose items
are an entity's rows carries the entity's relation table (a provider's
`relations`), and a member naming a relation records a HOP: it is
lowered right there to the correlated phrase the engine runs —
`{ $for: { r1: '$.User[*]' }, $where: { $eq: [...] }, $return: … }`,
a to-many hop packed as an array until `all()` fans it — so the
document never carries a relation name; the hop bindings `r1`, `r2`, …
are numbered per capture and reserved, and `explain().hops` reports
them. The rows stop being rows at a projection, where the sequence
drops the table.

## The emitter (`src/document.js`)

A `Sequence` is an immutable stage list. Emission folds the stages
into FLWOR phrases with clause-order segmentation: a `where` after an
`orderBy` opens a new nested document, consecutive `where`s conjoin
into one `$and`, and the item binding is always `it` (nested documents
shadow it deliberately, so emitted documents stay hand-readable). Every
iterated source is bound through an array constructor so an
array-valued row stays one item under the engine's `$for` unpacking
(the format doc's §5); only a provider's own root is bound bare.
Element terminals emit `[window]` array wrappers because the engine's
result shape is `undefined | item | items` — the wrapper is what keeps
an array-VALUED item unambiguous. Aggregate terminals wrap the whole
document (`{ $count: … }`), and `groupBy` packs its default return as
`{ key: …, items: [ '$it' ] }` because an object member takes exactly
one item.

The emitter also owns `requireNonNegativeInteger`, the shared count/index guard
for synchronous and asynchronous sequence windows and positional terminals.
Both surfaces report the same `JL0005` refusal at their existing call boundary.

## The typed surface (`types/index.d.ts`)

Hand-authored declarations are the public type contract (the runtime
stays JSDoc'd JavaScript). The line: the common path is precisely
typed, the exotic path is honestly `unknown`, nothing is ever a WRONG
type. Every type-level claim has a runtime twin in the same test
fixtures plus captured compiler messages, because `checkJs` is off and
nothing else would notice drift.

## The async surface (`src/async.js`, `src/concurrency.js`)

Async is a boundary, not a colour (D5). `fromAsync` streams a
single-pass source through per-item compiled evaluators; a barrier
operator (`orderBy`, `groupBy`, `aggregate`, `reverse`) collects the
buffer and runs the MAXIMAL document slice through the sync engine in
one call — so async answers are sync answers by construction, proven by
a byte-identical-document test. An async `join` exists only over a
provider origin, pushed inside the one document — the inner side of a
join re-reads the source, and a single-pass stream cannot be read twice.
`mapAsync` is
the one place element-wise asynchronous work happens: `concurrency`
is required, the modes reuse the `createTaskEffect` vocabulary
(`parallel`/`concat`/`switch`/`exhaust`), and failure is fail-closed —
the first rejection aborts every in-flight signal and the source.

## The pens (`src/schema/`, `src/model/`, `src/jslt/`, `src/migration/`, `src/contract/`, `src/flow/`, `src/app/`, `src/forms/`)

A pen is a by-code front-end to one of the suite's document formats,
exported under its own subpath (`@jarenjs/linq/schema`, `/model`, `/jslt`,
`/migration`, `/contract`, `/flow`, `/app`, `/forms`; `.` stays the chain). The rule set is one paragraph: the document is the
deliverable (plain, deep-frozen JSON, memoized under `.schema`,
`toJSON()` returns it); the pen imports no engine and re-implements no
compile check — it refuses only what it cannot spell, with a `JL01xx`
code; types are phantoms (`Infer<>`/`Input<>`) proven by a three-way
agreement against emit's declarations and the validator's verdicts over
one corpus; objects are closed by default. The schema pen is four
modules: `builders.js` (one small immutable class per kind, state
replaced through `with()` — which is also how a later pen extends it, by
subclassing, never by patching a prototype), `emit.js` (assembly: `$defs`
hoisting in discovery order, `$ref` resolution, the two refusals a
document could not carry faithfully — a name spelled twice, a default in
a branch the normalizer never descends), `check.js` (the ONLY pen module
that imports the recording proxy: a `check()` rule is captured with the
value at `$` and exactly the two externals the validator binds) and
`brand.js` (a registry symbol every builder answers `true` under). The
chain recognises a builder handed to `ofType`/`cast` by that symbol —
looked up by key in `src/schema-of.js`, not imported from the pen — so a
chain-only bundle carries nothing from the pen's directory, and a
pen-only bundle carries no chain module and no engine (the tree-shaking
gate proves both). The one shared machine, the capture in
`expression.js`, rides in the pen's bundle whether or not `check()` is
called: a class method cannot be shaken. Two small modules beside it are
shared by every pen: `capture-root.js` (`captureQuery`: one capture over
a value at `$` with named externals — `check()`'s `root`/`path`, the
model pen's `compute()` with none, the JSLT pen's `body()` with the
declared parameters) and `json-boundary.js` (`requireJson`, the `JL0101`
door), and `effect.js` (the `{ run, with? }` descriptor two formats spell
identically — a machine's effects and an app transition's — with each pen
passing in how its props are captured). The model pen (`src/model/`) and
the forms pen (`src/forms/`) each subclass the schema pen's classes
through one mixin; the JSLT pen (`src/jslt/`) is `body.js` (the body
capture, `apply`/`op` lifted into it through `liftExpression`, the `[]`
refusal) and `rules.js` (the rule object and the envelope, in Appendix
A's member order) — it imports nothing of `src/schema/` but `brand.js`.
The contract pen (`src/contract/`) is `operation.js` (the three kinds,
the error declaration and the policy vocabulary), `http.js` (the binding
and the §4.2 path-template scan, mirrored from the compiler's parser)
and `define.js` (the document, in CONTRACT-FORMAT §12.1's member order,
and the three identity wrappers that type a client, a handler table and
an AI toolbox). It reaches back into `schema/emit.js` for one thing —
`createHoist`/`emitInto`/`hoistedDefs`, the same `$defs` walk `assemble`
runs, over several roots instead of one — so a contract's `$defs` are
hoisted to the CONTRACT's root by the one implementation. The flow pen
(`src/flow/`) is `fsm.js`, `dag.js` and `capture.js`, whose scope binds NO
externals because neither flow engine binds any — a guard written through
the JSLT pen's `body()` would read `$root` as false forever. The app pen
(`src/app/`) is `capture.js` (APP-FORMAT §3.1's three names, and §5.3's
narrower closed world for a subscription), `action.js`
(`action`/`transition`/`effect`/`bind`), `patch.js` (the six RFC 6902
operations, `append`, and the path lambda lowered to a JSON Pointer — as
text where every segment is literal, as a lifted `$concat` where one is
computed) and `define.js` (the document, the initial state derived from
the state schema's defaults, and the view scan that refuses a binding to
an undeclared action). The forms pen (`src/forms/`) is `rules.js` (the
`form()` mixin and the rule context) and `submit.js` (`assertOnSubmit`,
the layer-3 `$query` twin, pinned deep-equal to forms' own transform);
neither imports the package it writes for.

## The client (`src/db/`)

`@jarenjs/linq/db` is the one subpath with a runtime edge: `open.js`
imports `openStore` from `@jarenjs/db`, `JarenValidator` from
`@jarenjs/validate` and the string and date-time formats from
`@jarenjs/formats` — declared in `package.json` as OPTIONAL peer
dependencies, never dependencies, so a consumer of any other subpath
installs nothing new and the store never imports this package. Three
gates hold the edge: the tree-shaking probes (the `.` entry carries no
`src/db/` module and not one byte of the three; the `./db` bundle
carries all three, no other pen, and the size CONSUMING states), the
packed-consumer gate (every subpath is imported WITHOUT the peers first
— `./db` must fail by a peer's name and nothing else may fail — then
with their closures installed from the tarballs), and the edge suite
in `test/db/provider.test.js` (both manifests, and every source and
declaration file of both packages, for every import spelling).
`handle.js` builds one frozen handle per declared name at open — the
store's entity set spread in, the chain start generated from
`AsyncSequence.prototype` so nothing is duplicated (`explain()` is the
one overload: the empty chain's without a document, the store's with
one), and `include`, `link`/`unlink`, `live` beside them. `include.js`
is a builder that EMITS the store's `load` spec: the relation member
captured to its name, every callback captured over `$it` through the
same recording proxy with no parameters, the nested includes resolved
over the scope's relation tables, the spec deep-frozen in a fixed
member order. `membership.js` reads the relation table before the store
records a link (`JL0107` names the kind); `live.js` hands a chain's
document and `explain().bindings` to the store's own registration.
Nothing here runs a query, plans one or keeps state: the store stays
the engine, and every read is one its `explain()` can name.

## The provider seam (`src/provider.js`)

A provider is any object with `execute(queryDocument, { externals })` —
optionally carrying `root` (the path its items are bound through, bare),
`roots` (a store-level provider's entity roots; refused by name,
`JL0007`), `scope` (the identity two joinable providers share; with
`relations` keyed by root name, where a chained hop finds its target's
table) and `relations` (the relation table of its rows, what a hop
lowers from).
`@jarenjs/db` implements it; the chain imports no store, and the
package's one runtime edge — the client subpath below — runs the other
way, a test asserting the direction. On the async surface the provider is asked
for first, receives the whole chain up to a `mapAsync` as one document,
and may answer a promise. `mapAsync` splits a provider chain: the
translatable prefix is pushed to the provider in ONE call, the
residual runs locally, and `explain()` reports the split.

## The decisions that cost something

- **Emission re-runs per call.** A callback is captured ONCE, when
  its operator is called; the document is re-emitted and the compiled
  program looked up on every terminal by design (the `Sequence` is
  immutable and cheap to walk; the benchmark publishes the price beside
  the hand-written loop). Hold the compiled document when the same
  query runs hot.
- **Same-source joins, or one provider scope.** One document has one
  root, so `join`/`groupJoin` across different sources is refused
  (`JL0005`) rather than silently materialised — except two providers
  sharing a `scope` (one store's entity sets), whose roots are two
  bindings of one multi-entity input.
- **Federation is explicit.** `federate()` (QUERY-PEN §12.1) accepts a
  connected equality graph across named providers. Source-local work runs at
  its provider; estimates choose a connected fetch order, hash sets reduce
  candidates, and the engine retains the original tuple semantics. Packed
  joins run inside out under the same cumulative row/byte admission credits.
  Per-side budgets also cap intermediates; buffered production and final
  results have the explicit limits documented in §12.1. Aliases receive
  independent input members, and array framing preserves array-valued rows.
- **The engine result shape leaks nowhere.** Every surface — sync,
  async, provider — reproduces `undefined | item | items` exactly,
  which is why the window-wrapper trick exists at all.

## What this is not

Not a storage engine (entities, identity, migrations — the store is
`@jarenjs/db`'s, and `src/db/` is its front door, never a second
engine), not IQueryable with expression trees over
arbitrary CLR-style methods (the operator set is the query engine's
104, closed and documented), not a runtime type inferrer for JSON
literals (`from(json)` is `unknown` until the caller asserts, and a pen
is the only inference route — `json-schema-to-ts`-style computation over
schema literals is deliberately absent), and not a lazy-collection
library for JavaScript iterables in general — the deliverable is always
a DOCUMENT, one of the suite's own, and everything else follows from
that.
