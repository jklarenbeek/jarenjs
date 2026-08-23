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
adults.toDocument();  // { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 21] }, … }
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
  runs the SAME operator set over cursors and streams — async is a
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
- **The provider contract.** Any object with
  `execute(queryDocument, { externals })` is a provider.
  `@jarenjs/db` implements it — a chain over a SQLite-backed
  collection pushes to SQL with no import edge in either direction.
  `mapAsync` splits a provider chain into a pushed prefix and a local
  residual, and `explain()` shows the split.

## What this is not

Not an ORM — entities, storage and migrations live in `@jarenjs/db`.
Not expression trees over arbitrary methods — the vocabulary is the
query engine's, and a construct outside it fails loudly at build time
with a coded error (`JL0001`–`JL0006`) rather than guessing. Not a
general lazy-iterable library — if you don't want a query document,
you don't want this package.

The normative mapping — every operator, its emitted phrase, and the
deliberate deviations — is [docs/LINQ-FORMAT.md](docs/LINQ-FORMAT.md);
internals are in [ARCHITECTURE.md](ARCHITECTURE.md).
