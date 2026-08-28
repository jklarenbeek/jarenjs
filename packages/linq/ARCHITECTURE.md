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
nested one is refused by name for the same reason.

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

## The pens (`src/schema/`, `src/model/`, `src/jslt/`, `src/migration/`)

A pen is a by-code front-end to one of the suite's document formats,
exported under its own subpath (`@jarenjs/linq/schema`, `/model`, `/jslt`,
`/migration`; `.` stays the chain). The rule set is one paragraph: the document is the
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
door). The model pen (`src/model/`) subclasses the schema pen's classes
through one mixin; the JSLT pen (`src/jslt/`) is `body.js` (the body
capture, `apply`/`op` lifted into it through `liftExpression`, the `[]`
refusal) and `rules.js` (the rule object and the envelope, in Appendix
A's member order) — it imports nothing of `src/schema/` but `brand.js`.

## The provider seam (`src/provider.js`)

A provider is any object with `execute(queryDocument, { externals })` —
optionally carrying `root` (the path its items are bound through, bare),
`roots` (a store-level provider's entity roots; refused by name,
`JL0007`) and `scope` (the identity two joinable providers share).
`@jarenjs/db` implements it; neither package imports the other, and a
test asserts both directions. On the async surface the provider is asked
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
- **The engine result shape leaks nowhere.** Every surface — sync,
  async, provider — reproduces `undefined | item | items` exactly,
  which is why the window-wrapper trick exists at all.

## What this is not

Not an ORM (no entities, no identity map — the store is
`@jarenjs/db`'s job), not IQueryable with expression trees over
arbitrary CLR-style methods (the operator set is the query engine's
104, closed and documented), and not a lazy-collection library for
JavaScript iterables in general — the deliverable is always a QUERY
DOCUMENT, and everything else follows from that.
