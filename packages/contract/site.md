---
package: "@jarenjs/contract"
card:
  title: Contract
  blurb: >-
    One document declares your JSON-in/JSON-out operations — kind, policy, HTTP
    binding — and compiles once into validators, transport normalizers and a
    static-beats-variable path matcher. The same contract serves over HTTP,
    in-process through the local binding, and across a MessagePort or a worker,
    binds into an @jarenjs/app document as generated task slots, and projects to
    OpenAPI 3.1, TypeScript, Markdown and AI tool definitions from the one source.
  perf: >-
    measured against a hand-composed router doing the same work — the dispatch
    loss published beside the wins
engines:
  - key: contract
    suite: contract
---

The layer between two Jaren ends. A `$contract` document — the sibling of
`$model`, `$fsm` and `jaren-app` — declares the operations they may exchange:
JSON in, JSON out, each with a kind (read, command or subscribe), one input
schema, an output schema, declared errors, a behavior policy and a REST-faithful
HTTP binding. `compileContract` compiles it once into per-operation validators,
transport normalizers (path and query strings decoded through the input schema
itself) and a path matcher whose static segments beat variables regardless of
registration order. A bad document is refused at compile with a stable `JC` code
and the JSON Pointer of the member at fault — never at request time.

```json
{ "$contract": "0.1", "id": "shop",
  "operations": {
    "catalog.load": {
      "kind": "read",
      "input":  { "type": "object", "properties": { "since": { "type": "string", "format": "date-time" } } },
      "output": { "type": "array", "items": { "$ref": "#/$defs/Product" } },
      "http":   { "method": "GET", "path": "/api/catalog" }
    }
  },
  "$defs": { "Product": { "type": "object", "required": ["id", "name"],
             "properties": { "id": { "type": "integer" }, "name": { "type": "string" } } } } }
```

Serving it is one call per binding: `serveHttp` turns the compiled contract plus
a handler table into a total dispatch pipeline — plain request in, plain response
out, every hostile input settled into a coded response — with fetch
(Request→Response) and node adapters, body limits, prototype-safe parameter
assembly, idempotency through a ledger interface, and the response validated
against the output schema before it leaves. The same handler table serves
in-process (local) and over MessagePort, Worker or BroadcastChannel (port, with
collision-free client-scoped request ids — this site's own cross-tab data studio
runs on it). A subscribe operation streams a @jarenjs/db `live()` subscription —
a snapshot, then `{ patch, seq }` emissions — as Server-Sent Events over http and
push frames over port, resumable by `seq`.

```js
import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';
import { openHttpClient } from '@jarenjs/contract/client';
import { contractAppBinding, createContractEffect } from '@jarenjs/contract/app';

const contract = compileContract(doc);
http.createServer(toNodeHandler(serveHttp(contract, handlers))).listen(8080);

const client = openHttpClient(contract, { baseUrl: 'http://localhost:8080' });
await client.invoke('catalog.load', { since: '2026-01-01T00:00:00Z' });
// { ok: true, value: [...], meta: { op, attempt, trace, revision, etag, notModified } }

// or drive it from an app document: generated task slots + ONE effect
const { slice, actions, schema } = contractAppBinding(contract);
```

The client resolves a JSON outcome for everything a server or a network can do —
a declared failure, a transport error, a peer that violated the contract, a local
cancellation — and never rejects for any of them. Three identities stay apart by
construction: the attempt id is the caller's, the trace id is the server's, and
the idempotency key is generated client-side and travels only as its header. The
app binding turns each operation into a generated task slot with start/done/reset
actions and one registered effect — no route strings, no hand-written wrappers,
and no import between the packages: the documents cross as JSON.

A binding carries what it can carry and says so. Which features each of the three
answers for — status codes, headers and etags, idempotency, streaming — is the
frozen capability table on
[this site's own contract section](#/docs?s=site-contract), beside the compiled
document this website runs its data plane on.

Everything a consumer wants beside the runtime is a projection of the same
compiled document: a browser-safe public subset (itself a valid `$contract`),
OpenAPI 3.1 (validated against the official meta-schema), TypeScript declarations
with a typed operation map, Markdown reference docs and AI tool definitions —
with a `jaren-contract` CLI whose `--check` fails CI the moment an artifact
drifts. The contract knows its own identity: `revision()` is the SHA-256 of the
canonical public projection, served at `/.well-known/jaren-contract`, and
`diffContracts` classifies what changed between two versions as breaking,
additive, neutral or honestly unknown, by a published rule table.

What it is not, said plainly: not a server framework (bring your own http server
or any framework via the adapters), no authentication or authorization, no
transport encryption, no replay protection beyond idempotency keys, and bytes are
not JSON — a non-JSON media operation is routed and matched but its body crosses
opaque. The measured cost per request is published beside Fastify's on the
Benchmarks page, losses included.

**Try it.** [Play's Contract engine](#/play?engine=contract) compiles a
`$contract` document as you type — `describe()`, the OpenAPI 3.1 projection, the
TypeScript declarations and an in-process dispatch against echo handlers, one tab
each. The Benchmarks page has the match and dispatch numbers beside find-my-way,
hono and Fastify.
