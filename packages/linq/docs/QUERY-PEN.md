# The Jaren query pen (normative)

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
// { "$for": { "it": "$[*]" }, "$where": { "$eq": ["$it.tenant", "$tenantId"] }, "$return": "$it" }
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
reason }], hops, document }` — `hops` the relation hops the callbacks
navigated, as on the sync surface (§4) — or, when a `mapAsync` sits in
the chain, `{ split: { pushed, residual } }` instead of `document`
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
