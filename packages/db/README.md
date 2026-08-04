# @jarenjs/db

Document storage for the Jaren suite, over SQLite. A **model
document** declares collections — each a JSON Schema plus declared
indexes — and `openStore` creates or opens a database, applies the
physical mapping through a dialect, and gives transactional,
schema-validated reads and writes. Queries arrive as plain Jaren query
documents (usually written through `@jarenjs/linq`) and are **pushed
down to SQL** where equivalence is proven, with everything else
running honestly in the engine. The same code runs on Node, on Bun,
and in a browser against an injected wasm handle, with zero
dependencies outside `@jarenjs/*`.

```js
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const store = await openStore({
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string' },
          email: { type: 'string', format: 'email' },
          age: { type: 'integer' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }],
    },
  },
}, { driver: nodeDriver(), path: 'app.db' });

const users = store.collection('users');
await users.insert({ id: 'u1', email: 'ada@example.test', age: 36 });

// a query document — here written by hand; linq writes the same thing
const adults = await users.execute({
  $for: { it: '$[*]' },
  $where: { $ge: ['$it.age', 21] },
  $return: '$it',
});
```

- **The pushdown planner with `explain()`.** A query compiles through
  the engine's published AST into a dialect-neutral plan and renders
  to guarded, parameter-bound SQL; whatever cannot be proven
  equivalent runs as a real compiled Jaren query (the residual), and
  `explain()` always says which is which — the SQL, the bound
  parameters, the indexes used (verified against the database's own
  plan output), and the residual's named reasons. A 418-run
  differential oracle keeps both paths agreeing. `strict: true` turns
  any residual into a compile error.
- **Storage is declarative.** Indexed paths become generated columns
  plus real indexes, typed from the collection's schema. Opening an
  existing database verifies the declared shape and refuses to alter
  it — reshaping is the migration story.
- **Migrations are documents.** `planMigration` diffs two models into
  rendered-DDL + JSLT-transform + assertion steps; a shadow database
  replays the whole chain before the real store is touched; a
  checksummed history refuses edited or reordered migrations; a
  narrowing without an adequate transform is refused against the REAL
  data, inside the transaction.
- **The safe profile.** Untrusted query documents run under composed
  bounds: engine limits on the residual, a mandatory row bound that
  refuses rather than truncates, reference allow-lists, optional
  full-scan refusal, and per-collection mandatory predicates no
  document shape can shed. Read-only stores refuse writes at the
  driver.
- **Writes validate** through an injected hook; without one,
  `store.capabilities.validated` is `false` and the docs say what that
  costs. The public API is asynchronous (the browser's OPFS story
  forces it) with a promise-free `store.sync` twin where the driver is
  synchronous.

## What SQLite-only means, frankly

SQLite is the supported backend — 3.45 or newer, on `node:sqlite`,
`bun:sqlite`, or your injected wasm build — and nothing else is
promised. The dialect seam exists and is tested against a double, but
no second dialect ships. Concretely: there is **no statement timeout**
(the drivers expose no interrupt; the capability slot is honestly
`false`), no server, no replication, and cross-process concurrency is
SQLite's own story (WAL plus a busy timeout, both set and visible on
`store.capabilities`).

## What this is not

Not an ORM with entities and relations (a collection is one schema,
one key, one document column — by design, in this version). Not a
sync engine or a replication layer. Not safe for mutually hostile
tenants without the profile's mandatory predicate — the SECURITY
policy states the claims and the non-claims plainly.

The normative formats are
[docs/MODEL-FORMAT.md](docs/MODEL-FORMAT.md) and
[docs/MIGRATION-FORMAT.md](docs/MIGRATION-FORMAT.md); the seams and
the pushdown contract are in [ARCHITECTURE.md](ARCHITECTURE.md).
