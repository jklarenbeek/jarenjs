# @jarenjs/linq

A C#-familiar fluent LINQ surface for the Jaren suite. Expressions are
captured as **plain Jaren query documents** — never
`Function.prototype.toString` — executed deferred over any iterable, or
handed whole to any provider exposing `execute(document, options)`.

```js
import { from } from '@jarenjs/linq';

const adults = from(users)
  .where((u) => u.age.gt(21))
  .orderBy((u) => u.name)
  .select((u) => ({ id: u.id, name: u.name }));

adults.toArray();
adults.toDocument();
// { "$for": { "it": "$[*]" },
//   "$where": { "$gt": ["$it.age", 21] },
//   "$orderby": { "$key": "$it.name" },
//   "$return": { "id": "$it.id", "name": "$it.name" } }
```

The emitted document is the whole contract: loggable, storable,
diffable, transportable, authorable by a constrained decoder, and
compilable by a bare `compileJsonQuery` with no linq involvement.
Parameters (`.params({ tenantId })`) become the document's externals —
the seam that later becomes bound SQL parameters.

The normative surface — the complete C#-method mapping table (native /
emulated / unsupported, honestly), deferred-execution semantics, the C#
terminal matrix, the provider contract and the `JL` error codes — lives
in [docs/LINQ-FORMAT.md](docs/LINQ-FORMAT.md). The asynchronous surface
(async sources, streaming, the bounded-concurrency boundary) is the
next order of the data program and has reserved sections there.

Dependencies: `@jarenjs/core` and `@jarenjs/json` only. MIT.
