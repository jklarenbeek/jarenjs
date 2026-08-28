# @jarenjs/linq

**The suite, by code.** Every engine in this repository takes a JSON
document — a query, a schema, a database model, a migration, a contract,
a stylesheet, a state machine, a dataflow, an application, a form — and
this is the one package that writes those documents from typed
JavaScript. The chain is the pen; the document is the deliverable.

`.` is the chain: you write `from(users).where(u =>
u.age.gt(21)).orderBy(u => u.name)`, and what exists afterwards is data
— inspectable, serializable, executable by the `@jarenjs/json` engine in
memory, streamed over a cursor, or pushed into a database by any
provider. Each subpath is a **pen** for one other format —
[`./schema`](#by-code-the-schema-pen), [`./model`](#by-code-the-model-pen),
[`./jslt`](#by-code-the-jslt-pen),
[`./migration`](#by-code-the-migration-pen),
[`./contract`](#by-code-the-contract-pen), [`./flow`](#by-code-the-flow-pen),
[`./app`](#by-code-the-app-pen), [`./forms`](#by-code-the-forms-pen) —
emitting exactly the document that format's engine already takes, and
carrying `Infer<>` types a gate proves equal to `@jarenjs/emit`'s
generated declarations. [`./db`](#the-front-door-jarenjslinqdb) is not a
pen: it is the store's typed front door, and the package's one runtime
edge. The rules every pen keeps, and the mapping table for each, are
[docs/PENS-FORMAT.md](docs/PENS-FORMAT.md).

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
  runs the same operator set over cursors and streams — joins only over
  a provider, pushed whole, because a single-pass stream cannot be read
  twice — and async is a
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
  `execute(queryDocument, { externals })` is a provider; one carrying
  `root` binds its items through that root, and two sharing a `scope`
  may be joined in one document. `@jarenjs/db` implements it — a chain
  over a SQLite-backed collection or an entity set
  (`from(store.sync.entity('Post'))`, `fromAsync(store.entity('Post'))`)
  pushes to SQL — the chain imports no store; the package's one runtime
  edge is the client subpath's (`@jarenjs/linq/db`, below) and it runs
  one way, toward the store; two entity sets
  of one store join in ONE statement; the store itself, serving several
  roots, is refused by name (`JL0007`). A provider carrying a relation
  table (`relations` — an entity set does) lets a declared relation
  NAVIGATE: `p.author.email` and `u.posts.all().count()` are hops,
  lowered at capture to the correlated phrases the engine and the store
  both run, so the document never carries a relation name and
  `explain().hops` lists what was navigated; a many-to-many hop is
  `JL0105` until the join table is a queryable root. An asynchronous provider is
  `fromAsync`'s: the document arrives whole and `execute` may answer a
  promise. `mapAsync` splits a provider chain into a pushed prefix and a
  local residual, and `explain()` shows the split.

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
What a pen cannot spell it refuses with a coded error (`JL0101`–`JL0107`)
naming the fix — there is no `.transform()` and no function `refine`;
cross-field rules are `check()`, transforms are application code. The
normative mapping table, the rules every pen keeps and the worked
examples a test executes are [docs/PENS-FORMAT.md](docs/PENS-FORMAT.md).

## By code: the model pen

`@jarenjs/linq/model` is the schema pen with the store's vocabulary
subclassed onto it: the same builders, plus the `x-entity` members
`@jarenjs/db` reads — `key()`, `unique()`, `index()`, `version()`,
`identity('uuid' | 'auto')`, `default()`, `column('integer' | 'json')`
and the three relation spellings — and `defineModel({ entities,
collections })`, which emits exactly the `$model` 0.1 document
`openStore` takes. Its shape hash equals the store's own, so a model
written this way is a model the migration engine already understands.

```js
import * as m from '@jarenjs/linq/model';
import type { InferMeta } from '@jarenjs/linq/model';

export const model = m.defineModel({ entities: {
  User: m.object({
    id: m.string().identity('uuid'),
    email: m.string().email().unique(),
    posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }),
  }),
  Post: m.object({
    pid: m.integer().identity('auto'),
    title: m.string(),
    authorId: m.string(),
    author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'cascade' }),
  }),
} });

const store = await openStore(model, { driver: nodeDriver() });   // @jarenjs/db takes it unchanged
type Meta = InferMeta<typeof model>;   // the EntityMetaMap typedStore<E> wants — no generate step
```

`InferMeta<>` is the point: `@jarenjs/db`'s typed surface wanted an
`EntityMetaMap` that `@jarenjs/emit` had to generate from a model file,
and a repo gate holds the pen's type equal to that generated map for the
fixture model — so the codegen step is optional rather than load-bearing.
The mapping table, member by member, is
[docs/PENS-FORMAT.md §3](docs/PENS-FORMAT.md#3-the-model-pen--jarenjslinqmodel);
what the model document itself means is
[MODEL-FORMAT.md](../db/docs/MODEL-FORMAT.md).

## By code: the JSLT pen

`@jarenjs/linq/jslt` writes `$jslt` 0.1 stylesheets the same way: rule
bodies are callbacks captured over the matched value, with `root`/`path`
and the declared parameters as typed externals; `apply()` spells the
apply-templates operator (and refuses the one shape the engine only
catches at run time — an `apply` as a bare object member, `JL0102`);
`rule()`/`stylesheet()` write the rule object and the envelope byte-equal
to the format's own Appendix A.

```js
import { stylesheet, rule, apply } from '@jarenjs/linq/jslt';

const book = stylesheet([
  rule({ schema: { type: 'object', required: ['isbn'] } },
    (v) => ({ title: v.title, children: [apply(v.chapters.all())] })),
  rule({ schema: { type: 'object', required: ['heading'] } },
    (v) => ({ name: v.heading })),
]);
compileJsltStylesheet(book, { compileTypeTest })(input);   // @jarenjs/json/jslt takes it unchanged
```

The mapping table and the worked examples are
[docs/PENS-FORMAT.md §4](docs/PENS-FORMAT.md#4-the-jslt-pen--jarenjslinqjslt).

## By code: the migration pen

`@jarenjs/linq/migration` closes the first picture — a schema by the
schema pen, a model by the model pen, a chain over the model's entity
sets, and a migration between two models whose data transform is typed
old row → new row. `defineMigration({ id, from, to })` hashes the two
models' shapes exactly as the store does; `.ddl()`, `.sql()`,
`.transform()`, `.assert()`, `.derive()` and `.step()` write the step
kinds MIGRATION-FORMAT names; `fromPlanned(planned, { from, to })` takes
the document `jaren-db plan` wrote and lets a typed `transform` replace
the draft the planner could not fill — the planner still plans, the pen
types the human part, and a draft left alone still refuses to run.

```js
import { fromPlanned } from '@jarenjs/linq/migration';
import { model as v1 } from './models/v1.js';   // the previous model, kept beside the current one
import { model as v2 } from './model.js';

export default fromPlanned(planned, { from: v1, to: v2 })
  .transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
//                     ^ the old row, typed        ^ the new row, checked: a dropped `handle` does not compile
```

`jaren-db` loads model and migration modules beside JSON, plans from the
committed `model.snapshot.json`, refuses a module that is not pure and,
in CI, a model that moved without a plan (`jaren-db check`). The mapping
table and the worked examples are
[docs/PENS-FORMAT.md §5](docs/PENS-FORMAT.md#5-the-migration-pen--jarenjslinqmigration).

## By code: the contract pen

`@jarenjs/linq/contract` writes `$contract` 0.1 documents — the
operations two ends exchange, their schemas, their policy and their HTTP
binding — with the operations' `named()` schemas hoisted into the
contract's own `$defs` and every member in the order CONTRACT-FORMAT
§12.1 fixes, so the pen's document and its own public projection differ
by nothing but the defaults the compiler materializes. The types come
with it: `ContractOf<typeof shop>` is the operation map, and
`typedClient`, `typedHandlers` and `typedTools` carry it onto a client,
a handler table and an AI toolbox without running the TypeScript
projection.

```js
import * as s from '@jarenjs/linq/schema';
import { defineContract, command, error, http } from '@jarenjs/linq/contract';
import { typedClient, typedHandlers } from '@jarenjs/linq/contract';

const Product = s.named('Product', s.object({ id: s.integer(), name: s.string() }).open());

export const shop = defineContract({ id: 'shop' }, {
  'product.save': command({
    input: s.object({ id: s.integer(), product: Product }).open(),
    output: Product,
    errors: { conflict: error({ status: 409 }) },
    http: http({ method: 'PUT', path: '/api/products/{id}' }),
  }),
});

const api = typedClient(openHttpClient(compileContract(shop.document), { baseUrl }), shop);
const outcome = await api.invoke('product.save', { id: 1, product });   // Outcome<Product>
```

The mapping table and the worked examples are
[docs/PENS-FORMAT.md §7](docs/PENS-FORMAT.md#7-the-contract-pen--jarenjslinqcontract).

## By code: the flow pen

`@jarenjs/linq/flow` writes the two `@jarenjs/flow` documents — a
`jaren-fsm` 0.1 machine and a `jaren-dag` 0.1 dataflow. State ids, event
names and node ids are literal types, so a transition into an undeclared
state or an edge from an undeclared node is a compile error; guards,
effect props, node queries and edge selectors are callbacks captured
over the scope the engine evaluates them in, never a path typed as a
string — which is also how the pen can refuse the one trap FLOW-FORMAT
§3 names itself, a plain-string guard that is vacuously true (`JL0102`).

```js
import { defineFsm, on, state, effect } from '@jarenjs/linq/flow';

const review = defineFsm({
  initial: 'draft',
  states: ['draft', 'review', state('published', { final: true })],
  transitions: [
    on('draft', 'submit').to('review'),
    on('review', 'approve', { payload: Approval }).when((s) => s.payload.fresh).to('published'),
    on('review').to('draft'),                    // a wildcard, listed last: document order is the priority
  ],
  context: Cart,
});

compileFsm(review).step('review', 'approve', { payload: { fresh: true } });   // @jarenjs/flow takes it unchanged
fsmToApp(review);                                                            // and so does the app projection
```

The mapping table and the worked examples are
[docs/PENS-FORMAT.md §8](docs/PENS-FORMAT.md#8-the-flow-pen--jarenjslinqflow).

## By code: the app pen

`@jarenjs/linq/app` writes the `jaren-app` 0.1 document `createApp`
runs — a whole interactive application as one JSON value — and answers
the state's JSON Schema beside it for `validateState`, never merged in
(the format has no slot for one). The initial state comes from the
state schema's own `default()`s; actions are captured over APP-FORMAT
§3.1's three names, so a patch value and an effect's props are the SAME
expression when they should be; and a patch PATH is a lambda over the
state that lowers to a JSON Pointer — `st.todos.at(2).done` is
`/todos/2/done`, and a computed index becomes the pointer expression
`{ "$concat": ["/todos/", "$payload.i", "/done"] }`. Two refusals the
loop can only report per dispatch land at build time instead: a view
binding an action `actions` does not declare (`JA2001`), and an
`$event` field §3.1 excludes because `$event` must survive
`JSON.stringify` (`JL0102`).

```js
import { action, append, bind, defineApp, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';

const { document, stateSchema } = defineApp({
  state: s.object({ todos: s.array(s.string()).default([]), draft: s.string().default('') }),
  view: [rule('$', (v) => ['main', {},
    ['button', { on: { click: bind('todo/add', { payload: v.draft }) } }, 'add']])],
  actions: {
    'todo/add': action((st, x) => transition({ patch: [append((c) => c.todos, x.payload)] })),
  },
});

createApp(document, { node, validateState: new JarenValidator().compile(stateSchema) });
```

The mapping table and the worked examples are
[docs/PENS-FORMAT.md §9](docs/PENS-FORMAT.md#9-the-app-pen--jarenjslinqapp).

## By code: the forms pen

`@jarenjs/linq/forms` is the schema pen plus the `x-form` vocabulary —
`form({ visible, enabled, assert, computed, message })` on every
builder — and `assertOnSubmit()`, which answers the same rules' layer-3
`$query` twin in one call. A rule is an ANNOTATION: nothing about what
the schema validates moves, and `Infer<>` reads exactly as it does on
`./schema`. The rules are callbacks over the three names the evaluator
binds — `c.root` the whole document, `c.value` the field, `c.pointer`
its location — so a rule is written, never typed as a path string.

```js
import * as f from '@jarenjs/linq/forms';
import { assertOnSubmit } from '@jarenjs/linq/forms';

const invoice = f.object({
  company: f.string().optional(),
  vatId: f.string().optional().form({
    visible: (c) => c.root.company.ne(''),
    assert: (c) => c.root.company.eq('').or(c.value.ne('')),
    message: 'VAT id is required for companies',
  }),
});

compileFormRules(buildFormModel(invoice.schema));         // per keystroke
new JarenValidator().compile(assertOnSubmit(invoice));    // on submit, the same rule
```

The mapping table and the worked examples are
[docs/PENS-FORMAT.md §10](docs/PENS-FORMAT.md#10-the-forms-pen--jarenjslinqforms).

## The front door: `@jarenjs/linq/db`

`open(model, { driver })` opens `@jarenjs/db`'s store and fronts it with
handles typed from the model pen — no cast, no generate step. Every read
is the chain and pushes down; `include` emits the store's one-statement
`load` spec; `link`/`unlink` reach the store's membership API; `live` is
the store's registration with the chain's bound params; and `explain()`
names what ran at every level — the chain's document and hops, the
graph's SQL and pagination strategy, the store's residual reasons.

```js
import { open } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { model } from './model.js';                          // defineModel(…) from the model pen

const db = await open(model, { driver: nodeDriver() });     // validated by default: formats assert
const hot = await db.entities.Post
  .where((p) => p.stars.ge(3)).orderBy((p) => p.pid).toArray();   // Post[], pushed down
const users = await db.entities.User
  .include((u) => u.posts, { where: (p) => p.stars.ge(3), take: 2 })   // one statement, whatever the depth
  .include((u) => u.labels, { count: true })
  .toArray();                                                // posts: Post[], labels: number
db.entities.User.link(users[0], 'labels', 'admin');          // 'labels' only: the many-to-many members
await db.saveChanges();
const live = await db.live(db.entities.Post.where((p) => p.stars.ge(3)));   // { result, subscribe, close, mode }
```

The edge is one, declared, and proven: this subpath imports
`@jarenjs/db`, `@jarenjs/validate` and `@jarenjs/formats` as OPTIONAL
peer dependencies — `npm install @jarenjs/linq` alone installs nothing
new, the `.` entry carries not one byte of them (the tree-shaking gate
holds it), a `./db` consumer installs the three, and the bundle price is
published in [CONSUMING](../../docs/CONSUMING.md). What is the store's
and what is the client's is one table in
[docs/PENS-FORMAT.md §6](docs/PENS-FORMAT.md#6-the-client--jarenjslinqdb).

**What the door costs, measured.** `benchmark/orm.js` runs the client as
one more route in every table beside Prisma, Drizzle and Kysely over the
same SQLite corpus, equality asserted before anything is timed and
statement counts printed beside the timings.

Against the store it fronts, the door is nearly free: <!--bm:orm.clientDoorPrice-->0.9× on a point read, 1.4× on an indexed predicate at 10 % selectivity, 1.0× on the two-level graph load<!--/bm-->
— because it issues the same documents the store would. What it does
NOT amortize is capture: a chain re-captures its callbacks and re-emits
its document on **every** call, by design, which is the predicate row's
difference and which a caller with a hot query removes by holding the
`Sequence` (or the emitted document) instead of rebuilding it.

Against the rivals, at this corpus, it is faster on <!--bm:orm.clientVsRivals-->8 of 9 against Prisma, 4 of 9 against Drizzle, 1 of 9 against Kysely<!--/bm-->,
and here is every row where the *fastest* rival beats it — <!--bm:orm.clientLosses-->update one column by primary key 18.8× (Drizzle), nested json member filter 6.3× (Kysely), cold start 3.0× (Prisma), posts per user 2.4× (Kysely), graph load 2.2× (Kysely), indexed predicate over 500 users, ids only 2.0× (Kysely), pagination over 5000 comments, page size 20 1.6× (Kysely), insert 1.4× (Kysely), point read by primary key 1.2× (Drizzle)<!--/bm-->.

Three things make that list readable rather than damning, and none of
them removes a row from it. **Kysely is a SQL builder**: on every row it
wins, you wrote the SQL — the comparison it belongs in is against a
hand-written statement, not against a schema-first ORM. **The update row
is the widest loss and has one cause**: the client's only write door is
the unit of work (`get`, mutate, `saveChanges`), where a rival issues one
prepared `UPDATE`; the store's own `update()` sits in the same table so
the difference is visible rather than argued. And **the claim that
survives is structural, not temporal** — the graph load's statement
counts are printed beside its timings, and the client answers a
two-level graph in ONE statement where the schema-first ORM takes three,
whatever the corpus and whatever the clock says.

## What a pen costs

A pen builds a **definition** — once, at module load — and the engine
compiles the document it emitted. That is the only place its price is
paid, and `benchmark/db.js` measures it as ns per build beside the
hand-written literal each pen must emit byte for byte — <!--bm:linq.penBuildCost-->schema 61.1×, model 87.1×, JSLT 72.1× a hand-written literal, and the migration pen 1.4× a hand-written document carrying the same two shape hashes<!--/bm-->.

Multiples that size are what typed builders, `$defs` hoisting, a
deep-freeze and a coded refusal per mistake cost against typing the JSON
yourself; against a request they cost nothing, because no request builds
a definition. The one pen that is nearly free is the migration pen, and
for a plain reason: a `$migration` document IS its two shape hashes, so
a hand-written one has to canonicalize and hash both models too.

The chain's price is a different shape and is published beside it: a
chain re-captures and re-emits its document on every call, so the
in-memory row in the same benchmark reports the loop, the chain and the
pre-compiled document as three separate figures.

## What this is not

Not a storage engine — the store is `@jarenjs/db`'s: its model, its
tables, its translator, its unit of work and its migrations live there,
and `@jarenjs/linq/db` is that store's front door, not a second engine
(it adds no storage semantics and duplicates no algorithm; every read it
makes is a query document or a `load` spec the store already runs, and
the store never imports this package).
Not expression trees over arbitrary methods — the vocabulary is the
query engine's, and an unknown METHOD fails loudly at build time with
a coded error (`JL0001`–`JL0007`; the pens' and the client's refusals are `JL0101`–`JL0107`)
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
