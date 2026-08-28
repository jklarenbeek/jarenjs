---
package: "@jarenjs/linq"
card:
  title: LINQ — the suite, by code
  blurb: >-
    One package writes every document the suite runs: C#-familiar chains
    whose output is a plain query document, and eight pens that write the
    others the same way — a JSON Schema, a database model, a JSLT stylesheet,
    a migration with its transform typed old row to new row, a contract, a
    state machine and a dataflow, an application, a form. A recording proxy
    captures the callback, the emitter folds stages into one FLWOR document,
    and the same chain runs in memory, over streams (one bounded mapAsync
    boundary), or pushed whole to a store's entity sets through the provider
    seam — or through the typed client that fronts the store under `./db`,
    over one declared edge.
  perf: >-
    one operator set, byte-identical documents through the sync and async
    drivers
engines:
  - key: linq
    title: LINQ
---

A C#-familiar chain whose product is a plain JSON query document — and, under
its subpaths, the pens that write the suite's other documents the same way:
`@jarenjs/linq/schema` (JSON Schema), `/model` (a store model), `/jslt` (a
stylesheet), `/migration` (a migration whose data transform is typed old row
to new row), `/contract` (an operation contract that types its own client and
handlers), `/flow` (state machines and dataflow graphs), `/app` (an
application with its actions, patches and subscriptions) and `/forms` (the
`x-form` rules a schema carries). Every pen emits exactly the published
document its engine already takes, and carries types a gate proves equal to
emit's generated declarations. Capture is a recording proxy (never
source-text inspection),
execution is deferred, and the emitted document runs in memory, over async
streams, or against any provider exposing execute(document, options) —
`@jarenjs/db` implements that contract (the chain imports no store), its
entity sets are providers a chain binds through by root, and `@jarenjs/linq/db`
fronts the store with a typed client over one declared, optional-peer edge.

```js
import { from } from '@jarenjs/linq';

const adults = from(users)
  .where((u) => u.age.gt(21))
  .orderBy((u) => u.name)
  .select((u) => ({ id: u.id, name: u.name }));

adults.toArray();    // deferred until a terminal
adults.toDocument(); // { $for: { it: ['$[*]'] }, $where: { $gt: ['$it.age', 21] }, … }
```

The async surface runs the SAME operator set over cursors: streamable stages go
per item, barrier operators buffer and run through the one engine, and mapAsync
is the single bounded-concurrency boundary (concurrency is required; the modes
are parallel / concat / switch / exhaust). Async answers equal sync answers by
construction — the same chain emits a byte-identical document through both
drivers.

**Try it.** What a chain emits is a plain query document — paste one into
[Play's `$query` engine](#/play?engine=query) and watch the same document run
there.
