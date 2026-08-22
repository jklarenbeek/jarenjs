---
package: "@jarenjs/linq"
card:
  title: LINQ — chains to query documents
  blurb: >-
    C#-familiar fluent chains whose output is a plain query document: a
    recording proxy captures the callback, the emitter folds stages into one
    FLWOR document, and the same chain runs in memory, over streams (one
    bounded mapAsync boundary), or pushed to SQL through the provider seam.
  perf: >-
    one operator set, byte-identical documents through the sync and async
    drivers
engines:
  - key: linq
    title: LINQ
---

A C#-familiar chain whose product is a plain JSON query document. Capture is a
recording proxy (never source-text inspection), execution is deferred, and the
emitted document runs in memory, over async streams, or against any provider
exposing execute(document, options) — `@jarenjs/db` implements that contract
with no import edge in either direction.

```js
import { from } from '@jarenjs/linq';

const adults = from(users)
  .where((u) => u.age.gt(21))
  .orderBy((u) => u.name)
  .select((u) => ({ id: u.id, name: u.name }));

adults.toArray();    // deferred until a terminal
adults.toDocument(); // { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 21] }, … }
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
