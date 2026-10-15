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
  `$it.list[0]` (negative integers count from the end; an integer
  beyond ±(2^53 − 1) is `JL0005` at build time — no array has an element
  there, and the path text cannot spell it); `at()` indexes an ARRAY,
  as a JSONPath index does: on a string member it answers nothing
  (`u.name.at(0)` is no character), and `u.name.substring(0, 1)` is the
  first character — the typed surface offers `at()` on no string
  expression, so only an untyped member can reach this;
  `u.list.all()` records `$it.list[*]`; a key that is not an
  identifier — or one that collides with a method name — goes through
  `u.get('odd key')`. A member read off an operator result is that
  member too: `u.items.at(u.i).$id` writes the key `get('$id')` writes
  (`{ "$get": [ …, "$$id" ] }`), never a reference to a variable or a
  parameter named `id`.
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
  cannot be spelled this way. (`===` between proxies is untrappable: a
  callback that answers `u.a === u.b` read members and is refused with
  `JL0109` (§14.10), but an identity test of bare proxies, `v === u`,
  reads nothing and stays undetectable; do not compare proxies.)
- **Some of JavaScript's own operators cannot be trapped.** A proxy is
  an object, so `&&`, `||`, `!`, `?:`, `in`, `typeof`, `Object.keys`,
  truthiness (`if (u.deleted)`), `===` and `!==` — and `==`/`!=` against
  `null` or `undefined` — evaluate against the PROXY, never the value:
  `u.age.gt(21) && u.name.eq('x')` captures only the right operand,
  `!u.deleted` is the constant `false`, `u.deleted ? 'a' : 'b'` is
  always `'a'`. A callback that read its argument and answers such a
  boolean itself — `(u) => u.deleted === null`, `(u) => !u.deleted` —
  is now refused with `JL0109` (§14.10) instead of capturing that
  constant; a boolean the callback only uses — inside a returned object
  or array, as a pen helper's argument, or as the condition of a `?:`,
  `&&` or `||` that answers a capture — is not refused and still writes
  a silently wrong document, and neither is a test of the bare argument
  (`(u) => u != null`), which reads nothing. Destructuring a parameter is
  a read, so an optional filter chooses its callback outside the callback
  (§14.10) rather than answering `true` after the read. Use the expression
  surface — `.and()`, `.or()`, `.not()` — for logic. The
  arithmetic and comparison operators (`u.age > 21`, `u.age + 1`,
  `${u.name}`, and `==` against a string, a number or a boolean) do ask
  the proxy for a primitive, and the capture refuses them with `JL0108`:
  one message, naming the comparison methods and `.concat()`; §14.9 gives
  the spelling that works for each. `JSON.stringify(u)` is refused with
  `JL0108` too (the capture has no value to serialize yet), and `u.toJSON`
  is that refusal rather than a member read: a document member named
  `toJSON` is read with `u.get('toJSON')`. Host method calls are outside the
  capture DSL: `u.toString()` can raise a plain `TypeError`. An array or a
  string method on a member (`u.tags.includes('a')`, `u.items.map(…)`,
  `u.name.toUpperCase()`) is refused with `JL0108` naming the spelling that
  works, or saying there is none (§14.9); `toString` remains
  an ordinary data-member name. A method name read without its call
  (`u.tags.length`, `u.name.upper`) is a function, and `>`, `+`, `==`, a
  template literal or `String()` over it is `JL0108` naming the method and
  its call (§14.9), not the constant `false` or the closure's source text. Serialize the finished chain's
  `toDocument()` result, after capture, to inspect or persist a query.
- **The parameters argument is not a value.** A callback's last
  argument is the parameters proxy (§7): `p.tenantId` reads one declared
  parameter, and the proxy itself embedded anywhere — a projection
  member, an operand, an array item — is `JL0004`. That covers the C#
  index idiom `select((x, i) => ({ v: x.a, i }))` too: a chain callback
  receives no element index, and the `i` there, the parameters proxy,
  used to embed as an empty object `{}`. Asking it for its keys is the
  same refusal, so a spread (`({ ...p })`), `Object.assign({}, p)` and
  `Object.keys(p)` — which used to read as `{}` and `[]` — are `JL0004`
  too.
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
  `JL0105` at build time (a composite key; a many-to-many entry that
  does not name its join row's columns, so there is no join root to
  lower through — MODEL-FORMAT §10.7); a member read off
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
| `SelectMany` | `$return` of a `$for` phrase over the projection — the projected value is iterated ONE level (an array member's elements, a constructed array's members; a scalar is itself), and the FLWOR `$return` concatenates per tuple. Emitted as `{ "$for": { "it": <projection> }, "$return": "$it" }` (the nested phrase rebinds `it` legally) | native | `(e: Expr<T>) => Expr<R[]>` → `Seq<R>`; C#'s result selector `(item, element) => …` is `JL0005` naming `selectMany(sel).select(resultSel)`, which maps each element (a result that reads the outer item as well has no spelling here) |
| `OrderBy` / `OrderByDescending` | `$orderby` key spec (`$dir`; `$empty`/`$collation` via `options`) | native | `(e: Expr<T>) => Expr<K>` → `Seq<T>`; C#'s comparer overload is `JL0005` — `{ collation }` names a registered collation |
| `ThenBy` / `ThenByDescending` | appended `$orderby` spec; must directly follow `orderBy*` (`JL0005`) | native | as `OrderBy` |
| `GroupBy` | `$groupby`; downstream items are `{ key, items }` | native | `(e: Expr<T>) => Expr<K>` → `Seq<{key: K, items: T[]}>`; C#'s element and result selectors are `JL0005` naming `groupBy(key).select((g) => …)`, which reads each group |
| `Join` | nested `$for` + `$where` `$eq` — the engine rewrites this shape to a HASH JOIN (compile-time, QUERY-FORMAT §6), which is why it is fast **when both keys are plain member paths** (`o => o.pid`, `i => i.id`); a key with an operator in it (`o => o.name.lower()`, `o => o.p.add(0)`) is not a probe key and the join runs as a nested loop. Both sides MUST derive from the same source, or from two providers sharing one `scope` (§8 — two entity sets of one store are two roots of ONE multi-entity input, and the store answers the equijoin in one statement); anything else is `JL0005`: a query document reads one input. On the async surface the join exists only over a provider, pushed whole (§10). The inner side's declared parameters ride along (§7) | native | `(inner: Seq<U>, ok, ik, (o: Expr<T>, i: Expr<U>) => Expr<R>)` → `Seq<R>` |
| `GroupJoin` | the matching group bound as an ARRAY value — `$let: { g: [ <correlated inner phrase> ] }` — so the result selector can index it (`g.at(0)`), fan it (`g.all()`), place it in a member (`{ matches: g }`) and aggregate over its members (`(u, g) => ({ n: g.count() })` counts the matches, `g.exists()` is whether there are any); same-source rule and parameter merge as `Join` | emulated | `(inner: Seq<U>, ok, ik, (o: Expr<T>, g: ArrayExpr<U> & AggregatableExpr) => Expr<R>)` → `Seq<R>` |
| `Skip` / `Take` | `$subsequence` | native | `(n: number)` → `Seq<T>`; one count and no more (`JL0005`) |
| `Distinct` | `$distinct` (deep structural equality — the grouping relation) | native | `()` → `Seq<T>`; reads no key, and one handed a selector is `JL0005` naming `select(sel).distinct()` (the projected values, not a by-key choice of rows) |
| `Reverse` | `$reverse` | native | `()` → `Seq<T>`; reads no argument (`JL0005`) |
| `Count` / `Sum` / `Average` / `Min` / `Max` | §8.8 aggregates (`Average` → `$avg`) | native | `count(): number`; `sum(): number`; `average/min/max(): number` (throw `JL2001` on empty; `min`/`max` follow the operand family); none reads an argument, and one handed an argument is `JL0005` naming `where(pred).count()` or `select(sel).sum()` |
| `Any()` | `$exists` | native | `(): boolean` |
| `Any(pred)` / `All(pred)` | `$some` / `$every` quantifier phrase | native | `(pred): boolean` (`all` vacuously true on empty) |
| `Aggregate(seed, fn)` | `$fold` — the accumulator clause; the result is a sequence of exactly ONE accumulated value (`.first()` reads it) | native | `(seed: A, (acc: Expr<A>, e: Expr<T>) => Expr<A>)` → `Seq<A>`; C#'s result selector is `JL0005` naming `aggregate(seed, step).select(resultSel)` |
| `Aggregate(fn)` (unseeded) | — JSON cannot spell "the implicit first element" as a lambda seed | unsupported (`JL0006`) | — |
| `First` / `FirstOrDefault` | `[ $subsequence [expr, 0, 1] ]` window | native | `(): T` (`JL2001` on empty) / `(d?): T \| D`; neither reads a predicate, and one handed to either is `JL0005` naming `where(pred).first()` / `where(pred).firstOrDefault(d)` |
| `Single` / `SingleOrDefault` | `[ $subsequence [expr, 0, 2] ]` window | native | `(): T` (`JL2001`/`JL2002`) / `(d?): T \| D` (`JL2002` on 2+); no predicate (`JL0005`, as `First`) |
| `Last` / `LastOrDefault` | `[ $subsequence [$reverse expr, 0, 1] ]` | native | as `First` |
| `ElementAt` / `ElementAtOrDefault` | `[ $subsequence [expr, i, 1] ]` | native | `(i): T` (`JL2003` out of range) / `(i, d?)` |
| `Concat` | `$seq` (a constant array's elements join the stream) | native | `(other: Seq<T> \| T[])` → `Seq<T>` |
| `DefaultIfEmpty` | `$default` | native | `(fallback?: T)` → `Seq<T>` |
| `OfType<S>` | `$valid` filter with a JSON Schema literal | native | `(schema)` → `Seq<S>`; needs `compileTypeTest` (`JL0003`) |
| `Cast<S>` | `$assert` per item | native | `(schema)` → `Seq<S>`; needs `compileTypeTest` (`JL0003`) |
| `Zip` | — no positional co-iteration in the grammar | unsupported (`JL0006`) | — |
| expression methods | `eq ne lt le gt ge` → `$eq…$ge`; `in(values)` → `$eq` against `{ $seq: values }`, `in(path)` → `$eq` against `path[*]`, or a path that already fans as it stands (membership, never `eq(array)`); `and or not` (a chain extends one argument list); `add sub mul div idiv mod neg`; `startsWith endsWith contains matches upper lower length concat substring replace` → §8.7; `count sum avg min max` → §8.8 (aggregates as expressions, e.g. over a group); `exists isEmpty` — these seven read no argument, and one handed an argument is `JL0005` (§13.3, §14.5); `at all get` | native | on `Expr<…>`, per the typed-surface order |
| date family (§8.13) | the whole family, one method per operator. Components `year month day hours minutes seconds offset week weekYear quarter weekday`; instants `epoch datetime`; predicates `isDate isTime isDatetime isDuration`; arithmetic `startOf(unit) endOf(unit) dateAdd(duration \| amount, unit?) dateSub(…) dateDiff(to, unit) dateFormat(pattern)`. `dateAdd`/`dateSub`/`dateFormat` carry the prefix because `add`, `sub` and `format` are taken or ambiguous on this surface — the same reason §8.14 spells `geoArea`. There is no `now()`: §8.13 has no clock, and a fluent surface does not get to add one | native | on `DateTimeExpr` (the `DateTime` brand) and on `UnknownExpr` |
| series family (§8.16) | `overlaps(other)` → `$overlaps`; `timeBucket(every, origin?, context?)` → `$time-bucket`; `resample(spec)`, `rolling(spec)` and `asof(right, spec?)` → the three sequence operators. A **spec is a literal** and is embedded verbatim — it is read once when the query compiles, so a spec built from the row is `JL0005`, and every rule about what it may *say* stays in the compiler (`JQ0003`). Note that a member literally named `at` is read with `get('at')`: `at(index)` is path navigation on this surface | native | on `ArrayExpr`/fanned paths for the three sequence operators, on `Expr<…>` for the two scalar ones |
| spatial family (§8.14) | `bbox geoArea geoLength centroid` → `$bbox $area $length $centroid`; `distance within bboxIntersects` → `$distance $within $bbox-intersects`; `geohash(precision?)` → `$geohash` (optional arity, like `substring`); `geoParse geoText geohashBounds geohashNeighbours` → the conversion family; `geoSimplify(tolerance)` → `$geo-simplify`. A plain JSON polygon embeds as a literal (`p.at.within(poly)`); `.params({ region })` makes it an external instead | native | on `Expr<…>`, per the typed-surface order |
| vector family (§8.15) | `similarity(other)` → `$similarity`. The other operand is an array of numbers: a captured one embeds as a literal, `.params({ query })` binds it at call time. There is no `knn` method — k-nearest is `orderByDescending(...).take(k)`, which is the composition the emitted document already is | native | on `Expr<…>`, per the typed-surface order |
| relation navigation — to-one hop (`p.author`, `p.author.email`) | over a provider with a relation table (§3, §8): `{ "$for": { "r1": "$.User[*]" }, "$where": { "$eq": ["$r1.<targetKey>", "$it.<via>"] }, "$return": "$r1.email" }` — the target's key against the row's foreign key (`kind: "oneToOne"`, the key on the declaring entity). Zero or one item: an object member's one value (absent when there is none), an operand elsewhere (empty compares false; `exists()`/`isEmpty()` say which), and under `$orderby` a key that may be empty (`$empty` applies). The binding is `r1`, `r2`, … per capture. An array member of the target fans as a path member does: `p.author.tags.all()` returns `"$r1.tags[*]"`, so `p.author.tags.all().eq('a')` holds when any element equals `'a'`, `p.author.items.all().sku` is every element's `sku` and `p.author.items.all().qty.sum()` totals them | native by desugaring — the document is the phrase; a store plans it as a correlated subselect where its correlation is proven (MODEL-FORMAT §10.1) and runs it as a named residual otherwise (`explain()`, §10.6) | `Expr<Post>['author']` is `ObjectExpr<User>` — emit's optional relation member, nothing new |
| relation navigation — to-many hop (`u.posts`, `u.posts.all()`) | `{ "$for": { "r1": "$.Post[*]" }, "$where": { "$eq": ["$r1.<via>", "$it.<targetKey>"] }, "$return": "$r1" }` — the target's foreign key against the row's key (`kind: "oneToMany"`, the key on the target). As a VALUE the phrase is packed, `[ <phrase> ]`, the array of related rows a member holds (`{ posts: u.posts }`; `u.posts.at(0)` indexes it); fanned, `u.posts.all()` is the bare phrase, a sequence: `.all().count()` → `{ "$count": <phrase> }`, `.all().exists()` → `{ "$exists": <phrase> }`, `.all().title` returns `"$r1.title"` per row (`[u.posts.all().title]` packs the titles; `.all().tags.all()` returns `"$r1.tags[*]"`, every related row's elements). `count()`/`exists()` on the value range over the rows too, as a group-join's group's do | native by desugaring, as above | `ArrayExpr<Post>`; `all()` is `FannedExpr<Post>` |
| relation navigation — chained, and from every row binding | hops nest: `p.author.posts.all().count()` is `{ "$count": { "$for": { "r1": "$.User[*]" }, "$where": …, "$return": { "$for": { "r2": "$.Post[*]" }, "$where": { "$eq": ["$r2.authorId", "$r1.id"] }, "$return": "$r2" } } }` — the inner phrase correlates with the outer binding; a hop off a fanned to-many (`u.posts.all().author`) is a sequence, one target per row; a join's `it2` hops from the inner row; a group-join's fanned group (`g.all().author`) binds each row first (`{ "$for": { "r1": "$g[*]" }, "$return": <hop over $r1> }`); the group itself is an array, not a row | native by desugaring, as above | as the target's `Expr<…>` |
| relation navigation — many-to-many (`u.labels`) | two links through the join table's root: the join row, then the target row it names (MODEL-FORMAT §10.7) | emulated | — |

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
a member access at all. `r.get('similarity')` reads the data. A stock
movement stored as `in` (beside `out`) bites the same way since `in()`
became membership: `s.in` is the method, and `s.get('in')` reads the
quantity.

**Membership is `in()`, not `eq(array)`.** `$eq` is a general comparison
(QUERY-FORMAT §8.4): true when any item of one side equals any item of
the other. `u.sku.in(['a', 'b'])` emits `{ "$eq": ["$it.sku", { "$seq":
["a", "b"] }] }` — the sequence of the values, so the member matches when
it equals any of them — while `u.sku.eq(['a', 'b'])` embeds the array as
ONE value (`$const`), which only an array-valued member equals. A list
bound at call time is a path: `.params({ skus })` with `u.sku.in(p.skus)`
emits `{ "$eq": ["$it.sku", "$skus[*]"] }`, one document for every list,
and `u.sku.in(u.tags)` is membership in an array member. A parameter
read whole as the list — `p.skus`, or `p.skus.all()` — must be bound to
an array when the chain runs (a terminal, an iteration, `explain()` —
over a `mapAsync` split too, whose prefix's lists count):
anything else is `JL0004` naming the parameter, where a scalar used to
match nothing and an object its member values, both silently; a member
path below a parameter (`p.cfg.skus`) is the binding's own shape and is
not checked. A client's `live(chain, { externals })` holds the rule to
what it registers — the chain's bindings with `externals` merged over
them — so a placeholder the options override is not refused, and an
override that is not an array is ([DB-CLIENT.md](DB-CLIENT.md) §2.1). A path that
already fans is the list as it stands, wherever along it the fan is:
`u.sku.in(u.tags.all())` emits `"$it.tags[*]"`, as `u.sku.in(u.tags)`
does, and `u.sku.in(u.items.all().sku)` emits `"$it.items[*].sku"`,
every item's `sku`. A member of a relation target is a list by the same
rule: `p.label.in(p.author.tags)` and `p.label.in(p.author.tags.all())`
both compare against the hop's phrase returning `"$r1.tags[*]"`, and
`u.name.in(u.posts.all().label)` against every related row's `label`; a
store answers them as the in-memory engine does. The values are
scalars — a string, a number, a boolean, `null` or a captured
expression; an object or array item, or an argument that is neither an
array nor a path — the relation's own rows (`p.author`,
`u.posts.all()`) among them — is `JL0005`. A store plans a list of values, a
parameter's list and a chain of `.or()` equalities on one member to one
bound list the member's index seeks (MODEL-FORMAT §10.1); membership in
another member's array compares two members of one row, which runs in
the engine, and `explain()` names it.

**A chain of `.or()` or `.and()` is one operator.** `a.or(b).or(c)`
emits `{ "$or": [a, b, c] }`, not a nest: chaining extends one argument
list (an operand that is itself an `or` keeps its own grouping), so a
thousand-term chain is one flat operator rather than a thousand-deep
document, and analysis flattens a nested same-operator call it is handed
anyway (QUERY-FORMAT §8.6).

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
opposite infinity. So is a sparse array (`[1, , 3]`): JSON has no holes,
and a hole used to become `null` inside a `$const` and reach the engine
as `undefined` from a constructor or an `in()` list — a refusal at run
time instead of at capture. Convert first — a `Date` to its ISO string
or epoch number, a hole to `null`. The boundary is the same for a
`concat` array and for a `params()` binding (`JL0004`): a parameter
becomes an external and, on a provider, a bound SQL parameter, so a
`Date` there would compare against nothing and answer `[]` with no error
anywhere. A constant is copied where it is captured, so writing into the
object afterwards changes nothing in a query already built (a query that
kept the reference answered the mutated value); a `fromDocument` document
and the schema `ofType`/`cast` are given are copied the same way.

## 6. Terminal semantics

The real C# semantics, because getting these wrong is how a
"LINQ-like" library becomes lodash with different names:

- `first()` on empty throws `JL2001`; `firstOrDefault(d)` returns `d`
  (or `undefined` when omitted).
- `single()` on empty throws `JL2001`; on two-or-more throws `JL2002`;
  `singleOrDefault(d)` throws on two-or-more and returns `d` on empty.
- `last()`/`lastOrDefault(d)` mirror `first` over the reversed window.
- `elementAt(i)` out of range throws `JL2003`;
  `elementAtOrDefault(i, d)` returns `d`; a function there, like a second
  argument after `d`, is `JL0005` naming `where(pred).elementAtOrDefault(i, d)`
  (it answered the function itself out of range).
- `average()`, `min()` and `max()` over an empty sequence throw
  `JL2001` (C# `InvalidOperationException`); `sum()` of nothing is `0`;
  `count()` of nothing is `0`.
- `count()`, `sum()`, `average()`, `min()` and `max()` read no argument:
  `count((r) => r.n > 3)` is `JL0005` naming `where(pred).count()`, and
  `sum((r) => r.n)` names `select(sel).sum()`. They used to build — the
  callback was never called, so `count(pred)` counted every row and
  `sum(sel)` folded the items it was meant to project (`JQ2001` over
  objects, the unprojected total over numbers). An `undefined` argument is
  not an argument, so a caller that forwards an optional one it did not
  receive is unchanged; `fromAsync()` refuses the same way, as a rejected
  promise.
- `first()`, `last()`, `single()`, `toArray()`, `distinct()` and `reverse()`
  read no argument either: `first((r) => r.n > 3)` is `JL0005` naming
  `where(pred).first()`, `distinct((r) => r.n)` names `select(sel).distinct()`
  (the projected values, not one row per key) and `toArray(sel)` names
  `select(sel).toArray()`. `firstOrDefault`, `lastOrDefault` and
  `singleOrDefault` read one DEFAULT VALUE and no predicate: a function
  there, or a second argument, is `JL0005` naming
  `where(pred).firstOrDefault(value)`. All of them used to build and answer
  as if the argument had never been written: `first(pred)` was the first
  row, `last(pred)` the last, `single(pred)` the only row (or `JL2002`
  whenever there were two), `firstOrDefault(pred)` the first row or, over
  an empty sequence, the function itself, `distinct(sel)` the plain
  distinct rows, and `toArray(sel)` and `reverse(sel)` the unprojected
  rows. `undefined` is no argument, here as above; a function-valued
  fallback is `firstOrDefault() ?? fallback`; `fromAsync()` refuses the same
  way, a terminal as a rejected promise and `distinct`/`reverse` at the
  call.
- Every operator reads exactly the arguments its row in §4 names, and an
  argument after the last one is `JL0005`: `groupBy(key, (r) => r.n)`
  (C#'s element selector), `selectMany(sel, (o, e) => …)` and
  `aggregate(0, step, (x) => x)` (C#'s result selectors), `join(…, comparer)`,
  `orderBy(key, options, comparer)`, `take(1, 2)`, `where(pred, x)`, and
  the same on `select`, `skip`, `concat`, `defaultIfEmpty`, `ofType`, `cast`,
  `groupJoin`, `thenBy*`, `params`, `mapAsync`, `any`, `all`, `elementAt`,
  `toDocument` and `explain`, and on the three that start a chain,
  `from(rows, {}, 5)`, `fromAsync(rows, {}, 5)` and
  `fromDocument(rows, document, {}, 5)`, whose message names the one
  options object that takes the engine registries. They used to build and
  answer as if it had never been written: `groupBy(key, elementSel)` still
  held whole rows in `items`, `aggregate(seed, step, resultSel)` answered
  the unprojected fold, `take(1, 2)` took one, `join(…, comparer)` compared
  as the engine compares, and `from(rows, {}, 5)` built `from(rows, {})`. The message names the spelling that does what the extra
  argument meant; a result selector that reads the
  outer item as well as the element has no spelling, and neither has a
  custom comparer. `undefined` is no argument, here as above;
  `fromAsync()` refuses the same way (a terminal as a rejected promise, a
  builder at the call).
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
`NaN`, `-0` or a sparse array is `JL0004` with the conversion named, and a
binding is copied when it is bound, so writing into the caller's object
afterwards changes neither the sequence nor what a provider receives, and each run hands a provider its own copy, so a provider that writes into its externals rewrites nothing the next run reads. A
parameter an `in()` reads whole as its list must be bound to an array
when the chain runs (§4), and the parameters argument itself is not a
value (§3): both are `JL0004` too.

The inner side of a `join`, `groupJoin` or `concat` contributes its
document WHOLE, so its declared parameters ride along into the new
sequence (`explain().externals` lists the union, `explain().bindings`
the values bound so far — what a provider receives as `externals`, and
what a host handed the chain, such as a live registration, forwards
without a second spelling); a name both sides
bind to different values is `JL0004` — one document carries one binding
per name, and two bindings that spell the same JSON (member order
included) are one value, whatever their references. Rebinding a name later (`.params({ k: 3 })`) re-runs the
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
  bare binding or a projection tree of member paths and constants
  (MODEL-FORMAT §10.2). An opaque projection remains a declared residual
  over the fetched roots (§10.6). `concat` stays
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
plans a plain hop with a proven correlation as a subselect of one statement
(MODEL-FORMAT §10.1) and runs any other in its residual over the fetched
roots, where `explain()` names the §10.6 reason and `strict` refuses it (`JD0010`).

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

The six are a CLOSED set, on `from`, `fromAsync` and `fromDocument`
alike: any other member is `JL0005`, naming the nearest one when it is
close (`from(rows, { limit })` — `did you mean 'limits'?`), and an
options argument that is not a plain object (a string, `null`, an array)
is `JL0005` too. Both used to be ignored: a misspelt `limits` left the
query unbounded, with no error anywhere. An ordering's options are
closed the same way — `empty` and `collation`, on `orderBy`,
`orderByDescending`, `thenBy` and `thenByDescending` — and a `null` there
used to escape as a raw `TypeError`; their VALUES stay the engine's to
judge (`JQ0003`).

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
| `JL0105` | a relation hop on the chain cannot lower: a many-to-many entry that does not name its join row's columns, a composite or undeclared key, or a malformed relation entry (§3, §4 "relation navigation") |
| `JL0106` | a migration step names a table the target model does not declare, or a draft it cannot match |
| `JL0107` | the client (`@jarenjs/linq/db`, [DB-CLIENT.md](DB-CLIENT.md)) named a member that is not the relation kind the operation needs: `include()` over a member that is not a declared relation, `link()`/`unlink()` over a relation that is not many-to-many |
| `JL0108` | a captured expression — in any pen's callback, or the chain's — was converted to a JavaScript primitive (`==`, `+`, a template literal or `<` met the capture proxy, or met a method read without its call, `u.name.length > 0`), met `JSON.stringify`, or had an array or a string method called on a member (`u.tags.includes('a')`) (§14.9) |
| `JL0109` | a captured callback — in any pen, or the chain — read its argument and answered a plain JavaScript boolean: `===`, `!==`, `!`, `typeof` or `== null` tested the capture proxy, never the value (§14.10) |

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
| `JL2009` | a durable mapped record violated identity, retention or fencing |
| `JL2008` | a federated fetch reached its row or byte budget (§12.1) |
| `JL2010` | a ledger `fail(ref, false)` carried no response — `createDbLedger`'s twin of the memory ledger's `JC1015` ([DB-CLIENT.md §2.6](DB-CLIENT.md#26-the-ledger)) |

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
  completion. `ordered` is a boolean (`JL0005` otherwise — the string
  `'false'` and `null` used to read as ordered; only an absent or
  `undefined` member takes the default), and the three are a closed set: a
  misspelt member (`ordred`) is `JL0005` naming the nearest, where it
  used to be ignored.
- An `AbortSignal` is threaded to every callback and aborted on early
  termination and on failure. A rejected callback FAILS CLOSED: the
  first rejection aborts every in-flight sibling and closes the source,
  including while its next pull is pending. Ordered mode still delivers
  preceding values and reports callback failures in source order. The
  producer is closed once; a failed close accompanies the callback's
  original failure in an `AggregateError`.
- `mapAsync` is NOT translatable to a provider. A provider-backed
  chain that reaches it SPLITS: everything before is pushed to the
  provider whole, everything after runs locally, and `explain()`
  reports `{ split: { pushed, residual } }` — the same residual
  honesty the SQL pushdown owes, applied to the async boundary.

## 12. The cursor contract and the source adapters

`fromAsync` accepts, in order of preference:

- a **provider** (§8) — asked for BEFORE the shapes below, so an
  `execute` duck that also happens to be iterable is a provider. The
  whole chain up to the first `mapAsync` — the terminal's wrapper
  included — is ONE document `execute` receives, once, with the bound
  externals, and `execute` MAY answer a promise here (the contract
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
  store's entity sets do — is handed the pushed document there when the
  chain is ITERATED, so a `for await` pulls one row at a time from an
  open statement and a `break` releases it; `toArray()` and the other
  terminals still push one whole window. A store's collection offers no
  `cursor()`: a chain over one is pushed as that one window when it is
  iterated too, and the `for await` walks the rows it answered;
- a **push queue** (`createPushQueue({ highWaterMark = 1024 })`) for
  feed/end-style readers with no pull protocol of their own (josl's
  push parsers deliberately have no backpressure protocol; the queue
  is where one appears): `feed(value)` returns `false` once the queue
  exceeds the mark — a pause HINT, never a hard stop — and
  `end(error?)` closes (or fails) the stream — the first `end()` decides, so a
  later one cannot erase the failure an earlier `end(error)` carried. The
  queue keeps its unread values by index: a drain is linear in the values
  fed, the mark counts the values not yet read, and several readers of one
  queue are each woken, every value reaching exactly one. The options are a closed
  set: a misspelt mark (`highWatermark`) is `JL0005` naming the nearest,
  and `null` or a non-object is `JL0005` — the first used to be ignored
  and the second to escape as a raw `TypeError`. Anything else is
  `JL0001` at `fromAsync()` time.

What this surface does NOT do, by design: it does not make the query
engine async (`packages/json` is untouched and strictly synchronous),
it does not add a second operator table, and it does not add
`selectAwait`/`whereAwait` variants.

### 12.1 The federation boundary (`federate`)

A query document reads ONE input, and a join whose sides come from two
unrelated sources is `JL0005` (§8). That refusal stands: nothing in a
chain relaxes it. What `federate()` adds is the one place to opt OUT of
it explicitly, by naming the sources and the bounds together:

```js
const fed = federate({
  sources: { orders: shop.entity('Order'), events: analytics },
  maxRows: 50_000,
  maxBytes: 32 * 1024 * 1024,
});

const rows = await fromAsync(fed.source('orders'))
  .where((o) => o.placedAt.gt(cutoff))
  .join(fromAsync(fed.source('events')), (o) => o.id, (e) => e.orderId,
    (o, e) => ({ id: o.id, at: e.at }))
  .toArray();
```

`fed.source(name)` is an ordinary provider source (§8) with the root
`$.<name>[*]` (a quoted member selector for names containing punctuation,
spaces or other characters), and all of a federation's sources share one scope — which
is exactly what admits the join. The federation is what executes it:

1. Each side's own filters and projection run at its source. Cursor sources
   receive that document directly; buffered sources receive an array wrapper
   so array-valued projected rows retain their item boundaries.
2. Mandatory equality predicates form a connected binding graph. The smallest
   declared `estimatedRows` starts the fetch. Each subsequent side is the
   smallest estimated side connected to an already fetched side. Missing or
   equal estimates preserve binding declaration order. Equality inside an OR
   does not establish an edge; disconnected bindings refuse `JL0005` before
   any source opens.
3. Each next side is reduced against the retained keys of its already fetched
   neighbours. Singular member/index paths are supported, including quoted
   names and negative array indexes. Compound key values are conservatively
   retained for the engine to compare.
4. The original query engine decides the result over those sets, in the
   original binding order. Fetch order never changes tuple or result order.
   Packed joins emitted by successive `.join()` calls execute inside out;
   their projected results become bounded intermediate sides. Aliases of one
   source retain independent fetched sets.

`explain(document)` reports `strategy`, per-side `budget`, `combinedBudget`,
`order` (the ordered side descriptions), and `resident.document`. Each side
names its source, estimate, join key, child document and `row`/`buffered`
streaming mode. Nested sides additionally expose `children`. `build` and
`probe` remain the first two sides for compatibility.

**Budgets are admission credits.** `maxRows` and `maxBytes` apply separately
at each source or intermediate. `maxTotalRows` and `maxTotalBytes` cover all
retained source and intermediate admissions in the entire call, and default
to twice their corresponding per-side budget, held at the largest safe
integer (a side budget of `Number.MAX_SAFE_INTEGER` is accepted, and its
default total is the same figure, where it used to be refused naming a
`maxTotalRows` nobody wrote). All four are positive safe integers. Credits are cumulative: freeing an intermediate's inputs does not
refund them. This conservative rule makes a nested plan's total explicit.
The spec is a closed set — `sources`, `maxRows`, `maxBytes`,
`maxTotalRows`, `maxTotalBytes` and `strategy` — and so is a described
source, `{ provider, estimatedRows? }`: any other member is `JL0005`
naming the nearest one, where a misspelt `maxTotalRow` used to leave the
combined budget at its default with no error.

A cursor refuses with `JL2008` before retaining the row that would exceed a
credit. Buffered sources are checked after they produce their array. Nested
resident phrases additionally cap `sequenceItems` and `resultItems` at
`maxRows` (or a stricter caller limit); exceeding those intermediate limits
raises `JL2008`. Intermediate bytes are checked after projection. These are
bounds on admitted data and intermediate item counts, **not** a promise to
bound a buffered provider's heap, the size of one constructed value, or the
final resident result. A caller can also supply query-engine limits for that
final result. Estimates affect planning only, never admission.

Every opened cursor closes exactly once on success, budget refusal, child
failure or cancellation. `signal` is checked at row boundaries and passed to
providers. Cleanup failures preserve a primary execution failure and never
strand another opened cursor.

There is no spill, distributed transaction or cross-source write, and none is
planned. Federated joins run in fetch order (steps 2 and 3 above): each next side
is reduced against the keys already fetched, and the query engine joins the
retained sets. A merge join would need each
provider to guarantee the order of what it yields, which no provider declares;
assuming one would answer wrong the first time a provider yields out of order.
Spilling, or a streaming intermediate engine, would be a second execution
contract, and it still could not bound what a buffered provider allocates
before it hands its array over. Keep each side inside its credits instead:
narrow a side with its own filters, declare `estimatedRows` so the smallest
side starts the fetch, or give a large side a cursor source rather than a
buffered one.

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

An aggregate reads no argument — `count`, `sum`, `avg`, `min`, `max`,
`exists` and `isEmpty` aggregate or test the value they are called on —
so `g.items.sum((r) => r.score)` is `JL0005`, naming the spelling that
works (`g.items.all().score.sum()`). It used to build: the callback was
never called, `count((r) => r.score > 3)` counted every row, and
`g.items.all().score.sum((x) => x.mul(2))` summed the scores
unchanged. An `undefined` argument is not an argument, so a caller that
forwards an optional one it did not receive is unchanged.

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
instructions: `explain().hops` lists what the callbacks navigated, and a
store pushes a hop natively where its correlation is proven (MODEL-FORMAT
§10.1) and runs the phrase as a named residual otherwise, and says so (§8).

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

`names.toArray()` answers `["Ada"]`. The saved document is copied when
`fromDocument` is called, so its author writing into it afterwards cannot
rewrite the sequence, and it became the source
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

The chain raises seventeen of the twenty-six codes:
- `JL0001`–`JL0007` at build time;
- `JL2001`–`JL2006` and `JL2008` while a terminal runs;
- `JL0105`, `JL0108` and `JL0109`. These sit in the `JL01xx` block
  because a relation hop, a primitive conversion and a boolean answer
  are pen-shaped refusals, but the chain's own expression capture raises
  them.

The other nine are the PENS' and the CLIENT's: `JL0101`–`JL0104`,
`JL0106` and `JL0107`, and the client door's `JL2007`, `JL2009` and `JL2010`. Their per-code conditions are the binder's,
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
| `JL0004` | a parameter was read undeclared, declared under a reserved or invalid name, bound to a non-JSON value, bound to two values by one join, or read whole as an `in()` list while bound to something other than an array; or the parameters argument itself was embedded as a value or spread |
| `JL0005` | an operator was used invalidly at build time: a value the document cannot carry, a stage in the wrong place, a bad argument, an option outside a closed option bag, an async-surface rule, a chain handed to the `live()`, `execute()`, `query()` or `explain()` of a source it was not built over |
| `JL0006` | an operator §4 records as `unsupported` was invoked |
| `JL0007` | a provider serves several entity roots and has none of its own |
| `JL0105` | a relation hop cannot lower to a phrase |
| `JL0108` | a captured expression was converted to a JavaScript primitive (`==`, `+`, a template literal or `<` met the capture proxy), or a method read without its call (`u.name.length`) was; met `JSON.stringify`, or had an array or a string method called on a member |
| `JL0109` | a callback read its argument and answered a plain JavaScript boolean: `===`, `!==`, `!`, `typeof` or `== null` tested the capture proxy |
| `JL2001` | `first`/`single`/`last`, or `average`/`min`/`max`, over an empty sequence |
| `JL2002` | `single`/`singleOrDefault` over two or more elements |
| `JL2003` | `elementAt` out of range |
| `JL2004` | a provider's `execute()` answered a promise on the synchronous surface |
| `JL2005` | a push queue was fed after `end()` |
| `JL2006` | a provider answered an element terminal with something other than one array |
| `JL2008` | a federated fetch or intermediate reached a per-side or combined row/byte budget (§12.1) |

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
untrappable: a callback that answers `u.a === u.b` read members and is
`JL0109` (§14.10), but an identity test of bare proxies (`v === u`) reads
nothing and stays undetectable; do not compare proxies.

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
| `from(rows).params({ d: new Date() })` | `parameter 'd' is bound to a Date instance, which is not query data — convert it first (a Date to its ISO string or epoch number, a Map to an object, NaN or -0 to a number, a hole to null)` | `d: date.toISOString()` |
| `from(rows).params({ z: -0 })` | `parameter 'z' is bound to -0, which is not query data — …` (the same tail) | `0`, or negate at query time — and note the message names `-0`, not the `0` its JSON text would suggest |
| `from(rows).params({ ids: [1, , 3] })` | `parameter 'ids' is bound to a sparse array (index 1 is a hole), which is not query data — …` (the same tail) | `[1, null, 3]` |
| `a.params({ k: 1 }).join(b.params({ k: 2 }), …)` | `parameter 'k' is bound to different values by the two sides of join — one document carries one binding per name; bind it once, or rename one side` | bind it once on the outer side, or rename one |
| `from(rows).select((x, i) => ({ v: x.a, i }))`, `where((x, p) => x.a.eq(p))` | `the parameters argument is not a value — read a declared parameter by name (p.tenantId); a chain callback receives no element index` | `p.k`, a declared parameter read by name — there is no element index to read (§3) |
| `select((x, p) => ({ ...p }))`, `Object.keys(p)` | the same message | `p.k`, by name — the proxy has no keys to list |
| `from(rows).params({ ids: 5 }).where((x, p) => x.a.in(p.ids)).toArray()` | `parameter 'ids' is the list an in() reads, so its binding must be an array, got a number — bind one value as [value]` | `.params({ ids: [5] })` |
| `client.live(chain.params({ ids: [] }), { externals: { ids: 5 } })` | the same message — the override is what the store would run | `externals: { ids: [5] }` |

A binding is not a captured constant: it becomes an external, and later a
bound SQL parameter. A `Date` there would compare against nothing and
answer `[]` with no error anywhere — which is why the check is at
`params()` time and not at the boundary. The `in()` list is the one
binding checked later, when the chain RUNS — a terminal, an iteration,
`explain()`, a live registration against the externals it registers —
because a `params()` after the capture, or a registration's own
`externals`, may rebind the name (§4).

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
| `select(() => [1, , 3])`, `where((u) => u.a.in([1, , 3]))` | `a captured expression cannot embed a sparse array — index 1 is a hole, which JSON cannot carry; write null there` | `[1, null, 3]` |
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
| `from(rows).take('2')` | `take takes a non-negative integer, got "2"` — `skip`, `take`, `elementAt` and `elementAtOrDefault`, on both surfaces, word the refused value one way: a string is quoted (it used to read as the number it spells), a bigint keeps its suffix (`got 2n`), an object or array is named (`got an object`, `got an array`, where an object read `[object Object]`), a function is `a function`, and a Symbol or null-prototype object is named (`got a symbol`) rather than escaping as the engine's own `TypeError`; a message matched on `got <number>` is unchanged | a number |
| `from(rows).where(42)` | `this operator takes a callback function` | a callback |
| `from(rows).join([], …)` | `join takes another sequence as its inner side` | `from(sameSource)` |
| `from(a).join(from(b), …)` | `join's other side must derive from the same source, or from two providers sharing one scope (one store's entity sets) — a query document reads one input; load both collections under one root, or join two entity sets of one store` | one source, or one store's two entity sets (§13.2) |
| `from(rows).concat(42)` | `concat takes a sequence or a constant array` | a sequence over the same source, or an array |
| `client.collections.orders.live(client.collections.users.where(…))` | `live() on collection 'orders' was handed a chain built over collection 'users' — a chain runs against the source it was built over; build it from this handle, or hand it to the handle it was built from` — the same for an entity handle | the chain from the handle it is registered on (`client.collections.users.live(…)`) (DB-CLIENT.md §6) |
| `client.collections.orders.execute(from(rows).where(…))`; `live`, `query` and `explain` likewise | `execute() on collection 'orders' was handed a chain built over 2 rows in memory — a handle runs a chain's document over its own rows, never the chain's; build it from this handle (or from([]) to write a document), or run it over its rows with toArray()` — the same for an entity handle | the chain from the handle (`client.collections.orders.where(…)`), `from([])` to write a document, or `from(rows).where(…).toArray()` for the rows (DB-CLIENT.md §6) |
| `select((r) => r.v.all().rolling(spec))` where `spec` reads the row | `rolling() takes a plain literal spec object, not an expression or captured value` | a literal spec |
| `select((u) => u.tags.at(2 ** 53))` | `at() takes a safe integer index, got 9007199254740992` | an index within ±(2^53 − 1), which an array can have |
| `groupBy(…).select((g) => g.items.sum((r) => r.score))`; the same with `count`, `avg`, `min`, `max`, `exists`, `isEmpty` or a predicate | `sum() takes no argument — it reads none, so the one passed would be ignored; to aggregate a member of each row fan the rows first: .all().<member>.sum()` | `g.items.all().score.sum()` (§13.3) |
| `from(rows).first((r) => r.n > 3)`; `last`, `single` and `fromAsync(rows)` likewise | `first() takes no argument — it reads none, so the one passed would be ignored; filter or project first: where(pred).first()` | `from(rows).where((r) => r.n.gt(3)).first()` |
| `from(rows).firstOrDefault((r) => r.n > 3)`; `lastOrDefault`, `singleOrDefault`, a second argument, and `fromAsync(rows)` likewise | `firstOrDefault() takes one default value, not a predicate — it reads no callback, so the one passed would be ignored or answered as the default; filter first: where(pred).firstOrDefault(value)` | `from(rows).where((r) => r.n.gt(3)).firstOrDefault(value)` |
| `from(rows).distinct((r) => r.n)`; `toArray(sel)`, `reverse(sel)` and `fromAsync(rows)` likewise | `distinct() takes no argument — it reads none, so the one passed would be ignored; filter or project first: select(sel).distinct()` (`select(sel).toArray()`, `where(pred).reverse()` for the others) | `from(rows).select((r) => r.n).distinct()` — the distinct values; a by-key choice of rows is not in the grammar |
| `from(rows).count((r) => r.n > 3)`; `sum`, `average`, `min`, `max` handed a selector; `fromAsync(rows)` likewise | `count() takes no argument — it reads none, so the one passed would be ignored; filter or project first: where(pred).count()` (`select(sel).sum()` for the others) | `from(rows).where((r) => r.n.gt(3)).count()`, `from(rows).select((r) => r.n).sum()` |
| `from(rows).groupBy((r) => r.k, (r) => r.n)` (C#'s element selector); `selectMany(sel, resultSel)`, `aggregate(seed, step, resultSel)` and `fromAsync(rows)` likewise | `groupBy() would ignore the argument past its last; groupBy(key).select((g) => ({ key: g.key, items: [g.items.all().member] }))` (`selectMany(sel).select(resultSel)` and `aggregate(seed, step).select(resultSel)` for the others) | `from(rows).groupBy((r) => r.k).select((g) => ({ key: g.key, items: [g.items.all().n] }))` — the elements of each group, as an array |
| `from(rows).take(1, 2)`; `where(pred, x)`, `select`, `skip`, `concat`, `defaultIfEmpty`, `ofType`, `cast`, `any`, `all`, `elementAt`, `params`, `mapAsync`, `toDocument`, `explain` and `fromAsync(rows)` likewise | `take() would ignore the argument past its last; skip(a).take(b)` (each member names its own spelling; `where(a).where(b)` for the ones that chain) | `from(rows).skip(1).take(2)` |
| `from(rows).orderBy(key, options, comparer)`; `orderByDescending`, `thenBy`, `thenByDescending`, `join(…, comparer)` and `groupJoin(…, comparer)` likewise | `orderBy() would ignore the argument past its last; orderBy(key, { collation }); no comparer` (`no comparer; keys compare as the engine does` for the joins) | `orderBy(key, { collation: 'name' })` with the collation registered (§8.1); a join compares as the engine does |
| `from(rows).elementAtOrDefault(9, (r) => r.n > 3)`, or a third argument | `elementAtOrDefault() takes one default value, not a predicate — it reads no callback, so the one passed would be ignored or answered as the default; filter first: where(pred).elementAtOrDefault(index, value)` | `from(rows).where((r) => r.n.gt(3)).elementAtOrDefault(9, value)` |
| `from(rows, { limit: { steps: 3 } })` | `from() does not take 'limit' — did you mean 'limits'?` | `{ limits: { steps: 3 } }` |
| `from(rows, {}, 5)`; `fromAsync(rows, {}, 5)` and `fromDocument(rows, document, {}, 5)` likewise | `from() would ignore the argument past its last; pass the engine registries in the one options object` | `from(rows, { limits: { steps: 3 } })`; an `undefined` in that place is no argument |
| `from(rows, { bogus: 1 })` | `from() does not take 'bogus'; the options are compileTypeTest, functions, collations, pathFunctions, limits, registry` | one of the six (§8.1); `fromAsync()` and `fromDocument()` refuse the same way, by their own names |
| `from(rows, 'x')`, `from(rows, null)` | `from() takes a plain options object` | an object literal, or no second argument |
| `orderBy((u) => u.n, { emtpy: 'greatest' })` | `orderBy() does not take 'emtpy' — did you mean 'empty'?` | `{ empty: 'greatest' }` |
| `orderBy((u) => u.n, null)` | `orderBy() takes a plain options object` | `{}`, or no second argument |

**A provider or a document that is not shaped as the contract says.**

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `from({ execute, root: 7 })` | `a provider's root is a path expression string ('$.Post[*]'), got number` | a path expression, or no `root` at all |
| `createPushQueue({ highWaterMark: 0 })` | `highWaterMark must be a positive integer` | a positive integer (1024 by default) |
| `createPushQueue({ highWatermark: 5 })` | `createPushQueue() does not take 'highWatermark' — did you mean 'highWaterMark'?` | `{ highWaterMark: 5 }` |
| `createPushQueue(null)` | `createPushQueue() takes a plain options object` | `{}`, or no argument |

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
| `mapAsync(fn, { concurrency: 2, ordered: 'false' })` | `mapAsync ordered must be a boolean, got "false"` | `ordered: false` |
| `mapAsync(fn, { concurrency: 2, ordered: null })` | `mapAsync ordered must be a boolean, got null` (`got an object` for `{}`, `got a number` for `1`) | `ordered: true`, or leave it out |
| `mapAsync(fn, { concurrency: 2, ordred: false })` | `mapAsync() does not take 'ordred' — did you mean 'ordered'?` | `ordered` — the members are `concurrency`, `mode` and `ordered` |
| `mapAsync(42, { concurrency: 1 })` | `mapAsync takes an async callback` | a callback |
| `federate({ sources, maxRows, maxBytes, maxTotalRow: 1 })` | `federate() does not take 'maxTotalRow' — did you mean 'maxTotalRows'?` | `maxTotalRows` (§12.1) |
| `federate({ sources: { a: { provider, estimateRows: 5 }, … }, … })` | `federate()'s source 'a' does not take 'estimateRows' — did you mean 'estimatedRows'?` | `{ provider, estimatedRows }` |
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
| `u.labels` where the many-to-many entry does not name its join row | `'labels' is a many-to-many relation whose entry does not name its join row's columns ({ joinTable, ownColumn, ownKey, targetColumn, targetKey } — MODEL-FORMAT §10.1), so the hop has no phrase to lower to` | a provider whose `relations` is the store's own table, which names them |
| a relation entry that is not a relation record | `the relation table names 'labels' but its entry is not a relation record ({ to, kind, via, fkEntity, fkTargets, targetKey } — MODEL-FORMAT §10.1)` | a provider whose `relations` is the store's own table |
| a relation whose `kind` is neither of the two | `'labels' has relation kind 'oneToNone', which is not one this surface lowers (oneToOne, oneToMany)` | `oneToOne` or `oneToMany` |
| a relation over a composite or undeclared key | `'labels' cannot lower: its foreign key or the key it references is composite or undeclared, and the hop's equality would need a tuple the vocabulary does not spell` | a single-column key, or `load({ include })` |

The first is the one a reader meets with a hand-built provider: a
many-to-many hop binds the JOIN TABLE as a root and correlates twice —
the join row, then the target row it names (MODEL-FORMAT §10.7) — so it
needs the entry to name the join row's columns, which the store's own
relation table does. Without them there is no phrase, and an honest
refusal beats a document that quietly reads the wrong rows.

### 14.9 `JL0108` — a capture converted to a primitive

A captured value is a proxy that stands for a value the engine computes
later, so JavaScript's own operators cannot see what it holds. Whenever
JavaScript asks the proxy for a primitive, the capture refuses with a
coded message instead of the raw `TypeError: Cannot convert object to
primitive value`. That covers loose equality against a string, a number
or a boolean, `+`, a template literal and a relational comparison. It
also refuses `JSON.stringify` of a capture (`toJSON` is read first, and the
capture answers the same coded message instead of recursing until a
`RangeError`), and the CALL of an array method on a member — `includes`,
`indexOf`, `lastIndexOf`, `some`, `every`, `filter`, `find`, `findIndex`,
`findLast`, `findLastIndex`, `map`, `flatMap`, `reduce`, `reduceRight`,
`forEach`, `slice`, `join`, `sort`, `reverse`, `flat`, `entries`, `keys`,
`values`, `fill`, `copyWithin`, `push`, `pop`, `shift`, `unshift`, `splice`,
`toSorted`, `toReversed`, `toSpliced` and `with` — where the member would have
thrown `u.tags.includes is not a function`. The call of a string method on a
member is refused the same way, the message calling it a string method:
`toUpperCase` and `toLocaleUpperCase` name `.upper()`, `toLowerCase` and
`toLocaleLowerCase` name `.lower()`, `replaceAll` names `.replace(pattern,
replacement)` (which replaces every match of an I-Regexp pattern), `charAt`
names `.substring(i, 1)`, `match` and `search` name `.matches(pattern)` and
`.contains(v)`, `localeCompare` names `.lt()`, `.eq()` and `.gt()`, and
`split`, `trim`, `trimStart`, `trimEnd`, `padStart`, `padEnd`, `repeat` and
`normalize`, which have no operator, say so. Each of these calls used to be the
raw `TypeError`. Reading such a name is still
the member read it always was (a document may hold a field called
`filter`, `keys` or `with`), and `get('includes')` is that member explicitly; only a member
named like an array or a string method is callable, for the refusal, so `typeof` of
every other capture is `'object'` as before. A name that is already an
operator method (`at`, `concat`, `contains`, `count`, `startsWith`,
`endsWith`, `substring`, `replace`, …) is that method.
Read without its call (`u.name.upper`, `u.tags.length`) it is still a
function, so `u.name.length > 0`, `u.name.upper + '!'`, `${u.name.upper}`,
`u.name.upper == 'A'` and `String(u.name.upper)` coerce a function and would
embed `false` or the closure's source text; converting it to a primitive is
refused with `JL0108`, the message naming the method (`.length`) and its call
(`.length(…)`). Calling it builds the expression as before, `typeof` of it is
`'function'`, and a document member that shares the method's name is read with
`get('length')`.
Off a relation target (`p.author.tags.includes('a')`) the message names
the spellings it names on a member of the row itself, and both run there:
`p.author.tags.all().eq('a')` holds when any element equals `'a'`, and
`p.label.in(p.author.tags)` when the label equals any element. A relation
target's member as the list of `in()` was refused `JL0005` ('it cannot
follow an operator result or a relation'); it now answers. A chain that spelled
`.all()` on a relation target's array member before it fanned read the whole
array as one value and matched nothing off it; it now reads the elements, and
matches the rows whose elements match.
Off a to-many relation (`u.posts.some((p) => p.published)`), where the related
rows are an array no member can be read off unfanned, the `JL0005` names the
same spelling over the fanned rows — `u.posts.all().published.eq(true)` holds
when any related post is published, `u.posts.all().published.ne(true).not()`
when every one is — where it used to name only the member read `.all().some`.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `(v) => v.tab == 'labels'` | `a captured expression is not a JavaScript value yet — ==, +, a template literal and < compare or join the capture itself; write the comparison with .eq(x), .ne(x), .lt(x), .exists() or .isEmpty(), and a string join with .concat(…) (=== and if (v) test the proxy, never the value, and a callback that answers such a boolean is refused JL0109)` | `(v) => v.tab.eq('labels')` |
| `` (v) => `${v.first} ${v.last}` `` | the same message | `(v) => v.first.concat(' ').concat(v.last)` |
| `(v) => v.n + 1`, `(v) => v.n < 2` | the same message | `(v) => v.n.add(1)`, `(v) => v.n.lt(2)` |
| `(v) => v.name.length > 0`, `` (v) => `${v.name.upper}` `` | `.length is a method of a captured expression, read here without its call, so it is a function and not the value …` naming the call | `(v) => v.name.length().gt(0)`, `(v) => v.name.upper()`; `v.get('length')` for a member called `length` |
| `(v) => JSON.stringify(v.tags)` | a message naming `JSON.stringify` | `(v) => ({ tags: v.tags })`; `JSON.stringify(chain.toDocument())` for the finished chain |
| `(v) => v.tags.includes('a')` | `.includes() is a JavaScript array method, and a captured expression has none …` and the spelling | `(v) => v.tags.all().eq('a')` holds when any element equals `'a'`; `v.name.contains('a')` on a string member; `v.sku.in(v.tags)` for a scalar in a list |
| `(v) => v.items.some((i) => i.qty)`, `.every`, `.filter`, `.find`, `.findIndex` | the message names the fanned comparison | `(v) => v.items.all().qty.eq(0)` for `some`; `(v) => v.items.all().qty.ne(0).not()` for `every` (no element differs, an empty array holds); `.at(i)` indexes one element |
| `(v) => v.items.map((i) => i.sku)`, `.flatMap` | the message names the fanned member | `(v) => v.items.all().sku`; `[v.items.all().sku]` keeps them as one array value |
| `(v) => v.items.reduce((a, i) => a + i.qty, 0)`, `.reduceRight` | the message names the aggregates | `(v) => v.items.all().qty.sum()`, `.count()`, `.min()`, `.max()`, `.avg()` |
| `.forEach`, `.slice`, `.join`, `.sort`, `.reverse` | the message says what a capture does instead | `.all()` and a named member; `.at(i)`; `.substring(start, length)` on a string member; the chain's `orderBy()` |
| `(v) => v.nest.flat()` | the message names the fan of each level | `(v) => [v.nest.all().all()]` |
| `.entries`, `.keys`, `.values`; `.push`, `.pop`, `.shift`, `.unshift`, `.splice`, `.fill`, `.copyWithin`; `.toSpliced`, `.with`; `.toSorted`, `.toReversed` | the message says what a capture does instead | `.all()`; `.at(0)` and `.at(-1)` read the first and the last element; the chain's `orderBy()` |
| `(v) => v.name.toUpperCase()`, `.toLowerCase()` | `.toUpperCase() is a JavaScript string method, and a captured expression has none …` and the spelling | `(v) => v.name.upper()`, `(v) => v.name.lower()` |
| `(v) => v.name.charAt(1)`, `.replaceAll('.', '-')`, `.match(/a/)` | the message names the capture's own operator | `(v) => v.name.substring(1, 1)`; `(v) => v.name.replace('\\.', '-')`; `(v) => v.name.matches('a.*')` |
| `(u) => u.posts.some((p) => p.published)` (a to-many relation) | `JL0005`: `.some is read off a to-many relation, … and .some() is a JavaScript array method …` and the spelling over the fanned rows | `(u) => u.posts.all().published.eq(true)` |

Some spellings cannot be trapped, because JavaScript never asks the
proxy for anything:
- `v.payload === null` is `false` for every value, and so is
  `v.payload == null` (and `== undefined`); their negations are `true`.
- `r.a == r.b` compares two proxies, so it is `false`, and
  `r.a != r.b` is `true`.
- `if (v.tab)` is always true.

Each of these tests the proxy itself, so a callback that answers the
result is refused with `JL0109` (§14.10): `.where(r => r.a == null)`
used to keep no row. A comparison of the bare argument reads nothing and
is not refused: `.check(x => x != null)` accepts everything. Write
`v.payload.eq(null)`, `v.payload.exists()`, `v.payload.isEmpty()` or
`r.a.eq(r.b)`.

### 14.10 `JL0109` — a callback answered a JavaScript boolean

The spellings §14.9 cannot trap still leave a trace when the callback
ANSWERS them: a plain JavaScript boolean, which no captured value could
have produced. A callback that read its argument — a member, a method, a
declared parameter, a pen's external or a form rule's context — and
answered `true` or `false` is refused, naming the constant the document
would have held. A callback that read nothing answers a deliberate
constant (`() => true`, `(x) => true`) and is written as one.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `(v) => v.payload === null` | `a captured callback read its argument and answered the JavaScript boolean false — ===, !==, !, typeof and == null test the capture proxy, never the value, so the document would hold that constant; write .eq(null), .ne(x), .exists(), .isEmpty() or .not(). A deliberate constant must read nothing, and destructuring a parameter or reading a member before choosing the answer is a read: choose the callback outside it (q.name ? ({ name }) => name.eq(q.name) : () => true) or read only inside the branch that uses the value` | `(v) => v.payload.eq(null)` |
| `(v) => v.n !== 1` | the same message, naming `true` | `(v) => v.n.ne(1)` |
| `(v) => !v.deleted`, `(v) => Boolean(v.deleted)` | the same message, naming `false` and `true` | `(v) => v.deleted.not()`, `(v) => v.deleted.eq(true)` |
| `(v) => (v.n.eq(1) ? true : false)` | the same message, naming `true` | `(v) => v.n.eq(1)` |
| `(v, p) => p.tenant === 'a'` | the same message, naming `false` | `(v, p) => p.tenant.eq('a')` |
| `({ name }) => (q.name ? name.eq(q.name) : true)`, `q.name` unset | the same message, naming `true` | `q.name ? ({ name }) => name.eq(q.name) : () => true`, or `(v) => (q.name ? v.name.eq(q.name) : true)` |
| `orderBy((v) => v.due === null)` | the same message, naming `false` | none today (below) |

**Destructuring a parameter is a read.** The optional-filter idiom
`where(({ name }) => (q.name ? name.eq(q.name) : true))` is refused even
when `q.name` is unset and `true` is exactly the answer meant: the
destructuring reads `name` before the callback chooses, and to the
capture a callback that read its argument and answered `true` is the
`x.a !== null` mistake — the two cannot be told apart. A member hoisted
into a local (`const n = x.name;`) is the same read. Choose the callback
outside the callback, `where(q.name ? ({ name }) => name.eq(q.name) : () => true)`,
or read only inside the branch that uses the value,
`where((v) => (q.name ? v.name.eq(q.name) : true))`: with the filter off
both write `true`, and with `q.name` set to `'x'` both write
`{ "$eq": ["$it.name", "x"] }`. The same holds in every pen — a `check()`
that destructures its externals, a flow guard or a subscription's `when`
that destructures its scope.

**An ordering key cannot test for `null`.** A key is a number, a string
or the empty sequence, never a boolean: `orderBy((v) => v.due.eq(null))`
is `JQ2005` at run time, and so was the `$key: false` the refused spelling
used to write. `orderBy((v) => v.due)` already sorts an ABSENT `due`
first (`{ empty: 'greatest' }` sorts it last), but a `null` `due` is
`JQ2005` as a key too, and no spelling without a boolean key orders
`null` items first today.

Every pen's callback runs in this capture, so the refusal is the same in
a schema `check()`, a forms rule, a flow guard, an app action, patch path
or subscription, a JSLT `body()`, a JTLT `query()` or `json()`, a model
`compute()`, index, `expressionIndex()` or collection key, a migration
assertion and the client's `include()` and `where()`. A callback that
read its argument and answered a boolean used to be taken at every one
of these sites — written as the constant (a `where`, a check, a forms
rule, a guard, an action, a subscription's `when` or `key`, a JSLT body,
a JTLT `json()`, a model `compute()`, a migration assertion, the client's
`where()`), failing at run time with `JQ2005` (an `orderBy` key), or
refused with the pen's own `JL0102` (a model index key, condition,
`expressionIndex()` argument or composite part, a collection `key`, an
app patch path), `JL0101` (a JTLT `query()`) or `JL0107` (the client's
`include()`) — and is now `JL0109` at all of them. What it cannot see
still writes a silently wrong document, because the callback never
answers the boolean itself or never read anything:
- a test of the BARE argument reads no member, so it answers what it
  answers for any object, exactly as a constant would: `== null`,
  `===`, `in`, `typeof`, `Object.keys`, `instanceof` and `Array.isArray`
  over the argument itself — `(x) => x != null` and
  `(x) => x instanceof Object` are `true`, `(x) => x === undefined`,
  `(x) => 'a' in x` and `(x) => Array.isArray(x)` are `false` — and an
  identity test of bare proxies (`v === u`); so §14.9's
  `.check(x => x != null)` still accepts everything;
- `&&`, `||` and `?:` answering a capture: `(v) => v.a && v.b` is
  `"$it.b"`;
- a boolean a pen helper consumes: `v.a.eq(1).and(v.b === null)` folds
  `false` into the `$and`, and an app action's `when(x.payload === null, …)`
  takes a constant condition;
- a boolean nested in a returned object or array:
  `select((v) => ({ f: v.a === null }))` writes
  `{ "$const": { "f": false } }`, and `select((v) => [v.a === null])`
  answers `[false]` for every item — a nested boolean is
  indistinguishable from a literal member.

### 14.11 The runtime codes

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
  `Object.keys`, truthiness and `===` evaluate against the proxy and
  yield a silently wrong document — unless the callback answers the
  boolean itself, which is refused with `JL0109` (§14.10) — while `>`,
  `<`, `+` and a template literal are refused with `JL0108` (§14.9).
  Use `.and()`, `.or()`,
  `.not()` and the comparison methods.
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
terminal bundles **<!--fact:bundle.chain-->231,415<!--/fact--> bytes** (esbuild, ESM, minified, tree-shaken,
`platform: 'neutral'`). The figure is measured by
`scripts/check-tree-shaking.js`'s chain probe and compared with this
section on every `npm run test:tree-shaking`: it is derived, never typed,
and a stale one is red here rather than wrong in a document somebody
reads.

Of that, **<!--fact:bundle.chain.own-->53,670<!--/fact--> bytes** are the chain's own modules — `sequence.js`,
`async.js`, `expression.js`, `document.js`, `provider.js`,
`concurrency.js`, `errors.js` and `schema-of.js`. The remaining ~170 kB
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
  module either, which is what keeps a <!--fact:bundle.jslt.kb-->28<!--/fact--> kB JSLT
  pen <!--fact:bundle.jslt.kb-->28<!--/fact--> kB.

`docs/CONSUMING.md` states the rounded price of every subpath in one
table, each figure held equal to the same measurements. Two of its rows
are the ones to read together: the chain at <!--fact:bundle.chain.kb-->231<!--/fact--> kB and
`./db` at <!--fact:bundle.db.kb-->1020<!--/fact--> kB.
The client costs what the store costs, by construction, and the chain
costs what running a query costs.

**Taking a pen as well costs less than the two figures suggest**, and
the reason is worth knowing: a bundler counts a shared module once, and
the chain and every pen share the expression capture (`expression.js`)
and the coded errors under it (`errors.js`, and `@jarenjs/core`'s error
and object helpers). A consumer importing the chain AND the schema pen
bundles **<!--fact:bundle.chain.withSchemaPen-->256,385<!--/fact--> bytes** — **<!--fact:bundle.chain.shared-->20,277<!--/fact--> bytes** less than the sum of the
figure above and [SCHEMA-PEN.md](SCHEMA-PEN.md#7-cost) §7's, which is
what those shared modules weigh. The probe measures that pair too, so
the saving is derived like everything else here. What the chain does NOT
share with a pen is the pens' own two shared doors, `capture-root.js`
and `json-boundary.js`: no chain callback reaches either, and neither is
in the figure above. Every pen document's §7 carries its own
subpath's figure; nothing here restates one.

## Native column queries and ranges

Chains and JSON documents share the db planner. Adopted scalar projections, connected joins, restricted correlated counts and proved one-root grouped aggregates have [native plans](../../db/docs/NATIVE-PLANS.md); unsupported shapes retain explanations and strict-mode refusals. The structural [range provider](../../app/docs/COLLECTION-PROVIDER.md) is `handle.range(spec, options)` from the root client, composed over the existing pager and capture.


## Lexical provider authoring

A string expression's `lexical(provider, request)` method emits
`{ $lexical: [provider, textExpression, request] }`. The provider name is a nonempty
string; the request is a plain literal JSON object. It records a declaration,
never builds an index or runs a second ranker. Compile the emitted document with
`compileJsonQuery(document, {lexicalProviders})`, binding the same
`createLexicalProvider` capability that a hand-written query uses. The ordinary
sequence provider has no implicit search catalog. Filters/facets run before top-k,
continuations bind the source snapshot, and `$search` remains regex-based.

For synchronous providers, iteration uses an available `syncQuery(document,
options)` cursor and propagates early return to release it. Providers without
that member retain their collecting behavior. SQLite entity planning flattens
safe identity/object projection chains and projected joins followed by filters
and ordering; it retains barriers around windows, grouping and inner ordering.
Standalone supported physical min/max and integer sum/average use guarded native
aggregates. Explicit SQLite null, collation, raw JSON text and byte semantics are
available through [the data layer native surface](../../db/docs/SQLITE-RELATIONAL.md).
