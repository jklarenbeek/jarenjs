# @jarenjs/linq

A C#-familiar fluent query surface whose output is a **plain JSON
query document**. You write `from(users).where(u =>
u.age.gt(21)).orderBy(u => u.name)`; what exists afterwards is data —
inspectable, serializable, executable by the `@jarenjs/json` engine in
memory, streamed over a cursor, or pushed into a database by any
provider. The chain is the pen; the document is the deliverable.

```js
import { from } from '@jarenjs/linq';

const adults = from(users)
  .where((u) => u.age.gt(21))
  .orderBy((u) => u.name)
  .select((u) => ({ id: u.id, name: u.name }));

adults.toArray();     // runs in memory, deferred until now
adults.toDocument();  // { $for: { it: ['$[*]'] }, $where: { $gt: ['$it.age', 21] }, … }
```

**The C# comparison, stated honestly.** The operator names, deferred
execution and the query-as-data idea are LINQ's. What differs: capture
is a recording proxy, never source-text inspection, so callbacks must
use the expression surface (`u.age.gt(21)`, not `u.age > 21` — a
JavaScript proxy cannot overload `>`); the operator vocabulary is the
query engine's, closed and documented in the
[mapping table](docs/LINQ-FORMAT.md); and `IQueryable`'s role is
played by the provider seam below.

- **Deferred and immutable.** A `Sequence` holds a stage list; nothing
  runs until a terminal (`toArray`, `first`, `count`, …). Every
  operator returns a new sequence.
- **Typed where it counts.** Hand-authored declarations type the
  common path precisely and degrade to honest `unknown` — never a
  wrong type — with runtime twins pinning every claim.
- **The async story (the obvious objection, answered).** `fromAsync`
  runs the same operator set over cursors and streams — joins excepted,
  because a single-pass source cannot be read twice — and async is a
  boundary, not a colour (the same chain emits a byte-identical
  document through both drivers, test-pinned). Element-wise async
  work happens in exactly one place, `mapAsync`, with a REQUIRED
  concurrency bound and the `parallel`/`concat`/`switch`/`exhaust`
  vocabulary; barrier operators buffer and run through the one engine
  so streaming answers equal in-memory answers by construction.
- **Geography is spellable.** The whole §8.14 family is on the
  expression surface: `p.location.within(region)`,
  `p.location.distance(here)`, `p.route.geoLength()`,
  `p.location.geohash(6)`, and the conversion pair `geoParse`/`geoText`
  that reads a WKT column and writes one back. A plain GeoJSON object
  embeds as a literal; `.params({ region })` binds it at call time
  instead, which is the shape a spatial index can be probed with. The
  spatial measurements are `geoArea`/`geoLength` because `length` on
  this surface is already `$string-length` — the mapping table says so
  in its own row.
- **Time is spellable.** The whole RFC 3339 date family is on the surface —
  `e.on.startOf('month')`, `e.on.dateAdd(3, 'day')`, `e.on.week()` — and so are
  the five time-series operators: `rows.all().resample({ every: 'PT1H', fill:
  'locf' })`, `rows.all().rolling({ width: 60000 })` and
  `left.all().asof(right, { by: '$.symbol' })`. A series spec is a literal and
  is embedded verbatim, so every rule about what it may say stays in the
  compiler rather than being restated here.
- **Meaning is spellable too.** `m.embedding.similarity(query)` emits
  §8.15's `$similarity`, and k-nearest is the chain it already looks
  like — `.orderByDescending(..., { empty: 'least' }).thenBy(m => m.id)
  .take(10)` — because ordering and windowing are stages, not a `knn`
  method. `.params({ query })` binds the query vector at call time, so
  one compiled document serves every question.
- **The provider contract.** Any object with
  `execute(queryDocument, { externals })` is a provider.
  `@jarenjs/db` implements it — a chain over a SQLite-backed
  collection pushes to SQL with no import edge in either direction.
  `mapAsync` splits a provider chain into a pushed prefix and a local
  residual, and `explain()` shows the split.

## By code: the schema pen

The chain is the first pen; `@jarenjs/linq/schema` is the second. It
builds standard JSON Schema 2020-12 documents in code — every keyword
`@jarenjs/validate` supports, cross-field rules captured into `$query`
through the same recording proxy the chain uses, `$defs`/`$ref`
recursion, the normalizer's per-field annotations — and carries
`Infer<>`/`Input<>` types that a gate proves equal to `@jarenjs/emit`'s
generated declarations and consistent with the validator's verdicts over
one corpus.

```js
import * as s from '@jarenjs/linq/schema';
import type { Infer } from '@jarenjs/linq/schema';

const User = s.object({
  id: s.string().uuid(),
  name: s.string().min(1),
  created: s.datetime(),
  age: s.integer().optional(),
}).check((u) => u.created.year().ge(1970));

User.schema;              // { type: 'object', properties: {…}, required: [...], additionalProperties: false, $query: {…} }
type User = Infer<typeof User>;   // { id: string; name: string; created: DateTime; age?: number }
from(rows).ofType(User);  // Sequence<User> — the chain takes a builder where it took a document
```

Objects are closed by default (`.open()` admits more); a document is a
frozen value (`JSON.stringify(builder)` is the document); a pen imports
no engine, so a schema-only bundle carries no chain and no validator.
What a pen cannot spell it refuses with a coded error (`JL0101`–`JL0104`)
naming the fix — there is no `.transform()` and no function `refine`;
cross-field rules are `check()`, transforms are application code. The
normative mapping table, the rules every pen keeps and the worked
examples a test executes are [docs/PENS-FORMAT.md](docs/PENS-FORMAT.md).

## What this is not

Not an ORM — entities, storage and migrations live in `@jarenjs/db`.
Not expression trees over arbitrary methods — the vocabulary is the
query engine's, and an unknown METHOD fails loudly at build time with
a coded error (`JL0001`–`JL0006`; the pens' refusals are `JL0101`–`JL0104`)
rather than guessing. JavaScript's own
operators are the one thing a proxy cannot trap: `&&`, `||`, `!`, `?:`
and `===` evaluate against the proxy object and yield a wrong document
silently (use `.and()`/`.or()`/`.not()`), and `u.age > 21` or `u.age + 1`
throw a plain `TypeError` — the format doc's §3 lists them. Not a
general lazy-iterable library — if you don't want a query document,
you don't want this package.

The normative mapping — every operator, its emitted phrase, and the
deliberate deviations — is [docs/LINQ-FORMAT.md](docs/LINQ-FORMAT.md);
internals are in [ARCHITECTURE.md](ARCHITECTURE.md).
