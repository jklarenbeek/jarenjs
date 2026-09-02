# The Jaren query pen

> the chain, `.` — query documents (`jaren-query`) and the provider
> seam. **Read it when** you are querying data, or implementing a
> provider that answers a query document

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. This document is a **guide** — read
it in order and you can write the format — whose normative section is
[§4 The mapping table](#4-the-mapping-table); the rules every pen keeps,
the shared refusal table, the index of the other pens and every pen's
mapping table collected in one place are the normative reference,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. Scope

You have data — an array in memory, a store's rows, a stream — and a
question to ask it, and you would like to write that question the way you
write code: filter, order, project, join, group. What you actually need
to hand the engine is a JSON document. So you either write the document,
in a grammar your editor knows nothing about, or you write JavaScript
and lose the ability to send it anywhere. This is the third option: a
method chain that RECORDS what you wrote and hands you the document.

`@jarenjs/linq` is a fluent front-end to the Jaren JSON Query language
([QUERY-FORMAT.md](../../json/docs/QUERY-FORMAT.md)): a C#-familiar
method chain whose expressions are CAPTURED as plain query documents
and executed deferred — over any iterable in memory, or by any
**provider** exposing `execute(document, options)` (§8). The builder
emits the query language and nothing else; there is no second grammar,
no private protocol, and no `Function.prototype.toString` anywhere.

**Scope.** This document is normative for the CHAIN — the `.` entry, the
query documents it emits, and the provider seam. The package's other
subpaths are **pens**: the same idea applied to the suite's other
formats, each writing exactly the published document its engine already
takes. They have one document each, indexed by the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md), which covers the rules every pen keeps
(§1) and the `JL01xx` refusal table this document's §9 mirrors;
`@jarenjs/linq/db` — the store's typed front door and the package's one
runtime edge — is [DB-CLIENT.md](DB-CLIENT.md).

What this package is NOT: it is not a storage engine — the store, its
tables, its planner, its unit of work and its migrations are
`@jarenjs/db`'s, and the client subpath is that store's front door
rather than a second engine; it does not evaluate JavaScript callbacks
per element (callbacks run ONCE, at build time, against recording
proxies); it infers nothing from a JSON literal (a document stays a
document — `from(json)` is `unknown` until the caller says otherwise,
and the pens are the only inference route); and it promises nothing the
query grammar cannot express — §4 records every such gap as
`unsupported`, by name.

**Why this one is the longest.** The other ten documents target 600–1000
lines; this one is half again as long, and it stays one document. Its
§1–§12 are cited by section number from more than seventy places, so the
numbering is fixed and the sections cannot be split or moved. It also
covers three surfaces no pen has — the chain, the asynchronous surface
and the provider contract — each of which a different reader arrives for.
A reader who wants only one of the three should use the section list: §1
to §7 are the chain, §8 and §12 the provider seam, §10 and §11 the
asynchronous surface, and §13 to §17 the same seven sections every pen
document carries.

**The running example.** §13's eight fences are one question asked eight
ways over one small blog's data — the users, the posts they wrote and the
orders placed against them — and §15 reads the types back off the same
chains. Two of the eight need a PROVIDER rather than an array, and they
are that same blog seen as a store's entity sets.

**How to read this document.** The ten pen documents this one is indexed
beside share a fixed seven-section shape, and a reader who has learned
one of them arrives here expecting it. This document keeps its own twelve
sections instead — 72 citations across the repository point at them by
number, and moving one would break them silently — so the same seven
questions are answered where they already were, and the five that had no
home were appended rather than inserted:

| What you came for | Read |
|---|---|
| what it writes, and the one-import example | §1 Scope, §2 The surface |
| the mapping table: every operator and what it emits | §4 |
| worked examples, executed by the docs gate | §13 |
| refusals: the spelling that trips each code, and the one that works | §14 (§9 is the normative code table) |
| the types | §15 |
| what it cannot spell | §16 |
| cost | §17 |

The eight sections the table does not name have no counterpart in a pen
document at all, because they are the chain's own subject: §3 expression
capture, §5 deferred execution and re-enumeration, §6 terminal
semantics, §7 parameters, §8 the provider contract, and §§10–12 the
asynchronous surface, its concurrency boundary and its source adapters.
A reader following the suite from the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md), can skip to the row they need; a
reader learning the chain should read §3, §5 and §6 in order first,
because everything else assumes them.

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
  `JL0001` at `from()` time, never at enumeration time. A provider's
  items are bound through ITS root (`root` — `'$.Post[*]'` for a store's
  entity set; the emitted `$for` iterates that root, bare); a provider
  that serves several roots and none of its own (a store with entities,
  `roots`) is `JL0007` at `from()` time, naming the roots to chain over;
  a provider carrying a relation table (`relations` — a store's entity
  set does) lets a relation member NAVIGATE (§3): `p.author.email`
  lowers to the correlated phrase the engine and the store run, and the
  document never carries the relation's name.
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
- **A relation name hops.** When the items are the rows of an entity
  whose provider carries a relation table (§8: `relations`, a store's
  entity set), a member access naming a declared relation records a
  HOP rather than a path segment — `p.author` is the related row,
  `u.posts` the array of related rows — and is lowered, at capture, to
  the correlated phrase §4's "relation navigation" rows spell; the
  emitted document carries the phrase, never the member's name. The
  hop's target is the target entity's row, with ITS relation table, so
  hops chain (`p.author.posts`); a trailing path continues on the target
  (`p.author.email`); `all()` on a to-many hop fans the related rows,
  and the aggregates and `exists()`/`isEmpty()` range over them. A
  relation name reached through `get()` hops too (the escape for a
  relation that collides with a method name). The rows stop being rows
  at a projection — after `select`, `selectMany`, `groupBy`, `join`,
  `groupJoin`, `aggregate` (and a `mapAsync`) a relation name is an
  ordinary member again — and a `fromDocument` chain never hops: there
  the document decides what the items are. A hop that cannot lower is
  `JL0105` at build time (a many-to-many member: its join table is not a
  queryable root in this version; a composite key); a member read off
  the to-many ARRAY before `all()` is `JL0005` with the fix named, where
  the same read off a stored array would answer nothing.

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
| `Join` | nested `$for` + `$where` `$eq` — the engine rewrites this shape to a HASH JOIN (compile-time, QUERY-FORMAT §6), which is why it is fast **when both keys are plain member paths** (`o => o.pid`, `i => i.id`); a key with an operator in it (`o => o.name.lower()`, `o => o.p.add(0)`) is not a probe key and the join runs as a nested loop. Both sides MUST derive from the same source, or from two providers sharing one `scope` (§8 — two entity sets of one store are two roots of ONE multi-entity input, and the store answers the equijoin in one statement); anything else is `JL0005`: a query document reads one input. On the async surface the join exists only over a provider, pushed whole (§10). The inner side's declared parameters ride along (§7) | native | `(inner: Seq<U>, ok, ik, (o: Expr<T>, i: Expr<U>) => Expr<R>)` → `Seq<R>` |
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
| relation navigation — to-one hop (`p.author`, `p.author.email`) | over a provider with a relation table (§3, §8): `{ "$for": { "r1": "$.User[*]" }, "$where": { "$eq": ["$r1.<targetKey>", "$it.<via>"] }, "$return": "$r1.email" }` — the target's key against the row's foreign key (`kind: "oneToOne"`, the key on the declaring entity). Zero or one item: an object member's one value (absent when there is none), an operand elsewhere (empty compares false; `exists()`/`isEmpty()` say which), and under `$orderby` a key that may be empty (`$empty` applies). The binding is `r1`, `r2`, … per capture | native by desugaring — the document is the phrase; a store runs it as a named residual (`explain()`, MODEL-FORMAT §10.6) | `Expr<Post>['author']` is `ObjectExpr<User>` — emit's optional relation member, nothing new |
| relation navigation — to-many hop (`u.posts`, `u.posts.all()`) | `{ "$for": { "r1": "$.Post[*]" }, "$where": { "$eq": ["$r1.<via>", "$it.<targetKey>"] }, "$return": "$r1" }` — the target's foreign key against the row's key (`kind: "oneToMany"`, the key on the target). As a VALUE the phrase is packed, `[ <phrase> ]`, the array of related rows a member holds (`{ posts: u.posts }`; `u.posts.at(0)` indexes it); fanned, `u.posts.all()` is the bare phrase, a sequence: `.all().count()` → `{ "$count": <phrase> }`, `.all().exists()` → `{ "$exists": <phrase> }`, `.all().title` returns `"$r1.title"` per row (`[u.posts.all().title]` packs the titles). `count()`/`exists()` on the value range over the rows too, as a group-join's group's do | native by desugaring, as above | `ArrayExpr<Post>`; `all()` is `FannedExpr<Post>` |
| relation navigation — chained, and from every row binding | hops nest: `p.author.posts.all().count()` is `{ "$count": { "$for": { "r1": "$.User[*]" }, "$where": …, "$return": { "$for": { "r2": "$.Post[*]" }, "$where": { "$eq": ["$r2.authorId", "$r1.id"] }, "$return": "$r2" } } }` — the inner phrase correlates with the outer binding; a hop off a fanned to-many (`u.posts.all().author`) is a sequence, one target per row; a join's `it2` hops from the inner row; a group-join's fanned group (`g.all().author`) binds each row first (`{ "$for": { "r1": "$g[*]" }, "$return": <hop over $r1> }`); the group itself is an array, not a row | native by desugaring, as above | as the target's `Expr<…>` |
| relation navigation — many-to-many (`u.labels`) | — the join table is not a queryable root in this version, so no phrase exists to lower to; `load({ include: { labels: true } })` reads the memberships | unsupported (`JL0105`, naming the join table) | — |

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
// { "$for": { "it": ["$[*]"] },
//   "$where": { "$eq": ["$it.tenant", "$tenantId"] },
//   "$return": "$it" }
```

The emitted document carries `$tenantId` as an external parameter
(QUERY-FORMAT §9) — the seam that later becomes a bound SQL parameter.
Undeclared use is `JL0004` at BUILD time with the fix in the message
(the engine would say JQ0005 at compile time; earlier and clearer
wins). The names `it`, `it2`, `acc` and `g` are RESERVED — they are the
emitted document's own binding names — and so are `r1`, `r2`, … (`r`
followed by a positive integer): the bindings a relation hop allocates,
numbered per capture (§3, §4 "relation navigation"). Declaring any of
them is `JL0004`. A binding must be query data (§5): a `Date`, `Map`,
`NaN` or `-0` is `JL0004` with the conversion named.

The inner side of a `join`, `groupJoin` or `concat` contributes its
document WHOLE, so its declared parameters ride along into the new
sequence (`explain().externals` lists the union, `explain().bindings`
the values bound so far — what a provider receives as `externals`, and
what a host handed the chain, such as a live registration, forwards
without a second spelling); a name both sides
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
- **`execute` is SYNCHRONOUS on this surface.** A `Sequence` terminal
  is a value — `toArray(): T[]`, `count(): number` — so a promise cannot
  be returned under that type. A provider that answers one is refused
  with `JL2004` at the seam, because the alternative is not a slow
  answer but a wrong one: the promise came back typed as the value,
  `count()` handed a `Promise` to arithmetic, and `first()` indexed the
  promise and returned `undefined`. An asynchronous provider (a
  wasm/OPFS driver, a store's asynchronous entity set) is `fromAsync`'s
  source (§12): the same document arrives whole, and `execute` MAY
  answer a promise there.

A provider MAY carry three more members, read at `from()`/`fromAsync()`
time:

- `root` — the path expression its items are bound through
  (`'$.Post[*]'` for a store's entity set); absent means the whole
  input, `'$[*]'`. The emitted document iterates the root BARE (§5): a
  stored document is an object, so an item is never an array there.
- `roots` — the entity roots a STORE-LEVEL provider serves when it has
  no root of its own (`['User', 'Post']`). Such a provider is refused by
  `from()`/`fromAsync()` with `JL0007`, naming them: `$[*]` over the
  entity map would answer every entity's rows mixed, or count the sets.
  `fromDocument` keeps its own rule — there the document IS the root.
- `scope` — an identity two providers share when their documents may be
  joined. One store's entity sets carry one `scope`, so
  `from(posts).join(from(users), (p) => p.authorId, (u) => u.id, (p) => p)`
  emits `{ "$for": { "it": "$.Post[*]", "it2": "$.User[*]" }, "$where":
  { "$eq": ["$it.authorId", "$it2.id"] }, "$return": "$it" }` — the shape
  the store's translator answers in ONE statement when the result is a
  bare binding (MODEL-FORMAT §10.2), and the declared residual over both
  fetched roots when it is a projection (§10.6). `concat` stays
  same-source even within a scope: one input per document. A scope MAY
  carry `relations` — the relation tables of every root of the scope,
  keyed by root name (a store's does) — which is where a chained hop
  finds its target's table; without it the first hop lowers and the
  target's members are plain paths.
- `relations` — the relation table of the rows the provider serves
  (MODEL-FORMAT §10.1; a store's entity set carries its entity's): a
  plain record, one entry per declared relation member, `{ to, kind,
  via?, fkEntity?, fkTargets?, joinTable?, targetKey }`. With it, a
  relation name on a callback's row hops (§3) and is lowered to the
  phrase §4's "relation navigation" rows spell; `kind` decides the
  equality's sides (`oneToOne`: the key on the declaring entity;
  `oneToMany`: on the target), `to` the root the hop binds (`$.<to>[*]`),
  `via` and `targetKey` its two columns. A `manyToMany` entry is
  `JL0105`. Absent, a relation name is an ordinary member.

An element terminal hands over the one-item WINDOW `[<phrase>]` (§6). A
provider that plans documents reads through that window — the store
plans the phrase inside as if it were bare and answers its rows as the
one array the constructor yields (`[]` for none, `[row]` for one) — so
`toArray()` and `first()` push exactly as `count()` does.

`@jarenjs/db` implements this contract without either package
importing the other: its collections and its entity sets are providers
(the sets carry `root`, `scope` and `relations`; the store carries
`roots` and `relations`), and a test double proves the document arrives
whole. A lowered hop is what a store receives as any other document: it
runs the correlated phrase in its residual over the fetched roots and
`explain()` names the §10.6 reason — no lowered shape pushes natively in
this version, and the store's `strict` refuses them all (`JD0010`).

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
| `JL0007` | a provider serves several entity roots (`roots`) and has no root of its own — chain over `store.entity(name)` |

Pen build errors (`LinqBuildError`, raised by `@jarenjs/linq/schema`,
`/model`, `/jslt` and the pens that follow them; LINQ-FORMAT.md §1.3 is
the normative home, this table mirrors it):

| Code | Condition |
|---|---|
| `JL0101` | a pen received a value it cannot spell: not JSON, not what the keyword takes, or a name → value map whose prototype a `__proto__:` literal replaced |
| `JL0102` | a pen was asked for a construct the format cannot carry |
| `JL0103` | a `$defs` name collision, a dangling ref, or an unnamed recursion |
| `JL0104` | a pen-owned keyword through `meta()`, or an external a captured rule did not declare |
| `JL0105` | a relation hop on the chain cannot lower: a many-to-many member (its join table is not a queryable root), a composite or undeclared key, or a malformed relation entry (§3, §4 "relation navigation") |
| `JL0106` | a migration step names a table the target model does not declare, or a draft it cannot match |
| `JL0107` | the client (`@jarenjs/linq/db`, [DB-CLIENT.md](DB-CLIENT.md)) named a member that is not the relation kind the operation needs: `include()` over a member that is not a declared relation, `link()`/`unlink()` over a relation that is not many-to-many |

Runtime errors (`LinqRuntimeError`):

| Code | Condition |
|---|---|
| `JL2001` | `first`/`single` found no element |
| `JL2002` | `single` found more than one element |
| `JL2003` | `elementAt` is out of range |
| `JL2004` | an asynchronous provider cannot back the synchronous surface |
| `JL2005` | a push queue was fed after it ended |
| `JL2006` | a provider answered an element terminal with something other than one array |
| `JL2007` | a ledger settlement named a ref that settles no started record — `createDbLedger`'s fence ([DB-CLIENT.md §2.6](DB-CLIENT.md#26-the-ledger)) |

Engine errors (`JQ…`) from a hand-written `fromDocument` document pass
through unwrapped — they already carry their own code and `docPath` —
with one exception: `JQ0008` (a schema operator with no type-test
compiler) is reported as `JL0003`, because the fix is the same
`compileTypeTest` hook whether `ofType`/`cast` or the document spelled
the operator.

## 10. The asynchronous surface: streaming and barriers

`fromAsync(source, options?)` gives the same operator surface over
async sources — joins only over a provider, see the table — emitting the SAME query
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
| `join`, `groupJoin` | over a PROVIDER origin, before any `mapAsync`: pushed WHOLE inside the one document, with an async sequence over the same provider (or one sharing its `scope`) as the inner side — the store answers a two-root equijoin in one statement; over an iterable, a cursor or a push queue `JL0005`: a join's inner side re-reads the source, and a single-pass source cannot be read twice (join on the sync surface, or collect the stream first) |
| `count`, `any`, `all`, `first`, `single`, `elementAt` | stream with early exit where semantics allow |
| `sum`, `average`, `min`, `max`, `last` | consume the stream; the aggregate itself runs through the ENGINE over the collected items, so its semantics (type errors included) are identical to the sync surface |

**Early termination MUST close the source**: `first()`, `any()`,
`take(n)`, and an exception mid-chain all call `.return()` on the
iterator — a generator left suspended holds a file handle or a read
transaction open. `explain()` reports `{ barriers: [{ operator,
reason }], streaming, barrier, hops, document }` — `hops` the relation
hops the callbacks navigated, as on the sync surface (§4); `streaming`
(`'row'` or `'buffered'`) and `barrier` what THIS surface does with the
item stream, one item at a time or a buffer at its first local barrier
— or, when a `mapAsync` sits in the chain, `{ split: { pushed,
residual } }` instead of `document` (`toDocument()` refuses with
`JL0005`: a host callback has no document form). Over a provider the
pushed document's own class — a set residual, an external the store
cannot bind — is the provider's `explain(document, { externals:
bindings })` to report, and the cursor a `for await` pulls from
carries the same `streaming`/`barrier` (§12). No silent caps, no silent
buffering: if a chain materialises, the report says which operator
forced it.

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

- a **provider** (§8) — asked for BEFORE the shapes below, so an
  `execute` duck that also happens to be iterable is a provider. The
  whole chain up to the first `mapAsync` — the terminal's wrapper
  included — is ONE document `execute` receives, once, with the bound
  externals, and `execute` MAY answer a promise here (D8: the contract
  mirrors §8's; the awaiting is this surface's). The residual after a
  `mapAsync` streams locally over the pushed rows, and `explain()`
  reports `{ split: { pushed, residual } }` exactly as for a
  synchronous prefix, with `barriers` naming only the residual's own.
  The same chain through `from(store.sync.entity('X'))` and
  `fromAsync(store.entity('X'))` MUST emit byte-identical documents —
  the one-operator-set proof, extended to roots;
- any **`AsyncIterable`** (async generators, `ReadableStream` — every
  target exposes `Symbol.asyncIterator` on it, josl's
  `iterateCsvStream` output);
- any sync iterable (wrapped);
- a **cursor**: `{ next(): Promise<{done, value}>, return?() }` — the
  shape the store's own row cursor implements (`QueryCursor`), adopted
  as-is. A provider that offers `cursor(document, options)` — the
  store's collections and entity sets do — is handed the pushed
  document there when the chain is ITERATED, so a `for await` pulls
  one row at a time from an open statement and a `break` releases it;
  `toArray()` and the other terminals still push one whole window;
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

## 13. Worked examples

Every `js` fence below is EXECUTED. `test/linq/pen-docs.test.js` writes
it as a module beside the workspace's `node_modules` — so `@jarenjs/linq`
resolves exactly as it does for a consumer — imports it, and asserts that
the single export's `toDocument()` equals the `json` fence beside it. A
fence that drifts from the emitter fails the suite; nothing here is a
sketch.

The eight are chosen to teach the CAPTURE MODEL rather than to cover the
operator table (§4 is the table). Read them in order: the first shows
what a chain is, and each one after it adds one thing the emitted
document does that the source does not obviously say.

They are also one question, asked eight ways, over one small blog's data
— the users, the posts they wrote and the orders placed against them.
Nothing is shared between the fences at run time (each is a whole module,
and that is what the gate runs), but the shapes are the same throughout,
so a member you meet in §13.1 means the same thing in §13.8, and the two
fences that need a PROVIDER rather than an array — the join and the hop —
are that same blog seen as a store's entity sets.

### 13.1 The chain, whole

The opening example of the README and of §2, executed. `where` becomes
the FLWOR `$where`, `orderBy` an `$orderby` key spec
(`orderByDescending`, `thenBy` and `thenByDescending` extend the same
clause), and `select` the `$return` constructor — one phrase, in the
order a reader writes it.

```js
import { from } from '@jarenjs/linq';

const users = [
  { id: 1, name: 'Ada', age: 36 },
  { id: 2, name: 'Bo', age: 19 },
];

export const adults = from(users)
  .where((u) => u.age.gt(21))
  .orderBy((u) => u.name)
  .select((u) => ({ id: u.id, name: u.name }));
```

```json
{
  "$for": { "it": ["$[*]"] },
  "$where": { "$gt": ["$it.age", 21] },
  "$orderby": { "$key": "$it.name" },
  "$return": { "id": "$it.id", "name": "$it.name" }
}
```

`adults.toArray()` answers `[{ "id": 1, "name": "Ada" }]`. The source is
bound through an array constructor, `["$[*]"]`, and §5 says why: the
engine unpacks an item that is an array one level, which is right for a
path and wrong for a row.

### 13.2 A join is a nested `$for` and an equality

Both sides read ONE input, so a join's other side derives from the same
source — or, as here, from a second provider sharing its `scope`: two
entity sets of one store are two roots of one multi-entity document, and
the store answers the equijoin in a single statement (§8).

```js
import { from } from '@jarenjs/linq';

// two entity sets of ONE store: two roots of one multi-entity input,
// which is what a shared `scope` declares (§8)
const scope = {};
const postSet = { execute: () => [], root: '$.Post[*]', scope };
const userSet = { execute: () => [], root: '$.User[*]', scope };

export const bylines = from(postSet).join(
  from(userSet),
  (p) => p.authorId,
  (u) => u.id,
  (p, u) => ({ title: p.title, author: u.name }),
);
```

```json
{
  "$for": { "it": "$.Post[*]", "it2": "$.User[*]" },
  "$where": { "$eq": ["$it.authorId", "$it2.id"] },
  "$return": { "title": "$it.title", "author": "$it2.name" }
}
```

There is no `$join` operator in the emitted document and there is no need
for one: the engine recognises this shape at COMPILE time and runs a hash
join (QUERY-FORMAT §6). It recognises it **only when both key
expressions are plain member paths** — `(p) => p.authorId` and
`(u) => u.id` are; `(p) => p.title.lower()` is not, and that join runs as
a nested loop with the same answer and a different cost. A provider's
roots stay bare (`"$.Post[*]"`, not `["$.Post[*]"]`): a stored document
is an object, so the unpacking rule §5 guards against cannot arise.

### 13.3 A group is a phrase, and its items are an array

`groupBy` emits `$groupby` and reseats: the downstream items are
`{ key, items }` objects, and every operator after it reads THOSE. The
`key` carries a `$default` to `null` because a group whose key expression
yielded nothing still has rows.

```js
import { from } from '@jarenjs/linq';

const orders = [
  { id: 1, city: 'Delft', total: 12 },
  { id: 2, city: 'Delft', total: 30 },
  { id: 3, city: 'Gouda', total: 7 },
];

export const perCity = from(orders)
  .groupBy((o) => o.city)
  .select((g) => ({ city: g.key, orders: g.items.count(), total: g.items.all().total.sum() }));
```

```json
{
  "$for": {
    "it": [
      {
        "$for": { "it": ["$[*]"] },
        "$groupby": { "g": "$it.city" },
        "$return": { "key": { "$default": ["$g", null] }, "items": ["$it"] }
      }
    ]
  },
  "$return": {
    "city": "$it.key",
    "orders": { "$count": "$it.items[*]" },
    "total": { "$sum": "$it.items[*].total" }
  }
}
```

`perCity.toArray()` answers `[{ city: 'Delft', orders: 2, total: 42 },
{ city: 'Gouda', orders: 1, total: 7 }]`.

**A group aggregates as its ROWS.** `g.items.count()` is the number of
rows in the group: the chain knows `items` holds a group and emits
`{ "$count": "$it.items[*]" }` — the fan — rather than `$count` over the
one array value, which would answer `1` for every group. This is the
same rule a group-JOIN's group has always kept (`g.count()` there is the
number of matches, §4), and the two group shapes now spell it the same
way.

`g.items` itself is still the array, and everything an array can do it
still does: a member takes it whole (`{ rows: g.items }` emits
`"$it.items"`), `at(0)` indexes it, and `all()` fans it explicitly —
which is what `g.items.all().total.sum()` above needs, because summing a
MEMBER of each row means fanning the rows first and then reading the
member (`"$it.items[*].total"`). Only the aggregates changed, and only
for the member the emitter writes the group into.

An array a CALLER stored is a different thing and keeps the older rule:
`u.tags.count()` is `1`. At capture time an array member and a scalar
member are the same path — the chain has no type to tell them apart, and
inventing one would be a guess — so `u.tags.all().count()` is how the
elements are counted, and `u.tags.exists()` is what the un-fanned form
was really answering.

### 13.4 A relation name hops, and the document never carries it

When the items are the rows of an entity whose provider carries a
relation table, a member access naming a declared relation records a HOP
and is lowered, at capture, into the correlated phrase §4's "relation
navigation" rows spell. What the reader writes is `p.author.name`; what
the store receives has no member called `author` anywhere in it.

```js
import { from } from '@jarenjs/linq';

// a store's entity set: its rows carry the entity's relation table
// (MODEL-FORMAT §10.1), which is what makes a relation name hop
const postSet = {
  execute: () => [],
  root: '$.Post[*]',
  scope: {
    relations: {
      Post: { author: { to: 'User', kind: 'oneToOne', via: 'authorId', targetKey: 'id' } },
      User: { posts: { to: 'Post', kind: 'oneToMany', via: 'authorId', targetKey: 'id' } },
    },
  },
  relations: { author: { to: 'User', kind: 'oneToOne', via: 'authorId', targetKey: 'id' } },
};

export const bylines = from(postSet)
  .select((p) => ({ title: p.title, author: p.author.name, siblings: p.author.posts.count() }));
```

```json
{
  "$for": { "it": "$.Post[*]" },
  "$return": {
    "title": "$it.title",
    "author": {
      "$for": { "r1": "$.User[*]" },
      "$where": { "$eq": ["$r1.id", "$it.authorId"] },
      "$return": "$r1.name"
    },
    "siblings": {
      "$count": {
        "$for": { "r2": "$.User[*]" },
        "$where": { "$eq": ["$r2.id", "$it.authorId"] },
        "$return": {
          "$for": { "r3": "$.Post[*]" },
          "$where": { "$eq": ["$r3.authorId", "$r2.id"] },
          "$return": "$r3"
        }
      }
    }
  }
}
```

Three things this document shows that the source does not:

- **The hop bindings are numbered per CAPTURE, not per hop site.** Both
  members are captured by one `select` callback, so the first hop takes
  `r1` and the chained one takes `r2` and `r3`. A second callback — a
  `where` before this `select` — would start again at `r1` in its own
  phrase.
- **`kind` decides which side of the equality carries the key.** The
  to-one hop compares the TARGET's key with the row's foreign key
  (`$r1.id` against `$it.authorId`); the to-many hop inside it compares
  the target's foreign key with the row's key (`$r3.authorId` against
  `$r2.id`).
- **A chained hop re-binds its source.** `p.author.posts` is not one
  phrase with two roots; it is a phrase inside a phrase, the inner one
  correlated with the outer's binding. The scope's `relations` is what
  lets the second link find `User`'s table — without it the first hop
  lowers and `posts` would be an ordinary member of the target.

`p.author` and `p.author.posts` are declarations of intent, not
instructions: `explain().hops` lists what the callbacks navigated, and
no lowered shape pushes natively in this version — a store runs the
phrase as a named residual and says so (§8).

### 13.5 A parameter is a seam, not a value

`.params()` DECLARES and BINDS in one call. The declaration is what the
document carries — `$tenantId`, an external (QUERY-FORMAT §9) — and the
binding is what the runner is handed beside it. The same document serves
every tenant, which is what makes it cacheable, loggable and pushable to
a provider as a prepared statement.

```js
import { from } from '@jarenjs/linq';

const orders = [{ id: 1, tenant: 'a7', total: 12 }];

export const ours = from(orders)
  .params({ tenantId: 'a7' })
  .where((r, p) => r.tenant.eq(p.tenantId));
```

```json
{
  "$for": { "it": ["$[*]"] },
  "$where": { "$eq": ["$it.tenant", "$tenantId"] },
  "$return": "$it"
}
```

`ours.explain().externals` is `['tenantId']` and `explain().bindings` is
`{ tenantId: 'a7' }` — the two halves the seam keeps apart. Reading an
undeclared name is `JL0004` at build time rather than `JQ0005` at compile
time (§14), and `.params({ tenantId: 'b3' })` on the result re-runs the
same document under the new value.

### 13.6 `selectMany` unpacks exactly one level

The projected value is iterated once — an array member's elements, a
constructed array's members, a scalar as itself — and the FLWOR `$return`
concatenates per tuple. That is a nested `$for` whose binding legally
shadows the outer `it`.

```js
import { from } from '@jarenjs/linq';

const posts = [{ id: 1, tags: ['linq', 'json'] }, { id: 2, tags: [] }];

export const tags = from(posts).selectMany((p) => p.tags);
```

```json
{
  "$for": { "it": ["$[*]"] },
  "$return": {
    "$for": { "it": "$it.tags" },
    "$return": "$it"
  }
}
```

`tags.toArray()` answers `["linq", "json"]`: the second post contributes
nothing, and an array of arrays would come back as an array of arrays —
one level, never a deep flatten.

### 13.7 `ofType` is a `$valid` filter, and it needs a compiler

`ofType` emits a `$valid` over a JSON Schema literal and `cast` an
`$assert` per item. Both are SCHEMA operators, and the query engine
compiles a schema operator only when a type-test compiler is injected —
so the option travels with the source, not with the operator.

```js
import { from } from '@jarenjs/linq';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const users = [{ id: 1, email: 'ada@example.com' }, { id: 2 }];

export const reachable = from(users, { compileTypeTest: createTypeTestCompiler() })
  .ofType({ type: 'object', required: ['email'] });
```

```json
{
  "$for": { "it": ["$[*]"] },
  "$where": { "$valid": ["$it", { "type": "object", "required": ["email"] }] },
  "$return": "$it"
}
```

The document is the same with or without the hook — emission never needs
it. What needs it is running: `from(users).ofType(…).toArray()` is
`JL0003` with the fix in the message (§14), and a schema-pen builder may
stand in for the literal (`s.object({ email: s.string() })`), whose
document is taken.

### 13.8 A hand-written document is a source of items

`fromDocument` attaches a stored or hand-written query document; its
result is the item sequence, and every operator chains over it. Only the
envelope this version knows is unwrapped — anything else is handed to the
engine so ITS verdict is what surfaces (§14).

```js
import { fromDocument } from '@jarenjs/linq';

const users = [{ id: 1, name: 'Ada', age: 36 }];
const saved = {
  $query: '0.1',
  $expr: { $for: { it: ['$[*]'] }, $where: { $gt: ['$it.age', 21] }, $return: '$it' },
};

export const names = fromDocument(users, saved).select((u) => u.name);
```

```json
{
  "$for": {
    "it": [
      {
        "$for": { "it": ["$[*]"] },
        "$where": { "$gt": ["$it.age", 21] },
        "$return": "$it"
      }
    ]
  },
  "$return": "$it.name"
}
```

`names.toArray()` answers `["Ada"]`. The saved document became the source
of a new phrase rather than being merged into one — which is what keeps a
document a reader did not write from being reinterpreted. A
`fromDocument` chain never hops (§3): there the document decides what the
items are, so a relation table has nothing to attach to.

## 14. Refusals

§9 is the normative code table: every `JL` code this package can raise,
held equal to the runtime's `LINQ_CODES` by
`test/errors/code-tables.test.js`. This section is the other half a
reader needs — the SPELLING that trips each one and the spelling that
works.

The chain raises fourteen of the twenty: `JL0001`–`JL0007` at build
time, `JL2001`–`JL2006` while a terminal runs, and `JL0105`, which sits
in the `JL01xx` block because a relation hop is a pen-shaped refusal but
is raised by the chain's own expression capture. The other six —
`JL0101`–`JL0104`, `JL0106` and `JL0107` — are the PENS' and the
CLIENT's. Their per-code conditions are the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3, and the spelling that trips each
one is in §4 of the document of the pen that raises it:
[SCHEMA-PEN.md](SCHEMA-PEN.md#4-refusals),
[MODEL-PEN.md](MODEL-PEN.md#4-refusals),
[JSLT-PEN.md](JSLT-PEN.md#4-refusals),
[MIGRATION-PEN.md](MIGRATION-PEN.md#4-refusals),
[CONTRACT-PEN.md](CONTRACT-PEN.md#4-refusals),
[FLOW-PEN.md](FLOW-PEN.md#4-refusals),
[APP-PEN.md](APP-PEN.md#4-refusals),
[FORMS-PEN.md](FORMS-PEN.md#4-refusals), and
[DB-CLIENT.md](DB-CLIENT.md#4-refusals) for the client.

`test/linq/pen-docs.test.js` holds the list below equal, in both
directions, to the codes thrown by the chain's own modules —
`packages/linq/src/*.js` less `json-boundary.js` and `capture-root.js`,
which are the pens' shared doors and raise only `JL01xx` (the gate
proves that too, so the exclusion cannot hide a chain refusal).

| Code | What the chain raises it for |
|---|---|
| `JL0001` | `from()`/`fromAsync()` received a source that is neither a supported shape nor a provider |
| `JL0002` | an expression proxy was used outside the capture it belongs to |
| `JL0003` | `ofType`/`cast` compiled a schema operator with no type-test compiler injected |
| `JL0004` | a parameter was read undeclared, declared under a reserved or invalid name, bound to a non-JSON value, or bound to two values by one join |
| `JL0005` | an operator was used invalidly at build time: a value the document cannot carry, a stage in the wrong place, a bad argument, an async-surface rule |
| `JL0006` | an operator §4 records as `unsupported` was invoked |
| `JL0007` | a provider serves several entity roots and has none of its own |
| `JL0105` | a relation hop cannot lower to a phrase |
| `JL2001` | `first`/`single`/`last`, or `average`/`min`/`max`, over an empty sequence |
| `JL2002` | `single`/`singleOrDefault` over two or more elements |
| `JL2003` | `elementAt` out of range |
| `JL2004` | a provider's `execute()` answered a promise on the synchronous surface |
| `JL2005` | a push queue was fed after `end()` |
| `JL2006` | a provider answered an element terminal with something other than one array |

`JL2007` is the client door's, not the chain's: `createDbLedger`'s stale
settlement ([DB-CLIENT.md §2.6](DB-CLIENT.md#26-the-ledger)); it is
listed with the runtime errors above and raised by no chain module.

Every message below is the one the chain raised when the spelling beside
it was run, with the code prefix (`JL0005: `) removed. Where a refusal
carries a `docPath`, it is appended to the message text as well
(`… at /0/$where/$valid`).

### 14.1 `JL0001` — the source

Dispatch happens ONCE, at `from()`/`fromAsync()` time, never at
enumeration time: an `execute` duck is a provider and is never
enumerated locally, any iterable gets the in-memory reference semantics,
and anything else is refused before a single row is read.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `from(42)` | `from() needs an iterable or a provider exposing execute(document, options)` | an array, a string, a `Set`, a generator, or a provider |
| `fromAsync(42)` | `fromAsync() needs an async iterable, an iterable, a cursor ({ next, return? }) or a push queue` | one of the five shapes §12 lists |
| `fromAsync('abc')` | the same message | a string is a CHUNK on the async surface, not a character stream — feed it through `createPushQueue()`. `from('abc')` iterates characters, and the twins differ here by design (§12) |

### 14.2 `JL0002` — the proxy left its capture

A recording proxy belongs to exactly ONE capture. The two conditions read
alike and mean different things, so they carry different messages.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `let saved; from(rows).where((u) => { saved = u; return u.id.gt(0); }); from(rows).where(() => saved.id.gt(0))` | `an expression proxy escaped its capture callback; expressions cannot be stored and replayed across operators` | capture in the callback that uses it — the document would otherwise reference a binding this phrase does not have |
| `from(rows).select((u) => ({ n: from(rows).where((v) => v.id.eq(u.id)).count() }))` | `an expression proxy of an enclosing capture was used inside a nested capture — a correlated subquery cannot be spelled this way (the inner document rebinds the item); compute the inner query first and use its result` | compute the inner query first, or — over a provider with a relation table — write the hop (§13.4), which is what a correlated phrase is |

Captures NEST legally: a chain built and run inside a callback
(`select((u) => ({ n: from(other).count() }))`) is ordinary, because it
touches none of the enclosing proxies. `===` between proxies is
untrappable and therefore undetectable; do not compare proxies.

### 14.3 `JL0003` — the schema operators need a compiler

`ofType` and `cast` emit `$valid` and `$assert`, and the query engine
compiles those only against an injected type-test compiler. The refusal
arrives when the document COMPILES, not when it is emitted (§13.7), and
it carries the `docPath` of the operator that needed it.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `from(rows).ofType({ type: 'object' }).toArray()` | `ofType/cast compile schema operators, which need a type-test compiler — pass options.compileTypeTest to from()/fromDocument() (e.g. createTypeTestCompiler() from @jarenjs/validate/query)` — `docPath` `/0/$where/$valid` | `from(rows, { compileTypeTest: createTypeTestCompiler() })` |
| `from(rows).cast({ type: 'object' }).toArray()` | the same message — `docPath` `/0/$return/$assert` | the same option |

The fix is one option on the source, and it is the same fix whether the
operator came from `ofType`/`cast` or from a hand-written document: the
engine's own `JQ0008` is re-reported under this code for that reason
(§9).

### 14.4 `JL0004` — the parameters

`.params({ … })` declares AND binds. Everything that can go wrong with a
name or a value is one code, because the reader's next action is the same
in every case: fix the `params()` call.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `from(rows).where((r, p) => r.tenant.eq(p.tenantId))` | `parameter 'tenantId' is not declared — declare it first: .params({ tenantId: value })` | declare it, as the message spells |
| `from(rows).params(42)` | `params takes an object of name → value bindings` | an object literal |
| `from(rows).params({ 'a-b': 1 })` | `'a-b' is not a valid parameter name` | an identifier: letters, digits and `_`, not starting with a digit |
| `from(rows).params({ it: 1 })` | `'it' is reserved (the emitted document's own binding names: it, it2, acc, g, and r1, r2, … for relation hops)` | any other name |
| `from(rows).params({ r1: 1 })` | the same message | `r`-plus-digits is reserved for the bindings a hop allocates (§13.4) |
| `from(rows).params({ d: new Date() })` | `parameter 'd' is bound to a Date instance, which is not query data — convert it first (a Date to its ISO string or epoch number, a Map to an object, NaN or -0 to a number)` | `d: date.toISOString()` |
| `from(rows).params({ z: -0 })` | `parameter 'z' is bound to -0, which is not query data — …` (the same tail) | `0`, or negate at query time — and note the message names `-0`, not the `0` its JSON text would suggest |
| `a.params({ k: 1 }).join(b.params({ k: 2 }), …)` | `parameter 'k' is bound to different values by the two sides of join — one document carries one binding per name; bind it once, or rename one side` | bind it once on the outer side, or rename one |

A binding is not a captured constant: it becomes an external, and later a
bound SQL parameter. A `Date` there would compare against nothing and
answer `[]` with no error anywhere — which is why the check is at
`params()` time and not at the boundary.

### 14.5 `JL0005` — the build-time catch-all

The widest code the chain has, and deliberately one code: every condition
under it is a defect in the chain as WRITTEN, found before anything runs.
They group into four families.

**A value the document cannot carry.** The query data model is JSON
(§5).

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `select(() => NaN)` | `a captured expression cannot embed NaN — the query data model is JSON, which has no NaN or Infinity, and lenient serialization would fold it into null` | a finite number |
| `select(() => Infinity)` | the same message, naming `Infinity` | a finite number, or a bound |
| `select(() => -0)` | `a captured expression cannot embed -0 — it shares its JSON text with 0 while dividing to the opposite infinity, so a document holding it cannot be keyed, stored or compared faithfully; use 0, or negate at query time` | `0` |
| `where((u) => u.at.eq(new Date()))` | `a captured expression cannot embed a Date instance — it carries no own enumerable members, so it would embed as {}. Convert it to query data first (a Date to its ISO string or epoch number, a Map to an object), or bind it through params().` | the ISO string, or `.params({ when })` |
| `select(() => new Map())` | the same message, naming `Map` | a plain object |
| `select(() => MyArray.from([1]))` | `a captured expression cannot embed an Array subclass instance — its behaviour is not expressible as query data` | a plain array |
| `select(() => undefined)` | `a captured expression cannot embed an undefined value` | `null`, which IS a value (§5) — a callback that forgot its `return` is the usual cause |

`-0` is the one nobody guesses, and it is worth the sentence. It is
JSON-representable by TEXT and not by value: `JSON.stringify(-0)` is
`"0"`, so a document holding it round-trips to a different number, while
`1 / -0` is `-Infinity` and `1 / 0` is `+Infinity`. A key built from it
would not match itself, a stored document would not compare equal to the
one that was written, and a cached compilation keyed by the document's
text would serve the `0` query for the `-0` one. There is no spelling
that preserves it, so there is no spelling that is allowed to.

**A stage in the wrong place, or an argument that is not one.**

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `from(rows).thenBy((u) => u.id)` | `thenBy/thenByDescending must directly follow orderBy/orderByDescending` | an `orderBy` first — `thenBy` extends that clause, it does not open one |
| `select((u) => u.age.add(1).all())` | `all() fans out a PATH ('$it.tags[*]'); it cannot follow an operator result` | `all()` on the path, then the operator |
| `select((u) => u.posts.title)` (a to-many hop) | `.title is read off a to-many relation, which holds an array of related rows — fan them first (.all().title), index one (.at(0)), or aggregate the array` | `u.posts.all().title`, `u.posts.at(0).title` |
| `from(rows).skip(-1)` | `skip takes a non-negative integer, got -1` | a non-negative integer |
| `from(rows).take(1.5)` | `take takes a non-negative integer, got 1.5` | an integer |
| `from(rows).where(42)` | `this operator takes a callback function` | a callback |
| `from(rows).join([], …)` | `join takes another sequence as its inner side` | `from(sameSource)` |
| `from(a).join(from(b), …)` | `join's other side must derive from the same source, or from two providers sharing one scope (one store's entity sets) — a query document reads one input; load both collections under one root, or join two entity sets of one store` | one source, or one store's two entity sets (§13.2) |
| `from(rows).concat(42)` | `concat takes a sequence or a constant array` | a sequence over the same source, or an array |
| `select((r) => r.v.all().rolling(spec))` where `spec` reads the row | `rolling() takes a plain literal spec object; it is read once when the query compiles, so it cannot be an expression or carry a captured value` | a literal spec |

**A provider or a document that is not shaped as the contract says.**

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `from({ execute, root: 7 })` | `a provider's root is a path expression string ('$.Post[*]'), got number` | a path expression, or no `root` at all |
| `createPushQueue({ highWaterMark: 0 })` | `highWaterMark must be a positive integer` | a positive integer (1024 by default) |

A malformed VERSION envelope is not this code: `fromDocument(rows,
{ $query: '0.2', $expr })` is compiled by the engine first, so the
engine's own verdict is what surfaces — `JQ0006: unknown query format
version "0.2"` — and a future document is never silently run as a 0.1
one. Only a spelling the engine accepts and this version does not
reaches `JL0005` (`a version envelope is exactly { $query: '0.1',
$expr: … } (QUERY-FORMAT §4.1)`).

**The async surface's own rules** (§§10–12).

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `fromAsync(rows).mapAsync(fn, {})` | `mapAsync requires { concurrency: <positive integer> } — an unbounded default is a denial of service waiting for a slow downstream` | `{ concurrency: 8 }` |
| `mapAsync(fn, { concurrency: 2, mode: 'x' })` | `mapAsync mode must be one of parallel\|concat\|switch\|exhaust, got 'x'` | one of the four |
| `mapAsync(42, { concurrency: 1 })` | `mapAsync takes an async callback` | a callback |
| `fromAsync(rows).concat(fromAsync(rows))` | `concat on an async sequence takes a constant array — an async source cannot be re-iterated for a second sequence` | a constant array, or `concat` on the sync surface |
| `fromAsync(rows).join(fromAsync(rows), …)` | `join on the async surface is pushed whole to a provider — it needs a provider source and comes before any mapAsync; over an iterable, a cursor or a push queue there is no join, because a single-pass source cannot be read twice (QUERY-PEN.md §10)` | join over a provider, join on the sync surface, or collect the stream first |
| `fromAsync(rows).mapAsync(fn, { concurrency: 1 }).toDocument()` | `toDocument() cannot represent mapAsync (a host callback); explain() reports the split` | `explain()`, which reports `{ split: { pushed, residual } }` |

### 14.6 `JL0006` — an operator §4 records as `unsupported`

Two operators, both refused by NAME rather than emulated wrongly. §16
carries the reasons.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `from(rows).zip(other)` | `zip is unsupported: the query grammar has no positional co-iteration (see QUERY-PEN.md §4)` | there is none — index both sides and join on the index, in host code |
| `from(rows).aggregate((acc, it) => …)` | `aggregate(fn) is unsupported: JSON cannot spell the implicit first element as a lambda seed — pass a seed, aggregate(seed, fn) (see QUERY-PEN.md §4)` | `aggregate(0, (acc, it) => acc.add(it.n))` |

### 14.7 `JL0007` — a provider with several roots and none of its own

A store is a provider that serves many entity roots. `$[*]` over its
entity map would answer every entity's rows mixed together, or count the
SETS rather than the rows — an answer that looks like an answer. So the
chain refuses at `from()` time and names the roots to chain over.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `from(store)` where the store serves `User` and `Post` | `this provider serves entity roots User, Post and has no root of its own — chain over one of them: from(store.entity(name)) (QUERY-PEN.md §8)` | `from(store.sync.entity('User'))` |
| `fromAsync(store)` | the same message | `fromAsync(store.entity('User'))` |

`fromDocument` keeps its own rule and is not refused here: there the
document IS the root, so there is nothing to choose.

### 14.8 `JL0105` — a hop that cannot lower

A relation hop is lowered at CAPTURE into the correlated phrase §4
spells. Four conditions have no phrase to lower to, and each names what
is missing.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `u.labels` where `labels` is many-to-many | `'labels' is a many-to-many relation: the join table 'UserLabel' is not a queryable root in this version, so the hop has no phrase to lower to — read the memberships with load({ include: { labels: true } })` | `load({ include: { labels: true } })` through the client ([DB-CLIENT.md](DB-CLIENT.md) §2) |
| a relation entry that is not a relation record | `the relation table names 'labels' but its entry is not a relation record ({ to, kind, via, fkEntity, fkTargets, targetKey } — MODEL-FORMAT §10.1)` | a provider whose `relations` is the store's own table |
| a relation whose `kind` is neither of the two | `'labels' has relation kind 'oneToNone', which is not one this surface lowers (oneToOne, oneToMany)` | `oneToOne` or `oneToMany` |
| a relation over a composite or undeclared key | `'labels' cannot lower: its foreign key or the key it references is composite or undeclared, and the hop's equality would need a tuple the vocabulary does not spell` | a single-column key, or `load({ include })` |

The first is the one a reader meets: a many-to-many member is exactly
the relation that has no direction to correlate in. The hop would need
to bind the JOIN TABLE as a root and correlate twice, and a join table
is not a queryable root in this version — so there is no phrase, and an
honest refusal that names the join table beats a document that quietly
reads the wrong rows. `load({ include })` reads the memberships through
the client instead, which is the operation the store already has.

### 14.9 The runtime codes

`JL2001`–`JL2006` are raised while a terminal RUNS. The first three are
the C# semantics, exactly (§6); the last three are the seam between a
terminal and the provider behind it.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `from([]).first()` | `first() found no element` | `firstOrDefault()`, which answers `undefined` |
| `from([]).single()` | `single() found no element` | `singleOrDefault(d)` |
| `from([]).last()` | `last() found no element` | `lastOrDefault(d)` |
| `from([]).average()` | `average() of an empty sequence` | guard with `any()`; `sum()` of nothing is `0` and `count()` of nothing is `0` |
| `from([]).min()` | `min() of an empty sequence` | as above |
| `from([]).max()` | `max() of an empty sequence` | as above |
| `from([1, 2]).single()` | `single() found more than one element` | `first()`, or a narrower `where` |
| `from([1, 2]).singleOrDefault(0)` | `singleOrDefault() found more than one element` | the default covers EMPTY, never ambiguity |
| `from([1]).elementAt(5)` | `elementAt(5) is out of range` | `elementAtOrDefault(5, d)` |
| `from(asyncProvider).toArray()` | `this provider's execute() answered a promise, and a Sequence terminal is a value — an asynchronous provider cannot back the synchronous surface. Emit the document with toDocument() and await the provider directly, or use a synchronous provider.` | `fromAsync(provider)` (§12), or `toDocument()` and await |
| `q.end(); q.feed(1)` on a push queue | `feed() after end(): the push queue is closed and takes no more values` | feed before `end()`; `end(error)` fails the stream |
| a provider answering `toArray()` with `undefined` | `the provider answered toArray() with undefined — an element terminal emits an array constructor, so a conforming execute() answers exactly one array (QUERY-PEN.md §8)` | answer the one array the window constructor yields (`[]` for none) |

`JL2004` is worth the sentence its message spends. The old seam let the
promise through under the value's type: `count()` handed back a `Promise`
typed `number`, and `first()` indexed the promise and returned
`undefined`. A wrong answer with no error anywhere is worse than a slow
one, so the synchronous surface refuses an asynchronous provider by name.

`JL2006` is the same argument one layer out: an element terminal emits
`[window]` precisely so a single array-valued item cannot be confused
with several items (§6), so a provider that answers anything but one
array is named rather than indexed into a `TypeError`. `count()` and the
other scalar terminals are not windowed and are not checked — a provider
answering `3` there is answering correctly.

## 15. The types

The declarations are HAND-AUTHORED, in `packages/linq/types/index.d.ts`
— chosen over emitting them from JSDoc, so the implementation stays
plain JavaScript and this file is the public type contract. The line it
holds, stated in the README and at the top of the file:

> the common path is precisely typed; the exotic path is honestly
> `unknown`; nothing is ever a WRONG type.

Every claim below has two pins. `test/consumer/types.ts` compiles it as
a consumer would (`strict`, `skipLibCheck: false`, NodeNext — the chain's
block runs from its `@jarenjs/linq` import to the end of the file), and
`test/linq/types.test.js` is its runtime twin: the same spelling, asserted
to emit and to answer what the type says it does. A claim with only one
of the two is half a claim.

### 15.1 The recording proxy is a type, not a shape

§3 describes what a proxy RECORDS; this is what it is declared as. The
callback's first argument is `Expr<T>` — a conditional that picks the
expression family from the element type, in an order that matters
because the `DateTime` brand is a string subtype and must match first:

| The element is | The proxy is | It carries |
|---|---|---|
| a `DateTime`-branded string | `DateTimeExpr` | the whole §8.13 date family |
| a `string` | `StringExpr` | comparison, the string operators, the spatial family (a geohash is a string) |
| a `number` | `NumberExpr` | comparison and arithmetic |
| a `boolean` | `BoolExpr` | `and`, `or`, `not` |
| an array | `ArrayExpr<E>` | `all()`, `at()`, `count()`, `similarity()`, the §8.16 sequence operators |
| an object | `ObjectExpr<T>` | exactly its members, recursively typed |
| anything else | `UnknownExpr` | everything, precisely nothing |

`UnknownExpr` is the honest top and the whole reason the line above can
be kept: where inference ends — a dynamic `get(name)`, a member read
after an operator, an element the source never declared — the surface
widens rather than guesses. `from(users).select((u) => u.get('odd key'))
.first()` is `unknown`, and a caller who knows better narrows it
themselves.

A member's type goes through `MemberExpr<V>`, which has one job: an
`unknown` (or `any`) member answers `UnknownExpr` rather than the first
arm `Expr<>` would otherwise pick for it. An OPTIONAL member is its
non-nullable expression — `u.address.city` on `address?: { city: string }`
is a `StringExpr`, and the projection's element type is `string` — because
absence is a query-time fact (§4: an empty operand compares false,
`exists()`/`isEmpty()` say which), not a type-level one.

Method names shadow member access on the proxy (§3), and the types say
so: `u.count` is the aggregate, and the escape `u.get('count')` is
declared to answer `UnknownExpr` because a dynamic key cannot be looked
up in `T`.

### 15.2 The sequence carries two type parameters

`Sequence<T, P>` and `AsyncSequence<T, P>`: `T` is the element, `P` the
parameters declared so far.

- `select` re-types through `Unwrap<R>` — an expression by its `__value`
  phantom, an object or array literal recursively, a literal as itself —
  so `select((u) => ({ id: u.id, name: u.name }))` is
  `Sequence<{ id: number, name: string }>` with nothing written down.
- `selectMany` unwraps and then takes the ELEMENT, one level, exactly as
  the runtime does (§13.6).
- `groupBy` reseats to `Sequence<{ key: K | null, items: T[] }>` — the
  `| null` is the `$default` the emitted document carries.
- `params<Q>(bindings: Q)` answers `Sequence<T, P & Q>`, and every
  callback's last argument is `ParamsExpr<P>`: exactly the declared
  names, each typed from its bound value. Reading an undeclared name is
  a compile error before it is `JL0004` (§14.4).
- `mapAsync<R>` crosses to `AsyncSequence<Awaited<R>, P>`: the element
  becomes the callback's RESOLVED type, and every terminal becomes a
  promise.
- `min()`/`max()` follow the operand family — a sequence of strings
  answers a string, everything else a number.

### 15.3 A document is a document

`fromDocument<T = unknown>(source, document, options?)` infers NOTHING
from the document it is handed: a query document is data, not a type,
and there is no honest way to read an element type out of it. It answers
`Sequence<unknown>` until the caller states otherwise
(`fromDocument<User>(rows, saved)`), and so does a parsed JSON literal
handed to `from()` — `from(JSON.parse(text)).toArray()` is `unknown[]`.
The pens are the inference route: `ofType`/`cast` given a schema-pen
builder re-type the sequence from the builder's own `Infer<>`
(`ofType<S>(schema: SchemaBuilder<S, …>): Sequence<S, P>`), and a
hand-written schema literal is caller-asserted with `unknown` as the
default, because a JSON Schema is not a TypeScript type.

The same rule runs through the provider seam: `Provider<T>` carries an
`__item` phantom, so a typed entity set infers its rows without a cast
and an untyped provider is `unknown`.

### 15.4 The exports that are not vocabulary

Five exports are surface a caller meets without ever calling:

| Export | Why a caller meets it |
|---|---|
| `Sequence` | to ANNOTATE (`function page(q: Sequence<User>)`). Its constructor is `private`: a sequence is built by `from`/`fromDocument`, never with `new` |
| `AsyncSequence` | the same, for the asynchronous surface (`fromAsync`) |
| `LinqBuildError` | `instanceof` on the build-time refusals — `code`, `reason` and `docPath` are declared readonly |
| `LinqRuntimeError` | `instanceof` on the terminal-time refusals, same three members |
| `LINQ_CODES` | the runtime code table §9 is held equal to; a `Readonly<Record<string, string>>` a host can render |

`DateTime` is a type-only export and costs nothing at run time: it is
`string & { __jarenTag: 'date-time' }`, a marker that turns on the date
family for a member without making every string a date.

**A refusal encoded in the types takes a `never` PARAMETER, not just a
`never` return.** `zip(unsupported: never): never` makes both
`from(rows).zip()` and `from(rows).zip(other)` compile errors. The
return type alone does not: `zip(...args: never[])` refuses an argument
and accepts none, so the one spelling a caller would actually write
type-checked and failed at run time instead. A JavaScript caller still
gets the coded refusal (`JL0006`, §14.6) — the encoding closes the
TypeScript half, and `test/consumer/types.ts` pins both spellings with
`@ts-expect-error`.

## 16. What it cannot spell

§4's table records three constructs as `unsupported` — a status that
means "throws a coded error naming the reason", never "emits something
close". This section gathers them with their reasons, and adds the
boundaries the package draws on purpose, so a reader can check each one
rather than discover it.

### 16.1 The three refused operators

| Construct | Why there is no emission | What it raises |
|---|---|---|
| `aggregate(fn)`, unseeded | C#'s unseeded overload means "the first element is the seed". A query document is data: there is no clause that says "start from whichever item comes first", and inventing one would make the document mean something the grammar does not define | `JL0006`, naming the seeded form |
| `zip()` | positional co-iteration — pair the *n*th of one input with the *n*th of another — has no operator in the grammar, and a FLWOR phrase reads ONE input. Emulating it would mean materialising both sides in the host, which is exactly the "runs somewhere other than the document says" the chain exists to avoid | `JL0006` |
| a many-to-many hop (`u.labels`) | the phrase would have to bind the JOIN TABLE as a root and correlate twice, and a join table is not a queryable root in this version | `JL0105`, naming the join table and pointing at `load({ include })` |

All three are checked in both directions: `test/linq/pen-docs.test.js`
holds §14's code list equal to what the chain's modules throw, and the
spellings above are the ones §14 shows raising them.

### 16.2 The operators that are not on the surface at all

The C# operator set is larger than the query grammar, and the chain does
not carry a method for an operator it cannot lower. `union`,
`intersect`, `except`, `skipWhile`, `takeWhile`, `chunk`, `append`,
`prepend`, `sequenceEqual`, `toDictionary` and `toLookup` are not
declared and not defined — reaching for one is a plain `TypeError`, not a
coded refusal, because there is no method to refuse from.

Two of them are compositions a reader can write today, and they are
worth naming because the absence otherwise reads as a gap:

- **`Union`** is `.concat(other).distinct()` — `$seq` followed by
  `$distinct`, whose equality is the grammar's deep structural one.
- **`Append`** is `.concat([value])`: a constant array's elements join
  the stream. There is no general `Prepend`, because `concat` appends;
  starting from the single-element source and concatenating the rest
  (`from([first]).concat(rest)`) works only when `rest` is a constant
  array.

The rest have no composition on this surface. `skipWhile`/`takeWhile`
need a predicate-terminated window and `$subsequence` takes positions;
`chunk` needs a windowing operator; `sequenceEqual`, `toDictionary` and
`toLookup` are host-side shapes rather than query results — read the
sequence and build them.

### 16.3 The boundaries this package draws on purpose

Each of these is a design commitment, checkable in the source:

- **No `Function.prototype.toString`, anywhere.** A callback is executed
  ONCE against recording proxies; nothing parses its text. `grep -rn
  'toString()' packages/linq/src/` finds none — the only `toString` in
  the package is a radix conversion escaping a control character in a
  path segment.
- **No per-element callback evaluation.** A predicate runs at BUILD
  time, produces an expression, and the engine evaluates that expression
  per row. This is why a JavaScript operator inside a callback is a trap
  rather than a slow path (§3): `&&`, `||`, `!`, `?:`, `in`, `typeof`,
  `Object.keys` and `===` evaluate against the proxy and yield a
  silently wrong document, while `>` and `+` throw a plain `TypeError`.
  Use `.and()`, `.or()`, `.not()` and the comparison methods.
- **No second grammar.** The chain emits the published query language
  and nothing else; `toDocument()` is compilable by a bare
  `compileJsonQuery` with no linq involvement, which is what makes a
  query loggable, storable, diffable and authorable by a constrained
  decoder.
- **No inference from a document.** `fromDocument` and a parsed JSON
  literal answer `unknown` (§15.3). The pens are the inference route.
- **No clock.** There is no `now()`: §8.13 has no clock operator, and a
  fluent surface does not get to add one. Bind the instant with
  `.params({ now })`.
- **No `knn` method.** k-nearest is `orderByDescending(… similarity …)`
  then `take(k)` — the composition the emitted document already is (§4).
- **No async query engine.** `packages/json` is strictly synchronous.
  `fromAsync` makes the SOURCE and the host boundary asynchronous and
  emits byte-identical documents (§10); there are no `selectAwait` or
  `whereAwait` variants, because a per-element async predicate is
  `mapAsync` then `where` (§11).
- **No correlated subquery through a captured proxy.** An enclosing
  capture's proxy used inside a nested one is `JL0002` (§14.2) — the
  inner document rebinds `$it`. Over a provider with a relation table
  the correlated phrase has a spelling: the hop (§13.4).
- **No non-JSON constant.** A `Date`, `Map`, `Set`, `RegExp`, class
  instance, `NaN`, `±Infinity` or `-0` in a captured expression is
  `JL0005`, and in a `params()` binding `JL0004` (§14.4, §14.5). The
  query data model is JSON, and a value that cannot survive the
  round-trip cannot be compared faithfully.
- **No document form for a host callback.** A chain carrying `mapAsync`
  has no `toDocument()`; `explain()` reports `{ split: { pushed,
  residual } }` instead (§11). The split is stated rather than hidden,
  which is the same honesty a SQL pushdown owes its residual.

### 16.4 When not to reach for the chain

The chain earns its place when a query has to TRAVEL — to a store, into a
saved document, across a version. Where it does not, the honest answers
are shorter:

- **The data is in memory and the query stays there.** `rows.filter()`
  and `rows.map()` are the language's own, need no import, and any
  JavaScript reader can follow them. A chain over an array buys one
  thing: a document you could have sent somewhere. If you are not going
  to send it, you are paying for a capture you never read.
- **The query is one statement of SQL you already know.** A store takes
  raw statements. A reporting query with three joins and a window
  function is a statement; expressing it as a chain either does not
  translate (§4 records every such gap) or translates into something
  nobody can review against the original.
- **The document already exists.** A saved `$query` is run with
  `fromDocument` (§13.8) or handed to the engine directly. Re-authoring
  it through the chain to "keep it typed" makes two spellings of one
  query, and the one that runs in production is whichever the deploy
  picked.
- **The predicate needs JavaScript.** A callback runs ONCE, at build
  time, against a proxy — so `if`, `&&`, a loop, a call into a library
  and a closure over a mutable variable all either throw or record
  something you did not mean (§3). A predicate that genuinely needs the
  language is `mapAsync`'s host boundary (§11), and a chain that is
  mostly host boundary is a program with a `where` at the front.
- **You want a type, not a query.** `ofType` and `cast` narrow a
  sequence's element type; neither validates unless a compiler was
  handed in (§13.7, §14.3). A chain reached for as a type assertion is a
  cast with extra steps — `from(rows)` already answers
  `Sequence<unknown>` and `as` is the language's own spelling.

## 17. Cost

A consumer importing `from` from `@jarenjs/linq` and calling one
terminal bundles **<!--fact:bundle.chain-->173,426<!--/fact--> bytes** (esbuild, ESM, minified, tree-shaken,
`platform: 'neutral'`). The figure is measured by
`scripts/check-tree-shaking.js`'s chain probe and compared with this
section on every `npm run test:tree-shaking`: it is derived, never typed,
and a stale one is red here rather than wrong in a document somebody
reads.

Of that, **<!--fact:bundle.chain.own-->39,371<!--/fact--> bytes** are the chain's own modules — `sequence.js`,
`async.js`, `expression.js`, `document.js`, `provider.js`,
`concurrency.js`, `errors.js` and `schema-of.js`. The remaining ~134 kB
is the query ENGINE and the core it stands on: a chain's document has to
run somewhere, and the in-memory runner is the reference semantics every
provider is measured against (§8). A consumer that only ever hands
`toDocument()` to a provider still pays it today, because the terminal
that emits the document is the same terminal that would run it.

The probe asserts four exclusions, and they are the cost claims worth
making:

- **no schema-pen module** — `ofType`/`cast` reach a builder through a
  registry symbol looked up by key (`schema-of.js`), so the chain
  imports nothing from `src/schema/`;
- **no client module** — `src/db/` is the package's one runtime edge and
  is not on this path;
- **not one byte of `@jarenjs/db`, `@jarenjs/validate` or
  `@jarenjs/formats`** — the client's optional peers. A consumer of the
  chain alone installs nothing new;
- **no pen bytes at all**, in either direction: the pens carry no chain
  module either, which is what keeps a <!--fact:bundle.jslt.kb-->19<!--/fact--> kB JSLT
  pen <!--fact:bundle.jslt.kb-->19<!--/fact--> kB.

`docs/CONSUMING.md` states the rounded price of all ten subpaths in one
table, each figure held equal to the same measurements. Two of its rows
are the ones to read together: the chain at <!--fact:bundle.chain.kb-->173<!--/fact--> kB and
`./db` at <!--fact:bundle.db.kb-->542<!--/fact--> kB.
The client costs what the store costs, by construction, and the chain
costs what running a query costs.

**Taking a pen as well costs less than the two figures suggest**, and
the reason is worth knowing: a bundler counts a shared module once, and
the chain and every pen share the expression capture (`expression.js`)
and the coded errors under it (`errors.js`, and `@jarenjs/core`'s error
and object helpers). A consumer importing the chain AND the schema pen
bundles **<!--fact:bundle.chain.withSchemaPen-->194,501<!--/fact--> bytes** — **<!--fact:bundle.chain.shared-->11,424<!--/fact--> bytes** less than the sum of the
figure above and [SCHEMA-PEN.md](SCHEMA-PEN.md#7-cost) §7's, which is
what those shared modules weigh. The probe measures that pair too, so
the saving is derived like everything else here. What the chain does NOT
share with a pen is the pens' own two shared doors, `capture-root.js`
and `json-boundary.js`: no chain callback reaches either, and neither is
in the figure above. Every pen document's §7 carries its own
subpath's figure; nothing here restates one.
