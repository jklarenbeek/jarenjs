# The Jaren LINQ surface (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119.

## 1. Scope

`@jarenjs/linq` is a fluent front-end to the Jaren JSON Query language
([QUERY-FORMAT.md](../../json/docs/QUERY-FORMAT.md)): a C#-familiar
method chain whose expressions are CAPTURED as plain query documents
and executed deferred — over any iterable in memory, or by any
**provider** exposing `execute(document, options)` (§8). The builder
emits the query language and nothing else; there is no second grammar,
no private protocol, and no `Function.prototype.toString` anywhere.

What this package is NOT: it is not an ORM (storage is `@jarenjs/db`'s
job), it does not evaluate JavaScript callbacks per element (callbacks
run ONCE, at build time, against recording proxies), and it promises
nothing the query grammar cannot express — §4 records every such gap
as `unsupported`, by name.

## 2. The surface

```js
import { from } from '@jarenjs/linq';

const adults = from(users)
  .where((u) => u.age.gt(21))
  .orderBy((u) => u.name)
  .select((u) => ({ id: u.id, name: u.name }));

adults.toArray();     // executes in memory
adults.toDocument();  // the SAME query, as one JSON document:
// { "$for": { "it": ["$[*]"] },
//   "$where": { "$gt": ["$it.age", 21] },
//   "$orderby": { "$key": "$it.name" },
//   "$return": { "id": "$it.id", "name": "$it.name" } }
```

(The source is bound through an array constructor, `["$[*]"]`, so that
an array-valued row stays one item — §5 says why; a provider's own root
is bound bare.)

- `from(source, options?)` — `source` is any iterable (arrays,
  strings, generators, Sets…) or a provider (§8); anything else is
  `JL0001` at `from()` time, never at enumeration time.
  `options.compileTypeTest` enables the schema operators behind
  `ofType`/`cast` (§4); absent, those two are `JL0003` with the fix in
  the message.
- `fromDocument(source, document, options?)` — attach a hand-written
  or stored query document; its result is the item sequence and every
  operator chains over it. Exactly the `{ "$query": "0.1", "$expr": … }`
  envelope is unwrapped; any other envelope — an unknown version, a
  stray member, a missing half — is compiled first so the ENGINE's
  verdict (`JQ0006`, `JQ0001`, `JQ0003`) is what surfaces, never a
  silent run under this version.
- Every operator returns a NEW immutable sequence (§5); terminal
  operations execute (§6).

## 3. Expression capture

A predicate or projection callback receives a **recording proxy** per
binding (and the parameters proxy last, §7). Member access records a
path segment; a method call records an operator; the callback's return
value becomes the expression:

- `u.a.b` records the path `$it.a.b`; `u.list.at(0)` records
  `$it.list[0]` (negative integers count from the end);
  `u.list.all()` records `$it.list[*]`; a key that is not an
  identifier — or one that collides with a method name — goes through
  `u.get('odd key')`.
- Method names SHADOW member access: `u.eq` is the operator, never
  the member. `u.get('eq')` reaches the member.
- Returned object literals become constructors: plain-keyed objects
  are Rule 1 map constructors, arrays are Rule 3 array constructors,
  and a data object with `$`-prefixed keys embeds through `$map`.
  Literal strings embed with the `$$` escape when they start with
  `$`; plain data trees embed as `$const`.
- A proxy belongs to exactly ONE capture. Storing one and replaying
  it into a later operator is `JL0002` — the emitted document would
  silently reference the wrong binding, so the build fails instead.
  Captures NEST: a chain built and run inside a callback is ordinary
  (`select((u) => ({ id: u.id, n: from(rows).count() }))`); an
  enclosing capture's proxy used inside the nested one is `JL0002` by
  name — the inner document rebinds `$it`, so a correlated subquery
  cannot be spelled this way. (`===` between proxies is untrappable and
  therefore undetectable; do not compare proxies.)
- **JavaScript's own operators are not trappable, and they do not
  fail loudly.** A proxy is an object, so `&&`, `||`, `!`, `?:`, `in`,
  `typeof`, `Object.keys` and `===` evaluate against the PROXY and
  yield a silently wrong document: `u.age.gt(21) && u.name.eq('x')`
  captures only the right operand, `!u.deleted` is the constant
  `false`, `u.deleted ? 'a' : 'b'` is always `'a'`. Use the expression
  surface — `.and()`, `.or()`, `.not()` — for logic. Arithmetic and
  comparison operators (`u.age > 21`, `u.age + 1`, `${u.name}`) throw a
  plain `TypeError` (a proxy cannot be converted to a primitive): loud,
  but not coded.
- The item binding is always named `it` in the emitted document
  (nested phrases shadow it legally), so captured expressions read
  `$it.…` at every depth and the document stays hand-readable.

## 4. The mapping table

Status vocabulary: **native** (emits the named construct), **emulated**
(emits a composition with identical semantics), **unsupported** (throws
a coded error naming the reason — an honest row beats a silently wrong
emission). The *typing* column is the intended TypeScript signature
shipped by the typed surface order; an operator whose signature cannot
be written is an operator whose runtime shape is wrong, so the column
is part of THIS design.

| C# / LINQ | Emission | Status | Typing (element `T`) |
|---|---|---|---|
| `Where` | FLWOR `$where` | native | `(e: Expr<T>) => Expr<boolean>` → `Seq<T>` |
| `Select` | `$return` constructor | native | `(e: Expr<T>) => Expr<R>` → `Seq<R>` |
| `SelectMany` | `$return` of a `$for` phrase over the projection — the projected value is iterated ONE level (an array member's elements, a constructed array's members; a scalar is itself), and the FLWOR `$return` concatenates per tuple. Emitted as `{ "$for": { "it": <projection> }, "$return": "$it" }` (the nested phrase rebinds `it` legally) | native | `(e: Expr<T>) => Expr<R[]>` → `Seq<R>` |
| `OrderBy` / `OrderByDescending` | `$orderby` key spec (`$dir`; `$empty`/`$collation` via `options`) | native | `(e: Expr<T>) => Expr<K>` → `Seq<T>` |
| `ThenBy` / `ThenByDescending` | appended `$orderby` spec; must directly follow `orderBy*` (`JL0005`) | native | as `OrderBy` |
| `GroupBy` | `$groupby`; downstream items are `{ key, items }` | native | `(e: Expr<T>) => Expr<K>` → `Seq<{key: K, items: T[]}>` |
| `Join` | nested `$for` + `$where` `$eq` — the engine rewrites this shape to a HASH JOIN (compile-time, QUERY-FORMAT §6), which is why it is fast **when both keys are plain member paths** (`o => o.pid`, `i => i.id`); a key with an operator in it (`o => o.name.lower()`, `o => o.p.add(0)`) is not a probe key and the join runs as a nested loop. Both sides MUST derive from the same source in 0.1 (`JL0005`): a query document reads one input; the relational order lifts this. The inner side's declared parameters ride along (§7) | native | `(inner: Seq<U>, ok, ik, (o: Expr<T>, i: Expr<U>) => Expr<R>)` → `Seq<R>` |
| `GroupJoin` | the matching group bound as an ARRAY value — `$let: { g: [ <correlated inner phrase> ] }` — so the result selector can index it (`g.at(0)`), fan it (`g.all()`), place it in a member (`{ matches: g }`) and aggregate over its members (`(u, g) => ({ n: g.count() })` counts the matches, `g.exists()` is whether there are any); same-source rule and parameter merge as `Join` | emulated | `(inner: Seq<U>, ok, ik, (o: Expr<T>, g: ArrayExpr<U> & AggregatableExpr) => Expr<R>)` → `Seq<R>` |
| `Skip` / `Take` | `$subsequence` | native | `(n: number)` → `Seq<T>` |
| `Distinct` | `$distinct` (deep structural equality — the grouping relation) | native | `()` → `Seq<T>` |
| `Reverse` | `$reverse` | native | `()` → `Seq<T>` |
| `Count` / `Sum` / `Average` / `Min` / `Max` | §8.8 aggregates (`Average` → `$avg`) | native | `count(): number`; `sum(): number`; `average/min/max(): number` (throw `JL2001` on empty; `min`/`max` follow the operand family) |
| `Any()` | `$exists` | native | `(): boolean` |
| `Any(pred)` / `All(pred)` | `$some` / `$every` quantifier phrase | native | `(pred): boolean` (`all` vacuously true on empty) |
| `Aggregate(seed, fn)` | `$fold` — the accumulator clause; the result is a sequence of exactly ONE accumulated value (`.first()` reads it) | native | `(seed: A, (acc: Expr<A>, e: Expr<T>) => Expr<A>)` → `Seq<A>` |
| `Aggregate(fn)` (unseeded) | — JSON cannot spell "the implicit first element" as a lambda seed | unsupported (`JL0006`) | — |
| `First` / `FirstOrDefault` | `[ $subsequence [expr, 0, 1] ]` window | native | `(): T` (`JL2001` on empty) / `(d?): T \| D` |
| `Single` / `SingleOrDefault` | `[ $subsequence [expr, 0, 2] ]` window | native | `(): T` (`JL2001`/`JL2002`) / `(d?): T \| D` (`JL2002` on 2+) |
| `Last` / `LastOrDefault` | `[ $subsequence [$reverse expr, 0, 1] ]` | native | as `First` |
| `ElementAt` / `ElementAtOrDefault` | `[ $subsequence [expr, i, 1] ]` | native | `(i): T` (`JL2003` out of range) / `(i, d?)` |
| `Concat` | `$seq` (a constant array's elements join the stream) | native | `(other: Seq<T> \| T[])` → `Seq<T>` |
| `DefaultIfEmpty` | `$default` | native | `(fallback?: T)` → `Seq<T>` |
| `OfType<S>` | `$valid` filter with a JSON Schema literal | native | `(schema)` → `Seq<S>`; needs `compileTypeTest` (`JL0003`) |
| `Cast<S>` | `$assert` per item | native | `(schema)` → `Seq<S>`; needs `compileTypeTest` (`JL0003`) |
| `Zip` | — no positional co-iteration in the grammar | unsupported (`JL0006`) | — |
| expression methods | `eq ne lt le gt ge` → `$eq…$ge`; `and or not`; `add sub mul div idiv mod neg`; `startsWith endsWith contains matches upper lower length concat substring replace` → §8.7; `count sum avg min max` → §8.8 (aggregates as expressions, e.g. over a group); `exists isEmpty`; `at all get` | native | on `Expr<…>`, per the typed-surface order |
| date family (§8.13) | the whole family, one method per operator. Components `year month day hours minutes seconds offset week weekYear quarter weekday`; instants `epoch datetime`; predicates `isDate isTime isDatetime isDuration`; arithmetic `startOf(unit) endOf(unit) dateAdd(duration \| amount, unit?) dateSub(…) dateDiff(to, unit) dateFormat(pattern)`. `dateAdd`/`dateSub`/`dateFormat` carry the prefix because `add`, `sub` and `format` are taken or ambiguous on this surface — the same reason §8.14 spells `geoArea`. There is no `now()`: §8.13 has no clock, and a fluent surface does not get to add one | native | on `DateTimeExpr` (the `DateTime` brand) and on `UnknownExpr` |
| series family (§8.16) | `overlaps(other)` → `$overlaps`; `timeBucket(every, origin?, context?)` → `$time-bucket`; `resample(spec)`, `rolling(spec)` and `asof(right, spec?)` → the three sequence operators. A **spec is a literal** and is embedded verbatim — it is read once when the query compiles, so a spec built from the row is `JL0005`, and every rule about what it may *say* stays in the compiler (`JQ0003`). Note that a member literally named `at` is read with `get('at')`: `at(index)` is path navigation on this surface | native | on `ArrayExpr`/fanned paths for the three sequence operators, on `Expr<…>` for the two scalar ones |
| spatial family (§8.14) | `bbox geoArea geoLength centroid` → `$bbox $area $length $centroid`; `distance within bboxIntersects` → `$distance $within $bbox-intersects`; `geohash(precision?)` → `$geohash` (optional arity, like `substring`); `geoParse geoText geohashBounds geohashNeighbours` → the conversion family; `geoSimplify(tolerance)` → `$geo-simplify`. A plain JSON polygon embeds as a literal (`p.at.within(poly)`); `.params({ region })` makes it an external instead | native | on `Expr<…>`, per the typed-surface order |
| vector family (§8.15) | `similarity(other)` → `$similarity`. The other operand is an array of numbers: a captured one embeds as a literal, `.params({ query })` binds it at call time. There is no `knn` method — k-nearest is `orderByDescending(...).take(k)`, which is the composition the emitted document already is | native | on `Expr<…>`, per the typed-surface order |

Two spatial names are deliberately not the obvious ones, and the reason
is the same one that made §8.14's `$length` and §8.7's `$string-length`
two operators: **`length` on this surface is already `$string-length`**,
and §8.14's `$length` is a geodesic line measurement. One method name
cannot carry both, and renaming the shipped string method for symmetry
would break a published surface for a cosmetic gain — so the spatial one
is **`geoLength`**, and **`geoArea`** joins it, because a bare `area()`
on an arbitrary expression reads as arithmetic to a C# eye. The prefix
names the family the way `geoParse`/`geoText` already do.

Every method name shadows a data member of the same name — that is what
the null prototype on the method table is for, and what `get(name)`
escapes. A position stored as `at` is the case that bites: `p.at` is the
index method, so it reads `p.get('at').within(region)`. A stored score
named `similarity` is the same bite with a worse error — `r.similarity`
is the *method*, so calling it as a member yields a `TypeError` about a
function rather than a coded build error, because the surface never sees
a member access at all. `r.get('similarity')` reads the data.

**k-nearest is a chain, not a method.** `similarity()` is one operator
and the ordering and the window are stages that already exist, so the
top k reads as what it is:

```js
from(memories)
  .params({ query })
  .orderByDescending((m, p) => m.embedding.similarity(p.query), { empty: 'least' })
  .thenBy((m) => m.id)
  .take(10)
  .select((m) => m.text)
```

`{ empty: 'least' }` under a descending sort puts the rows whose key is
empty — no vector, or one of the wrong width — **last**, and `thenBy` on
the identity breaks ties, so the chain answers the same rows in the same
order every time it runs. `.params({ query })` rather than a captured
array is what makes the emitted document one query for every question,
which is the shape a provider can push down.

## 5. Deferred execution and re-enumeration

Every operator returns a new immutable `Sequence`; NOTHING runs until a
terminal operation. A sequence may be enumerated repeatedly and **each
enumeration re-reads the source** — the C# contract, and the one that
surprises people:

```js
const rows = [1, 2, 3];
const q = from(rows).where((n) => n.gt(1));
q.toArray(); // [2, 3]
rows.push(4);
q.toArray(); // [2, 3, 4] — the source was read AGAIN
```

The compiled query is shared through a bounded cache keyed by the
document's exact JSON text — COLLISION-FREE and ORDER-SENSITIVE — so
re-enumeration is cheap without pretending the results are frozen.
A 32-bit fingerprint would not do here: it collides after tens of
thousands of documents, and a collision means one query runs another
query's compiled program — wrong rows, cache hit reported, nothing said.
Nor would an order-insensitive identity: a constructor's member order is
part of a document's meaning, and `{ id, name }` and `{ name, id }` must
each answer in their own order however the cache is warmed.
`for…of` a sequence iterates `toArray()`'s result (one enumeration per
loop).

**`toDocument()` is a deep snapshot**, on both surfaces. A sequence is
immutable, so the document it hands out is an independent tree: writing
into a returned document (or into `explain()`'s) cannot change what a
later enumeration answers.

**An item is an item.** The engine's `$for` unpacks an item that is an
array into its members, one level (QUERY-FORMAT §6.2, D4) — right for a
path like `$.tags`, wrong for a chain, where an array-valued ROW (a CSV
record, a pair) is one item that `where`, `select` and `count` never
split. So the emitter binds every source a phrase iterates through an
array constructor — `{ "$for": { "it": ["$[*]"] } }` — whose one array
item is unpacked exactly once, into the rows as they are; a reseated
phrase and a join side are packed the same way. `from([[1, 2], [3]])
.where(() => true).count()` is `2` on both surfaces, and the streaming
async surface agrees by construction. The one source left bare is a
PROVIDER's own root (`$.Post[*]`): a stored document is an object, so D4
never applies there, and the bare root is the shape the provider's
planner pushes.

**Constants come back frozen and shared on the sync surface.** A
literal object or array in a projection, a `defaultIfEmpty` fallback or
a `concat` array is engine data: every row that yields it yields the
SAME frozen value (`rows[0] === rows[1]`, and writing into it throws).
The async surface hands out a fresh copy per enumeration instead —
same values, no shared identity — because a streamed row is yours.

**A `null` a callback returns is a VALUE, not an absent clause.**
`where(() => null)` filters everything out (null is not true),
`select(() => null)` projects nulls, `groupBy(() => null)` is one
null-keyed group, and a null seed still folds. The emitted document
carries the clause with its null in place.

**A captured constant crosses a real JSON boundary.** The query data
model is JSON, so a `Date`, `Map`, `Set`, `RegExp` or class instance is
refused (`JL0005`) rather than embedded — `Object.keys` reports nothing
for them, so they would embed as `{}` and the query would compare against
an empty object. `NaN` and `±Infinity` are refused for the same reason
(JSON has neither, and lenient serialization folds them into `null`), and
so is `-0`, which shares its JSON text with `0` while dividing to the
opposite infinity. Convert first — a `Date` to its ISO string or epoch
number. The boundary is the same for a `concat` array and for a
`params()` binding (`JL0004`): a parameter becomes an external and, on a
provider, a bound SQL parameter, so a `Date` there would compare against
nothing and answer `[]` with no error anywhere.

## 6. Terminal semantics

The real C# semantics, because getting these wrong is how a
"LINQ-like" library becomes lodash with different names:

- `first()` on empty throws `JL2001`; `firstOrDefault(d)` returns `d`
  (or `undefined` when omitted).
- `single()` on empty throws `JL2001`; on two-or-more throws `JL2002`;
  `singleOrDefault(d)` throws on two-or-more and returns `d` on empty.
- `last()`/`lastOrDefault(d)` mirror `first` over the reversed window.
- `elementAt(i)` out of range throws `JL2003`;
  `elementAtOrDefault(i, d)` returns `d`.
- `average()`, `min()` and `max()` over an empty sequence throw
  `JL2001` (C# `InvalidOperationException`); `sum()` of nothing is `0`;
  `count()` of nothing is `0`.
- `any()` is existence; `all(pred)` is vacuously true over the empty
  sequence.

Element terminals emit their window inside an ARRAY constructor
(`[ … ]`), so the engine's result mapping (`undefined | item | items`)
can never confuse "one array-valued item" with "several items" — the
window array is always the single result and its elements are read
positionally.

## 7. Parameters

`.params({ tenantId })` declares AND binds externals; a callback reads
them through its last argument:

```js
from(rows)
  .params({ tenantId: 'a7' })
  .where((r, p) => r.tenant.eq(p.tenantId))
  .toDocument();
// { "$for": { "it": "$[*]" }, "$where": { "$eq": ["$it.tenant", "$tenantId"] }, "$return": "$it" }
```

The emitted document carries `$tenantId` as an external parameter
(QUERY-FORMAT §9) — the seam that later becomes a bound SQL parameter.
Undeclared use is `JL0004` at BUILD time with the fix in the message
(the engine would say JQ0005 at compile time; earlier and clearer
wins). The names `it`, `it2`, `acc` and `g` are RESERVED — they are the
emitted document's own binding names — and declaring them is `JL0004`.
A binding must be query data (§5): a `Date`, `Map`, `NaN` or `-0` is
`JL0004` with the conversion named.

The inner side of a `join`, `groupJoin` or `concat` contributes its
document WHOLE, so its declared parameters ride along into the new
sequence (`explain().externals` lists the union); a name both sides
bind to different values is `JL0004` — one document carries one binding
per name. Rebinding a name later (`.params({ k: 3 })`) re-runs the
whole document under the new value, on the async surface too: a
`params()` after a `mapAsync` rebinds the pushed prefix as well as the
residual.

## 8. The provider contract

A **provider** is any object exposing:

```
execute(queryDocument, options) -> undefined | item | items[]
```

- `queryDocument` arrives WHOLE — a terminal hands over the full
  emitted document (including the terminal's own wrapper, §6);
  nothing is enumerated locally, ever.
- `options.externals` is the `{ name: value }` record of bound
  parameters (§7).
- The return value uses the ENGINE's result mapping
  (`undefined` = empty, a single item as itself, several items as an
  array) — the in-memory runner is the reference semantics every
  provider MUST match, and it implements this same interface.
- **`execute` is SYNCHRONOUS.** A `Sequence` terminal is a value —
  `toArray(): T[]`, `count(): number` — so a promise cannot be returned
  under that type. A provider that answers one is refused with `JL2004`
  at the seam, because the alternative is not a slow answer but a wrong
  one: the promise came back typed as the value, `count()` handed a
  `Promise` to arithmetic, and `first()` indexed the promise and returned
  `undefined`. An asynchronous provider (a wasm/OPFS driver) is reached
  by emitting `toDocument()` and awaiting the provider directly.

`@jarenjs/db` implements this contract without either package
importing the other; a test double proves the document arrives whole.

### 8.1 Compilation registries

`from(source, options)` and `fromDocument(source, doc, options)` take the
engine's own compile options, so a document that is expressible is also
executable in memory:

| option | what it enables |
|---|---|
| `compileTypeTest` | `ofType`/`cast` (the schema operators) |
| `collations` | `orderBy(…, { collation })` — a `nl` sort is `JQ0010` without it |
| `functions` | `$call` in a hand-written or saved document |
| `pathFunctions` | custom RFC 9535 path function extensions |
| `limits` | step, depth and sequence bounds — the reason a SAVED document can be run at all. `resultItems` does not bind a chain: a terminal reads ONE packed window (§6), so the bound that guards a chain's size is `sequenceItems` on its phrases; on the async surface only `steps`/`depth` and a barrier phase's `sequenceItems` apply, because streaming stages evaluate one item at a time |
| `registry` | an explicit cache-partition key, when the hooks above are rebuilt per call |

Compiled documents are cached per registry COMBINATION, not per document
alone: the same document compiles to different code with and without a
collation registry, so sharing one partition would answer a caller who
passed no collations with the compiled-with version.

## 9. Error codes

Build errors (`LinqBuildError`; `docPath` where a document position
exists):

| Code | Condition |
|---|---|
| `JL0001` | `from()` received neither an iterable nor a provider |
| `JL0002` | an expression proxy escaped its capture callback |
| `JL0003` | `ofType`/`cast` need an injected `compileTypeTest` |
| `JL0004` | an undeclared or reserved parameter name was used |
| `JL0005` | an operator was used invalidly at build time |
| `JL0006` | an unsupported operator was invoked |

Pen build errors (`LinqBuildError`, raised by `@jarenjs/linq/schema`
and the pens that follow it; PENS-FORMAT.md §1.3 is the normative
home, this table mirrors it):

| Code | Condition |
|---|---|
| `JL0101` | a pen received a value it cannot spell: not JSON, or not what the keyword takes |
| `JL0102` | a pen was asked for a construct the format cannot carry |
| `JL0103` | a `$defs` name collision, a dangling ref, or an unnamed recursion |
| `JL0104` | a pen-owned keyword through `meta()`, or a `check()` external other than `root`/`path` |

Runtime errors (`LinqRuntimeError`):

| Code | Condition |
|---|---|
| `JL2001` | `first`/`single` found no element |
| `JL2002` | `single` found more than one element |
| `JL2003` | `elementAt` is out of range |
| `JL2004` | an asynchronous provider cannot back the synchronous surface |
| `JL2005` | a push queue was fed after it ended |
| `JL2006` | a provider answered an element terminal with something other than one array |

Engine errors (`JQ…`) from a hand-written `fromDocument` document pass
through unwrapped — they already carry their own code and `docPath` —
with one exception: `JQ0008` (a schema operator with no type-test
compiler) is reported as `JL0003`, because the fix is the same
`compileTypeTest` hook whether `ofType`/`cast` or the document spelled
the operator.

## 10. The asynchronous surface: streaming and barriers

`fromAsync(source, options?)` gives the same operator surface over
async sources — joins excepted, see the table — emitting the SAME query
documents: the same chain through `from` and `fromAsync` MUST emit
byte-identical documents (the one-operator-set proof), with terminals
returning promises. The rule: **the pipeline is synchronous, the
boundaries are async.** A compiled query never awaits; what is
asynchronous is where rows come from and where element-wise host work
happens (§11).

Per operator, whether it STREAMS (per-item evaluation, flat memory) or
is a BARRIER (materialises the stream so far and runs the maximal run
of document stages through the engine over the buffer — inherent,
because the engine itself materialises for `$orderby`/`$groupby`):

| Operator | Async behaviour |
|---|---|
| `where`, `select`, `selectMany`, `ofType`, `cast` | stream (per-item compiled evaluators — the engine, one item at a time) |
| `skip`, `take` | stream; `take` CLOSES the source when satisfied |
| `distinct` | stream, with a running key set (the grouping relation: `NaN` groups with `NaN`) |
| `defaultIfEmpty` | stream (an emptiness flag) |
| `concat` | stream for a CONSTANT array; another sequence is refused (`JL0005`) — an async source is single-pass and cannot be re-iterated for a second chain |
| | on the SYNC surface, `concat` also requires the same source: a query document reads one input, so the other sequence contributes its EXPRESSION, and a foreign sequence would have that expression evaluated against THIS source — reading the wrong rows twice instead of concatenating two inputs |
| `orderBy`/`thenBy`, `groupBy`, `aggregate`, `reverse` | BARRIER, named by `explain()` with the reason (a `thenBy` is part of the `$orderby` barrier it extends) |
| `join`, `groupJoin` | NOT on the async surface: a join's inner side re-reads the source, and an async source is single-pass. Join on the sync surface, or collect the stream first |
| `count`, `any`, `all`, `first`, `single`, `elementAt` | stream with early exit where semantics allow |
| `sum`, `average`, `min`, `max`, `last` | consume the stream; the aggregate itself runs through the ENGINE over the collected items, so its semantics (type errors included) are identical to the sync surface |

**Early termination MUST close the source**: `first()`, `any()`,
`take(n)`, and an exception mid-chain all call `.return()` on the
iterator — a generator left suspended holds a file handle or a read
transaction open. `explain()` reports `{ barriers: [{ operator,
reason }], document }` — or, when a `mapAsync` sits in the chain,
`{ split: { pushed, residual } }` instead of `document`
(`toDocument()` refuses with `JL0005`: a host callback has no document
form). No silent caps, no silent buffering: if a chain materialises,
the report says which operator forced it.

Re-enumeration follows the sync contract: each enumeration calls the
source's iterator method again. A one-shot generator object simply
exhausts — the same way it does under `from`. Streamed constants
(`concat`, `defaultIfEmpty`) are handed out as a fresh copy per
enumeration (§5).

## 11. The concurrency boundary

```js
await fromAsync(rows)
  .mapAsync(async (row, signal) => fetchScore(row.id, signal),
            { concurrency: 8, mode: 'parallel', ordered: true })
  .where((r) => r.score.gt(0.5))
  .toArray();
```

`mapAsync` is the ONE explicit boundary for element-wise asynchronous
host work. There is no parallel universe of `selectAwait`-shaped
operators; a per-element async *predicate* is `mapAsync` then `where`.

- `concurrency` is REQUIRED and MUST be a positive integer (`JL0005`)
  — the unbounded default is how libraries like this take down a
  downstream service.
- `mode` reuses the `createTaskEffect` vocabulary (`@jarenjs/app` §9),
  deliberately, so a reader who knows one knows the other:
  `parallel` (a sliding window of N), `concat` (strictly sequential),
  `switch` (a newer item supersedes and ABORTS the in-flight task),
  `exhaust` (items arriving while busy are dropped). The source is
  pulled eagerly under `switch`/`exhaust` — that race IS the mode.
- `ordered: true` (default) preserves source order and buffers at most
  `concurrency` results — the stated cost; `ordered: false` yields on
  completion.
- An `AbortSignal` is threaded to every callback and aborted on early
  termination and on failure. A rejected callback FAILS CLOSED: the
  first failure wins, every in-flight sibling aborts, the source
  closes (the `compileDag` discipline).
- `mapAsync` is NOT translatable to a provider. A provider-backed
  chain that reaches it SPLITS: everything before is pushed to the
  provider whole, everything after runs locally, and `explain()`
  reports `{ split: { pushed, residual } }` — the same residual
  honesty the SQL pushdown owes (D8), applied to the async boundary.

## 12. The cursor contract and the source adapters

`fromAsync` accepts, in order of preference:

- any **`AsyncIterable`** (async generators, `ReadableStream` — every
  target exposes `Symbol.asyncIterator` on it, josl's
  `iterateCsvStream` output);
- any sync iterable (wrapped);
- a **cursor**: `{ next(): Promise<{done, value}>, return?() }` — the
  shape the SQL provider's row iterator implements later, adopted
  as-is;
- a **push queue** (`createPushQueue({ highWaterMark = 1024 })`) for
  feed/end-style readers with no pull protocol of their own (josl's
  push parsers deliberately have no backpressure protocol; the queue
  is where one appears): `feed(value)` returns `false` once the queue
  exceeds the mark — a pause HINT, never a hard stop — and
  `end(error?)` closes (or fails) the stream. Anything else is
  `JL0001` at `fromAsync()` time.

What this surface does NOT do, by design: it does not make the query
engine async (`packages/json` is untouched and strictly synchronous),
it does not add a second operator table, and it does not add
`selectAwait`/`whereAwait` variants.
