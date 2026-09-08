# The Jaren contract pen

> `./contract` — `$contract` 0.1 documents: the operations, their
> schemas, their declared behavior and their REST binding. **Read it
> when** you are declaring an API and want its client, its server and
> its tools typed from one document

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. This document is a **guide** — read
it in order and you can write the format — whose one normative section is
[§2 The mapping table](#2-the-mapping-table); the rules every pen keeps, the shared refusal table, the
index of the other pens and every pen's mapping table collected in one
place are the normative reference,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

You have a service with an API, and three things need to agree about it:
the server that implements it, the client that calls it, and whatever
else reads it — a generated OpenAPI file, a tool set handed to a model, a
test. A contract is the one document all three read, and writing it by
hand means keeping JSON Schemas, HTTP verbs and error names in step by
eye. This pen writes that document from typed calls, and the same typed
calls then check the client, the handlers and the tools against it.

```js
import { defineContract, read, command, subscribe, http, error } from '@jarenjs/linq/contract';
```

writes `$contract` 0.1 documents
([CONTRACT-FORMAT](../../contract/docs/CONTRACT-FORMAT.md)): the
operations, their schemas, their declared behavior and their REST
binding, as one document `compileContract` takes unchanged. The schemas
are the schema pen's ([SCHEMA-PEN.md](SCHEMA-PEN.md)), and every
`named()` builder any operation reaches is hoisted once into the
CONTRACT's own `$defs` and referenced `#/$defs/<name>` — the same
hoisting walk [the schema pen](SCHEMA-PEN.md#27-references-and-defs)
runs over one root, run over every operation's `input`, `output` and
error schemas instead.

The pen imports nothing of `@jarenjs/contract`: the compiler stays the
only judge of what the document means, and a tree-shaking probe holds it
(§7).

**The running example.** §3 is one shop's service surface, and it is six
contracts rather than one on purpose: a `$contract` document is the unit
a service publishes, so a product with a health endpoint, a catalog, an
order intake, a live picking board, a document store and an internal
notes service publishes six of them. Read in order they build the whole
surface up — the smallest possible contract, then a shared definition,
then declared failures and the whole policy, then a stream, then the
binding's harder cases, and last one contract driving a client, a handler
map and a tool set at once. §5 reads the types back off the last of
them. What the pen adds over writing the JSON by hand is three things —
the member order the revision hashes, the `$defs` hoisting, and the
phantom types the three consumers of §5 read.

### 1.1 The two rules that make the document comparable

Both are gates, and together they are why a pen contract and its own
public projection can be compared member for member:

- **The member order is §12.1's** — the normative order the contract
  revision hashes: root `$contract, id, version, compat, $defs,
  operations`; operation `kind, input, output, errors, policy, http,
  doc`; error `status, schema`; http `method, path, in, body, status,
  media`; policy §12.1's public order with the two server-side knobs
  (`limits`, `errors`) in their §3.1 places; `$defs` in first-reference
  order. The pen writes members in that order whatever order they were
  declared in — `test/linq/contract-pen.test.js` builds a deliberately
  scrambled contract and asserts every `Object.keys` above.
- **No default is ever written.** §3.1's defaults are the compiler's to
  materialize and `describe()` marks them inferred; a pen that wrote
  them would turn every default into a declaration and move the revision
  for nothing. The test asserts the exact difference: strip from
  `publicProjection(compileContract(doc))` what `describe().inferred`
  names, the locations §4.1 chose or the template forced, the policy
  members the source never declared and an error's resolved status, undo
  §4.2's path canonicalization — and what is left is the pen's own
  document.

The second rule has a visible consequence a reader meets early:
`command({ output: true })` with no `http` emits an operation of two
members, and the operation the compiler describes has a task, an
idempotency mode, a cache mode, a media type and a `POST /<op-id>`
binding. None of that is missing from the document; all of it is
inferred, and `describe().inferred` says so member by member.

## 2. The mapping table

Nine exported functions, one exported class and the two members that
class carries — eleven names a caller writes, and every one of them is
in a table below. The class itself is §5's, because a caller never
constructs one.

### 2.1 The document

The two calls that make a contract: the envelope, and the identity
members the format compares two revisions by.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineContract({ id?, version?, compat? }, operations)` | `{ $contract: '0.1', id?, version?, compat?, $defs?, operations }` in §12.1's root order, deep-frozen | `Contract<Ops>`; `ContractOf<typeof c>` is the operation map §5 reads | native; a head member the pen does not know, an `id` outside `[A-Za-z_][A-Za-z0-9_-]*`, a non-string `version`, a `compat` that is not an array of strings, or no operation at all, `JL0101` |
| `.document` | the deep-frozen `$contract` document — the same object every time | `ContractDocument` | native |
| `toJSON()` | the same document, so `JSON.stringify(contract)` is the contract | `ContractDocument` | native |

`operations` is a name → value map read by its own keys (the binder's
§1.1 rule 5): an operation id is written with `setObjectMember`, so
`{ ['__proto__']: read({ … }) }` is an ordinary operation and
`{ __proto__: read({ … }) }` is `JL0101`. An operation id is not
otherwise checked here — `catalog.load` and `Not An Id` both emit —
because CONTRACT-FORMAT §2.2's pattern
(`^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$`) is `compileContract`'s to
enforce, at `JC0003`.

### 2.2 The three operation kinds

An operation declares what it is by which of these three writes it, and
the kind decides what the format lets it do — whether it may repeat
safely, whether it may change state, whether it streams.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `read({ input?, output, errors?, policy?, http?, doc? })` | `{ kind: 'read', … }` in §12.1's operation order, declared members only | `OperationDeclaration<'read', S>`; `kind` is the literal | native; a member the spec does not take, a missing `output`, or a non-string `doc`, `JL0101` |
| `command({ … })` | `{ kind: 'command', … }` | `OperationDeclaration<'command', S>` | native; the same three |
| `subscribe({ … })` | `{ kind: 'subscribe', … }` — `output` is the SNAPSHOT schema (§17) | `OperationDeclaration<'subscribe', S>`; never opaque | native; the same three |

The three are one function under three names: they differ only in the
`kind` they carry and in what the COMPILER then requires of them (§2.8).
An operation may also be written by hand as `{ kind, …members }`, which
`defineContract` accepts and lowers the same way. It is a second door
into one emitter and it runs the same checks: the closed member set, the
required `output` and the string `doc` are all applied, and the refusal
names the operation's own position (`/operations/note.get/extra`) rather
than the spec's. §4.4 has the pair side by side.

### 2.3 The schema positions

Three positions take a schema: an operation's `input`, its `output`, and
an error's `schema`.

| Written as | Emits | Type reading | Status |
|---|---|---|---|
| a schema-pen builder | the builder's schema, its `named()` definitions hoisted to the contract's `$defs` and referenced `#/$defs/<name>` | `Infer<>` of the builder; `Input<>` for the accepted shape | native |
| a JSON Schema object, or `true` / `false` | copied verbatim, deep-cloned | `unknown` — a literal is never inferred (the binder's §1.1 rule 2) | native; a value that is neither an object nor a boolean, or one that is not JSON, `JL0101` |

`output` is required and `input` is not: an operation with no `input`
takes none, and reads `input: null` on both sides of §5's agreement.
`true` is the honest spelling for "any value", and it is what an opaque
operation's `output` usually is, since the contract never decodes those
bytes.

The hoist is per CONTRACT, not per operation: one builder reached from
three operations is one `$defs` entry and three `$ref`s, and the entries
come out in first-reference order. Two DISTINCT builders under one name
is `JL0103` (§4.3), and identity is what "distinct" means — the same
builder reached from anywhere is one definition.

### 2.4 The errors map

The failures an operation DECLARES, as opposed to the ones any operation
can raise: each a name the caller matches on, with a status and an
optional payload schema.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `errors: { <code>: … }` | `{ <code>: { status?, schema? } }`, in declaration order | the declared codes are the operation's `errors` union — `'conflict' \| 'not-found'` | native; a map that is not a plain object, a code outside `^[a-z][a-z0-9-]*$`, or an entry that is not a plain object, `JL0101` |
| `error({ status?, schema? })` | `{ status?, schema? }` in that order — `error()` with nothing emits `{}` | `ErrorDeclaration<E>` | native; another member, or a status outside 100–599, `JL0101` |

`error()` is a checked declaration, and the same two members written by
hand are accepted and checked identically: `readErrors` runs the plain
object through `error()` itself, so `{ conflict: { status: 409 } }` and
`{ conflict: error({ status: 409 }) }` emit the same entry and refuse the
same way. The default status (`400`) is the compiler's, so an entry that
declares none emits `{}` and reads its status from `describe()`.

### 2.5 The policy

`policy` takes the nine members CONTRACT-FORMAT §3.1 declares, and emits
the declared ones only, in this order:

| Member | Takes | Emits |
|---|---|---|
| `task` | `switch`, `exhaust`, `concat`, `parallel` | the token |
| `idempotency` | `none`, `optional`, `required` | the token |
| `revision` | `"input:<json-pointer>"` | the string, verbatim |
| `cache` | `none`, `revision` | the token |
| `limits` | `{ maxBodyBytes }`, a positive integer | `{ maxBodyBytes }` |
| `errors` | `{ details }` — `none`, `paths`, `full` | `{ details }` |
| `retry` | `{ max, on }` — an integer ≥ 0 and an array of code strings | `{ max, on }`, the array copied |
| `stream` | `{ resume?, heartbeatMs?, maxPatchBytes? }` — `snapshot`/`replay`, an integer ≥ 1000, a positive integer | the declared members only |
| `audience` | `public`, `server` | the token |

Every one is `native`, and every one refuses a value outside its set with
`JL0101` naming the set (§4.1). `limits` and `errors` are the two
server-side knobs the public projection drops, written in their §3.1
places (§1.1). The pen checks each member against its own table and stops
there: it does not check a member against the operation's KIND, so a
`read` carrying `idempotency: 'required'` is a well-formed policy the pen
writes and the compiler refuses (`JC0014`).

### 2.6 The HTTP binding

Where an operation lands on a URL, and where each input member goes when
it gets there — the one part of a contract that is about transport.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `http({ method, path, in?, body?, status?, media? })` | the binding in §12.1's http order, declared members only | `HttpBinding<H>`; a non-JSON `media` makes the operation `opaque: true` | native; a member the binding does not take, a method outside the seven tokens, a non-string `body`, a status outside 200–299 or a non-string `media`, `JL0101`; a reserved path-template form or a member mapped to `path` the template does not declare, `JL0102` |

| Member | Takes | Note |
|---|---|---|
| `method` | one uppercase token of `GET HEAD POST PUT PATCH DELETE OPTIONS` | lowercase is refused; the format's table is uppercase |
| `path` | a path template (§4.2) | `{name}` and `:name` both accepted, and **written as declared** |
| `in` | input member → `path` \| `query` \| `header` \| `body` | only the members the §4.1 default does not already place |
| `body` | the input member whose value IS the request body | a non-empty string |
| `status` | 200–299 | the success status; `200` is the default and is never written |
| `media` | a media type | anything but `application/json` or a `+json` suffix makes the operation opaque (§4.5) |

Two things this row does not do, and both are deliberate. It does not
canonicalize: `path: '/docs/:id'` stays `/docs/:id` in the document, and
`/docs/{id}` is what `describe()` and every projection show — §4.2's
canonical form is the compiler's, not the pen's. And it does not require
a `path` variable to be an input member (`JC0009`) or check the route
shape against the contract's other operations (`JC0010`): both need the
whole document, and one binding is all `http()` can see.

The binding may also be written as a plain object in the operation's
`http:` position. `defineContract` runs it through `http()` — the same
checks, the same messages — so the two spellings differ only in when the
refusal arrives.

### 2.7 The three consumers

Three identity wrappers that type a client, a handler map or a tool set
against the contract that describes it. None of them emits anything;
they exist so a mismatch is a compile error rather than a 404.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `typedClient(client, contract)` | — (identity) | `TypedClient<C>`: `invoke` over the invokable operations, `subscribe` over the subscribe ones, `url` over all of them | native |
| `typedHttpClient(client, contract)` | — (identity) | `TypedHttpClient<C>`: `TypedClient<C>` plus `bytes` over `OpaqueOf<C>` — the opaque operations, whose success is a `ByteResponse` (a live stream) rather than the output type; for an `openHttpClient` client only, a local or port client has no `bytes` | native |
| `typedHandlers(contract, handlers)` | — (identity) | `TypedHandlerTable<C, Host = null, Carrier = 'http'>`: one handler per invokable operation, `(input, ctx) => output \| Failure`; `ctx` is `HandlerContext<Host, Carrier>` — the HTTP context by default, `Host` the host lifecycle's `ctx.host`, a carrier union a discriminated union to narrow on `ctx.carrier` (CONTRACT-FORMAT §7.7) | native; a missing or misspelled operation does not compile, and an HTTP-only member on a port/local context does not either |
| `typedTools(tools, contract)` | — (identity) | `TypedTool<C>[]`: `name` is the id with `.` → `_`, `execute` takes the operation's ACCEPTED input | native |

All of them are `void contract; return x;` at run time — they add
nothing, wrap nothing and cost nothing. What they do is carry the phantom `Ops`
onto a value the engine produced, which is what makes one authored
document type a client, a server's handler table and an AI toolbox with
no generate step. §3.6 runs all three over one contract and §5 is what
holds their readings true.

### 2.8 What the pen does not judge

The pen refuses its own surface — a member it does not know, a value
outside a declared set — and the one format rule it can see earlier and
exactly, the path template. Everything else is `compileContract`'s,
because everything else needs the document as a whole:

| The document the pen writes | The compiler's refusal |
|---|---|
| a member the document's own closed vocabulary does not carry | `JC0013` (§4.4) |
| an operation id outside `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$` | `JC0003` |
| a `read` that declares `idempotency` | `JC0014` |
| a `GET` carrying a body-located member | `JC0016` |
| an opaque operation with a body-located member | `JC0017` |
| a `subscribe` bound to anything but `GET` | `JC0019` |
| a path variable that is not an input member | `JC0009` |
| two operations sharing a route shape | `JC0010` |

Each row is a document the pen EMITS: `test/linq/contract-pen.test.js`
builds several of them through the pen and asserts the compiler's code,
which is how the division stays a division rather than a gap. LINQ-FORMAT
§1.1 rule 1 is the reason — a pen refuses only what it cannot SPELL, or
what the engine's own rule would refuse and the pen can see earlier,
mirrored and never invented.

## 3. Worked examples

Every `js` fence exports exactly one contract, and the `json` fence that
follows is what the pen emits — executed by
`test/linq/pen-docs.test.js`. CONTRACT-FORMAT's own three worked examples
are rebuilt the same way and held BYTE-equal to that document's fences by
`test/linq/contract-pen.test.js`, so the format spec and this pen cannot
drift apart either.

### 3.1 The smallest complete contract

**The health endpoint** — the smallest complete contract the shop
publishes. One `read`, one binding, and a `doc` string. Nothing else is required:
no `version`, no `$defs`, no `policy`.

```js
import * as s from '@jarenjs/linq/schema';
import { defineContract, http, read } from '@jarenjs/linq/contract';

export const health = defineContract({ id: 'health' }, {
  'health.check': read({
    output: s.object({ ok: s.boolean(), uptimeMs: s.integer() }).open(),
    http: http({ method: 'GET', path: '/api/health' }),
    doc: 'Liveness, and how long the process has been up.',
  }),
});
```
```json
{
  "$contract": "0.1",
  "id": "health",
  "operations": {
    "health.check": {
      "kind": "read",
      "output": {
        "type": "object",
        "properties": { "ok": { "type": "boolean" }, "uptimeMs": { "type": "integer" } },
        "required": ["ok", "uptimeMs"]
      },
      "http": { "method": "GET", "path": "/api/health" },
      "doc": "Liveness, and how long the process has been up."
    }
  }
}
```

`.open()` is a schema-pen decision, not a contract one (the binder's §1.1
rule 4 closes objects by default), and an open response schema is what
lets a server add a member without breaking a client that validates.

### 3.2 A shared definition, hoisted once

**The catalog.** `Product` is reached by four positions across two operations and is one
`$defs` entry with four `$ref`s. The hoist is the contract's, so a
definition never appears inside an operation.

```js
import * as s from '@jarenjs/linq/schema';
import { command, defineContract, http, read } from '@jarenjs/linq/contract';

const Product = s.named('Product', s.object({
  id: s.integer(),
  name: s.string().min(1),
  price: s.number().min(0),
}).open());

export const catalog = defineContract({ id: 'catalog', version: '2', compat: ['1'] }, {
  'product.get': read({
    input: s.object({ id: s.integer() }).open(),
    output: Product,
    http: http({ method: 'GET', path: '/api/products/{id}' }),
  }),
  'product.save': command({
    input: s.object({ id: s.integer(), product: Product }).open(),
    output: Product,
    http: http({ method: 'PUT', path: '/api/products/{id}', in: { product: 'body' } }),
  }),
});
```
```json
{
  "$contract": "0.1",
  "id": "catalog",
  "version": "2",
  "compat": ["1"],
  "$defs": {
    "Product": {
      "type": "object",
      "properties": {
        "id": { "type": "integer" },
        "name": { "type": "string", "minLength": 1 },
        "price": { "type": "number", "minimum": 0 }
      },
      "required": ["id", "name", "price"]
    }
  },
  "operations": {
    "product.get": {
      "kind": "read",
      "input": {
        "type": "object",
        "properties": { "id": { "type": "integer" } },
        "required": ["id"]
      },
      "output": { "$ref": "#/$defs/Product" },
      "http": { "method": "GET", "path": "/api/products/{id}" }
    },
    "product.save": {
      "kind": "command",
      "input": {
        "type": "object",
        "properties": { "id": { "type": "integer" }, "product": { "$ref": "#/$defs/Product" } },
        "required": ["id", "product"]
      },
      "output": { "$ref": "#/$defs/Product" },
      "http": { "method": "PUT", "path": "/api/products/{id}", "in": { "product": "body" } }
    }
  }
}
```

`id` is a path variable in both bindings and is placed by §4.1's rules,
so neither `in` map names it; `product` is named because a `PUT`'s
default would have put it in the body anyway and saying so is the
document being explicit. The `$defs` entry carries no `$defs` of its
own — the schema pen's own per-root hoist is superseded by the
contract's.

### 3.3 Declared failures, and the whole policy

**Order intake**, where a failure is a thing you declare rather than a
status you hope for. `errors` and `policy` together — every policy member the format declares,
including the two the public projection drops.

```js
import * as s from '@jarenjs/linq/schema';
import { command, defineContract, error, http, read } from '@jarenjs/linq/contract';

const Conflict = s.named('Conflict', s.object({ currentRevision: s.integer() }).open());

export const orders = defineContract({ id: 'orders' }, {
  'order.place': command({
    input: s.object({ sku: s.string(), qty: s.integer().min(1), revision: s.integer() }).open(),
    output: s.object({ orderId: s.string() }).open(),
    errors: {
      conflict: error({ status: 409, schema: Conflict }),
      'out-of-stock': error({ status: 422 }),
      rejected: error(),
    },
    policy: {
      task: 'exhaust',
      idempotency: 'required',
      revision: 'input:/revision',
      limits: { maxBodyBytes: 16384 },
      errors: { details: 'paths' },
      retry: { max: 2, on: ['JC2002'] },
      audience: 'public',
    },
    http: http({ method: 'POST', path: '/api/orders' }),
  }),
  'order.list': read({
    output: s.array(s.string()),
    policy: { cache: 'revision', task: 'switch' },
    http: http({ method: 'GET', path: '/api/orders' }),
  }),
});
```
```json
{
  "$contract": "0.1",
  "id": "orders",
  "$defs": {
    "Conflict": {
      "type": "object",
      "properties": { "currentRevision": { "type": "integer" } },
      "required": ["currentRevision"]
    }
  },
  "operations": {
    "order.place": {
      "kind": "command",
      "input": {
        "type": "object",
        "properties": {
          "sku": { "type": "string" },
          "qty": { "type": "integer", "minimum": 1 },
          "revision": { "type": "integer" }
        },
        "required": ["sku", "qty", "revision"]
      },
      "output": {
        "type": "object",
        "properties": { "orderId": { "type": "string" } },
        "required": ["orderId"]
      },
      "errors": {
        "conflict": { "status": 409, "schema": { "$ref": "#/$defs/Conflict" } },
        "out-of-stock": { "status": 422 },
        "rejected": {}
      },
      "policy": {
        "task": "exhaust",
        "idempotency": "required",
        "revision": "input:/revision",
        "limits": { "maxBodyBytes": 16384 },
        "errors": { "details": "paths" },
        "retry": { "max": 2, "on": ["JC2002"] },
        "audience": "public"
      },
      "http": { "method": "POST", "path": "/api/orders" }
    },
    "order.list": {
      "kind": "read",
      "output": { "type": "array", "items": { "type": "string" } },
      "policy": { "task": "switch", "cache": "revision" },
      "http": { "method": "GET", "path": "/api/orders" }
    }
  }
}
```

Three things the fence shows that a sentence would not. `rejected:
error()` emits `{}` — a declared code with no status and no details
schema, which is legal and which reads its `400` from `describe()`.
`order.list` declared `cache` before `task` and the document carries
`task` first: §12.1's order is the pen's, not the author's. And
`retry.on` names a `JC2xxx` taxonomy code rather than one of this
operation's own — both spellings are accepted, because a retry policy
that could only name declared codes could not say "retry a timeout".

### 3.4 A subscribe operation and its stream binding

**The picking board, live.** `subscribe`'s `output` is the SNAPSHOT schema (§17); the emissions that
follow travel the stream wire as patches against it.

```js
import * as s from '@jarenjs/linq/schema';
import { command, defineContract, http, subscribe } from '@jarenjs/linq/contract';

const Board = s.named('Board', s.object({
  seq: s.integer(),
  rows: s.array(s.string()),
}).open());

export const board = defineContract({ id: 'board' }, {
  'board.watch': subscribe({
    input: s.object({ id: s.string() }).open(),
    output: Board,
    policy: { task: 'switch', stream: { resume: 'replay', heartbeatMs: 2000, maxPatchBytes: 65536 } },
    http: http({ method: 'GET', path: '/board/{id}' }),
    doc: 'The board, live: a snapshot, then patches.',
  }),
  'board.clear': command({ input: s.object({ id: s.string() }).open(), output: Board }),
});
```
```json
{
  "$contract": "0.1",
  "id": "board",
  "$defs": {
    "Board": {
      "type": "object",
      "properties": {
        "seq": { "type": "integer" },
        "rows": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["seq", "rows"]
    }
  },
  "operations": {
    "board.watch": {
      "kind": "subscribe",
      "input": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"]
      },
      "output": { "$ref": "#/$defs/Board" },
      "policy": {
        "task": "switch",
        "stream": { "resume": "replay", "heartbeatMs": 2000, "maxPatchBytes": 65536 }
      },
      "http": { "method": "GET", "path": "/board/{id}" },
      "doc": "The board, live: a snapshot, then patches."
    },
    "board.clear": {
      "kind": "command",
      "input": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"]
      },
      "output": { "$ref": "#/$defs/Board" }
    }
  }
}
```

`board.clear` declares no `http` and takes the canonical binding —
`POST /board.clear`, every input member in the body, status `200`,
`application/json` (§4.3). The pen writes no `http` member for it,
because the canonical binding is a default and §1.1's second rule
forbids writing defaults; `describe()` marks the whole binding inferred.

The three stream knobs and the `task` are what the pen writes. The media
type a subscribe travels on is NOT: `text/event-stream` is forced by the
compiler (§17), which is also why a subscribe is never opaque no matter
what its media says.

### 3.5 Path templates, member locations and an opaque operation

**The document store**, which is where the HTTP binding gets interesting.
The two template spellings, the four locations, a whole-body member, a
declared success status, and a media type that makes an operation
opaque.

```js
import * as s from '@jarenjs/linq/schema';
import { command, defineContract, http, read } from '@jarenjs/linq/contract';

export const docs = defineContract({ id: 'docs' }, {
  'doc.put': command({
    input: s.object({
      id: s.string(),
      folder: s.string(),
      body: s.array(s.object({}).open()),
      dry: s.boolean().optional(),
    }).open(),
    output: true,
    http: http({
      method: 'PUT',
      path: '/docs/{folder}/{id}',
      in: { dry: 'query' },
      body: 'body',
      status: 204,
    }),
  }),
  'doc.thumbnail': read({
    input: s.object({ id: s.string() }).open(),
    output: true,
    http: http({ method: 'GET', path: '/docs/:id/thumb', media: 'image/png' }),
  }),
});
```
```json
{
  "$contract": "0.1",
  "id": "docs",
  "operations": {
    "doc.put": {
      "kind": "command",
      "input": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "folder": { "type": "string" },
          "body": { "type": "array", "items": { "type": "object" } },
          "dry": { "type": "boolean" }
        },
        "required": ["id", "folder", "body"]
      },
      "output": true,
      "http": {
        "method": "PUT",
        "path": "/docs/{folder}/{id}",
        "in": { "dry": "query" },
        "body": "body",
        "status": 204
      }
    },
    "doc.thumbnail": {
      "kind": "read",
      "input": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"]
      },
      "output": true,
      "http": { "method": "GET", "path": "/docs/:id/thumb", "media": "image/png" }
    }
  }
}
```

`/docs/:id/thumb` is written as declared and canonicalized to
`/docs/{id}/thumb` by the compiler; a projection or a `describe()` shows
the canonical form, this document shows the author's. The reserved forms
`{+id}`, `{id*}`, `{a,b}`, `*` and `:id?` are all refused here rather
than at compile time, naming the same form `JC0008` would (§4.2).

Two members are placed and two are not. `id` and `folder` are path
variables, named by the template itself — mapping one to `path` in the
`in` map is redundant and mapping a member the template does NOT declare
is `JL0102`. `body` and `dry` are the two the author placed, and `body`
is the whole-body member: its value IS the request body, so no other
member may be body-located beside it.

`doc.thumbnail`'s `image/png` makes it **opaque** (§4.5). The
consequences are all on the type side and §5 pins them: it is out of
`invoke` and out of the tool set, and it is reachable through `url()`
only.

### 3.6 One document, three consumers

**The internal notes service**, and the pen's whole value in one fence: one authored contract, and a client,
a handler table and an AI toolbox all typed off it with no generate step.
The three wrappers are identity at run time, so what this fence proves is
that a pen contract IS a contract — it compiles, it serves, it invokes,
and its declared failure comes back as an outcome rather than a throw.

```js
import * as s from '@jarenjs/linq/schema';
import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { contractTools } from '@jarenjs/contract/project';
import { command, defineContract, error, http, read, typedClient, typedHandlers, typedTools }
  from '@jarenjs/linq/contract';

const Note = s.named('Note', s.object({ id: s.string(), text: s.string().min(1) }).open());

export const notes = defineContract({ id: 'notes', version: '1' }, {
  'note.get': read({
    input: s.object({ id: s.string() }).open(),
    output: Note,
    errors: { 'not-found': error({ status: 404 }) },
    http: http({ method: 'GET', path: '/notes/{id}' }),
  }),
  'note.save': command({
    input: s.object({ note: Note }).open(),
    output: Note,
    policy: { idempotency: 'required' },
    http: http({ method: 'POST', path: '/notes' }),
  }),
});

// the three consumers, all typed off the one document above
const store = new Map([['n1', { id: 'n1', text: 'first' }]]);
const compiled = compileContract(notes.document);
const handlers = typedHandlers(notes, {
  'note.get': (input, ctx) => store.get(input.id) ?? ctx.fail('not-found'),
  'note.save': (input) => { store.set(input.note.id, input.note); return input.note; },
});
const api = typedClient(openLocalClient(compiled, handlers), notes);
const got = await api.invoke('note.get', { id: 'n1' });
if (!got.ok || got.value.text !== 'first') throw new Error('the read did not round-trip');
const missing = await api.invoke('note.get', { id: 'n9' });
if (missing.ok || missing.error.code !== 'not-found') throw new Error('the declared failure is an outcome');
const tools = typedTools(contractTools(compiled, api), notes);
if (tools.map((t) => t.name).join(' ') !== 'note_get note_save') throw new Error('the tool names are the ids');
api.close();
```
```json
{
  "$contract": "0.1",
  "id": "notes",
  "version": "1",
  "$defs": {
    "Note": {
      "type": "object",
      "properties": { "id": { "type": "string" }, "text": { "type": "string", "minLength": 1 } },
      "required": ["id", "text"]
    }
  },
  "operations": {
    "note.get": {
      "kind": "read",
      "input": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"]
      },
      "output": { "$ref": "#/$defs/Note" },
      "errors": { "not-found": { "status": 404 } },
      "http": { "method": "GET", "path": "/notes/{id}" }
    },
    "note.save": {
      "kind": "command",
      "input": {
        "type": "object",
        "properties": { "note": { "$ref": "#/$defs/Note" } },
        "required": ["note"]
      },
      "output": { "$ref": "#/$defs/Note" },
      "policy": { "idempotency": "required" },
      "http": { "method": "POST", "path": "/notes" }
    }
  }
}
```

The `ctx.fail('not-found')` in the handler is the only spelling that
compiles for a code this operation declares, and `missing.error.code`
is that code — a declared failure is data, never an exception, on either
side of the wire. The tool names are the operation ids with `.` → `_`,
which is `ToolName<>` in §5 and `contractTools`' own rule at run time.

## 4. Refusals

The contract pen raises these three `LinqBuildError` codes and no others
— `test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/contract/` names. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, a member of its own surface it does not know, a value outside a declared set, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry: a reserved path-template form, a member mapped to a `path` the template does not declare, or a hand-written operation `kind` outside the three |
| `JL0103` | a `$defs` name collision, a reference no definition answers, or a `lazy()` that does not return a named builder |

Every message below is the one the pen raised when the spelling beside it
was run, with the code prefix (`JL0101: `) removed. `docPath`, where the
refusal carries one, is the JSON pointer of the node being assembled and
is appended to the message text as well (`… at /operations/a/policy/task`).

**Where the three codes come from is not one directory.** `JL0101` and
`JL0102` are thrown by `packages/linq/src/contract/` — 59 sites across
`define.js`, `operation.js` and `http.js`, 40 of the first and 19 of the
second. The three tables below carry 73 rows over them, which is not a
contradiction: one site serves many spellings (`closedTo` is a single
throw reached from six functions, and one branch of `policyMember`
covers four policy members), so a row is a CONDITION a caller can hit
and a site is a line in the source. `JL0103` is thrown by the SHARED
hoisting walk (`packages/linq/src/schema/emit.js`), reached from
`defineContract` and named in `define.js`'s own `@throws`, which is why
the refusal gate finds it in this pen's directory and why its `docPath`
is rooted in the contract (`/operations/a/output/properties/p`) rather
than in a schema. `JL0104` — the schema pen's owned-keyword and external
rules — is NOT in the table, and the reason is worth a reader's time: it
fires when the schema builder's method is called, before the contract is
written, so a caller who sees it is looking at a schema-pen line.

### 4.1 `JL0101` — the value, the member and the set

Raised at the door of whichever function received it.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `defineContract(42, { … })` | `defineContract() takes ({ id?, version?, compat? }, operations), got 42 as its first argument` | `defineContract({}, { … })` |
| `defineContract({ name: 'x' }, …)` | `defineContract() does not take 'name' — the head is id, version, compat; everything else is an operation` | move it into `operations` |
| `defineContract({ id: '9shop' }, …)` | `defineContract() id matches [A-Za-z_][A-Za-z0-9_-]*, got a string` | `{ id: 'shop9' }` |
| `defineContract({ version: 5 }, …)` | `defineContract() version is a string, got 5` | `{ version: '5' }` |
| `defineContract({ compat: '4' }, …)` | `defineContract() compat is an array of peer version strings` | `{ compat: ['4'] }` |
| `defineContract({}, [])` | `defineContract() operations is a plain object of id → operation, got a Array instance` | a plain object |
| `defineContract({}, {})` | `defineContract() needs at least one operation` | declare one |
| `defineContract({}, { __proto__: read({ … }) })` | `defineContract() operations received a map whose prototype was replaced: a '__proto__:' key in an object literal sets the prototype instead of adding a member, so that member is not there to emit — spell it { ['__proto__']: … }, which is an own key` | `{ ['__proto__']: read({ … }) }` |
| `defineContract({}, { a: 42 })` | `an operation is read(), command() or subscribe() — got 42` | `read({ output: true })` |
| `read(42)` | `read() takes { input?, output, errors?, policy?, http?, doc? }, got 42` | a plain object |
| `read({ output: true, extra: 1 })` | `read() does not take 'extra' — it takes input, output, errors, policy, http, doc` | drop it, or put it in `policy` |
| `read({})` | `read() needs an output — every operation declares one (true for "any value")` | `read({ output: true })` |
| `read({ output: true, doc: 42 })` | `read() doc is a string, got 42` | `doc: '…'` |
| `read({ output: { type: 'string', default: () => 1 } })` | `the schema at /operations/a/output received a Object instance, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | a JSON value for the default |
| `read({ output: 42 })` | `a schema is an object, true or false — got 42` | a builder, an object, or `true` |
| `errors: 42` | `errors is a plain object of code → error(), got 42` | a plain object |
| `errors: { Bad: error({}) }` | `an error code matches ^[a-z][a-z0-9-]*$, got 'Bad'` | `{ bad: error({}) }` |
| `errors: { bad: 42 }` | `errors.bad is error({ status?, schema? }), got 42` | `error({ status: 400 })` |
| `error({ code: 'x' })` | `error() does not take 'code' — it takes status, schema` | the code is the map's key |
| `error({ status: 99 })` | `error() status is an integer in 100–599, got 99` | `error({ status: 409 })` |
| `policy: 42` | `policy is a plain object of the members CONTRACT-FORMAT §3.1 declares, got 42` | a plain object |
| `policy: { mode: 1 }` | `policy does not take 'mode' — it takes task, idempotency, revision, cache, limits, errors, retry, stream, audience` | the member §3.1 names |
| `policy: { task: 'queue' }` | `policy.task is one of switch, exhaust, concat, parallel, got a string` | `task: 'exhaust'` |
| `policy: { idempotency: 'maybe' }` | `policy.idempotency is one of none, optional, required, got a string` | `idempotency: 'optional'` |
| `policy: { cache: 'always' }` | `policy.cache is one of none, revision, got a string` | `cache: 'revision'` |
| `policy: { audience: 'admin' }` | `policy.audience is one of public, server, got a string` | `audience: 'server'` |
| `policy: { revision: '/x' }` | `policy.revision is "input:<json-pointer>" — where in the input the revision a command asserts lives, got a string` | `revision: 'input:/x'` |
| `policy: { limits: 1 }` | `policy.limits is { maxBodyBytes }` | `limits: { maxBodyBytes: 4096 }` |
| `policy: { limits: { max: 1 } }` | `policy.limits does not take 'max' — it takes maxBodyBytes` | `maxBodyBytes` |
| `policy: { limits: { maxBodyBytes: 0 } }` | `policy.limits.maxBodyBytes is a positive integer, got 0` | a positive integer |
| `policy: { errors: 1 }` | `policy.errors is { details }` | `errors: { details: 'paths' }` |
| `policy: { errors: { detail: 1 } }` | `policy.errors does not take 'detail' — it takes details` | `details` |
| `policy: { errors: { details: 'some' } }` | `policy.errors.details is one of none, paths, full, got a string` | `details: 'full'` |
| `policy: { retry: 1 }` | `policy.retry is { max, on }` | `retry: { max: 2, on: [] }` |
| `policy: { retry: { max: 1, ms: 1 } }` | `policy.retry does not take 'ms' — it takes max, on` | the backoff is the client's |
| `policy: { retry: { max: -1, on: [] } }` | `policy.retry.max is an integer ≥ 0, got -1` | `max: 0` or more |
| `policy: { retry: { max: 1, on: 1 } }` | `policy.retry.on is an array of error codes (declared codes, or JC2xxx taxonomy codes)` | `on: ['JC2002']` |
| `policy: { stream: 1 }` | `policy.stream is { resume?, heartbeatMs?, maxPatchBytes? }` | a plain object |
| `policy: { stream: { keepAlive: 1 } }` | `policy.stream does not take 'keepAlive' — it takes resume, heartbeatMs, maxPatchBytes` | `heartbeatMs` |
| `policy: { stream: { resume: 'always' } }` | `policy.stream.resume is snapshot or replay, got a string` | `resume: 'replay'` |
| `policy: { stream: { heartbeatMs: 500 } }` | `policy.stream.heartbeatMs is an integer ≥ 1000, got 500` | `heartbeatMs: 2000` |
| `policy: { stream: { maxPatchBytes: 0 } }` | `policy.stream.maxPatchBytes is a positive integer, got 0` | a positive integer |
| `http(42)` | `http() takes { method, path, in?, body?, status?, media? }, got 42` | a plain object |
| `http({ method: 'GET', path: '/a', headers: {} })` | `http() does not take 'headers' — the binding is method, path, in, body, status, media (CONTRACT-FORMAT §4)` | `in: { … }` for a header-located member |
| `http({ method: 'get', path: '/a' })` | `http() method is one uppercase token of GET HEAD POST PUT PATCH DELETE OPTIONS, got a string` | `method: 'GET'` |
| `http({ …, in: 42 })` | `http() in is a plain object of input member → path \| query \| header \| body` | a plain object |
| `http({ …, in: { x: 'cookie' } })` | `http() in.x is one of path, query, header, body, got a string` | `{ x: 'header' }` |
| `http({ …, body: 42 })` | `http() body names the input member whose value IS the request body, got 42` | `body: 'doc'` |
| `http({ …, status: 404 })` | `http() status is an integer in 200–299, got 404` | `status: 204` |
| `http({ …, media: 42 })` | `http() media is a media type, got 42` | `media: 'image/png'` |

Two rows to read carefully. `{ __proto__: … }` is the binder's §1.1 rule
5 at this pen's one map door: the literal form sets the object's
prototype instead of adding a member, so the operation never reaches the
pen at all and the prototype is the only trace left to refuse by. And
`http() in received a Object instance, which is not JSON` — the message
for `in: { x: NaN }` — is the JSON boundary, shared by every pen, and it
is the one refusal in this table that carries no `docPath`: its `what`
names the position instead.

### 4.2 `JL0102` — the reserved path template, and the kind

Raised by `http()` scanning the template, which mirrors the compiler's
own parser: every form §4.2 reserves is refused by name at build time,
before `compileContract` would answer `JC0008` with the same meaning.
Every message carries `docPath: '/path'`.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `path: 42` | `http() path is a path template string, got 42` | a string |
| `path: 'a/b'` | `a path template must start with "/"` | `'/a/b'` |
| `path: '/a/'` | `a trailing "/" declares an empty segment; the root template "/" is the only empty path` | `'/a'` |
| `path: '/a//b'` | `an empty segment ("//")` | `'/a/b'` |
| `path: '/a/{id}.json'` | `a variable must be a whole segment ("{name}"), found "{id}.json" — the format reserves a variable that is only part of a segment` | `'/a/{id}'`, with the suffix in `media` |
| `path: '/a/{id'` | `a variable must be a whole segment ("{name}"), found "{id" — the format reserves a variable that is only part of a segment` | close the brace |
| `path: '/a/x:y'` | `":" is reserved for a variable segment (":name"), found "x:y"` | `'/a/x/y'` |
| `path: '/a/*'` | `"*" is a reserved wildcard form; $contract 0.1 has no wildcards, found "*"` | name the segments |
| `path: '/a?b'` | `"?" cannot appear in a path template (the query and fragment are not part of the path)` | `in: { b: 'query' }` |
| `path: '/a b'` | `whitespace or a control character in segment "a b"` | `'/a%20b'` |
| `path: '/a%zz'` | `a malformed percent-escape in segment "a%zz"` | a well-formed escape |
| `path: '/a/{+id}'` | `"{+id}" uses the reserved RFC 6570 operator "+"; $contract 0.1 supports only "{name}"` | `'/a/{id}'` |
| `path: '/a/{id*}'` | `"{id*}" uses the reserved "*" expansion modifier; $contract 0.1 has no wildcards` | `'/a/{id}'` |
| `path: '/a/{a,b}'`, `path: '/a/{id:3}'` | `"{a,b}" uses a reserved RFC 6570 list or prefix form; $contract 0.1 supports only "{name}"` | one variable per segment |
| `path: '/a/:'` | `":name" must be a whole segment with an identifier name, found ":"` | `'/a/:id'` |
| `path: '/a/:id?'` | `":id?" uses a reserved "?" modifier; $contract 0.1 has no wildcards or optional segments` | two operations, or `{id}` |
| `path: '/a/{1x}'` | `a variable name must match [A-Za-z_][A-Za-z0-9_]*, found "1x"` | `'/a/{x1}'` |
| `path: '/a/{id}/b/{id}'` | `the variable "id" is declared twice` | two names |
| `http({ method: 'GET', path: '/a', in: { id: 'path' } })` | `http() maps 'id' to path, but the template declares no {id} — a path member is named by the template itself` | `path: '/a/{id}'`, and drop the `in` entry |
| `defineContract({}, { a: { kind: 'stream', output: true } })` | `an operation kind is one of read, command, subscribe — got a string` | `subscribe({ output: true })` |

The last row is the only `JL0102` that is not a template: a HAND-WRITTEN
operation carries its own `kind`, and a kind outside the three is a
construct the format cannot carry. `read()`, `command()` and
`subscribe()` cannot trip it — they write the kind themselves.

The eight reserved forms are refused by the pen and by the compiler with
the same meaning and the same names; `test/linq/contract-pen.test.js`
runs `/a/{id}.json` through both and asserts `JL0102` from the pen and
`JC0008` from `compileContract`. Which one a caller sees depends only on
where the template was written — through `http()`, or into a JSON
document by hand.

### 4.3 `JL0103` — the definition

Raised when the `$defs` block is closed and every name a `ref()` demanded
must be answered, or when a `lazy()` thunk is resolved. The walk is the
schema pen's, run over every operation's schemas at once, so a collision
between two operations is found here and nowhere earlier.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| two operations, each `output: s.named('P', …)` over a DIFFERENT builder | `two distinct builders are named 'P' in one document — a $defs entry can hold one definition; rename one of them` | one shared `const P = s.named('P', …)` |
| `output: s.object({ p: s.ref('Nope') })` | `ref('Nope') names no definition in this document — a name is defined by named('Nope', …) somewhere the root can reach` | define it in a schema this contract reaches |
| `output: s.object({ n: s.lazy(() => s.string()) })` | `lazy() must return a NAMED builder — a recursion is spelled as a $ref, and a $ref needs a definition to point at: lazy(() => Node) where Node = named('Node', …)` | `s.lazy(() => Node)` |

"Distinct" is by identity, not by shape: the same builder under one name,
reached from any operation, is one definition. Two builders that emit the
same JSON are still two and still a collision. The `docPath` names the
operation the second reference came from, which is what tells a caller
which two to reconcile.

A `ref()` may reach across operations: a definition named in one
operation's `input` answers a `ref()` in another's `output`, because the
`$defs` block is the contract's. What it cannot do is reach a name
nothing defines — that is this row, and it is why a contract assembled
from schemas written in several files still has one namespace.

### 4.4 Two closed vocabularies, and which one a caller meets

There are two closed member sets over the same document, and a reader who
does not know that will look up the wrong code.

- **The pen's surface** is what `read()`, `command()`, `subscribe()`,
  `error()`, `http()` and `defineContract()` take. A member outside it is
  `JL0101`, at the call, naming the members that function does take.
- **The document's own vocabulary** is CONTRACT-FORMAT's, and it is
  `compileContract`'s to enforce: `JC0013`, at compile time, naming the
  closed set. It is what a hand-written JSON contract meets, and what a
  pen contract meets for anything the pen does not check.

The two are deliberately not one. The pen cannot own the document's
vocabulary — it writes only the members it was given, so a member the
format adds tomorrow must not be a member the pen refuses today — and the
compiler cannot own the pen's, because `read({ output: true, extra: 1 })`
never becomes a document at all.

```js
read({ output: true, extra: 1 })
// JL0101: read() does not take 'extra' — it takes input, output, errors, policy, http, doc

compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true, extra: 1 } } })
// JC0013: unknown operation member 'extra' — the operation vocabulary is closed
//         (kind, input, output, errors, policy, http, doc) at /operations/a/extra
```

**The pen's surface has two doors, and both run the same check.** An
operation written by hand inside `defineContract` —
`{ kind: 'read', output: true, extra: 1 }` — meets the pen's `JL0101`,
not the compiler's `JC0013`, because the member never becomes a document
member. The only difference from the declaration door is the `docPath`,
which names the operation's own position because there is one:

```js
defineContract({}, { 'note.get': { kind: 'read', output: true, extra: 1 } })
// JL0101: read() does not take 'extra' — it takes input, output, errors,
//         policy, http, doc at /operations/note.get/extra
```

That symmetry is load-bearing rather than tidy. A pen emits only the
members it was given, so an unchecked door does not pass an unknown
member through to the compiler — it DROPS it, silently, where neither
refusal can reach it; and a member the pen does write without checking
(a non-string `doc`) reaches the document, which then fails the
published grammar. Both halves are pinned by
`test/linq/contract-pen.test.js`, which runs the same three spellings
through both doors and asserts the reason and the `docPath` of each.

## 5. The types

The pen is the only inference route (the binder's §1.1 rule 2): a
`Contract<Ops>` carries a phantom that `ContractOf<>` reads, and every
consumer below narrows off that one reading. Nothing here exists at run
time. The `shop` contract below is a catalog like §3.2's with declared
failures like §3.3's on it — the two features a consumer's types show off
at once.

```ts
import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { contractTools } from '@jarenjs/contract/project';
import { typedClient, typedHandlers, typedTools } from '@jarenjs/linq/contract';
import type { Contract, ContractOf, InvokableOf, Outcome } from '@jarenjs/linq/contract';

type Ops = ContractOf<typeof shop>;
//   { 'product.save': { kind: 'command'; input: …; accepts: …; output: …;
//                       errors: 'conflict' | 'not-found'; opaque: false }, … }

const compiled = compileContract(shop.document);
const handlers = typedHandlers(shop, {
  'catalog.load': () => catalog,                       // must answer the declared output
  'product.save': (input, ctx) => saved ? input.product : ctx.fail('conflict'),
});
const served = openLocalClient(compiled, handlers);    // the binding: any contract client
const api = typedClient(served, shop);                 // the same object, narrowed by the phantom
const outcome: Outcome<Product> = await api.invoke('product.save', { id: 1, revision: 4, product });
api.url('image.bytes', { id: 3 });                     // an opaque operation: a URL builder here
api.invoke('image.bytes', { id: 3 });                  // does not compile — it carries bytes
const web = typedHttpClient(openHttpClient(compiled, { baseUrl }), shop);
const image = await web.bytes('image.bytes', { id: 3 });  // Outcome<ByteResponse>: { status, headers, media, body: ReadableStream }
web.bytes('product.save', { id: 1, revision: 4, product });  // does not compile — a JSON operation is invoked, not streamed
for (const tool of typedTools(contractTools(compiled, api), shop)) toolbox.add(tool);

declare const anyContract: Contract<any>;              // the class: an annotation, never a `new`
type Invokable = keyof InvokableOf<typeof shop>;       // 'catalog.load' | 'product.save'
```

`contractTools` takes either client — the binding (`served`) or the
typed view of it (`api`). That is not free: its `ToolClient` declares
`invoke` as a METHOD rather than as a function-valued property, and a
method's parameters are bivariant, so a client that narrows `invoke`'s
operation type to a literal union — which is exactly what `typedClient`
exists to do — still satisfies it. Written as a property it would not,
and the pen's whole claim, one document and three consumers, would fail
at the third. `test/consumer/linq-contract.ts` pins both spellings and
asserts they answer the same type.

### 5.1 What `ContractOf<>` reads, member by member

One entry per declared operation, each an `OperationType`:

| Member | Read from | Value |
|---|---|---|
| `kind` | the declaration | `'read'`, `'command'` or `'subscribe'`, as a literal |
| `input` | `Infer<>` of the input schema | the OUTPUT shape — post-normalization, defaults present — or `null` when none is declared |
| `accepts` | `Input<>` of the input schema | the ACCEPTED shape: a defaulted member optional, a coerced member in its transport form |
| `output` | `Infer<>` of the output schema | `unknown` for a hand-written JSON Schema or a boolean |
| `errors` | the keys of `errors` | a literal union, `never` when none is declared |
| `opaque` | the binding's `media` | `true` unless the media is `application/json` or a `+json` suffix; always `false` for a `subscribe` |

`opaque` is what splits the three consumers' views. `ContractOf<>` is
every operation; `InvokableOf<>` drops the opaque ones, exactly as
§12.3's `Operations` does, and it is what types `invoke`, the handler
table and the tool set; `SubscribableOf<>` keeps the `subscribe` ones and
types `client.subscribe`. `url()` is the one member declared over
`ContractOf<>` itself, which is how an opaque operation stays reachable.

The media is read by PATTERN, never by indexing: `S extends { http:
HttpBinding<infer H> }` and then `H extends { media: infer M }`. An
absent optional member of a constraint is not the same as one the author
declared, and indexing `H['media']` would make the two indistinguishable
— so a binding with no `media` falls through to `'application/json'` by
the pattern failing rather than by a lookup returning `undefined`.

### 5.2 The class, and the two members it carries

`Contract` is the one exported class, and a caller never constructs one:
its constructor is private in the declaration and `defineContract()` is
the only route. A caller meets it as an annotation — `Contract<any>` for
a function that takes any pen contract — and reaches its two members,
`document` and `toJSON()`, both of which answer the same deep-frozen
JSON. The phantom `__ops` is declared and never present at run time; it
exists so `ContractOf<>` has something to infer from.

### 5.3 What the pins hold

Two files, both compiled by `npm run test:types`:

| File | What it proves |
|---|---|
| `test/consumer/linq-contract-generated.ts` | `toTypeScript`'s own declarations for the three documents `test/linq/contract-corpus.js` emits, produced by `scripts/generate-contract-pen-fixture.js`. `test/linq/contract-pen.test.js` asserts the committed file is exactly what the generator produces today, so it cannot drift |
| `test/consumer/linq-contract.ts` | for all three corpus contracts and a fourth built in the file, `ContractOf<>`'s `input`, `output` and error codes EQUAL (not merely assignable) to what the projection declares; `Meta`, `WireError`, `Outcome<T>`, `InvokeContext`, `Failure` and `HandlerContext` equal to the projection's rendering of §10.1's fixed D6 shapes; a local round trip; and six negatives |

The six negatives are the list of what the types forbid, each of which
FAILS the build the day it starts compiling:

```ts
void api.invoke('product.saev', input);          // a misspelled operation id
void api.invoke('product.save', { id: 1, rev: 4, product });   // 'revision' is the member
void api.invoke('image.bytes', { id: 3 });       // opaque: reach it through url()
const short = typedHandlers(Shop, { 'catalog.load': () => catalog });  // a missing handler
const notATool: 'image_bytes' = tools[0]!.name;  // the opaque operation is not a tool
void liveApi.subscribe('board.set', input, {});  // 'board.set' is a command
```

### 5.4 Three readings a caller will otherwise meet at run time

- **A date-formatted string is the `DateTime` brand on both sides.** It
  is the suite's one reading of `format: "date-time"`, shared by
  `@jarenjs/db`'s generated entity types, the schema pen and
  `toTypeScript` — so a contract whose input carries a date types the
  same through the pen and through `jaren-contract types`. The branding
  MOVED the published projection: a consumer comparing a generated file
  from before it will see a diff on every date member, and that diff is
  not a regression. `test/consumer/linq-contract.ts` pins the equality
  from both directions.
- **A hand-written JSON Schema is `unknown` on both sides.** `output:
  { type: 'string' }` reads `unknown`, not `string`, and so does the
  projection's rendering of the same document. That is the binder's rule
  2 — a literal is never inferred — and the honest answer, since nothing
  proved the literal is a schema at all. `s.from<T>(json)` is the
  caller's assertion when they want one.
- **Pattern-match an absent optional member; never index it.** A handler
  writing against `ContractOf<C>[K]` reaches `input` and `output` through
  `extends { input: infer I } ? I : never`, not through `['input']`. The
  declaration does the same everywhere, and the reason is §5.1's: an
  operation that declares no input has `input: null`, and an index would
  make "declared as null" and "never declared" the same type.

## 6. What it cannot spell

The contract pen's limits are narrow, because a `$contract` document is
mostly a map of schemas and the schema pen carries those limits
([SCHEMA-PEN.md](SCHEMA-PEN.md#6-what-it-cannot-spell) §6 is the list
that matters most to a contract author). What is left is three groups,
and then §6.1 — the cases where the answer is not to reach for this pen
at all.

- **The reserved path-template forms.** RFC 6570's operators and
  modifiers, the `*` wildcard, the optional `:name?` segment, and a
  variable that is only part of a segment. `$contract` 0.1 has level-1
  templates and nothing else, because a template is also a MATCHER
  (§5) and a router that has to expand `{+path}` cannot answer
  `match(method, path)` in one pass. §4.2 lists every form with the
  spelling that works; the general answer is one variable per whole
  segment, and a query member for everything else.
- **Anything the format decides across members.** A `read`'s
  idempotency, a `GET`'s body member, an opaque operation's body member,
  a `subscribe`'s method, a route-shape collision, a path variable that
  is not an input member. None of these is unspellable — the pen writes
  every one of them — and each is `compileContract`'s to refuse, by
  §2.8's table. They are in this section because a reader looking for
  "why can't I do X" will look here, and the answer is that they CAN
  write it and it will not compile.
- **The wire, and the bindings.** `jaren-contract-port` frames (§16.1)
  are the one `@jarenjs/contract` document shape with no pen and there
  will not be one: they are exchanged on a wire, not authored, so a
  builder for them would type nothing a caller writes. The binder's
  decision table ([LINQ-FORMAT.md](LINQ-FORMAT.md) §1.0) carries the
  rule and the whole list of formats it excludes; message catalogs are on
  the other side of that table, an authored format whose pen is not
  written yet.

One absence is worth naming because it is not a limit at all. There is no
`describe()`, no `publicProjection()` and no `toTypeScript()` here: those
are the compiler's, they need the materialized defaults the pen refuses
to write, and reaching them means one import of `@jarenjs/contract` over
`contract.document`. §7 is what that separation buys.

### 6.1 When not to reach for this pen

- **The contract is data.** A `$contract` read from a file, fetched from
  a running service's `describe()`, or produced by another tool is a
  value; `compileContract` takes it directly.
- **You are consuming a contract you do not own.** The three wrappers of
  §2.7 type a client, a handler map or a tool set against a contract
  DOCUMENT — they do not need this pen to have written it. Import the
  document the service publishes and wrap that; authoring a second copy
  of somebody else's contract is how the two drift.
- **The service is not one.** A contract is a published surface with a
  version and a compatibility list, and its whole value is that two
  parties can compare two revisions. One function called over a local
  import is not a service, and giving it a contract buys nothing but a
  build step.
- **The API is not request/response.** Three operation kinds is the whole
  vocabulary — a read, a command and a subscription. A protocol that
  negotiates, that is bidirectional beyond a subscription, or that is
  really a stream of bytes has no spelling here, and §6's third bullet
  says why the wire's own frames deliberately have no pen.
- **You want what the compiler produces, not what the pen writes.**
  Defaults materialized, a public projection, an OpenAPI file, a
  TypeScript declaration — all of those are `@jarenjs/contract`'s over
  `contract.document`, and none of them needs this subpath at run time.

## 7. Cost

`@jarenjs/linq/contract` builds to **<!--fact:bundle.contract-->45,298<!--/fact--> bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
(<!--fact:bundle.contract.kb-->45<!--/fact--> kB) beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md).

The probe is a gate, not a report: building a one-operation contract as a
consumer would, it asserts four things and fails the build on any of
them:

- **the schema pen is included, and that is the ceiling.** A contract's
  inputs and outputs are schemas, so the two are measured together and
  the bundle carries <!--fact:bundle.schema-->33,156<!--/fact--> of its <!--fact:bundle.contract-->45,298<!--/fact--> bytes as the schema pen's own.
  The contract pen's own share is the remaining ~12 kB, most of it the
  refusal messages §4 lists;
- **no chain module** — none of `sequence.js`, `document.js`, `async.js`,
  `concurrency.js`, `provider.js` or `sources.js` contributes a byte, and
  the chain's own bundle carries no contract module either;
- **no `@jarenjs/contract` byte** — not one, which is the tree-shaken
  proof of §1's claim that the compiler is the only judge of what the
  document means. Nor `@jarenjs/validate`, `@jarenjs/emit`,
  `@jarenjs/db`, `@jarenjs/formats`, `@jarenjs/refs` or `@jarenjs/json`;
- **no other pen** — the schema pen is the only one, and the schema pen
  in turn carries no contract module.

A consumer who writes a contract and also compiles it pays both prices
and they add rather than overlap. That is the shape the separation is
for: a browser bundle that only needs the TYPES a contract implies —
`typedClient` over an HTTP binding, say — ships the pen's <!--fact:bundle.contract.kb-->45<!--/fact--> kB and none
of the compiler, while the server that serves the contract imports
`@jarenjs/contract` and does not need the pen at all.
