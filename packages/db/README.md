# @jarenjs/db

Documents AND entities in SQLite. A **model document** declares
collections (a JSON Schema, a key, indexes) and — since phase B —
**entities**: keys, typed columns, relations, defaults and an
optimistic-concurrency token, all inside the schema through the
`x-entity` vocabulary. `openStore` applies the physical mapping
through a dialect and gives transactional, schema-validated reads and
writes; queries arrive as plain Jaren query documents (usually
written through `@jarenjs/linq`) and are **pushed down to SQL** where
equivalence is proven, with everything else running honestly in the
engine. The same code runs on Node, on Bun, and in a browser against
an injected wasm handle, with zero dependencies outside `@jarenjs/*`.

**The honest framing, first**: Prisma, Drizzle and Kysely are mature,
support several databases, and are faster on some benchmark rows —
those losses are published on the suite page with their reasons. What
none of them has is a query that is one serializable JSON document,
executable by two independent engines proven to agree by a
differential oracle, running unchanged in Node, Bun and the browser,
with schema-validated writes from the fastest validator in the
ecosystem. The composition is the product; the individual numbers are
what they are.

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

## The relational half (phase B)

- **Entities and relations** (`x-entity`, MODEL-FORMAT §9): hybrid
  rows — key and mapped scalar columns beside one JSONB document —
  with real foreign keys (`PRAGMA foreign_keys` set AND verified),
  all three relation kinds, and derived epoch columns for indexed
  instant ranges.
- **One-statement graph loads** (§10): `entity('User').load({ include:
  { posts: { include: { comments: true } } } })` runs in exactly ONE
  statement regardless of depth or parent count — asserted by a
  counting driver in the tests, and published with statement counts
  beside the timings on the benchmark page. Keyset pagination when
  the ordering allows it, reported, never silent.
- **The unit of work** (§11): reads are plain deep-frozen JSON (no
  proxies, asserted); mutation is replacement; `saveChanges()` diffs
  snapshots into minimal parameterised statements in one transaction,
  with insert batching, `JD0040` cycle refusal, `JD2040` optimistic
  conflicts, and a report of every statement, fallback and count.
- **Generated types**: `entityEmitModel` + `@jarenjs/emit` render the
  model into entity interfaces, input variants and an `EntityMetaMap`;
  `typedStore` (from `@jarenjs/db/typed`) types every read, checks
  every write, and widens `load` results by their include
  specification.
- **Relational migrations and the `jaren-db` CLI** (MIGRATION-FORMAT
  §§9–12): the strategy-table diff, the documented twelve-step table
  rebuild with `foreign_key_check` inside the transaction, shape
  EQUALITY against a fresh build as the acceptance criterion, drift
  detection, and `jaren-db check` for CI.

## What this is not

Not a sync engine or a replication layer. Not multi-database — see
above. Not safe for mutually hostile tenants without the profile's
mandatory predicate — the SECURITY policy states the claims and the
non-claims plainly. `$groupby` pushdown, relation-name query sugar
and a many-to-many membership API are named future work
(MODEL-FORMAT §10.6, the roadmap), not silent gaps.

The normative formats are
[docs/MODEL-FORMAT.md](docs/MODEL-FORMAT.md) (storage §§1–7, safe
profile §8, entities §9, relational translation §10, the unit of work
§11) and [docs/MIGRATION-FORMAT.md](docs/MIGRATION-FORMAT.md)
(documents §§1–8, relational changes §§9–12); the seams, the pushdown
contract and the phase-B engines are in
[ARCHITECTURE.md](ARCHITECTURE.md); the ORM benchmark methodology is
in [benchmark/README.md](../../benchmark/README.md).
