# @jarenjs/contract

Operation contracts for the Jaren suite. A **`$contract` document** — the
sibling of `$model`, `$fsm` and `jaren-app` — declares the operations two
Jaren ends may exchange: JSON in, JSON out, each with a *kind* (`read` or
`command`), an input object schema, an output schema, declared errors, a
behavior *policy* and an HTTP *binding*. `compileContract` compiles it
**once** into per-operation validators, transport normalizers and a path
matcher whose static segments beat variables regardless of registration
order; `serveHttp` puts it behind HTTP as a **total** dispatch pipeline —
plain request in, plain response out, every request-caused failure a
coded response — with a `fetch` and a `node` adapter and idempotency
through a ledger interface; `openHttpClient` calls it from the other end
with the same validator and resolves a JSON **outcome** for everything a
server or a network can do; `contractAppBinding` + `createContractEffect`
let a `@jarenjs/app` document call every operation through one generated
task slot per operation and one registered effect; and the
**projections** turn the same compiled contract into every artifact a
consumer wants beside the runtime — a browser-safe public subset that is
itself a `$contract` document, a valid OpenAPI 3.1 document, TypeScript
declarations with a typed operation map, Markdown reference docs and
`@jarenjs/ai` tool definitions — with a `jaren-contract` CLI whose
`--check` fails CI the moment an artifact drifts. The contract knows its
own identity: `contract.revision()` is the SHA-256 of the canonical
public projection, served at the well-known path and carried in every
outcome's `meta.revision`, and `diffContracts(a, b)` classifies what
changed between two versions — breaking, additive, neutral or honestly
**unknown** — by a published rule table, with `jaren-contract diff
--fail-on breaking` as the CI gate. A `subscribe` operation streams a
`@jarenjs/db` `live()`-shaped subscription — the snapshot, then
LIVE-FORMAT `{ patch, seq }` emissions — as Server-Sent Events over
http and as push frames over port, resumable by seq. Every wire error
speaks twelve languages: the `contract/*` message catalog ships English
in-package and all eleven `@jarenjs/locales` packs carry it, key for
key, enforced by the repository's parity tests.

Zero dependencies outside the suite: `@jarenjs/core`, `@jarenjs/json`,
`@jarenjs/validate`, and — reached only from the `./project` subpath, so
a bundle that never projects never carries it — `@jarenjs/emit`. No
`eval`, CSP-safe; the adapters need only the
platform's `Request`/`Response` or Node's `(req, res)`. The normative contract is
[docs/CONTRACT-FORMAT.md](docs/CONTRACT-FORMAT.md); the grammar is
published as JSON Schema in
[`schemas/jaren-contract.schema.json`](schemas/jaren-contract.schema.json)
(with a mechanically derived draft-07 twin).

## The document in one glance

```json
{
  "$contract": "0.1",
  "id": "shop",
  "$defs": {
    "Product": { "type": "object",
                 "properties": { "id": { "type": "integer" }, "name": { "type": "string" } },
                 "required": ["id", "name"] }
  },
  "operations": {
    "catalog.load": {
      "kind": "read",
      "input":  { "type": "object", "properties": { "since": { "type": "string", "format": "date-time" } } },
      "output": { "type": "array", "items": { "$ref": "#/$defs/Product" } },
      "policy": { "task": "switch", "cache": "revision" },
      "http":   { "method": "GET", "path": "/api/catalog" }
    },
    "product.save": {
      "kind": "command",
      "input":  { "type": "object", "properties": {
                  "id": { "type": "integer" }, "revision": { "type": "integer" },
                  "product": { "$ref": "#/$defs/Product" } },
                  "required": ["id", "revision", "product"] },
      "output": { "$ref": "#/$defs/Product" },
      "errors": { "conflict": { "status": 409 }, "not-found": { "status": 404 } },
      "policy": { "idempotency": "required", "revision": "input:/revision" },
      "http":   { "method": "PUT", "path": "/api/products/{id}/master" }
    },
    "image.bytes": {
      "kind": "read",
      "input":  { "type": "object", "properties": { "id": { "type": "integer" } }, "required": ["id"] },
      "output": true,
      "http":   { "method": "GET", "path": "/api/images/{id}", "media": "application/octet-stream" }
    }
  }
}
```

One input schema per operation; the binding only says **where** its
members travel (`path` variables, then `query` for a read and `body` for
a command by default, or an explicit `in` map). Path and query strings
are decoded by a normalizer compiled over exactly those members; body
members are never coerced. An operation without `http` is bound to the
canonical `POST /<op-id>`. A non-JSON `media` marks an operation
*opaque*: routed and matched, never validated as JSON, its bytes
streamed both ways — the handler pulls the upload chunk by chunk and
may answer a stream, and the HTTP client reaches it through `bytes()`.

## The same document, by code

`@jarenjs/linq/contract` is the pen that writes this format. The
builders are the schema pen's, every `named()` schema is hoisted into
the contract's `$defs`, the members land in the order §12.1 fixes, and
no default is written — so the document below is byte for byte the one
above:

```js
import * as s from '@jarenjs/linq/schema';
import { command, defineContract, error, http, read } from '@jarenjs/linq/contract';

const Product = s.named('Product', s.object({ id: s.integer(), name: s.string() }).open());

export const shop = defineContract({ id: 'shop' }, {
  'catalog.load': read({
    input: s.object({ since: s.string().format('date-time').optional() }).open(),
    output: s.array(Product),
    policy: { task: 'switch', cache: 'revision' },
    http: http({ method: 'GET', path: '/api/catalog' }),
  }),
  'product.save': command({
    input: s.object({ id: s.integer(), revision: s.integer(), product: Product }).open(),
    output: Product,
    errors: { conflict: error({ status: 409 }), 'not-found': error({ status: 404 }) },
    policy: { idempotency: 'required', revision: 'input:/revision' },
    http: http({ method: 'PUT', path: '/api/products/{id}/master' }),
  }),
  'image.bytes': read({
    input: s.object({ id: s.integer() }).open(),
    output: true,
    http: http({ method: 'GET', path: '/api/images/{id}', media: 'application/octet-stream' }),
  }),
});

compileContract(shop.document);                    // the same compile, the same errors
```

The types come with it, without the `types` projection: `ContractOf<typeof
shop>` is the operation map, and `typedClient`, `typedHandlers` and
`typedTools` carry it onto a client, a handler table and an AI toolbox.
The pen's document is
[CONTRACT-PEN.md](../linq/docs/CONTRACT-PEN.md); it imports nothing of
this package.

## Compile once, use everywhere

```js
import { compileContract } from '@jarenjs/contract';

const contract = compileContract(doc);            // ContractCompileError (JC00xx, with docPath) on a bad document

const hit = contract.match('PUT', '/api/products/12/master');
hit.op.id;                                         // 'product.save'
hit.params;                                        // { id: '12' }  — decoded strings

const op = contract.operations['product.save'];
op.http.in;                                        // { id: 'path', revision: 'body', product: 'body' }
op.input.transport.normalize({ id: '12' });        // { id: 12 }   — path/query strings → declared types
op.input.validate({ id: 12, revision: 3, product: { id: 12, name: 'x' } }).valid;   // true
op.output.validate({ id: 12 }).valid;              // false — the validator's collect-errors contract
op.policy;                                         // every default materialized
op.errors.conflict.status;                         // 409

contract.describe();                               // pure JSON: resolved bindings + policy, defaults marked `inferred`
```

The compile is synchronous and total for a hostile document: an
unresolved `$ref`, an unknown member (the vocabulary is closed), a
`GET` with a body, two operations sharing a route shape, a reserved
template form — each is a `ContractCompileError` with a stable code and
the JSON Pointer of the member at fault, at compile, never at request
time.

## Serve it over HTTP

```js
import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';     // or toFetchHandler from '@jarenjs/contract/fetch'
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import http from 'node:http';

const server = serveHttp(compileContract(doc), {
  'catalog.load': async (input, ctx) => {                     // input = { since? } — query strings already coerced
    const catalog = await loadCatalog(input.since);
    ctx.etag(String(catalog.revision));                       // 304 on a matching If-None-Match, etag: W/"…" otherwise
    return catalog;                                           // validated against the output schema before it leaves
  },
  'product.save': async (input, ctx) => {                     // input = { id, revision, product } — path + body assembled
    const saved = await save(input);
    return saved ?? ctx.fail('conflict', {}, { current: await current(input.id) });   // 409, the declared code on the wire
  },
  'image.bytes': (input, ctx) => ({ status: 200, headers: { 'content-type': 'image/png' }, body: bytes(input.id) }),   // opaque: raw
}, { ledger: createMemoryLedger() });                         // required: product.save declares idempotency

http.createServer(toNodeHandler(server)).listen(8080);

// or drive it directly — a pure function over plain objects, no socket needed
const response = await server.dispatch({ method: 'GET', url: '/api/catalog?since=2026-01-01T00:00:00Z', headers: {}, body: null });
response.status;                                             // 200
response.headers['x-jaren-trace'];                           // the server trace of this request
JSON.parse(response.body);                                   // the catalog
```

Every option has a default. The host facts among them come from a
`runtime` record (`@jarenjs/core/runtime`) when one is given — and every
binding takes one: `serveHttp`, `servePort` and `openLocalClient` mint
their trace from its `uuid`, `openPortClient` its client id, `openHttpClient`
its idempotency keys (its `now` stamps the key records and its `random`
draws the retry jitter), and `createMemoryLedger` stamps claims with its
`now`. So a server, its ledger, a client, a store and a job queue share
one record and a deterministic run is configured once; an explicit `trace`,
`keys` or `now` still wins over the record's member, and with no record
every binding reads the platform as it always did. Give the server and its
ledger the SAME record: a ledger built without a clock follows the
binding's instants, and one built with its own clock must not disagree
with the server that stamps its claims.

The pipeline routes (404/405 with `Allow`), enforces the body limit
(413) before reading, checks the media (415), parses (400), assembles the
input from path, query and headers through a prototype-safe setter,
normalizes the transport strings, validates (400 with `details` by
`policy.errors.details`), claims the idempotency key, decides a declared
precondition, calls the handler through one promise boundary, validates
the output (500 — the server broke the contract), applies
`If-Match`/`If-None-Match`, serializes.
Every non-2xx body is `{ code, message, requestId, details?, retryable }`
with `x-jaren-trace` on the response; a handler's thrown error never
reaches the wire (`onError` sees it). `server.capabilities` says what
the binding carries — `head`, `etag`, `idempotency`, `validatedOutput` —
and never degrades silently: an idempotent operation without a `ledger`
is refused at construction. `GET /.well-known/jaren-contract` answers
`describe()`. The normative pipeline, taxonomy and ledger interface are
[CONTRACT-FORMAT.md §7–§9](docs/CONTRACT-FORMAT.md#7-the-http-server-binding).

**The host lifecycle.** Every server binding takes the same two hooks
([§7.7](docs/CONTRACT-FORMAT.md#77-the-host-lifecycle-identify-acquire-release-settle)):
`identify(meta)` runs after the route resolved and before a byte of the
body is read, and answers `{ host, release? }` — the host `scope(ctx)`
sees; `acquire(input, identity, enter)` runs after the input validated
and after a new idempotency claim, and calls `enter({ host, release?,
settlement? })` once — the host the handler sees as `ctx.host`, frozen
beside it. A host that opens a transaction around `enter` commits it
when `enter` resolves and rolls it back when it rejects, and a lease
whose `settlement` is `{ ledger: createDbLedger(tx), required: true }`
has the claim recorded inside `enter`, so the domain write and the
receipt commit together or not at all. Releases run once each, acquired
before identity, before the response is exposed — or when an opaque
body or an SSE stream is done. A hook fault is the host's (`JC2008`,
observed), a hook's `meta.fail(code)` a declared failure. The generated
`HandlerContext<Host, Carrier>` carries `ctx.host` and `ctx.carrier`;
port and local contexts spell the HTTP-only members as `null`.

```js
const server = serveHttp(contract, handlers, {
  ledger: createDbLedger(db),
  identify: (meta) => ({ host: { tenant: meta.headers['x-tenant'] ?? null } }),
  acquire: (input, identity, enter) => db.transaction(
    (tx) => enter({ host: { db: tx }, settlement: { ledger: createDbLedger(tx), required: true } }),
    { mode: 'immediate' }),
});
```

Without a declared resolver, `If-Match`/`If-None-Match` are applied
**after** the handler and only when it armed a tag — a cache device,
**never a write guard**. The `preconditions` option is the write guard:
a per-operation resolver of the CURRENT entity tag, decided before the
handler, so a stale `If-Match` refuses 412 with zero handler runs and a
matching `If-None-Match` read answers 304 without computing the
representation.

```js
const server = serveHttp(contract, handlers, {
  ledger: createMemoryLedger(),
  preconditions: {
    'product.save': (input) => `r${revisionOf(input.id)}`,   // a bare string is a STRONG tag; null = no representation
  },
});
```

### Recipes: Fastify, Hono, Express

None of these is a dependency; each recipe is executed by a test that
imports the framework from the benchmark workspace.

```js
// Fastify — hijack before parsing; the node adapter carries body limits, SSE and abort
const app = fastify();
const handler = toNodeHandler(server);
app.all('/*', {
  onRequest: (req, reply, done) => { reply.hijack(); handler(req.raw, reply.raw); done(); },
}, () => {});
```

`reply.hijack()` hands the untouched socket to the node adapter before
any parser runs, so the recipe coexists with an existing app: routes
registered beside it keep their parsers and parsed bodies, static paths
beat the wildcard, and Fastify's own `bodyLimit` never answers — the
operation's `policy.limits.maxBodyBytes` is the single body ceiling,
refusing as the contract's coded `JC2003` instead of Fastify's
`FST_ERR_CTP_BODY_TOO_LARGE`. Subscribe operations stream (the adapter
calls `response.stream`, writing each event only after the previous one
drained — a slow reader parks the source instead of growing a buffer)
and a dropped peer reaches the handler as `ctx.signal` — the earlier
buffer-parser recipe carried neither. To
confine the contract, register the same route in an encapsulated plugin
with `{ prefix }`; the prefix must then prefix the contract's declared
paths (canonical bindings and the well-known path included). One
shutdown note: a hijacked request never completes in Fastify's own
bookkeeping, so its keep-alive socket never counts as idle — close the
dispatcher first, then `app.server.closeAllConnections()` before
`app.close()`.

```js
// Hono — the fetch handler is the whole app (Bun.serve, Deno, workers alike)
const app = new Hono();
app.all('*', (c) => toFetchHandler(server)(c.req.raw));
```

```js
// Express — the node handler is middleware
const app = express();
app.use(toNodeHandler(server));
```

### Recipe: large outputs — validate on rebuild, serve by revision

`validateOutput: "always"` proves every response against the contract
and is the right default; on a multi-megabyte cached representation it
is also the measured heavy share of the hot row (the benchmark's fourth
column keeps it visible — docs/ROADMAP.md). The honest downgrade is not
"skip validation" but "validate once per REVISION instead of once per
request": prove the snapshot when it is rebuilt, arm its revision as the
tag, and let `preconditions` answer 304 before the handler even runs.

```js
const validateCatalog = contract.operations['catalog.load'].output.validate;
const cache = { revision: 0, value: null };
function rebuild(next) {                 // on every write to the source
  const v = validateCatalog(next);       // the JC2010 caught at build time, once
  if (!(v === true || v?.valid === true)) throw new Error('the snapshot breaks the contract');
  cache.revision += 1;
  cache.value = next;
}
const server = serveHttp(contract, {
  ...handlers,
  'catalog.load': (input, ctx) => { ctx.etag(`r${cache.revision}`, { strong: true }); return cache.value; },
}, {
  validateOutput: 'never',               // declared: capabilities.validatedOutput === false
  preconditions: { 'catalog.load': () => `r${cache.revision}` },   // 304 BEFORE the handler
});
```

The tradeoff is declared, never silent: `validateOutput` is server-wide,
so `capabilities.validatedOutput === false` tells every consumer the
per-request guarantee moved to the rebuild path — keep that path the
only writer of the cache, or the guarantee is gone.

## Call it from the other end

```js
import { openHttpClient } from '@jarenjs/contract/client';

const client = openHttpClient(contract, { baseUrl: 'https://shop.example', timeoutMs: 5000 });

const loaded = await client.invoke('catalog.load', { since: '2026-01-01T00:00:00Z' }, { attempt: 1 });
// { ok: true, value: [...], meta: { op, attempt: 1, trace: '<x-jaren-trace>', revision, etag: 'W/"…"', notModified: false } }
// meta.revision is the server's contract revision once negotiate() has learned it, null before

const saved = await client.invoke('product.save', { id: 12, revision: 3, product });   // validated with the SAME validator the server runs, then PUT /api/products/12/master with the body members as JSON and a generated Idempotency-Key
if (!saved.ok) {
  saved.kind;            // 'failure' (a declared error or a JC2xxx the server answered) | 'network' | 'contract' | 'cancelled'
  saved.error;           // { code: 'conflict', message, status: 409, details: { current }, retryable: false } — JSON, never an Error
}
client.url('image.bytes', { id: 7 });         // 'https://shop.example/api/images/7' — an opaque operation is a URL, not an invoke
await client.negotiate();                     // { compatible, reason: 'same-version' | 'server-accepts' | 'client-accepts' | 'version-mismatch' | 'unreachable' | 'not-a-contract', server, error }
```

`invoke` **never rejects** for anything a server or a network can do —
invalid input is refused before anything is sent (`JC2050`), a transport
failure is `network` (`JC2051`, the error's name only — never its text),
an abort is `cancelled` (`JC2052`), an invalid or undeclared response is
`contract` (`JC2053`/`JC2055`); it throws only for the host's own
mistake (`JC1005`: an unknown or opaque operation). The three identities
stay apart by construction: `meta.attempt` is the caller's and is never
read from a response, `meta.trace` is the server's `x-jaren-trace`, and
the idempotency key is generated here (`keys`, or `ctx.idempotencyKey`)
and travels only as `Idempotency-Key` — with a durable `storage` it is
recorded without the input and `client.pending()` lists what a restart
must reconcile. Retry runs only under a declared `policy.retry`. The
normative client is [CONTRACT-FORMAT.md §10](docs/CONTRACT-FORMAT.md#10-the-http-client-binding).

## Bindings: the same contract with no wire, or a message channel

HTTP is one of three bindings; the other two carry the SAME operations,
handlers and outcomes where no HTTP exists. **`local`** is the pipeline
in-process — the test seam, SSR, a CLI calling its own operations — with
the client and the server as one object:

```js
import { openLocalClient } from '@jarenjs/contract/local';   // serveLocal is the same factory

const client = openLocalClient(contract, handlers);          // the serveHttp handler table, reused verbatim
const saved = await client.invoke('product.save', { id: 12, revision: 3, product });
// a declared failure: { ok: false, kind: 'failure', error: { code: 'conflict', …, status: null, … } }
// — status is null and PRESENT: this binding carries no statuses and says so, never omits the member
```

The jaren website runs its whole data plane on this binding: a compiled
`$contract` declares the reads for its package census, build provenance,
benchmark artifacts and repository documents, the browser resolves every one
of them through `openLocalClient` with output validation on, and the build's
generators prove what they write against the output schema of the operation
the page will read it through. It is a static site — there is no server to
talk to — so the contract buys shape rather than transport: a drifted
artifact settles as a typed refusal instead of a wrong render.

**`port`** is request/response over a `MessagePort`, a `Worker`, a
`BroadcastChannel` or a worker's own `self` — JSON frames marked
`jaren: "contract/0.1"` (the grammar ships as
`schemas/jaren-contract-port.schema.json`), so contract traffic shares a
channel with anything else without touching it:

```js
// inside the worker
import { servePort } from '@jarenjs/contract/port';
servePort(contract, handlers, { channel: self });

// in the page
import { openPortClient } from '@jarenjs/contract/port';
const client = openPortClient(contract, { channel: worker, timeoutMs: 15_000 });
const rows = await client.invoke('data.rows', { collection: 'notes' });
```

Request ids are `"<clientId>:<seq>"` with a UUID per client instance,
and a client ignores every frame outside its own prefix — so two tabs
on one shared channel can never settle each other's requests, whatever
they fire concurrently (the repository's own data studio runs its
cross-tab db-owner protocol on exactly this). A handler fault answers
`JC2070` (kind `contract` — never dressed as a declared failure), an
unanswered request is `JC2072` after `timeoutMs`, cancellation crosses
as a `cancel` frame with the id scoping as the guarantee.
`createContractEffect` and `contractTools` take these clients unchanged
— they read `invoke` and nothing else. What each binding carries, from
its frozen `capabilities`:

| capability | `http` server / client | `local` | `port` |
|---|---|---|---|
| `status` | yes | no (`error.status: null`) | no (`error.status: null`) |
| `headers` | yes | no | no |
| `media` (opaque operations) | yes — streamed both ways; `client.bytes()` | no (`JC1005` at invoke) | no (`JC1005`; `JC2071` to a foreign asker) |
| `etag` | yes | no | no |
| `idempotency` | with a `ledger` / always sent | no — declared policy inert, stated | no — `key` reserved in the frame grammar |
| `stream` (`subscribe`) | yes — SSE, `Last-Event-ID` resumption (paged replay, bounded queue) | no (`JC1005` at invoke) | yes — push frames, per-client streams (the same replay and bounds) |
| `cancel` | `'signal'` | `'signal'` | `'message'` |

The normative bindings are [CONTRACT-FORMAT.md §15–§16](docs/CONTRACT-FORMAT.md#15-the-local-binding),
the stream wire [§17–§19](docs/CONTRACT-FORMAT.md#17-subscribe-operations).

## Call it from a @jarenjs/app document

```js
import { createApp, createTaskEffect } from '@jarenjs/app';
import { contractAppBinding, createContractEffect } from '@jarenjs/contract/app';

const { slice, actions, schema } = contractAppBinding(contract, { ops: ['catalog.load', 'product.save'] });
// slice   → { 'catalog.load': { id: 0, status: 'idle', kind: null, value: null, error: null, meta: null }, … }   pure JSON, mount at /contract
// actions → 'contract/catalog.load/start' + '/done' + '/reset' per operation — the TASKS.md id guard built in
// schema  → the slice's JSON Schema for validateState (value = the output schema or null)

const app = createApp({ state: { contract: slice }, view, actions: { ...actions, ...own } }, {
  effects: { contract: createContractEffect(client, { createTaskEffect }) },   // ONE effect; the task mode comes from policy.task
});
app.dispatch('contract/catalog.load/start', { since: '2026-01-01T00:00:00Z' });
```

A `subscribe` operation becomes a **subscription** instead of a task:
the binding additionally returns `subs` (spread into the app document)
and `createContractSubscription(client)` is the one `contract-stream`
handler they run — `start` flips the slot live, the snapshot and every
patch land id- and seq-guarded, and the maintained document keeps
LIVE's structural sharing because the handler applies the emissions
with `@jarenjs/json/patch` ([CONTRACT-FORMAT.md §11.4](docs/CONTRACT-FORMAT.md#114-subscribe-operations-the-generated-subscription)).

No route strings, no hand-written wrappers, and no import of
`@jarenjs/app` from this package — the documents cross as JSON and the
task-effect factory crosses as a function the host passes in. A
superseded read dispatches once with the newer result, an out-of-order
older response is rejected by the id guard, a double-dispatched command
runs once and its result lands, a slot can always be released with
`reset`, and every failure lands in state as the same outcome shape with
its kind beside it.
The runnable walkthrough is [docs/APP-INTEGRATION.md](docs/APP-INTEGRATION.md);
the normative binding is [CONTRACT-FORMAT.md §11](docs/CONTRACT-FORMAT.md#11-the-app-binding).

## Project it to everything else

One compiled contract, five artifacts — every one deterministic, every
one checkable in CI (`@jarenjs/contract/project`):

```js
import { publicProjection, toOpenApi, toTypeScript, toMarkdown, contractTools } from '@jarenjs/contract/project';

publicProjection(contract);   // the browser-safe subset — ITSELF a valid $contract document
                              // (server-audience operations, limits and error detail levels stripped;
                              //  operations with `policy: { audience: 'server' }` never leave the server)
toOpenApi(contract, { info: { title: 'Shop', version: '5' } });
                              // → { document, dropped }: OpenAPI 3.1, validated in this repo against the
                              //   official meta-schema; declared errors become enum-pinned wire-error
                              //   schemas; policy rides along as x-jaren-policy; every keyword the dialect
                              //   cannot carry is refused (JC0060) or — under lenient — dropped and REPORTED
toTypeScript(contract);       // one .d.ts: CatalogLoadInput/Output per operation, a typed Operations map,
                              //   Outcome<T>/Meta/WireError exactly as every binding builds them, and a
                              //   typed Client and Handlers — invoke('product.save', …) is fully typed
toMarkdown(contract);         // reference docs: operations table, per-operation sections, the type tables
contractTools(contract, client);
                              // @jarenjs/ai ToolDefs (WebMCP for free) without importing that package:
                              //   name 'product_save', a self-contained inputSchema, execute → the outcome
```

And on the command line, the drift gate:

```sh
jaren-contract openapi --contract shop.json --out api/ --info-title Shop
jaren-contract types   --contract shop.js   --out src/shop.d.ts --check   # exit 1 when stale; the module IS the source
jaren-contract docs    --contract shop.json --out docs/
jaren-contract diff    --from api/v1.json --to shop.js --fail-on breaking
```

Every document flag — `--contract`, `--from`, `--to` — takes a `.json`
file or a pure module (`.js`, `.mjs`, `.cjs`, and `.ts`/`.mts`/`.cts`
where Node strips types) whose `default` or `contract` export is the
document or a `@jarenjs/linq/contract` pen (its `toJSON()` is the
emission); the module is evaluated twice and refused (exit 2) when the
two emissions differ, so a clock or randomness in a contract module
never projects two different declarations. The loader is
`@jarenjs/json/node`, the Node-only subpath `jaren-db` shares — this
package imports neither `linq` nor `db`. `types --out … --check` against
the module is the types twin CI runs: exit 1 when the declaration is
missing or stale, 0 when current, and an ordinary run rewrites nothing
that did not change.

`describe` and `public` print JSON; exit 0 current/written, 1 drift
under `--check`, 2 on a compile refusal printed as `code docPath reason`
or an unreadable, impure or undocumented input.
The normative projection rules — the public projection's member order
(the revision hashes those bytes), the OpenAPI mapping and keyword
policy, the tool naming — are
[CONTRACT-FORMAT.md §12](docs/CONTRACT-FORMAT.md#12-projections).

## Know what changed: revision and diff

```js
import { diffContracts, isCompatible } from '@jarenjs/contract/diff';

await contract.revision();
// 64 lowercase hex: the SHA-256 over the RFC 8785 canonical bytes of the
// public projection — memoized, so it is computed at most once per process.
// Two compiles of equal documents agree across machines; a change a client
// can observe moves it; a server-audience operation or a policy.limits
// value does not. GET /.well-known/jaren-contract answers it (computed
// lazily on the first request), negotiate() learns it, and every outcome
// after that carries it in meta.revision — correlation data, never the
// compatibility decision.

const { breaking, additive, neutral, unknown } = diffContracts(v1, v2);
// every change classified by the CONTRACT-FORMAT §13 rule table (R1–R15):
//   breaking — an operation or error removed, a binding member moved, a new
//              required input member, a narrowed input, a removed/optional-
//              ized/narrowed output member, idempotency now required, an
//              operation withdrawn to audience: server
//   additive — an operation/error added, an optional input member, a widened
//              schema, a relaxed idempotency
//   neutral  — task mode, retry, cache, policy.revision, doc
//   unknown  — what the checker does not model (anyOf/if/not, a CHANGED
//              pattern, an external $ref, an error details schema):
//              REPORTED, never silently classed
// each Change = { kind, op, docPath, from?, to?, rule } — the docPath a
// validator error would name, $refs resolved

isCompatible(clientContract, serverContract);
// the negotiation rule as a pure function (same version, or either end's
// compat names the other's) — the SAME implementation negotiate() runs,
// exported so a server can refuse an incompatible peer too
```

```sh
jaren-contract diff --from api/v1.json --to api/v2.json --fail-on breaking   # exit 1 on a breaking change
```

`--fail-on` requires at least one change class; a missing or empty value is a
usage error (exit 2), so an unset CI variable cannot silently disable the gate.

The revision answers "is this byte-for-byte the contract I compiled
against?"; `version`/`compat` answer "do the authors claim we speak?";
the diff answers "what exactly moved, and does it break me?". They are
three different questions and none is derived from another —
[CONTRACT-FORMAT.md §13–§14](docs/CONTRACT-FORMAT.md#13-the-breaking-change-diff).

## Benchmarks

Measured on the committed suite (`npm run benchmark:contract` — a real
123-route table, 47 GET; recipes, fairness decisions and the correctness
gates are in the file's header), published through the repository's
benchmark-figure gate so no number here is typed by hand:

- **Route match**: the compiled matcher resolves the probe mix —
  static hot paths, variables, the static-beats-variable case, a miss —
  at <!--fact:contract.match.vs-fmw-->172 ns per lookup vs find-my-way's 185 ns<!--/fact-->;
  hono's TrieRouter is <!--fact:contract.match.vs-hono-->1.9x<!--/fact--> behind, and its RegExpRouter refuses this
  route table outright (a static path registered after a param sibling).
- **Dispatch, in-process**: the whole pipeline (route, decode, validate
  input, handler, validate output,
  serialize) is <!--fact:contract.dispatch.vs-fastify-->2.8–11.9x<!--/fact-->
  faster than Fastify driven through its own `inject` — a number that
  includes Fastify's mock-stream harness, which is why the next row
  exists.
- **The honest loss**: the bare pieces Fastify composes — find-my-way +
  Ajv + fast-json-stringify, called directly with no harness and no
  response validation
  — are <!--fact:contract.dispatch.losses-->2.5–11.4x<!--/fact--> faster than
  this pipeline. The wide end of that band is the bare `{ok:true}`
  route, where the rival's compiled serializer answers in ~200 ns and
  there is almost no work to amortize the pipeline against; on the
  request shapes with real bodies and validation the loss sits at the
  narrow end. That is the measured price of a total dispatch (every
  hostile input settles into a coded response) that also proves the
  server kept its own contract before a byte leaves. Over a real
  loopback socket the two stacks are level: the socket dominates both.
- **The optimization trigger**: on the heaviest in-process row (the
  5×4-body PUT), response serialization is <!--fact:contract.serialization.share-->11.5%<!--/fact-->
  of the request and output validation is <!--fact:contract.validateOutput.share-->29%<!--/fact-->.
  A schema-driven serializer stays unscheduled while serialization is below
  25%: even making that stage free would move the whole request by only about a
  tenth. The suite republishes both shares on every measured run; for a large
  cached representation, validate on rebuild and serve by revision instead of
  paying validation on every request.
- **Revision**: computing it
  costs <!--fact:contract.revision.ms-->2.8 ms<!--/fact--> for the 123-operation
  contract, once per process.

## What it is not

Boundaries, stated as plainly as the capabilities — each one a
deliberate decision, not a gap:

- **Not a server framework.** No process manager, no middleware stack,
  no plugin system, no logger. The server binding is a pure dispatch
  pipeline over plain request/response objects; bring `node:http`,
  `Bun.serve`, or any framework through the ≤15-line adapter recipes
  above.
- **No authentication or authorization.** A request that reaches the
  pipeline is dispatched by route alone. Compose auth in front of the
  handler table (the adapter seam is where a host's middleware already
  runs) — the contract declares what may be said, not who may say it.
- **No transport encryption.** TLS belongs to the server or proxy that
  terminates the socket.
- **No replay protection beyond idempotency keys.** `Idempotency-Key`
  deduplicates a declared command through the host's ledger; it is not
  a nonce scheme and does not authenticate the sender.
- **Bytes are not JSON.** A non-JSON `media` marks an operation opaque:
  routed and matched, path and query still decoded and validated, the
  body streamed to the handler as a pull source that never yields past
  the declared limit, and never modeled. `client.bytes()` is its typed
  door — a live response stream, never a JSON value — and `invoke`
  refuses it. Images and OAuth redirects are host paths, not JSON
  operations.
- **No replication, and no storage of its own.** The ledger and the
  command lifecycle ship as JSON documents (`$model`, `$fsm`); the
  in-memory ledger is for tests and single-process hosts. A durable
  ledger is one import away and adds no dependency here:
  `createDbLedger` in `@jarenjs/linq/db` implements the ledger over a
  `@jarenjs/db` store (immediate claims, a persisted generation fence,
  settlement inside the host's transaction), and
  [CONTRACT-FORMAT.md §8.1](docs/CONTRACT-FORMAT.md#81-a-durable-ledger-over-nodesqlite--an-example-not-an-export)
  is a complete, tested ~60-line ledger over `node:sqlite` (built into
  Node ≥ 24) for a host without the store — an example, not an export.
- **Reconnect is opt-in, HTTP-only, and network-only.**
  `subscribe(op, input, { reconnect: { max } })` re-establishes a
  stream after a network loss — a rejected request, a missed heartbeat,
  the server's `JC2096`, a body that ends before `end` — from the last
  delivered seq under the retry backoff, and ends with one `JC2097`
  when the budget is spent; a declared failure, a contract outcome or
  the server's `end` never reconnects, and the port client has no
  network loss to reconnect from. Absent, a `network` outcome is
  delivered as is and the host re-enters `subscribe` with the
  subscription's `lastSeq`.

## What is here

Here: the document and its grammar, `compileContract`, `contract.match`,
`describe()`, the `JC0001–JC0017` compile errors; the HTTP server binding
(`serveHttp`, the `JC2001–JC2015` wire taxonomy with its English catalog,
`fetch` and `node` adapters, the ledger interface with `createMemoryLedger`
and the `idempotencyLedgerModel`/`commandLifecycleFsm` documents); the HTTP
client (`openHttpClient`, the D6 outcomes with the `JC2050–JC2058` client
codes, the client half of idempotency, retry, `negotiate`, and `bytes`
for the opaque operations — a live response stream and a streamed
upload, typed as `HttpClient`/`ByteOperations` by the projection and
`typedHttpClient`/`OpaqueOf` by the pen); the app
binding (`contractAppBinding`, `createContractEffect`); the projections
(`publicProjection`, `toOpenApi` with `JC0060`, `toTypeScript`,
`toMarkdown`, `contractTools`); `contract.revision()` with `JC0061`,
`diffContracts`/`isCompatible` and the `jaren-contract` CLI with `diff
--fail-on`; the `local` and `port` bindings (`openLocalClient`/`serveLocal`,
`servePort`/`openPortClient`, the `JC2070–JC2074` codes and the
`jaren-contract-port` frame grammar with collision-free client-scoped
request ids); the `subscribe` kind with the `stream` binding
(`client.subscribe` over SSE and port push frames carrying LIVE-FORMAT
patches, `JC2090–JC2095`, the generated app subscription with
`createContractSubscription`, and the one SSE codec of the suite in
`@jarenjs/core/text/sse`); and the `contract/*` locale packs in all
eleven `@jarenjs/locales` languages, key parity enforced by test.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.contract-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/contract` | JavaScript | declared |
| `@jarenjs/contract/http` | JavaScript | declared |
| `@jarenjs/contract/fetch` | JavaScript | declared |
| `@jarenjs/contract/node` | JavaScript | declared |
| `@jarenjs/contract/ledger` | JavaScript | declared |
| `@jarenjs/contract/diff` | JavaScript | declared |
| `@jarenjs/contract/client` | JavaScript | declared |
| `@jarenjs/contract/local` | JavaScript | declared |
| `@jarenjs/contract/port` | JavaScript | declared |
| `@jarenjs/contract/stream` | JavaScript | declared |
| `@jarenjs/contract/app` | JavaScript | declared |
| `@jarenjs/contract/project` | JavaScript | declared |
| `@jarenjs/contract/schemas/jaren-contract-port.draft-07.schema.json` | schema | — |
| `@jarenjs/contract/schemas/jaren-contract-port.schema.json` | schema | — |
| `@jarenjs/contract/schemas/jaren-contract.draft-07.schema.json` | schema | — |
| `@jarenjs/contract/schemas/jaren-contract.schema.json` | schema | — |
| `@jarenjs/contract/package.json` | metadata | — |
| `@jarenjs/contract/provider` | JavaScript | declared |
<!--/fact-->

Author JSON template catalogs and MessageSpec references with the
[messages pen](../linq/docs/MESSAGES-PEN.md); existing locale render functions
retain their pluralization and formatting behavior.

## Structured query inputs and app reconnect

Object- and array-typed query members use one JSON-encoded parameter,
including empty arrays, nulls and nested values. Scalar strings stay
literal; parsed JSON is validated without coercion. The client, URL
builder, server dispatcher and OpenAPI projection share this codec.
Malformed or repeated JSON members are `JC2012`. Handwritten callers
must migrate repeated array keys (`tag=a&tag=b`) to one encoded JSON array;
deploy matching client/server versions and revise the contract's `version`
for revision negotiation. See [the wire rules](docs/CONTRACT-FORMAT.md#4-the-http-binding-and-member-locations).

Opt into HTTP subscription recovery per operation:

```javascript
const binding = contractAppBinding(contract, {
  subs: { 'board.feed': { reconnect: { max: 2 } } },
});
```

The generated subscription forwards the option to `client.subscribe`.
The slot stays live with its id and last value while reconnecting; replay
continues from the last delivered sequence. Exhaustion surfaces `JC2097`.
Stop, reset and app destruction stop recovery. Without the option,
network loss is surfaced immediately; an explicit server end remains
terminal. Port and local channel lifecycles are unchanged.

The fixed-heap host-seam test measures the Node response's writable queue
and the producer's unwritten chunk separately from bytes already accepted
by TCP. The in-process Fetch leg can measure produced-minus-consumed
bytes directly. Complete-byte hashes, cursor pulls and cancellation
finalizers remain part of the same end-to-end test.

`@jarenjs/contract/provider` supplies bounded provider execution, compiled JSON
REST/GraphQL dialects and private run authority. Partial observations retain
wire text and never become complete snapshots. See
[provider descriptors and ingestion](docs/PROVIDER-FORMAT.md).
