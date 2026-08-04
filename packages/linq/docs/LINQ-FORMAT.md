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
// { "$for": { "it": "$[*]" },
//   "$where": { "$gt": ["$it.age", 21] },
//   "$orderby": { "$key": "$it.name" },
//   "$return": { "id": "$it.id", "name": "$it.name" } }
```

- `from(source, options?)` — `source` is any iterable (arrays,
  strings, generators, Sets…) or a provider (§8); anything else is
  `JL0001` at `from()` time, never at enumeration time.
  `options.compileTypeTest` enables the schema operators behind
  `ofType`/`cast` (§4); absent, those two are `JL0003` with the fix in
  the message.
- `fromDocument(source, document, options?)` — attach a hand-written
  or stored query document; its result is the item sequence and every
  operator chains over it (a `{$query, $expr}` envelope is unwrapped).
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
  (`===` between proxies is untrappable and therefore undetectable;
  do not compare proxies.)
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
| `SelectMany` | `$return` (a multi-item projection flattens per tuple) | native | `(e: Expr<T>) => Expr<R[]>` → `Seq<R>` |
| `OrderBy` / `OrderByDescending` | `$orderby` key spec (`$dir`; `$empty`/`$collation` via `options`) | native | `(e: Expr<T>) => Expr<K>` → `Seq<T>` |
| `ThenBy` / `ThenByDescending` | appended `$orderby` spec; must directly follow `orderBy*` (`JL0005`) | native | as `OrderBy` |
| `GroupBy` | `$groupby`; downstream items are `{ key, items }` | native | `(e: Expr<T>) => Expr<K>` → `Seq<{key: K, items: T[]}>` |
| `Join` | nested `$for` + `$where` `$eq` — the engine rewrites this shape to a HASH JOIN (compile-time, QUERY-FORMAT §6), which is why it is fast. Both sides MUST derive from the same source in 0.1 (`JL0005`): a query document reads one input; the relational order lifts this | native | `(inner: Seq<U>, ok, ik, (o: Expr<T>, i: Expr<U>) => Expr<R>)` → `Seq<R>` |
| `GroupJoin` | projection over a correlated inner phrase (the matching group as an expression: `(u, g) => ({ n: g.count() })`); same-source rule as `Join` | emulated | `(inner: Seq<U>, ok, ik, (o: Expr<T>, g: Expr<U[]>) => Expr<R>)` → `Seq<R>` |
| `Skip` / `Take` | `$subsequence` | native | `(n: number)` → `Seq<T>` |
| `Distinct` | `$distinct` (deep structural equality — the grouping relation) | native | `()` → `Seq<T>` |
| `Reverse` | `$reverse` | native | `()` → `Seq<T>` |
| `Count` / `Sum` / `Average` / `Min` / `Max` | §8.8 aggregates (`Average` → `$avg`) | native | `count(): number`; `sum(): number`; `average/min/max(): number` (throw `JL2001` on empty; `min`/`max` follow the operand family) |
| `Any()` | `$exists` | native | `(): boolean` |
| `Any(pred)` / `All(pred)` | `$some` / `$every` quantifier phrase | native | `(pred): boolean` (`all` vacuously true on empty) |
| `Aggregate(seed, fn)` | `$fold` — the accumulator clause | native | `(seed: A, (acc: Expr<A>, e: Expr<T>) => Expr<A>): A` |
| `Aggregate(fn)` (unseeded) | — JSON cannot spell "the implicit first element" as a lambda seed | unsupported (`JL0005`) | — |
| `First` / `FirstOrDefault` | `[ $subsequence [expr, 0, 1] ]` window | native | `(): T` (`JL2001` on empty) / `(d?): T \| D` |
| `Single` / `SingleOrDefault` | `[ $subsequence [expr, 0, 2] ]` window | native | `(): T` (`JL2001`/`JL2002`) / `(d?): T \| D` (`JL2002` on 2+) |
| `Last` / `LastOrDefault` | `[ $subsequence [$reverse expr, 0, 1] ]` | native | as `First` |
| `ElementAt` / `ElementAtOrDefault` | `[ $subsequence [expr, i, 1] ]` | native | `(i): T` (`JL2003` out of range) / `(i, d?)` |
| `Concat` | `$seq` (a constant array's elements join the stream) | native | `(other: Seq<T> \| T[])` → `Seq<T>` |
| `DefaultIfEmpty` | `$default` | native | `(fallback?: T)` → `Seq<T>` |
| `OfType<S>` | `$valid` filter with a JSON Schema literal | native | `(schema)` → `Seq<S>`; needs `compileTypeTest` (`JL0003`) |
| `Cast<S>` | `$assert` per item | native | `(schema)` → `Seq<S>`; needs `compileTypeTest` (`JL0003`) |
| `Zip` | — no positional co-iteration in the grammar | unsupported (`JL0006`) | — |
| expression methods | `eq ne lt le gt ge` → `$eq…$ge`; `and or not`; `add sub mul div idiv mod neg`; `startsWith endsWith contains matches upper lower length concat substring replace` → §8.7; `count sum avg min max` → §8.8 (aggregates as expressions, e.g. over a group); `year month day epoch` → §8.13; `exists isEmpty`; `at all get` | native | on `Expr<…>`, per the typed-surface order |
| spatial family (§8.14) | — surface deferred to the relational order; hand-write the document (`fromDocument`) today | unsupported (`JL0006`-adjacent: no methods exist yet) | — |

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
document's content (`contentKey`), so re-enumeration is cheap without
pretending the results are frozen. `for…of` a sequence iterates
`toArray()`'s result (one enumeration per loop).

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
- 0.1 is synchronous; the asynchronous surface is §§10–12 (reserved).

`@jarenjs/db` implements this contract without either package
importing the other; a test double proves the document arrives whole.

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

Runtime errors (`LinqRuntimeError`):

| Code | Condition |
|---|---|
| `JL2001` | `first`/`single` found no element |
| `JL2002` | `single` found more than one element |
| `JL2003` | `elementAt` is out of range |

Engine errors (`JQ…`) from a hand-written `fromDocument` document pass
through unwrapped — they already carry their own code and `docPath`.

## 10. Streaming and barriers (reserved)

Reserved for the asynchronous surface order.

## 11. The concurrency boundary (reserved)

Reserved for the asynchronous surface order.

## 12. The cursor contract (reserved)

Reserved for the asynchronous surface order.
