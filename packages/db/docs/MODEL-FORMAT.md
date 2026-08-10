# The Jaren model format (`jaren-model`)

This document is normative. The key words MUST, MUST NOT, SHOULD and
MAY are to be interpreted as described in RFC 2119.

Canonical schema: [`schemas/jaren-model.schema.json`](../schemas/jaren-model.schema.json)
(draft 2020-12), with the mechanically derived draft-07 twin beside it.

Section allocation is fixed so no two documents ever claim the same
section number: §§1–7 the storage subset, §8 the safe profile, §9
entities, §10 relational translation, §11 the unit of work.

## 1. Scope

A **model document** declares the collections of a store: each
collection is a JSON Schema for its documents, a key declaration, and
a set of declared indexes. `openStore(model, { driver, ... })` opens
(or creates) a database through an injected **driver**, applies the
physical mapping through a **dialect**, and gives transactional,
schema-validated reads and writes.

This is version `0.1` — the storage subset. Every collection is an
entity with no relations and a single JSON document column. Later
versions add vocabulary to THIS format; they do not add a second
format. Querying, migrations, entities and change capture are outside
this document's scope and own their reserved sections below.

The store runs over SQLite — on Node (`@jarenjs/db/node`), on Bun
(`@jarenjs/db/bun`), and in a browser against an injected wasm handle
(`@jarenjs/db/wasm`) — and promises nothing else.

## 2. The model document

```json
{
  "$model": "0.1",
  "collections": {
    "users": {
      "schema": { "type": "object", "required": ["id", "email"],
                  "properties": { "id": {"type": "string"},
                                  "email": {"type": "string", "format": "email"},
                                  "age": {"type": "integer"} } },
      "key": "/id",
      "indexes": [
        { "name": "by_email", "path": "$.email", "unique": true },
        { "name": "by_age", "path": "$.age" }
      ]
    }
  }
}
```

- `$model` MUST be `"0.1"`.
- `collections` MUST carry at least one collection; names MUST be
  identifiers (`[A-Za-z_][A-Za-z0-9_]*`).
- `schema` MUST be an object schema — it is what stored documents
  validate against (§5) and the type source for indexed paths (§3).
- `key` is an RFC 6901 pointer to the caller-supplied key member, and
  MUST select at least one member — or `null` when the store
  allocates keys (§6).
- `indexes[].path` is a JSONPath expression that MUST be **singular**:
  it selects exactly one member per document. Wildcards, slices,
  filters, descendants and function calls are not indexable; a
  non-singular path is rejected at open with `JD0004` naming the
  expression. A composite index takes a non-empty array of paths.
- Index names MUST be identifiers, unique within their collection.

An invalid model document is `JD0005` with a `docPath` pointing at the
offending member. Model checking happens before any database work.

## 3. Physical mapping

Each collection maps to one table, rendered entirely by the dialect —
no SQL text exists outside a dialect. On SQLite:

- a `key` column (`PRIMARY KEY`, typed from the key declaration),
- a `doc` column holding the document as JSONB in a `BLOB` column of a
  `STRICT` table,
- one **virtual generated column** per distinct indexed path, typed
  from the collection's schema at that path (`string` → `TEXT`,
  `integer` → `INTEGER`, `number` → `REAL`, `boolean` → `INTEGER`,
  undeclared → `ANY`), and
- one index per `indexes` entry, named `<collection>_<index name>`,
  over the generated columns of its paths.

Index paths are analyzed through the query engine's published AST: a
path is indexable exactly when the analysis reports it singular and
every segment is a plain member or index selection. The collection's
schema is the type source — the mapping needs no engine-side type
inference.

Two indexes over the same path share one generated column. A member
name the dialect's JSON path grammar cannot carry (an embedded `"` or
a control character, on SQLite) is `JD0004`.

**Opening an existing database verifies, never alters.** If a declared
collection's table already exists it MUST match what the model would
create; any disagreement is `JD0002` naming the first difference.
Reshaping a live database is the migration story — a later capability —
and `openStore` MUST NOT attempt it.

"Match" means every physical property that decides behaviour, not just
the names and types:

- structurally — column names, declared types and generated flags; index
  names, uniqueness, and covered columns **in their declared order**
  (`(a,b)` and `(b,a)` are different indexes: one serves an `a`-prefix
  lookup and the other does not);
- by DECLARED TEXT — the stored `CREATE` statement is compared against
  the planned one, which is where the properties no pragma reports live:
  `PRIMARY KEY`, `NOT NULL`, `DEFAULT`, `CHECK`, `STRICT`, a generated
  column's expression, an index's partial predicate, and each index
  term's collation and direction. A table that lost its primary key, or
  whose `gx_a` now reads `$.b`, keeps every name and type it had;
- for entities, the whole foreign-key TUPLE — source and target column,
  `ON DELETE` and `ON UPDATE`. Comparing counts accepted
  `ON DELETE SET NULL` becoming `ON DELETE CASCADE`, which deletes
  different rows;
- an index the database has and the model does not declare is also
  drift: it changes deletion semantics and the plans the optimizer picks.

Physical column ORDER is deliberately **not** drift. SQLite's
`ALTER TABLE … ADD COLUMN` can only append, so a migrated table and a
freshly built one legitimately disagree there, and this store never reads
a column positionally.

## 4. The driver contract and the synchronous fast path

A driver is `{ name, dialect, open(path, options) }`; `open` returns a
`Connection` or a promise of one:

```
Connection = {
  synchronous,                 // boolean
  capabilities,                // read once at open — see below
  exec(sql), prepare(sql), transaction(fn), close(),
  registerFunction(name, options, fn) | null,
  registerAggregate(name, spec) | null,
  session(table) | null
}
Statement = { run(params), get(params), all(params), iterate(params) }
```

Every method MAY return a value or a promise; the store never assumes
either. Parameters bind positionally as arrays.

**Capabilities** are read once at open — from the library's version
report, its compile options, and the binding's declaration — and are
the single source of truth for feature gating. The table covers at
least: `version`, `jsonb`, `generatedColumns`, `returning`, `upsert`,
`savepoints`, `rtree`, `fts`, `sessions`, `userFunctions`,
`deterministicIndexableFunctions`, `alterTableFull`, plus two slots
that are **empty (`false`) on every SQLite driver**:
`statementTimeout` and `rowEstimates`. SQLite exposes no interrupt, no
progress handler and no row-estimate API; a driver that cannot do a
thing MUST say so here rather than degrade silently. The slots exist
so a driver that has the facts can fill them without a contract
change.

On the Bun binding, `userFunctions`,
`deterministicIndexableFunctions` and `sessions` are `false` by
construction: `bun:sqlite` exposes no `function`, no `aggregate` and
no `createSession`.

A library below SQLite **3.45** fails at open with `JD0001` naming
the version found.

**The public store API is asynchronous.** Every store and collection
method returns a promise, because a browser store over OPFS is
asynchronous no matter what backend sits behind it. Where — and only
where — `connection.synchronous` is `true`, the store also carries
`store.sync`:

```js
store.sync.collection('users').get(key)   // the same read, no promise
store.sync.transaction(fn)
```

`store.sync` is **absent** on an asynchronous driver — not a set of
throwing stubs — so feature-testing it is honest. The asynchronous
surface allocates exactly one promise per call (the internal
composition is sync-capable and adds none); the measured difference is
the price of portability, published with the benchmarks rather than
waved away.

**Concurrency defaults are decided here.** A file-backed store opens
with `PRAGMA busy_timeout` set to **5000 ms** and journal mode
**WAL**, both overridable through `openStore`'s `busyTimeout` and
`journalMode` options; `:memory:` stores set neither. The values in
effect are visible on `store.capabilities.busyTimeoutMs` and
`store.capabilities.journalMode` (`null` for in-memory stores).

The runtime builtin behind a binding is imported lazily inside
`open()` — never at module scope — so every driver subpath loads under
every runtime; on a runtime without the builtin, `open` fails with
`JD0003`. The root `@jarenjs/db` subpath never references a runtime
builtin at all.

## 5. Writes and transactions

```js
const store = await openStore(model, { driver, compileSchema });
const users = store.collection('users');

await users.insert(doc);            // JD2001 when the key exists
await users.put(doc);               // upsert
await users.patch(key, jsonPatch);  // RFC 6902, applied in the database
await users.delete(key);            // resolves false when nothing was stored
await users.get(key);               // resolves undefined when absent
await store.transaction(fn);        // savepoint-nested, returns fn's value
```

**Writes validate through the injected hook.** `compileSchema` has the
`compileTypeTest` signature: it takes a collection's schema and
returns a validation function; the function returns `true`/`false` or
`{ valid, errors }`. A rejected write is `JD2003` carrying the hook's
`errors` when it produced any. Without a hook, writes are unvalidated
and `store.capabilities.validated === false` — a declared downgrade.
The cost of running without one: the database constraints only see the
key and the indexed members; everything else is stored as given.
`@jarenjs/db` never imports `@jarenjs/validate`.

**`patch` validates the result, then updates in place.** The patch is
applied to the stored document with the copy-on-write engine and the
RESULT is validated (`JD2003` rejects before any SQL). The operations
are then translated to the dialect's JSON-set primitives so a
one-field update does not rewrite a large document. Translatable in
0.1: `replace`, `add` of an object member, `add` at an array's end,
and `remove`. Anything else — `test`, `move`, `copy`, a mid-array
insert — falls back to a whole-document write. The fallback is
**counted and exposed** at `collection.stats()`
(`{ patchTranslated, patchFallback }`), measured rather than assumed.
A malformed patch document raises the json family's own coded errors
unchanged; `patch` on an absent key is `JD2006`.

**`transaction(fn)` nests via savepoints.** `fn` receives the store
and may itself call `transaction`; each level is one savepoint. A
throw rolls back exactly its own level and rethrows — an outer
transaction that catches the error continues and its own work
commits. There is no implicit retry.

### 5.1 Transaction ownership

A SQLite connection holds ONE savepoint stack, so two transactions that
overlap in time on one connection cannot both be correct: `RELEASE`
discards everything opened after its target, so whichever finished first
would take the other's savepoint with it, and the second would then fail
with *no such savepoint* over rows it had already committed. Unique
savepoint names do not help — the stack is a stack.

So a **top-level transaction owns its connection until it settles**, and
an overlapping one waits its turn. Two concurrent request handlers
sharing a store both commit, and both report success.

Nesting is asked for in one of two ways, and the difference is not
cosmetic:

- **Synchronously** — a `transaction` called while an owning callback is
  still on the stack nests, because nothing can interleave there. This is
  `store.sync.transaction` inside `store.sync.transaction`.
- **Through the scope** — an `async` callback has already awaited, so the
  stack cannot say whether a request is its own nested work or an
  unrelated caller. Nest through the store the callback RECEIVED:

  ```js
  await store.transaction(async (tx) => {
    await store.collection('docs').put(doc, 'a');   // joins this transaction
    await tx.transaction(async () => { … });        // nests inside it
  });
  ```

  Reaching back through the outer `store.transaction` from inside a
  callback queues behind the transaction the caller is part of, so it
  waits for itself; after `queueTimeout` (default 5 s, the busy-timeout
  default) that becomes `JD0012` naming the fix rather than hanging.

**One residual, stated plainly.** A bare statement issued while a
transaction is open JOINS that transaction and shares its fate, because
SQLite has no per-statement transaction scope and every operation inside
a callback reaches the connection the same way an unrelated caller does.
Work that must be in the transaction is therefore safe; an unrelated
writer on a SHARED store is not. Give each concurrent writer its own
store when independent writes must not share a rollback.

## 6. Identity

Key allocation is declared, never guessed (three strategies, platform
primitives only):

| declaration | strategy | `insert` returns |
|---|---|---|
| `"key": "/id"` | caller-supplied: the key is read from the document at the pointer | the extracted key |
| `"key": null, "identity": "uuid"` | `crypto.randomUUID()`, stored in the key column only | the allocated UUID |
| `"key": null, "identity": "integer"` | database-allocated integer key | the allocated integer |

A caller-keyed document whose pointer resolves to nothing or to a
non-scalar is `JD2002`; so is an explicit key argument that is not a
string or a number. For allocated identities, `put(doc, key)` updates
a known document and `put(doc)` allocates.

## 7. Error codes

`DbCompileError` (`JD0xxx`, problems opening a store) and
`DbRuntimeError` (`JD2xxx`, problems reading or writing one) build on
the suite's coded contract: a stable `code`, a bare `reason`, a
composed `message`, a `docPath` into the model document where one
exists — and, on runtime errors, the `collection` and (where known)
the `key` as own properties. Database errors are wrapped, never leaked
raw: the reason keeps the original text, `cause` keeps the original
error.

| code | raised when |
|---|---|
| `JD0001` | the SQLite library is below the supported floor |
| `JD0002` | the declared model disagrees with the existing database |
| `JD0003` | the driver binding is unavailable on this runtime |
| `JD0004` | an index path is not a singular member selection |
| `JD0005` | the model document is invalid |
| `JD0010` | strict mode refused a residual |
| `JD0011` | the profile refused the document |
| `JD0012` | work waited too long for the open transaction to settle |
| `JD0030` | an unknown x-entity member was declared |
| `JD0031` | relation declarations contradict each other |
| `JD0032` | the include specification is invalid |
| `JD0040` | the save spans a relation cycle |
| `JD0050` | live queries require change capture |
| `JD0051` | the demanded live mode is unavailable |
| `JD0052` | the live-query bound was reached |
| `JD2001` | insert found the key already present |
| `JD2002` | a usable key could not be resolved for the write |
| `JD2003` | the write failed schema validation |
| `JD2004` | an undeclared collection was requested |
| `JD2005` | a database operation failed |
| `JD2006` | patch found no document at the key |
| `JD2007` | the result exceeded the profile row bound |
| `JD2040` | the row changed under an optimistic update |
| `JD2050` | a changeset could not be decoded |
| `JD2051` | the change log is not enabled |
| `JD2060` | the maintained live state exceeded its bound |
| `JD2061` | another context owns the database |
| `JD2062` | the store closed with job handlers still in flight |

The table above is proven in sync with the runtime `DB_CODES` table by
a test.

## 8. The safe execution profile

A query document that arrives from a tenant, a remote client or a
language model can reach a database. Parameter binding makes injection
structurally impossible; it does nothing about resource exhaustion or
cross-tenant reads. A **profile** composes four independent bounds:

```js
const store = await openStore(model, { driver, profile: 'safe' });
// or per call:
collection.query(doc, { profile: { maxRows: 200, externals: ['min'] } });
```

`'safe'` is the default table; a profile object overrides members over
it. The defaults: engine limits
`{ sequenceItems: 100000, resultItems: 10000, steps: 1000000, depth: 32 }`,
`maxRows: 1000`, no externals, no host functions, no collations, all
of the store's collections, no mandatory predicates, no scan refusal.

1. **Engine limits.** The four engine limits ride into every residual
   compilation, so the JavaScript portion of a query is bounded by the
   engine's own enforcement and fails with the engine's own codes.
2. **The mandatory row bound.** Every non-aggregate fetch carries a
   database-side `LIMIT` of `maxRows + 1`. A fetch that crosses
   `maxRows` — a result set, a residual's candidate set, a diverted
   full scan — is the coded `JD2007` and the result is refused WHOLE.
   It is never silently truncated.
3. **Reference containment.** The document may reference only the
   externals, host functions and collations the profile declares, and
   only collections the profile allows; an undeclared reference is the
   compile error `JD0011`, never a runtime surprise. No UDF
   registration happens under a profile. Optionally
   (`refuseFullScan: true`), a plan whose `EXPLAIN QUERY PLAN`
   narrative shows a full-table SCAN of the collection is refused with
   `JD0011` — a structural gate, because SQLite exposes no row
   estimates to bound by.
4. **Mandatory predicates.** `predicates: { users: { $eq:
   ['$it.tenant', 'acme'] } }` conjoins the predicate into EVERY plan
   for that collection at the plan's root, after translation — the
   native statement, the residual's candidate fetch and the diverted
   full scan all wear it, so no document shape (`$or` at the top, a
   negation, a quantifier, a residual, a window, an aggregate) can
   produce a fetch without it. A predicate MUST translate natively; a
   host-configured predicate that cannot is a `TypeError` at first
   use, because there is no residual to hide it in.

**Read-only stores.** `openStore(model, { readOnly: true })` opens the
connection read-only at the DRIVER, so every write is refused by the
database itself (`JD2005` wrapping `SQLITE_READONLY`), not merely by
the API surface — a translation bug cannot become a write. A read-only
store verifies the declared shape and creates nothing (`JD0002` when a
table is missing), and leaves the file's journal mode untouched.

**The non-claims, stated plainly.** This profile does NOT claim:

- a statement timeout on the shipped drivers — `node:sqlite` and
  `bun:sqlite` expose no interrupt and no progress handler, the
  `statementTimeout` capability is `false`, and a long-running
  database-internal computation (a native aggregate over a large
  table) is bounded by nothing here. A driver whose capability is
  filled gets a real timeout without a contract change.
- a row-estimate bound — SQLite's plan output is prose, so the
  structural SCAN refusal is the honest substitute.
- safety for arbitrary untrusted SQL — none can be expressed.
- tenant isolation without the mandatory predicate — a shared database
  is NOT safe for mutually hostile tenants unless the profile carries
  one.

The containment story on SQLite is exactly this composition: engine
limits (bounding the residual portion), the mandatory `LIMIT`, the
optional SCAN refusal, the allow-lists, and the mandatory predicates.
Each bound is proven to fire by the hostile-input suite, and the store
is proven usable after every refusal.

### 8.1 Registered operators run in the residual

A store MAY open with a registry (`createJsltRegistry()` from
`@jarenjs/json/jslt`, or raw `functions` / `extensions` maps), and its
operators — `$npv`, `$mean`, `$sqrt`, … — become engine vocabulary a
query or entity document may use:

```js
import { createJsltRegistry, financePack, statsPack } from '@jarenjs/json/jslt';
const store = await openStore(model, {
  driver,
  operators: createJsltRegistry().use(financePack).use(statsPack),
});
store.capabilities.operators; // ['$npv', '$irr', …, '$mean', …]
```

A registered operator is a vocabulary extension of the **engine**, and
the engine runs against a store in JavaScript over the fetched rows —
the **residual**. So in this ring every registered operator is
**correct everywhere and accelerated nowhere**: the planner recognises
its name (it is not the unknown-operator error `JQ0002`), keeps it in
the residual, compiles the residual with the same registered
`{ functions, extensions }`, and `explain()` names it as the reason the
query did not translate natively — never silently:

```js
store.collection('deals').explain(doc).residual.reasons;
// [{ construct: '$npv', reason: "registered operator '$npv' runs in the
//    residual (Ring 2 — correct, not pushed to SQL)" }, …]
```

The result is identical to the same document run over the same rows by
the in-memory engine — differential-tested — and to the direct core
function. The pushable subset of these operators can be accelerated into
SQL where the driver allows — §8.2 — but that is an optimisation layered
over this residual, never a change to the answer.

**Profile interaction.** A first-class registered `op`/`agg` (a native
operator like `$npv`) is host-provided machinery — the store owner
registered it, not the foreign document — so it is **allowed by default**
under a profile, exactly as the internal `$apply` is. What the profile
still governs:

- the mandatory bounds apply to the residual as always: a registered-
  operator query fetches at most `maxRows + 1` candidate rows and is
  refused with `JD2007` past `maxRows`; the mandatory predicate still
  conjoins into the candidate fetch; engine limits still bound the JS;
- the profile's `functions` allow-list still governs a registered `fn`
  reached through `$call` — a `$call('clamp', …)` name must be declared
  in `functions`, or it is the compile error `JD0011`, because a `fn` is
  a host function like any other. Only the first-class `op`/`agg`
  operators are exempt.

Without a registry the store is byte-identical to before: a document
using `$npv` fails `JQ0002`, and `capabilities.operators` is `[]`.

### 8.2 SQL pushdown of the pushable-scalar subset (driver-gated)

A pack marks each entry `pushable: 'scalar'` (a per-row scalar function —
the math ops), `'aggregate'`, or `false`. Where the driver has user
functions, a `pushable:'scalar'` operator used in a **WHERE predicate**
is registered as a SQLite **deterministic UDF** and the plan emits the
call (`… WHERE jaren_p_<hash>(json_text(doc))`), so SQLite drives the row
iteration and the operator runs inside the callback — instead of every
candidate row crossing into the residual. It is the same compiled engine
fragment either way, so the answer is identical by construction; the
only question is where the loop runs.

The per-driver capability matrix — read once at open, on
`store.capabilities`:

| capability | node:sqlite | bun:sqlite | wasm |
|---|---|---|---|
| `userFunctions` (scalar UDF) | ✅ | ❌ | probed |
| `aggregateFunctions` (aggregate UDF) | ✅ | ❌ | probed |
| `pushableOperators` | the scalar subset | `[]` | scalar subset if `userFunctions` |

On **bun:sqlite** there is no UDF API, so `pushableOperators` is `[]` and
every registered operator is the residual (§8.1) — no failure, the same
result, reported by capability. A **profiled (untrusted) document never
triggers host-side registration** — the UDF hatch is gated on `profile
=== null`, exactly as the engine-internal hatch is; a profiled `$sqrt`
predicate runs in the residual.

**When it wins — measured, published honestly.** The push narrows *before*
rows cross into JavaScript, so it wins exactly when something else
narrows too (20 000 rows, node:sqlite, median ms):

| shape | pushed | residual | verdict |
|---|---|---|---|
| solo `$sqrt` predicate, ~20 % match | 22 | 21 | ~even |
| solo `$sqrt` predicate, ~90 % match | 41 | 23 | residual **1.75×** |
| indexed `$eq` **and** `$sqrt` (5 % pass the index) | 5.2 | 21 | push **3.9×** |
| `$sqrt` predicate with `LIMIT 10` | 0.03 | 21 | push **615×** |

So a `$sqrt` predicate beside a selective native predicate or a `LIMIT`
is a large win; a `$sqrt` predicate that is the *sole* filter of a full
table scan is a wash to a modest loss (the UDF re-parses each row in the
callback). **The push is not gated behind a cost heuristic**, because
SQLite exposes no row estimates (`capabilities.rowEstimates` is `false`)
to build one on — a crude guess would be dishonest. It pushes
deterministically and this profile is published so the shape of the win
is known; add a narrowing predicate or a `LIMIT` and the push pays.

**The honest ceiling.** A `pushable:false` operator (a whole-series
`$npv`, an `$sma`) is never a UDF — it stays the residual, `explain()`
lists no `udfs` for it. Aggregate-UDF pushdown (`db.aggregate` step/final
over `GROUP BY`) is **not emitted**: no shipped pack marks an entry
`pushable:'aggregate'` (the finance/stats aggregators fold a *per-document*
sequence — that is a per-row scalar to SQL, already covered by the scalar
path where marked — not a cross-row column), and cross-row aggregate
pushdown additionally waits on `$groupby` pushdown, itself a deliberate
residual today. The `aggregateFunctions` capability is probed and
reported regardless, so the day a pack marks `'aggregate'` the driver
gate is already in place.

## 9. Entities, the `x-entity` vocabulary, relations

### 9.1 Scope, and the phase-A relationship

An **entity** is a generalisation of a collection, not a replacement:
a collection is an entity whose every property is JSONB and which
declares no relations, and one physical engine sits underneath both.
A model document MAY declare `collections`, `entities`, or both, and
a phase-A store document opens unchanged under the entity engine
(test-asserted). Entities live under `entities`, keyed by identifier
names:

```json
{
  "$model": "0.1",
  "entities": {
    "User": {
      "schema": {
        "type": "object",
        "required": ["id", "email"],
        "properties": {
          "id":      { "type": "string", "x-entity": { "key": true, "default": "uuid" } },
          "email":   { "type": "string", "format": "email",
                       "x-entity": { "unique": true } },
          "created": { "type": "string", "format": "date-time",
                       "x-entity": { "default": "now", "column": "integer", "index": true } },
          "profile": { "type": "object" },
          "posts":   { "x-entity": { "relation": { "to": "Post", "many": true,
                       "via": "authorId", "onDelete": "cascade" } } }
        }
      }
    }
  }
}
```

The schema stays a valid JSON Schema throughout: strip every
`x-entity` member and it accepts and rejects exactly the same values
(test-asserted over a corpus). The vocabulary is invisible to the
validator by the same argument as `x-form`.

### 9.2 The `x-entity` vocabulary (a closed set)

| member | on | meaning |
|---|---|---|
| `key` | a property | this property is (part of) the primary key; several form a composite key |
| `unique` | a property | a unique index over the property's column |
| `index` | a property | a non-unique index over the property's column |
| `default` | a property | applied on write, in JavaScript (§9.6): `"now"` (insert stamp), `"updated"` (insert AND every update), `"uuid"`, `"auto"` (single INTEGER key, database-allocated), `{ "value": … }` (a literal), `{ "query": … }` (a query document over the document being written) |
| `column` | a property | storage override: `"integer"` on a `date-time`/`date` string stores epoch milliseconds in a real column (index-friendly range predicates); `"json"` keeps a scalar in the JSONB document (the opt-out that preserves present-`null`, §9.3) |
| `relation` | a property | `{ to, many?, via?, through?, onDelete? }` — §9.4 |
| `version` | a property | the optimistic-concurrency token (§11.5): a plain integer column, one per entity, never the key — engine-owned and bumped on every successful write |

**An unknown member of `x-entity` is `JD0030` with a `docPath`.** A
silently ignored mapping directive is a data-loss bug waiting to
happen, so this vocabulary is deliberately stricter than the
validator's ignore-unknown posture — the strictness is local to the
one namespace this package owns.

### 9.3 The hybrid mapping

Stated once, mechanically applied, and returned as data by
`explainMapping(model)` so it can be golden-tested and printed:

| Schema shape | Storage |
|---|---|
| scalar (`string`/`number`/`integer`/`boolean`) at the top level | a real typed column |
| `format: date-time`/`date` with `column: "integer"` | an epoch-milliseconds `INTEGER` column; the document keeps the RFC 3339 string, the column carries the derived epoch |
| `enum` of scalars | a column plus a `CHECK (column IN (…))` |
| nested object / array, or `column: "json"` | the JSONB document column, queryable by path exactly as in phase A |
| relation | a foreign-key column, or a join table for many-to-many (§9.4) |

`STRICT` tables throughout. The physical row is the key column(s),
the mapped scalar columns, and one JSONB `doc` column holding
everything else; a read merges them back. **The absent-versus-null
rule, plainly**: for a column-mapped scalar, JSON `null` and absence
both store as SQL `NULL` and read back as ABSENT. A property that
needs present-`null` semantics declares `column: "json"` and stays in
the document.

### 9.4 Relations and referential integrity

Declared on one side, inferred on the other; when both sides declare,
the inverses MUST agree (`JD0031` on any contradiction).

- **one-to-many** — `{ to, many: true, via, onDelete }`: `via` names
  the foreign-key property on the TARGET entity (`authorId` on
  `Post`). If the target declares that property it MUST be a
  column-mapped scalar of the key's type; otherwise the column is
  inferred.
- **one-to-one** — `{ to, via, onDelete }` (no `many`): `via` names
  the foreign-key property on the DECLARING entity, and its column is
  unique.
- **many-to-many** — `{ to, many: true, through? }` (no `via`): a
  join table, named `through` when given, otherwise the deterministic
  `<A>_<B>` with the entity names sorted — implicit names are exactly
  the thing teams later regret, so the explicit name exists. Its two
  foreign keys cascade on delete (join rows die with either side; not
  configurable in this version).

`onDelete` is REQUIRED wherever a foreign-key column is created —
`"cascade"`, `"restrict"` or `"setNull"` — never defaulted silently.
Referential integrity is real SQLite foreign keys:
`PRAGMA foreign_keys = ON` is set AND VERIFIED per connection (it
defaults off), a violating write fails with the wrapped database
error, and the declared on-delete behaviour is observed by test.

### 9.5 Identity

Per entity, by the key properties (D11 — platform primitives only):
caller-supplied (any scalar key, composite included);
`default: "uuid"` on a single string key (`crypto.randomUUID()`);
`default: "auto"` on a single integer key (the database allocates —
an index-locality choice, documented as NOT a sortable-id guarantee).
Composite keys are ordinary: mark several properties `key: true`;
reads and deletes take `{ prop: value, … }`.

### 9.6 Defaults

Applied on write in JavaScript, never by SQL `DEFAULT`, so the value
the application sees and the value stored are the same — and the
behaviour is identical on every driver. `"now"` stamps an RFC 3339
UTC string on insert when the property is absent; `"updated"` stamps
on insert AND on every update, always; `{ "value": … }` fills a
literal when absent; `{ "query": … }` evaluates a query document over
the document being written. Defaults run BEFORE validation, so the
injected hook sees the completed document.

### 9.7 Error-code additions

The entity engine adds two codes to the package's single table (§7):
`JD0030` — an unknown `x-entity` member; `JD0031` — relation
declarations whose inverses contradict. Everything else raises the
existing codes (`JD0005` for structural model defects, `JD2005` for
database-refused writes including foreign-key violations).

## 10. Relational translation

Phase B's planner extension: entity query documents translate to
selections and joins over the hybrid tables, and graph loading is one
statement. The residual rule is unchanged — anything not proven
translatable runs the set residual over the fetched entity root,
`explain()` says so, and `strict: true` refuses it (`JD0010`).

### 10.1 Entity query documents

`store.execute(document)` queries the **multi-entity root**: the
engine-side value is `{ <EntityName>: [documents…], … }` and bindings
range over `$.<Entity>[*]`. This is the shape the differential oracle
can actually prove — the in-memory engine sees exactly the documents
the entity sets return (`test/db/oracle/relations/`). Relation-NAME
navigation (`$.author.name`) is deliberately not query-document sugar:
the engine has no embedded `author` member to walk, so no oracle could
vouch for it. Name-based navigation lives on the `load` surface
(§10.4), where results and statement counts are the proof.

Per binding, predicates resolve through three reference flavors:

- **entity-column** — a mapped scalar column. Total forms, no
  `json_type` guard: a column-mapped property has no present-`null`
  (§9.3), so presence IS `IS NOT NULL`. Cross-type literals decide at
  plan time (`false`, or presence for `$ne`).
- **entity-epoch** — a derived instant column (§10.3).
- **entity-doc** — any other path rides the JSONB document with the
  phase-A guarded truth table, aliased per binding.

Externals bind against entity columns (with the phase-A `valueTypeOf`
guard); a boolean, `null` or missing external diverts to the residual
at bind time, exactly as phase A does. Externals against document
paths stay residual.

### 10.2 Joins

Two bindings joined by one equality between their column references
become an INNER equijoin — exactly the engine's
cross-product-plus-filter semantics. Result order is deterministic:
any `$orderby` keys first, then BOTH bindings' row identities in
binding order, which is the engine's nested-loop order. `explain()`
reports the join (`{ left, right }`) and the `EXPLAIN QUERY PLAN`
narrative; the paired foreign key carries an index (every foreign key
does — unique for a strict one-to-one, plain otherwise), so the probe
side of the join is a `SEARCH`, never a second scan.

On the `load` surface the join KIND is derived from the schema
(§10.4): a `oneToOne` include reports `inner (fk required)` when the
`via` property is in `required`, `left (fk optional)` otherwise —
one of the quiet advantages of models being JSON Schema.

### 10.3 Instants (the epoch column)

A `column: "integer"` date property stores the RFC 3339 string in the
document and a derived epoch-milliseconds column beside it (§9.3).
Two rules keep that column honest:

- **The write contract.** A present string value must parse in the
  property's own family and be Z-normalized (`date` properties:
  `YYYY-MM-DD`; `date-time` properties: any precision, `Z` suffix).
  Anything else — an offset form, junk — is refused (`JD2003`): an
  offset would let the epoch order sit hours away from the codepoint
  order of the document string, which is the order the engine
  compares.
- **The comparison form.** An ordering comparison against a literal of
  the column's family compiles to a ±1 s epoch RANGE on the column —
  Z-normalized strings sharing a second prefix sit within one second,
  so the range is a superset — plus the exact document-string
  comparison that decides. The index narrows
  (`EXPLAIN QUERY PLAN … USING INDEX`), the text answers, and mixed
  stored precisions cannot diverge from the engine. `$ne`, string
  operators, presence tests and non-family literals simply ride the
  guarded document forms. `$orderby` over an instant path sorts the
  document string, never the integer column, for the same reason.

### 10.4 One-statement graph loading

`store.entity(name).load(spec)` compiles an include tree to correlated
subqueries projected as JSON — `json_group_array(json_object(…))` for
to-many, a scalar `json_object` for to-one, a correlated `COUNT(*)`
for `count: true` — and executes **one statement regardless of depth
or parent count**, asserted by a counting driver
(`test/db/statement-count.test.js`); N+1 is a test, not a promise.

```js
store.entity('User').load({
  where:   { $gt: ['$it.age', 10] },       // over the root entity
  orderBy: '$it.name',
  take: 20, after: cursor,                 // §10.5
  include: {
    posts: {
      where:   { $ge: ['$it.stars', 3] },  // INSIDE the subquery
      orderBy: { $key: '$it.stars', $dir: 'desc' },
      take: 2,
      include: { comments: true },         // nesting
    },
    followers: { count: true },            // the count, not the rows
  },
})
```

Per-relation `where`/`orderBy`/`take` apply INSIDE the subquery — the
point where naive loaders fall back to N+1. Clauses compile against
the child's own reference flavors; an untranslatable clause is a
refusal (`JD0032`) naming the include path, never a silent residual.
Include depth is bounded (default 3, override with `maxDepth`);
exceeding it is `JD0032` with the bound printed. A cyclic include
specification is rejected. Unknown relation names are `JD0032` too.

### 10.5 Pagination

`$orderby` + `$subsequence` translate to `ORDER BY` + `LIMIT/OFFSET`
on the query surface. On the `load` surface, `after` (a cursor) with a
single ascending or descending ordering over a UNIQUE column — the
key, or any `unique: true` column — compiles to **keyset pagination**
(`WHERE col > ?` / `< ?`) instead of a growing `OFFSET`; `skip`
compiles to offset. `explainLoad()` reports which strategy ran
(`keyset` / `offset` / `none`) — offset degrading quietly on large
tables is a well-known footgun, and naming it is cheap. A cursor over
a non-unique column, a document path, or a multi-key ordering is
refused (`JD0032`).

### 10.6 What remains residual

Reported by `explain()` with reasons, refused under `strict`, and —
because joins make residuals more expensive — accompanied by the
`EXPLAIN QUERY PLAN` narrative (SQLite exposes no row estimates;
a number appears only where `capabilities.rowEstimates` is filled):

- three or more bindings;
- non-equality join predicates, and disjunctions spanning bindings;
- `$groupby` (the engine's post-group cardinality rebinding deserves
  its own order; the count-of-related-rows case ORMs are bad at is
  already native via `count: true` includes);
- projections (`$return` objects) — over one binding or across a join;
- externals against document paths; booleans and `null` at bind time;
- everything phase A already listed (§8 of `QUERY-FORMAT.md`
  notwithstanding, the truth table is the contract).


## 11. The unit of work

Read entities, produce changed plain JSON, call `saveChanges()`: the
minimal set of parameterised statements runs inside ONE transaction,
ordered so no foreign key is violated mid-flight, with optimistic
concurrency where a version property is declared. Change tracking is
copy-on-write diffing — **no proxies exist on any read path**, and the
assertion is a test, not a promise.

### 11.1 Snapshot tracking (the default)

A materialised entity — from `create`, `get`, `update` or `load`
(root AND included children) — is plain, **deep-frozen** JSON,
registered under its identity. The frozen document itself is the
snapshot: the tracker retains exactly one reference per entity, no
copies. Mutation is replacement:

```js
const ada = await users.get('u1');            // frozen, tracked
users.put({ ...ada, age: 37 });               // the next version
users.add({ id: 'u9', name: 'new' });         // pending insert
users.remove('u2');                           // pending delete
const report = await store.saveChanges();     // one transaction
```

- `put(next)` requires the key to be tracked (`JD2006` otherwise) and
  validates through the injected hook. `add()` completes defaults and
  validates immediately; an `auto` key stays absent until the save
  allocates it. `remove()` of a pending add cancels it. Documents
  handed to `add`/`put` are adopted and frozen.
- A re-read refreshes a CLEAN record's snapshot; a DIRTY record stays
  authoritative — the read still returns the fresh row. `discard(key)`
  drops tracking without scheduling anything; it is the recovery step
  after a `JD2040` conflict (discard, re-read, reapply, save again).
- `asNoTracking()` returns a read-only surface (`get`, `load`) whose
  results are plain UNfrozen data, registered nowhere — a 100k-row
  report retains no snapshots (proven by a forced-GC live-set test).
- Query results (`store.execute`, linq) are plain data, never tracked:
  a projection has no identity to track.

### 11.2 Explicit updates (the other mode)

`set.update(key, changes)` and `set.delete(key)` skip tracking: one
immediate statement, last-write-wins by contract. An explicit update
still bumps a declared version property, so optimistic savers observe
the row changed. This is the path reactive layers and job runners use.

### 11.3 The diff-to-statement table

`saveChanges()` diffs snapshot against current with the suite's own
diff engine (`createJSONPatch`) and maps each operation:

| Diff operation | Statement |
|---|---|
| a top-level mapped scalar (or foreign-key) member | one column assignment (`SET col = ?`; removal writes `NULL` — reads absent, §9.3) |
| a top-level instant member (`column: "integer"`) | the epoch column AND a `jsonb_set` of the document string, one statement |
| a path inside the JSONB document | a `jsonb_set` / `jsonb_remove` chain over the `doc` column (the §5 patch translation) |
| a many-to-many relation member | join-table `INSERT`/`DELETE` rows from the KEY-SET difference (element internals belong to the child entity) |
| the version member | dropped — engine-owned, always written as snapshot + 1 |
| a one-to-many / one-to-one relation member EDIT | refused (`JD2003`): projections are not stored state |
| anything else (`move`, a mid-array insert, …) | the whole-row fallback — full column set + full document, **counted** in the report |

All assignments for one entity coalesce into ONE `UPDATE`. Relation
members never enter the stored document (`split` strips them on every
write path).

### 11.4 Ordering and batching

Statements run: inserts parent-first (topological over the foreign-key
edges among the inserted entities) → updates → join-table rows (both
endpoints exist by then) → deletes child-first. An update may
reference a parent inserted in the same save. A foreign-key cycle —
self-references included — among the entities being inserted or
deleted is **`JD0040`** naming the cycle; break the save in two.

Same-shape inserts of one entity coalesce into multi-row `VALUES`
statements, bounded by `min(100 rows, ⌊900 parameters / row width⌋)`
(`BATCH_ROW_BOUND`, `BATCH_PARAM_BUDGET`). Generated keys come back
through `RETURNING` in one round trip; ascending keys pair with
insertion order (asserted by test). Measured on this machine: 2000
inserts = 20 statements at ~22 ms versus 2000 single-row statements at
~31 ms in one transaction — the wall-clock gap is modest in-process,
the 100× statement reduction is the point for anything remote.

### 11.5 Optimistic concurrency

Declare a token with `version: true` (§9.2). Every `saveChanges()`
update and guarded delete carries `WHERE version = ?` (the SNAPSHOT
version) and writes snapshot + 1; a zero-row result is **`JD2040`**
carrying the entity and key, and the whole save rolls back. Without a
version property there is no concurrency check and the report says so:
`concurrency.unversioned` names every touched entity that has none —
never a silent last-write-wins the reader believes is protected. (A
row that vanished entirely still conflicts an update: zero rows is
zero rows.) An unguarded delete of a missing row is a no-op.

### 11.6 Failure semantics and the return shape

`saveChanges()` is all-or-nothing inside one transaction. On ANY
failure the tracker is left exactly as it was before the call — the
same save can be retried once the cause is gone; a half-applied
tracker is worse than a rollback. Only a committed save advances
snapshots (bumped versions, generated keys) and clears pending work.

The return value is data, not a boolean:

```js
{
  inserted, updated, deleted,          // row counts
  joinInserted, joinDeleted,           // membership rows
  fallbacks,                           // whole-row writes, counted
  statements: [{ sql, rows }, …],      // what actually ran
  concurrency: { checked, unversioned: [names] },
  elapsedMs,
}
```
