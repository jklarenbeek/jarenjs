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
task slot per operation and one registered effect. Everything else a
consumer wants beside the runtime — the message-port and stream
bindings, the OpenAPI/TypeScript/Markdown projections, the AI-tool view,
the revision and the breaking-change diff — is coming in this line as a
projection of the same document.

Zero dependencies outside the suite: `@jarenjs/core`, `@jarenjs/json`,
`@jarenjs/validate`. No `eval`, CSP-safe; the adapters need only the
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
    "Product": { "type": "object", "required": ["id", "name"],
                 "properties": { "id": { "type": "integer" }, "name": { "type": "string" } } }
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
      "input":  { "type": "object", "required": ["id", "revision", "product"], "properties": {
                  "id": { "type": "integer" }, "revision": { "type": "integer" },
                  "product": { "$ref": "#/$defs/Product" } } },
      "output": { "$ref": "#/$defs/Product" },
      "errors": { "conflict": { "status": 409 }, "not-found": { "status": 404 } },
      "policy": { "idempotency": "required", "revision": "input:/revision" },
      "http":   { "method": "PUT", "path": "/api/products/{id}/master" }
    },
    "image.bytes": {
      "kind": "read",
      "input":  { "type": "object", "required": ["id"], "properties": { "id": { "type": "integer" } } },
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
*opaque*: routed and matched, never validated as JSON.

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

The pipeline routes (404/405 with `Allow`), enforces the body limit
(413) before reading, checks the media (415), parses (400), assembles the
input from path, query and headers through a prototype-safe setter,
normalizes the transport strings, validates (400 with `details` by
`policy.errors.details`), claims the idempotency key, calls the handler
through one promise boundary, validates the output (500 — the server
broke the contract), applies `If-Match`/`If-None-Match`, serializes.
Every non-2xx body is `{ code, message, requestId, details?, retryable }`
with `x-jaren-trace` on the response; a handler's thrown error never
reaches the wire (`onError` sees it). `server.capabilities` says what
the binding carries — `head`, `etag`, `idempotency`, `validatedOutput` —
and never degrades silently: an idempotent operation without a `ledger`
is refused at construction. `GET /.well-known/jaren-contract` answers
`describe()`. The normative pipeline, taxonomy and ledger interface are
[CONTRACT-FORMAT.md §7–§9](docs/CONTRACT-FORMAT.md#7-the-http-server-binding).

### Recipes: Fastify, Hono, Express

None of these is a dependency; each recipe is executed by a test that
imports the framework from the benchmark workspace.

```js
// Fastify — a catch-all route, the raw body handed to dispatch
const app = fastify();
app.removeAllContentTypeParsers();
app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, body));
app.all('/*', async (req, reply) => {
  const r = await server.dispatch({ method: req.method, url: req.url, headers: req.headers, body: req.body ?? null });
  reply.code(r.status).headers(r.headers);
  return r.body === null ? reply.send() : reply.send(r.body);
});
```

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

## Call it from the other end

```js
import { openHttpClient } from '@jarenjs/contract/client';

const client = openHttpClient(contract, { baseUrl: 'https://shop.example', timeoutMs: 5000 });

const loaded = await client.invoke('catalog.load', { since: '2026-01-01T00:00:00Z' }, { attempt: 1 });
// { ok: true, value: [...], meta: { op, attempt: 1, trace: '<x-jaren-trace>', revision: null, etag: 'W/"…"', notModified: false } }

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

## Call it from a @jarenjs/app document

```js
import { createApp, createTaskEffect } from '@jarenjs/app';
import { contractAppBinding, createContractEffect } from '@jarenjs/contract/app';

const { slice, actions, schema } = contractAppBinding(contract, { ops: ['catalog.load', 'product.save'] });
// slice   → { 'catalog.load': { id: 0, status: 'idle', value: null, error: null, meta: null }, … }   pure JSON, mount at /contract
// actions → 'contract/catalog.load/start' + '/done' per operation — the TASKS.md id guard built in
// schema  → the slice's JSON Schema for validateState (value = the output schema or null)

const app = createApp({ state: { contract: slice }, view, actions: { ...actions, ...own } }, {
  effects: { contract: createContractEffect(client, { createTaskEffect }) },   // ONE effect; the task mode comes from policy.task
});
app.dispatch('contract/catalog.load/start', { since: '2026-01-01T00:00:00Z' });
```

No route strings, no hand-written wrappers, and no import of
`@jarenjs/app` from this package — the documents cross as JSON and the
task-effect factory crosses as a function the host passes in. A
superseded read dispatches once with the newer result, an out-of-order
older response is rejected by the id guard, a double-dispatched command
runs once, and every failure lands in state as the same outcome shape.
The runnable walkthrough is [docs/APP-INTEGRATION.md](docs/APP-INTEGRATION.md);
the normative binding is [CONTRACT-FORMAT.md §11](docs/CONTRACT-FORMAT.md#11-the-app-binding).

## What is here, and what is coming

Here: the document and its grammar, `compileContract`, `contract.match`,
`describe()`, the `JC0001–JC0016` compile errors; the HTTP server binding
(`serveHttp`, the `JC2001–JC2015` wire taxonomy with its English catalog,
`fetch` and `node` adapters, the ledger interface with `createMemoryLedger`
and the `idempotencyLedgerModel`/`commandLifecycleFsm` documents); the HTTP
client (`openHttpClient`, the D6 outcomes with the `JC2050–JC2058` client
codes, the client half of idempotency, retry, `negotiate`); the app
binding (`contractAppBinding`, `createContractEffect`). Coming in this
line: `local`/`port`/`stream` bindings, projections (OpenAPI 3.1,
TypeScript, Markdown, AI tools), the revision hash and `diffContracts`,
and the locale packs for the wire errors.
