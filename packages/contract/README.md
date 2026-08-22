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
| `media` (opaque operations) | yes | no (`JC1005` at invoke) | no (`JC1005`; `JC2071` to a foreign asker) |
| `etag` | yes | no | no |
| `idempotency` | with a `ledger` / always sent | no — declared policy inert, stated | no — `key` reserved in the frame grammar |
| `stream` (`subscribe`) | yes — SSE, `Last-Event-ID` resumption | no (`JC1005` at invoke) | yes — push frames, per-client streams |
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
jaren-contract types   --contract shop.json --out src/shop.d.ts --check   # exit 1 when stale
jaren-contract docs    --contract shop.json --out docs/
```

`describe` and `public` print JSON; exit 0 current/written, 1 drift
under `--check`, 2 on a compile refusal printed as `code docPath reason`.
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
  at <!--bm:contract.match.vs-fmw-->172 ns per lookup vs find-my-way's 180 ns<!--/bm-->;
  hono's TrieRouter is <!--bm:contract.match.vs-hono-->1.8x<!--/bm--> behind, and its RegExpRouter refuses this
  route table outright (a static path registered after a param sibling).
- **Dispatch, in-process**: the whole pipeline (route, decode, validate
  input, handler, validate output,
  serialize) is <!--bm:contract.dispatch.vs-fastify-->2.8–15.1x<!--/bm-->
  faster than Fastify driven through its own `inject` — a number that
  includes Fastify's mock-stream harness, which is why the next row
  exists.
- **The honest loss**: the bare pieces Fastify composes — find-my-way +
  Ajv + fast-json-stringify, called directly with no harness and no
  response validation
  — are <!--bm:contract.dispatch.losses-->2.4–7.5x<!--/bm--> faster than
  this pipeline. The wide end of that band is the bare `{ok:true}`
  route, where the rival's compiled serializer answers in ~200 ns and
  there is almost no work to amortize the pipeline against; on the
  request shapes with real bodies and validation the loss sits at the
  narrow end. That is the measured price of a total dispatch (every
  hostile input settles into a coded response) that also proves the
  server kept its own contract before a byte leaves. Over a real
  loopback socket the two stacks are level: the socket dominates both.
- **Revision**: computing it
  costs <!--bm:contract.revision.ms-->1.4 ms<!--/bm--> for the 123-operation
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
  body handed over raw and never modeled. Images and OAuth redirects
  are host paths, not JSON operations.
- **No replication or durability.** The ledger and the command
  lifecycle ship as JSON documents (`$model`, `$fsm`) a host may open
  with `@jarenjs/db`; the in-memory ledger is for tests and
  single-process hosts. Durability is the host's.
- **No automatic reconnect.** A stream that ends with a `network`
  outcome is re-entered by the host calling `subscribe` again with the
  last delivered seq (`lastSeq` is the hook); the backoff/resume/give-up
  policy is the open decision tracked in the repository ROADMAP.

## What is here

Here: the document and its grammar, `compileContract`, `contract.match`,
`describe()`, the `JC0001–JC0017` compile errors; the HTTP server binding
(`serveHttp`, the `JC2001–JC2015` wire taxonomy with its English catalog,
`fetch` and `node` adapters, the ledger interface with `createMemoryLedger`
and the `idempotencyLedgerModel`/`commandLifecycleFsm` documents); the HTTP
client (`openHttpClient`, the D6 outcomes with the `JC2050–JC2058` client
codes, the client half of idempotency, retry, `negotiate`); the app
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
