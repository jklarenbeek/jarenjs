# The jaren-contract format — normative

The contract between this document and the code: `compileContract` in
`@jarenjs/contract` implements exactly what is written here, and a test
holds the two together (every ```json block below is a complete document
that must validate against the published grammar and compile; the error
table in §6 must equal the package's `CONTRACT_CODES`). Section numbers
are stable — later sections are appended, never renumbered.

## §1 Purpose

A **contract** is a Jaren document — the sibling of `$model`, `$fsm` and
`jaren-app` — that declares the *operations* two Jaren ends may exchange:
JSON in, JSON out, each with a kind, an input schema, an output schema,
declared errors, a behavior policy and an HTTP binding. It is compiled
**once** into per-operation validators, transport normalizers and one
path matcher, and it is the single source every artifact around it is
projected from.

A contract document is written by hand, or by code: `@jarenjs/linq/
contract` is the pen that writes exactly this format — the same
operations, schemas, policies and bindings, in §12.1's member order,
with the operations' named schemas hoisted into `$defs` — and it types
the client, the handler table and the AI tools from the same builders,
without running the TypeScript projection of §12.3. The three worked
examples below are rebuilt through it, byte for byte, by its own test
suite.

Format 0.1 covers the document, its compilation, the HTTP binding's
*shape* (§2–§6), the HTTP **server** binding that carries it (§7–§9:
the request pipeline and its wire errors, idempotency and the ledger
interface, the `fetch` and `node` adapters), the HTTP **client** binding
(§10: outcomes, the client half of idempotency, retry, negotiation), the
`@jarenjs/app` binding (§11: the generated documents and the one
effect) and the **projections** (§12: the public projection every other
artifact is built on, OpenAPI 3.1, TypeScript, Markdown, the AI tool
definitions, and the `jaren-contract` CLI). The in-process, message-port
and stream bindings, the revision hash and the locale catalogs are the
coming lines of this package and will append their sections here.

### §1.1 What the format is not

- Not a second schema language: `input`, `output` and error schemas are
  ordinary JSON Schema, compiled by `@jarenjs/validate`.
- Not a router DSL: the path template dialect is RFC 6570 level 1 (`{name}`),
  what OpenAPI uses; `:name` is accepted and canonicalized.
- Not a place to describe bytes: a non-JSON `media` marks an operation
  **opaque** — routed and matched, its path/query still decoded, its body
  neither decoded nor validated by the contract.

## §2 The document

```json
{
  "$contract": "0.1",
  "id": "shop",
  "version": "5",
  "compat": ["4"],
  "$defs": {
    "Catalog": {
      "type": "object",
      "properties": {
        "revision": { "type": "integer" },
        "products": { "type": "array", "items": { "$ref": "#/$defs/Product" } }
      },
      "required": ["revision", "products"]
    },
    "Product": {
      "type": "object",
      "properties": {
        "id": { "type": "integer" },
        "name": { "type": "string", "minLength": 1 },
        "price": { "type": "number", "minimum": 0 }
      },
      "required": ["id", "name", "price"]
    },
    "Conflict": { "type": "object", "properties": { "current": { "$ref": "#/$defs/Product" } } }
  },
  "operations": {
    "catalog.load": {
      "kind": "read",
      "input": { "type": "object", "properties": { "since": { "type": "string", "format": "date-time" } } },
      "output": { "$ref": "#/$defs/Catalog" },
      "errors": { "stale": { "status": 409 } },
      "policy": { "task": "switch", "cache": "revision" },
      "http": { "method": "GET", "path": "/api/catalog" },
      "doc": "The whole catalog snapshot."
    },
    "product.save": {
      "kind": "command",
      "input": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "revision": { "type": "integer" },
          "product": { "$ref": "#/$defs/Product" }
        },
        "required": ["id", "revision", "product"]
      },
      "output": { "$ref": "#/$defs/Product" },
      "errors": {
        "conflict": { "status": 409, "schema": { "$ref": "#/$defs/Conflict" } },
        "not-found": { "status": 404 }
      },
      "policy": { "task": "exhaust", "idempotency": "required", "revision": "input:/revision" },
      "http": {
        "method": "PUT",
        "path": "/api/products/{id}/master",
        "in": { "revision": "body", "product": "body" }
      }
    },
    "image.bytes": {
      "kind": "read",
      "input": { "type": "object", "properties": { "id": { "type": "integer" } }, "required": ["id"] },
      "output": true,
      "http": { "method": "GET", "path": "/api/images/{id}", "media": "application/octet-stream" }
    }
  }
}
```

### §2.1 Members

| member | required | meaning |
|---|---|---|
| `$contract` | yes | MUST be `"0.1"`. |
| `id` | no | An identifier for the contract (`[A-Za-z_][A-Za-z0-9_-]*`): a tool prefix, a file name. |
| `version` | no | The consumer's version string — a compatibility claim, unrelated to any content hash. |
| `compat` | no | Peer `version` strings this contract accepts. |
| `$defs` | no | Named schemas the operations reference as `#/$defs/<name>`. Every value MUST be a schema (an object or a boolean). |
| `operations` | yes | Operation id → operation. MUST carry at least one. |

**Every object in this format has a closed vocabulary.** The root, an
operation, `policy` and its `limits`/`errors`/`retry`/`stream`, `http`,
and an error declaration accept exactly the members listed for them; an
unknown member is `JC0013` at that member. A silently ignored `policy` is a
behavior bug, so this format refuses rather than ignores.

The document MUST be JSON: a member that is a function, a symbol, a
bigint, a non-finite number, a class instance, or part of a cycle is
`JC0001` at that member; a member whose accessor throws is `JC0001` at
that member too. `undefined` members are absent. `compileContract` reads
the document once, through guarded access, into a plain snapshot; the
`Contract` keeps that snapshot (deep-frozen) as `doc`, and the caller's
object is neither frozen nor mutated.

### §2.2 Operation ids

An operation id MUST match `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$` —
dotted lowercase words (`catalog.load`, `product.save`). The same string
is a valid JSON member, a tool name, a file name and a URL path segment,
so it is stable across every projection. In a `docPath` an id is one
reference token: `/operations/product.save/http/path`.

### §2.3 `$ref`

A `$ref` inside `input`, `output`, an error schema or `$defs` resolves
**within the document** (`#`, `#/…` JSON Pointer, `#anchor`) or against
a schema passed as `compileContract(doc, { schemas })` by its `$id`
(with an optional pointer/anchor fragment). Anything unresolved is
`JC0007` at compile — never at request time. The compiler registers the
document with its validator under a synthetic id and compiles every
operation schema as a reference into it, so `#/$defs/Product` inside an
operation means the contract's own `$defs`, exactly as a reader expects.
That registration is **one per compile**: the document is added to the
(possibly host-injected, `compileContract(doc, { validator })`) validator
under `urn:jaren:contract:<n>`, `n` a process-wide counter, and is never
removed — a host sharing one validator across many compiles keeps them
all; a host that compiles many documents passes a validator per compile
or accepts the growth.

## §3 Operations, policy and the defaults

An operation is `{ kind, input?, output, errors?, policy?, http?, doc? }`.

| member | required | meaning |
|---|---|---|
| `kind` | yes | `"read"`, `"command"` or `"subscribe"`. A subscribe operation's `output` is its **snapshot** schema and its emissions travel the stream binding (§17–§19). |
| `input` | no | A JSON Schema whose **effective type is `object`** — `"type": "object"` on the schema itself or on the schema a `$ref` chain reaches (`JC0005`). Its top-level `properties` are the members the HTTP binding places (§4). Absent means the operation takes no input. |
| `output` | yes | Any JSON Schema, `true` included (`JC0006` when absent). |
| `errors` | no | `code → { status?, schema? }`. A code matches `^[a-z][a-z0-9-]*$`; `status` is an integer in 100–599 (default **400**); `schema` a JSON Schema for the error's details (`JC0011`). |
| `policy` | no | The declared behavior — the table below. |
| `http` | no | The REST binding (§4). Absent means the **canonical binding**. |
| `doc` | no | A string for projections. |

### §3.1 Policy

Every policy member has a default. **Defaults are materialized into the
compiled operation, never into the source document**; `describe()` shows
the resolved value and marks it inferred.

| member | values | default | meaning |
|---|---|---|---|
| `task` | `switch` \| `exhaust` \| `concat` \| `parallel` | `switch` for a read or a subscribe, `exhaust` for a command | Which task mode a host effect runs the operation in: replace an in-flight attempt, let the first one finish, queue, or run concurrently. A **subscribe MUST be `switch`** (`JC0018`) — a subscription slot is replaced, never queued. |
| `idempotency` | `none` \| `optional` \| `required` | `none` | Whether a command carries an idempotency key. A **read MUST be `none`** (`JC0014`); a **subscribe MUST be `none`** (`JC0020`). |
| `revision` | `"input:<json-pointer>"` | absent (`null`) | Where in the input the revision a command asserts lives, as an RFC 6901 pointer after `input:` (`JC0014` on malformed). The operation MUST declare `input`, and the pointer's **first reference token** MUST name a member of `input.properties` (`JC0014` otherwise — "revision points at '/x' but input declares no member 'x'"); deeper tokens are not checked (a member's schema may be a `$ref` or open), and the empty pointer (`"input:"`) addresses the whole input. Distinct from the **contract revision** (`contract.revision()`, `describe().revision`, the client's `meta.revision` — the hash of the public projection, §14): `policy.revision` names the *resource* revision a command asserts, and no binding reads it at runtime — a `preconditions` resolver (§7.5) or the handler's own domain comparison is how a server enforces it. |
| `cache` | `none` \| `revision` | `none` | Whether a read's result may be cached by revision. |
| `limits.maxBodyBytes` | positive integer | `1048576` | The request-body ceiling a server binding enforces. |
| `errors.details` | `none` \| `paths` \| `full` | `paths` | How much of a validation failure crosses the wire: nothing, instance path + keyword, or the raw validator errors. |
| `retry` | `{ max: integer ≥ 0, on: [codes] }` | absent (`null`) | Which error codes a client may retry (declared codes, or `JC2xxx` taxonomy codes), and how often beyond the first attempt; a network failure is always retried under a declared `retry`. A **command MUST declare `idempotency: "required"` to carry `retry`** (`JC0014`) — a retried command without a key the server deduplicates on runs twice; a read is idempotent by nature. |
| `stream` | `{ resume?, heartbeatMs?, maxPatchBytes? }` | `{ resume: "snapshot", heartbeatMs: 15000 }` on a subscribe | The stream policy of a **subscribe** operation (`JC0014` on any other kind): `resume` is `snapshot` \| `replay` (§18's resumption rule), `heartbeatMs` an integer ≥ 1000 (the SSE heartbeat interval; a client treats `2 × heartbeatMs` of silence as `JC2094`), `maxPatchBytes` a positive integer — an emission whose serialized patch exceeds it is replaced by a fresh `snapshot` event (§18). |
| `audience` | `public` \| `server` | `public` | Who may see the operation. A `server` operation is served and handled like any other, but is **kept out of the public projection** (§12.1) and therefore out of every projection built on it — OpenAPI, TypeScript, Markdown, the AI tools — and out of the revision. |

The compiled `policy` is always
`{ task, idempotency, revision, cache, limits: { maxBodyBytes }, errors: { details }, retry, stream, audience }` —
`stream` the materialized `{ resume, heartbeatMs, maxPatchBytes }` on a
subscribe operation and `null` on every other kind.

### §3.2 `describe()`

`contract.describe()` is a pure-JSON summary with a stable member order:

```jsonc
{
  "$contract": "0.1", "id": "shop", "version": "5", "compat": ["4"],
  "revision": null,                       // reserved for the revision hash
  "operations": [{
    "id": "product.save", "kind": "command",
    "method": "PUT", "path": "/api/products/{id}/master",
    "status": 200, "media": "application/json", "opaque": false,
    "in": { "id": "path", "revision": "body", "product": "body" },
    "body": null,
    "task": "exhaust", "idempotency": "required", "cache": "none",
    "inferred": { "http": false, "status": true, "media": true, "in": [],
                  "task": false, "idempotency": false, "cache": true }
  }]
}
```

`inferred` tells declared from defaulted: `http` is true when the whole
binding is the canonical one; `in` lists the members whose location the
compiler chose; the booleans mark defaulted `status`, `media`, `task`,
`idempotency`, `cache`. Operations appear in document order. A subscribe
operation additionally shows its resolved `stream` policy (`{ resume,
heartbeatMs, maxPatchBytes }`) and its forced `media`
(`text/event-stream`).

## §4 The HTTP binding and member locations

`http` is `{ method, path, in?, body?, status?, media? }`.

| member | required | rule | code |
|---|---|---|---|
| `method` | yes | An **uppercase** token of `GET HEAD POST PUT PATCH DELETE OPTIONS`. | `JC0012` |
| `path` | yes | A path template (§4.2). | `JC0008` |
| `in` | no | Input member → `path` \| `query` \| `header` \| `body`. | `JC0009` |
| `body` | no | The name of the input member whose value **is** the request body — how a route whose body is a raw array or scalar is described. | `JC0009` |
| `status` | no | The success status, an integer in 200–299. Default `200`. | `JC0012` |
| `media` | no | The response media type. Default `application/json`. | `JC0012` |

### §4.1 One input schema; the binding says where members travel

The `input` schema is the contract; **location is metadata**. Every
top-level `input.properties` member gets exactly one location:

1. a member named by a path variable → `path` (mapping it elsewhere is `JC0009`);
2. the member named by `http.body` → `body` (no other member may be
   body-located then — map the rest to `query` or `header`, `JC0009`);
3. a member named in `http.in` → that location (`JC0009` when it names no
   input member, an unknown location, or `path` for a member the template
   does not declare);
4. otherwise the default: `query` for a `read`, `body` for a `command`.

Scalar path, query and header members arrive as strings and are decoded
by a normalizer compiled over those members with `coerceTypes`
(`@jarenjs/validate/normalize`). **JSON query members and body members are
never coerced**, including nested values.

A query member whose effective declared `type` is `object` or `array`
(or a type array including either) uses **one JSON value in one query
parameter**. The client applies `JSON.stringify`, then `URLSearchParams`;
the server percent-decodes and applies `JSON.parse` before validation.
This includes nullable and scalar/structured unions: their values always
use JSON encoding. Empty arrays, nulls, arrays of objects, numeric object
keys and strings inside those unions round-trip without guessing from
text. An absent member is omitted. Plain `string` members remain literal,
even when their text looks like JSON. `$ref` chains are resolved at
compilation; unconstrained schemas and unions expressed only with
`anyOf`/`oneOf` do not imply a codec — declare a top-level `type` to choose
one. Malformed JSON or multiple occurrences of a JSON member are `JC2012`;
a well-formed value of the wrong type is `JC2006`. Undeclared query keys
are ignored. Scalar query members remain last-wins.

The compiled operation carries
`input.transport = { normalize, members: { path, query, header, repeated }, queryJson, schemas, required }`
(`null` when nothing travels as a string), beside `input.effective`, the
resolved input object schema. `schemas` and `required` describe all
transport members for URL validation; `queryJson` lists the JSON members
excluded from scalar normalization. `repeated` identifies array-typed
query/header members; JSON query encoding takes precedence. Array headers
still collect repeated lines or comma-separated values (RFC 9110 §5.3)
before normalization; other headers require one line (§7.4). The server
validates the reassembled input; the client validates before splitting it.

**Wire migration:** array query members use `tag=["a","b"]` (URL-encoded),
replacing `tag=a&tag=b`. Update handwritten callers and deploy matching
client/server versions together; published contracts should change their
`version` so revision negotiation detects a mismatched deployment. The
OpenAPI projection declares these parameters with
`content: { "application/json": { schema: ... } }`, rather than an
exploded array schema.

An operation bound to `GET` or `HEAD` MUST NOT carry a body-located
member (`JC0016`) — including a `command` whose members default to the
body: map them to `query` explicitly.

Members outside `input.properties` (a `patternProperties` or
`additionalProperties` match) have no location; they belong to the body
object.

### §4.2 The path template

A template is a leading `/`, then non-empty segments separated by `/`.
The root template `/` has no segments and is the only empty path (a
trailing `/` anywhere else is an empty segment, `JC0008`). A **variable
is a whole segment**, `{name}` (RFC 6570 level 1) or `:name` — accepted
and **canonicalized to `{name}`**, which is what `describe()` and every
projection show — with `name` matching `[A-Za-z_][A-Za-z0-9_]*` and
declared once per template. A static segment is any run of characters
except `/ { } : * ? #`, whitespace and control characters; a `%` in it
MUST open a well-formed escape, and escaped bytes MUST decode as UTF-8
(`JC0008` at the path when they do not).

Reserved and refused by name (`JC0008` says which): the RFC 6570 operator
forms `{+name}` `{#name}` `{.name}` `{/name}` `{;name}` `{?name}` `{&name}`
`{=name}`, the modifiers `{name*}` `{name:3}` `{a,b}`, the `{name+}` tail,
the `*` wildcard, `:name?`/`:name*`/`:name+`, and a variable that is only
part of a segment (`{id}.json`).

Every path variable MUST be a member of `input.properties` (`JC0009`).

### §4.3 The canonical binding

When `http` is absent, the operation is bound to **`POST /<op-id>`**,
every input member in the body, status `200`, `application/json`. A
declared `http` is used as written — a declared path is never rewritten
to fit the canonical form.

### §4.4 Route shapes

The **shape** of a binding is its method plus its template with every
variable normalized to `{}`: `GET /api/products/{}`. Two operations MUST
NOT share a shape (`JC0010` at the second one, in document order); the
canonical binding takes part (`POST /<id>` may collide with a declared
`POST /<id>`). Static segments compare in decoded space, so `/a` and
`/%61` share a shape, as do differently cased percent-escapes. An escaped
slash stays inside its segment, and escaped braces stay static text:
`/a%2Fb` differs from `/a/b`, and `/%7B%7D` differs from `/{id}`.

### §4.5 Opaque operations

A `media` other than `application/json` (or a `+json` structured-syntax
suffix, parameters ignored) marks the operation **opaque**: it is routed
and matched, its path/query still decoded, its body neither decoded nor
validated by the contract, and it is excluded from `invoke` and from the
generated `Operations` map — an HTTP client reaches it through `bytes`
(§10.6), whose success owns the live response stream, and through `url`.
Its bytes are **streamed** in both directions: the handler pulls the
upload one chunk at a time and may answer a pull source of its own
(§7.1). `image.bytes` in §2 is one. Because its body is
bytes the contract never decodes, an opaque operation MUST NOT declare a
**body-located member** — neither through `http.body`, nor `http.in`,
nor the `command` default (`JC0017` at the member that placed it there,
or at `http.media` when the default did): map the member to `query` or
`header`, or make the operation JSON. Its transport members are
therefore always its whole input, and are validated like any other
input (§7.1).

## §5 The path matcher

`contract.match(method, path)` resolves a request line to
`{ op, params } | null`, where `params` holds the path variables by name
as **decoded strings** (the transport normalizer of §4.1 turns them into
their declared types). It receives the path only; the binding splits the
query off first. Rules:

- One static-segment tree per method; a walk tries **statics first, then
  the variable child, and backtracks** on a dead end. Therefore a static
  segment beats a variable **regardless of registration order**:
  `GET /api/production-runs/prefill` resolves to its own operation whether
  it was declared before or after `GET /api/production-runs/{id}`.
- Matching is **exact on the trailing slash**: `/a/` is a different shape
  from `/a`, and since no template has an empty segment it never matches.
  A variable never binds an empty segment.
- Each segment is **percent-decoded once**; statics are compared in decoded
  space; a decoded `/` (`a%2Fb` → `a/b`) never re-splits.
- A malformed escape makes `match` return `null` — it never throws across
  the binding boundary (a request is hostile input; a binding maps `null`
  to its not-found answer).
- The method is a case-sensitive token: `get` matches nothing.
- Variables bind through a prototype-safe setter, so a template variable
  or a request can never write `__proto__`.

`contract.allowed(path)` is the matcher's second question — the methods
under which this path shape reaches an operation, sorted (`[]` for none,
for a malformed escape, or for a non-path) — what a server answers in a
405's `Allow` (§7.2). It walks every method tree and is off the hot path.

The matcher is package-private (`compileRoutes` is not exported); it is
reached only through `contract.match` and `contract.allowed`. Its
measured cost on the reference 123-route table is published by the
benchmark suite when that lands.

## §6 Error codes

Compile errors are `ContractCompileError` — `{ code, reason, message,
docPath }` on the coded-error contract of `@jarenjs/core` — thrown by
`compileContract`. `docPath` is an RFC 6901 pointer into the document
(`''` is the root; only `~` and `/` are escaped, so a dotted id is one
token). This table is the normative list; `CONTRACT_CODES` in the package
carries the same codes and a test holds them equal.

| code | condition |
|---|---|
| JC0001 | the document is not a well-formed contract object: not an object, `$contract` is not `"0.1"`, `$defs` is not a map of schemas, a member is not a JSON value, or a member threw when read |
| JC0002 | `operations` is not an object with at least one member, or an operation declaration is not an object |
| JC0003 | an operation id does not match `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$` |
| JC0004 | `kind` is none of `read`, `command`, `subscribe` |
| JC0005 | `input` is not a schema whose effective type is `object` |
| JC0006 | `output` is absent or not a schema |
| JC0007 | a `$ref` resolves neither within the document nor against the registered schemas |
| JC0008 | `http.path` is not a valid path template (§4.2; the message names the reserved form) |
| JC0009 | a path variable, `http.in` key or `http.body` names no input member, or a member is mapped to a location it cannot travel in (§4.1) |
| JC0010 | two operations share method and canonical path shape (§4.4) |
| JC0011 | `errors` is malformed: not an object, a code is not `^[a-z][a-z0-9-]*$`, a status is not a 100–599 integer, or a schema is not a schema |
| JC0012 | `http.method` is not an uppercase token of the supported set, `http.status` is not a 200–299 integer, or `http.media` is not a media type |
| JC0013 | an unknown member in a closed object (the document root, an operation, `policy`, `limits`, `retry`, `policy.errors`, `http`, or an error declaration) |
| JC0014 | a `policy` member is mistyped or outside its declared set (§3.1), a read declares `idempotency`, or a command declares `retry` without `idempotency: "required"` |
| JC0015 | `id`, `version`, `compat` or an operation `doc` is mistyped |
| JC0016 | an operation bound to `GET` or `HEAD` carries a body-located member (a GET body) |
| JC0017 | an opaque operation (a non-JSON `http.media`) declares a body-located member — its body is bytes the contract never decodes, so the member could never be validated (§4.5) |
| JC0018 | a subscribe operation declares a `policy.task` other than `switch` — a subscription slot is replaced, never queued (§17) |
| JC0019 | a subscribe operation is bound to a method other than `GET` — a stream is fetched, not sent (§17) |
| JC0020 | a subscribe operation declares a `policy.idempotency` other than `none` — a subscription registers, it does not commit (§17) |

`JC0021–JC0049` are reserved for further document-level rules and are
appended to this table when they land; `JC0050–JC0069` are the binding-
declaration and projection compile codes (`JC0060`, the OpenAPI keyword
policy, is in §12.2's table). `JC1001–JC1049` are host
programming errors (`ContractHostError`, a thrown `TypeError` with `code`
and `reason`) and `JC2001–JC2049` the HTTP request-time errors
(`ContractRuntimeError` in-process, a wire error on the response) — both
tables are in §7. Later ranges: `JC2050–JC2069` client-side (§10.3),
`JC2070–JC2089` port/local (§15–§16), `JC2090–JC2109` stream (§18).

The three worked examples this document is tested against, complete:

```json
{
  "$contract": "0.1",
  "operations": {
    "health.check": { "kind": "read", "output": { "type": "object" }, "http": { "method": "GET", "path": "/api/health" } }
  }
}
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
          "doc": { "type": "array", "items": { "type": "object" } },
          "dry": { "type": "boolean" }
        },
        "required": ["id", "doc"]
      },
      "output": true,
      "policy": { "idempotency": "optional" },
      "http": { "method": "PUT", "path": "/docs/:id", "in": { "dry": "query" }, "body": "doc", "status": 204 }
    },
    "doc.remove": {
      "kind": "command",
      "input": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
      "output": true
    }
  }
}
```

## §7 The HTTP server binding

`serveHttp(contract, handlers, options)` (`@jarenjs/contract/http`) is a
**binding**, modeled like a `@jarenjs/db` driver: it has a `name`, a
frozen `capabilities` table that states what it cannot carry, and one
method a host calls per request — `dispatch(request) → Promise<response>`
over plain JSON-ish objects. It routes, decodes, normalizes, validates,
calls the handler, validates the output, applies idempotency and
entity-tag policy, and answers with the declared statuses and one stable
error body. **Everything a request can do wrong is a coded response;
nothing a request can do escapes as a throw** — `dispatch` rejects only
for a malformed request *object* (`JC1004`), which is an adapter author's
mistake.

```jsonc
// HttpRequest — what an adapter builds and what a test hands to dispatch
{ "method": "PUT", "url": "/api/products/12/master?dry=true",   // origin-less path + optional ?query
  "headers": { "content-type": "application/json", "idempotency-key": "k-1" },  // lowercase names; a value is a string, or an array when the adapter saw repeated field lines
  "body": "{\"revision\":4,...}" }                                // string | Uint8Array | null, as received; an optional `signal` (AbortSignal) rides along
// HttpResponse — what dispatch answers
{ "status": 200, "headers": { "content-type": "application/json; charset=utf-8", "x-jaren-trace": "…" }, "body": "{…}" }
```

The dispatcher is `{ dispatch, capabilities, contract, describe(),
close() }` — `close()` ends every live SSE stream (§18.1);
`capabilities` is `{ name: "http", status: true, headers: true, media: true,
head, etag: true, idempotency: <ledger present>, validatedOutput:
<validateOutput === "always">, stream: true, cancel: "signal" }` — a
declared downgrade (`head: false`, `validatedOutput: false`,
`idempotency: false`) is reported here, never silent.

### §7.1 Handlers and the request context

`handlers` maps operation id → `Handler = (input, ctx) => value |
Promise<value> | ContractFailure`. `input` is the reassembled, validated
input object (`null` when the operation declares no `input`); the value
is the operation's output. `ctx` is frozen per request:

| member | meaning |
|---|---|
| `op` | the compiled operation |
| `trace` | the server trace id of this request (also `x-jaren-trace` on the response and `requestId` in an error body) |
| `carrier` | `"http"` — the binding this context comes from (`"port"` and `"local"` on theirs, §15–§16) |
| `host` | the host lifecycle's value (§7.7): what `acquire` entered with — `null` by default, the identity's host when only `identify` is named; the value itself is the host's and is not deep-frozen |
| `method`, `path` | the request line, path without the query |
| `params` | the raw decoded path strings, frozen |
| `headers` | **declared header members only** (by header name, string values) plus `if-match`/`if-none-match` when present — the binding reads no other request header on a handler's behalf |
| `body` | the raw request body of an **opaque** operation: text, bytes, or — when the adapter handed the request over as a stream — a pull source (`AsyncIterable<Uint8Array>`) that never yields a byte past `policy.limits.maxBodyBytes` (the chunk that would cross it throws a `BodyLimitError`, exported by `@jarenjs/contract/http`, to the puller); `null` for a JSON operation, whose body was decoded into `input` |
| `signal` | the request's `AbortSignal` when the adapter has one (the node adapter aborts it when the client goes away before the response finished), else `null` |
| `idempotency` | `{ key, scope }` when this request runs under an idempotency key, else `null` |
| `fail(code, params?, details?, { retryable? }?)` | a declared failure by code — returns a `ContractFailure` value the handler returns; `params` feed the message catalog, `details` become the wire `details` (validated against the declaration's schema when it has one), `retryable` overrides the default taken from `policy.retry.on` |
| `etag(tag, { strong? }?)` | arm the entity-tag path (§7.5); `tag` is the opaque tag without quotes |
| `status(n)` | override the success status; must be an integer in 200–299 (`JC1006` otherwise — a host error the handler boundary settles into `JC2008`, seen by `onError`) |

An **opaque** operation (`http.opaque`) takes a *raw* handler: `(input,
ctx) => { status, headers?, body? }` with the bytes in `ctx.body`; it
bypasses media, parse, body assembly, idempotency and output validation.
**The bytes stream.** Through the adapters (§9) `ctx.body` is a pull
source: the handler reads it with `for await`, one chunk at a time, and
nothing is collected on its behalf. The source counts: the chunk that
would cross `policy.limits.maxBodyBytes` is never yielded — the upstream
is cancelled once and a `BodyLimitError` is thrown to the puller. A
handler that lets it propagate answers `JC2003` (the request's fault,
not a host fault — `onError` does not see it); one that catches it
decides for itself. The handler's `body` may likewise be a pull source
(an async iterable, or a Web `ReadableStream`, normalized): the adapter
writes it chunk by chunk behind the socket's backpressure, and under
HEAD it is cancelled once, never drained. A plain (non-stream) response
answered with the upload still unread cancels the upload once before the
response is exposed; a streamed response keeps the upload alive — the
handler may be transforming it — and releases it once when the response
reaches EOF, throws, or is cancelled by the consumer. A limit crossing
met by such a transform after the headers went out cuts the response
body (the status cannot be rewritten) and is reported to `onError`.
Effects a handler made before a chunked upload crossed its limit are its
own to undo; the host lifecycle's acquired transaction (a later order's
seam) is where such a rollback belongs.
Its transport members are decoded and normalized into `input` and
validated like any other input (`JC2006`) — they **are** its whole
input, since an opaque operation cannot declare a body-located member
(`JC0017`, §4.5). `input` is `null` when the operation
declares none. Its response is passed through verbatim plus
`x-jaren-trace`; a value that is not `{ status, headers?, body? }` is
`JC2010`. It may still `ctx.fail` a declared code (answered as JSON like
every other error).

A handler may also **throw** a `ContractRuntimeError` whose `code` the
operation declares — that is a declared failure too (`params` and
`retryable` are read from it). Any other throw, rejection or hostile value
is `JC2008`.

### §7.2 The pipeline, in order

1. **The request object.** `method`/`url` strings, `headers` an object,
   `body` a string, `Uint8Array`, a pull source (`AsyncIterable<
   Uint8Array>`, or a Web `ReadableStream`, normalized to one) or `null`
   (an absent body is `null`) — a malformed object is `JC1004`,
   **rejected**, never a response.
2. **Route.** `url` is split at the first `?`; the path goes to
   `contract.match(method, path)`; under `HEAD` with `head` on, `HEAD`
   is tried, then `GET`. No match: an undecodable path (a malformed
   percent-escape) is `JC2011`; the `wellKnown` path answers `describe()`
   under GET/HEAD (405 otherwise); `contract.allowed(path)` non-empty
   (with `HEAD` added beside `GET` when `head` is on) is `JC2002` with
   `Allow`; else `JC2001`. A matched operation without a handler (a
   `partial` server) is `JC2013`.
   Then **identify** (§7.7): the host lifecycle's first hook runs with
   the operation, the trace, the signal and the raw transport facts —
   before any byte of the body is read — and answers the identity
   lease (its `host` is what `scope` sees) or a declared failure; a
   hook fault is `JC2008`. Every later refusal in this list releases the
   identity before it is exposed.
3. **The body limit.** A `content-length` above `policy.limits.maxBodyBytes`
   is `JC2003` **before** any read (the adapters honor this too, §9); a
   text or byte body whose length exceeds the limit is `JC2003` after; a
   pull source is measured as it is pulled — a JSON operation drains it
   under the limit and answers `JC2003` at the first byte past it (the
   source cancelled once, the crossing chunk never retained), an opaque
   handler's source throws `BodyLimitError` there (§7.1). Applies to
   every matched operation, opaque and body-less included; a body-less
   operation releases a source without pulling it.
4. **Opaque** → the transport input validated as in step 8 when no
   member is body-located (`JC2006`), then the raw handler through the
   same boundary as step 11; done.
5. **Media.** A body-carrying operation (a body-located member or a
   whole-body member) with a non-empty body requires a `content-type`
   whose `type/subtype` is the operation's `http.media` (parameters
   ignored, case-insensitive; a `+json` structured-syntax suffix is
   accepted for `application/json`); else `JC2004`. A body-less
   operation with a body **ignores** the body. An empty body needs no
   media.
6. **Parse.** A pull source is drained whole first (a source that fails
   or is aborted before EOF never arrived whole: `JC2005`); bytes are
   decoded as strict UTF-8 (invalid → `JC2005`; a leading BOM is
   stripped by the decoder); then `JSON.parse` (a failure is `JC2005`).
7. **Assemble** the input object through a prototype-safe setter only, in
   this order: path members (raw decoded strings), query members
   (`URLSearchParams` semantics — `+` is a space; `queryJson` members
   decode one JSON value, scalar members are last-wins; an **undeclared
   query key is ignored, never merged**; malformed encoding/JSON or a
   repeated JSON member is `JC2012`), declared header members (by their
   lowercased name; §7.4), then the scalar transport normalizer (JSON
   members excluded), then the body,
   **never coerced**: `http.body` names a member → the parsed value is
   that member; otherwise the parsed value must be an object (`JC2006`
   with `path: ""` otherwise) and each of its own members is set unless
   it names a path/query/header member (which is **ignored** — the body
   cannot override a location the request already answered); an
   undeclared body member is set and left for the validator to judge
   under the schema's own `additionalProperties`. A JSON body's own
   `__proto__` member becomes an own data property, never a prototype.
8. **Validate** the input with the operation's compiled validator →
   `JC2006`, `details` by `policy.errors.details` (§7.3). A
   **subscribe** operation branches here: with `accept:
   text/event-stream` the response is the SSE stream, without it the
   one-shot snapshot read (§18.1); the steps below never run for it
   (its `policy.idempotency` is `none` by construction).
9. **Idempotency** when `policy.idempotency !== "none"` (§8): a missing
   `Idempotency-Key` is `JC2007` under `required` and runs plainly under
   `optional`; otherwise the input is hashed and the ledger claimed. A
   `replay`, `mismatch` or `in-progress` answer returns here — the host
   lifecycle's `acquire` is never called for it.
   Then **acquire** (§7.7): the second hook runs with the validated
   input and the identity context, and calls `enter` with the lease the
   handler runs under; the handler's context is the identity context
   with the acquired `host`, frozen. Steps 10–14 run inside `enter`.
10. **Preconditions, opt-in** (§7.5): when the operation has a
    `preconditions` resolver, the CURRENT tag is resolved BEFORE the
    handler — a command consults it only under a conditional header, a
    safe method always. `If-Match` first (strong comparison): a
    mismatch, or a `null` resolution (`*` included), is `JC2014` with
    **zero handler invocations** — on a claimed command the key is
    released retryable, nothing ran; then `If-None-Match` (weak): a
    match answers `304` before the handler on GET/HEAD and `JC2014` on
    other methods, while a `null` resolution passes it — the
    create-guard. On a pass a safe method arms the resolved tag (the
    handler may re-arm), a command arms nothing, and step 13's
    comparisons stand down. The claim (step 9) comes FIRST: a committed
    key replays before the resolver runs.
11. **The handler**, through **one uniform promise boundary** — a
    synchronous throw, a non-promise return and a rejection settle
    alike. A `ContractFailure` (from `ctx.fail`) or a thrown
    `ContractRuntimeError` with a declared code → the declared error
    response; anything else → `JC2008`, its cause handed to `onError`.
    A value whose `then` accessor throws is a rejection here — the
    hostile-value case of `JC2008`.
12. **Output validation** (`validateOutput: "always"`, the default): the
    value against the operation's output validator → `JC2010` on failure
    or on a throwing accessor; the validator's errors reach `onError`,
    never the wire. `"never"` is a declared downgrade
    (`capabilities.validatedOutput: false`).
13. **Entity tags** when the handler armed one and step 10 did not
    already decide (§7.5): `If-Match` first (strong comparison; mismatch
    → `JC2014`), then `If-None-Match` (weak comparison; match → `304` on
    GET/HEAD, `JC2014` on other methods). Because the tag is known only
    after the handler runs, both are evaluated **after** step 11 and
    only when a tag was armed — **a cache device, never a write guard**:
    a stale `If-Match` here means the handler already ran, and on a
    claimed command the 412 is recorded non-retryable (§8). The
    pre-handler guard is the `preconditions` option (step 10), or the
    handler's own comparison of `ctx.headers["if-match"]`.
14. **Serialize.** `JSON.stringify(value)`; a value JSON cannot carry
    (a cycle, a BigInt) is `JC2010`; `undefined` answers no body. Status
    is `ctx.status()` or `http.status`; headers `content-type: <media>;
    charset=utf-8` (when a body), `x-jaren-trace`, `etag` when armed;
    a `204` carries no body; a HEAD carries the `content-length` of the
    body it dropped and no body. Then the ledger claim is settled (§8).
    A raw handler's body passes through as it is: text, bytes, or a pull
    source the adapter streams (no `content-length`; HEAD cancels it).
    Under a lease that **requires settlement** (§7.7) the claim is
    recorded through the lease's ledger inside `enter`, before `enter`
    resolves, and the root ledger stands down; a host fault or a
    pre-handler refusal makes `enter` reject — a host transaction
    around it rolls back — and the root ledger releases the key
    retryable outside it.
15. **Release.** The acquired lease, then the identity, each once: before
    the response is exposed (a release that fails there is `JC2008`,
    its cause observed), or — for a pull-source body and an SSE stream
    — when the body settles or the stream is done (a failure then is
    observed only).

Every step's failure path returns a response. `dispatch` never rejects
for request content; a defect of the binding itself is caught last and
answered `JC2008` too, so a server never sees an unhandled rejection.

### §7.3 The wire error

Every non-2xx JSON response body is:

```jsonc
{ "code": "JC2006",                       // a JC2xxx code, or the DECLARED error code ("conflict")
  "message": "the input of operation product.save is invalid",
  "requestId": "3f2c…",                   // the server trace, equal to the x-jaren-trace header
  "details": [ { "path": "/revision", "keyword": "type" } ],   // by policy.errors.details; absent under "none"
  "retryable": false }
```

`message` is rendered from the msgid through the catalog (the host
`catalog` option first, the English catalog in the package second) and
**never interpolates a request value** — its parameters are the operation
id, a declared limit, a media type, a method list, a declared header
member name or a declared error code. `details` follows
`policy.errors.details` for a validation failure: `none` → absent;
`paths` → `[{ path, keyword }]` (instance path + keyword, no values, no
schema); `full` → the validator's own error records with their `params`.
For a **declared** failure, `details` is what the handler gave to
`ctx.fail`, validated against `errors[code].schema` when the declaration
has one (a mismatch is `JC2010` — the handler broke its own error
contract; without a schema, the details must still be a JSON value) and
crossing regardless of `policy.errors.details` (that policy governs
validation failures; a declared error's details are the operation's own
contract). A declared failure's message is `contract/error/<code>` from
the host catalog when it defines one, else the generic
`contract/handler-error` (`operation {op} failed with {code}`); its
`retryable` is the failure's own, or whether `policy.retry.on` names the
code. The `errorBody` option projects the wire record (the body plus
`status`) into another JSON shape for legacy consumers; a projector that
throws or answers non-JSON falls back to the shape above.

Every response carries `x-jaren-trace: <trace>`; every error response
also `cache-control: no-store`; a 405 carries `Allow`; a 409
`in-progress` carries `retry-after: 1`; a 412 from `If-None-Match`
carries the `etag`. Header names are lowercase.

The taxonomy — code, status, msgid, retryable — is the normative table
below; `HTTP_ERRORS` (`@jarenjs/contract/http`) is the same table as data,
`CONTRACT_CODES` lists every code, the English catalog
(`contractMessagesEn`) has exactly these msgids plus
`contract/handler-error`, and a test holds the four equal.

| code | status | msgid | retryable | when |
|---|---:|---|---|---|
| `JC2001` | 404 | `contract/not-found` | no | no operation matches method + path (a lowercase method token, an unknown path, a trailing slash) |
| `JC2002` | 405 | `contract/method-not-allowed` | no | the path shape is served under other methods; `Allow` lists them (`HEAD` beside `GET` when `head` is on) |
| `JC2003` | 413 | `contract/body-too-large` | no | `content-length` or read length > `policy.limits.maxBodyBytes` |
| `JC2004` | 415 | `contract/unsupported-media` | no | a body-carrying operation with a non-empty body whose `content-type` is not the declared media (parameters ignored, `+json` accepted for JSON) |
| `JC2005` | 400 | `contract/malformed-json` | no | body present and not valid JSON, or not valid UTF-8 |
| `JC2006` | 400 | `contract/invalid-input` | no | the reassembled input fails the operation's input validator; also a non-object body under `body:"*"` (`path: ""`), and a body the canonicalizer refuses (a lone surrogate; keyword `canonical`) |
| `JC2007` | 400 | `contract/idempotency-key-required` | no | `policy.idempotency: "required"` and no (or an empty) `idempotency-key` header |
| `JC2008` | 500 | `contract/handler-failed` | no | the handler threw a non-declared error, rejected, answered an undeclared code or a hostile value, or the binding itself faulted; `onError(err, ctx)` sees the cause |
| `JC2009` | 409 | `contract/idempotency-conflict` | see §8 | the ledger says `in-progress` (retryable, `retry-after: 1`) or `mismatch` (not retryable, `details: [{ "kind": "mismatch" }]`) |
| `JC2010` | 500 | `contract/invalid-output` | no | the handler value fails the output validator, cannot be serialized, a raw response is malformed, or a declared error's details fail their schema — the server broke the contract |
| `JC2011` | 400 | `contract/malformed-path` | no | the path carries a malformed percent-escape |
| `JC2012` | 400 | `contract/malformed-query` | no | the query string is not decodable (malformed escape/UTF-8/JSON, or a repeated JSON member) |
| `JC2013` | 501 | `contract/not-implemented` | no | a `partial` server has no handler for the operation |
| `JC2014` | 412 | `contract/precondition-failed` | no | `If-Match` does not match the armed tag (strong comparison), or `If-None-Match` matches on a non-GET/HEAD |
| `JC2015` | 400 | `contract/invalid-header` | no | a declared scalar header member arrived repeated, or a header value is not a string |

`JC2016–JC2049` are reserved for later http-side codes; a new one is
added to `CONTRACT_CODES`, this table and the English catalog in one
change.

Host programming errors are `ContractHostError` — a `TypeError` with
`code` and `reason`, **thrown** at construction or from `ctx`, never a
wire response:

| code | when |
|---|---|
| `JC1001` | `serveHttp`, `serveLocal` or `servePort`: `handlers` is not an object, a key names no operation of the contract, a value is not a function, or an option (a channel without `postMessage`, say) is malformed |
| `JC1002` | `serveHttp`, `serveLocal` or `servePort`: an operation has no handler (on `serveHttp`, unless `partial` is set; on the status-less bindings an opaque operation is exempt — §15) |
| `JC1003` | a binding cannot carry a declared feature: an operation declares `policy.idempotency` and no `ledger` was given (say so, never degrade) |
| `JC1004` | `dispatch` received a malformed request object |
| `JC1005` | a client (`invoke`, `url`) or the contract effect was asked for an operation the contract does not declare, or `invoke` for an opaque operation (§10; on `local`/`port` the binding cannot carry it at all — §15, §16) |
| `JC1006` | `ctx.status(n)` with `n` not an integer in 200–299 |
| `JC1007` | `contractAppBinding`: `ops` names an operation the contract does not declare, or `namespace`/`statePath` is malformed (§11) |
| `JC1008` | `openHttpClient`, `openPortClient`, `client.url`, `createContractEffect`, `createContractSubscription` or a projection (`publicProjection`, `toOpenApi`, `toTypeScript`, `toMarkdown`, `contractTools`): an argument or option is malformed (§10, §11, §12, §16) |
| `JC1009` | the stream wire's SSE encoder was handed text the frame cannot carry: a bare carriage return inside `data`, a line terminator inside `event` or `id` (§18) |
| `JC1010` | `client.subscribe` was asked for an operation that is not a subscribe operation (§19) |
| `JC1011` | a ledger `commit`/`fail` named a ref that settles no started record — expired, reclaimed under a newer generation, or settled already (§8); refused by the ledger, reported to `onError` by the binding |

### §7.4 Headers

The binding reads, on the request: `content-type` and `content-length`
(steps 3, 5), `idempotency-key` (§8), `if-match` and `if-none-match`
(§7.5), and the **declared header members** — an input member mapped to
`header` travels as the header named by the member's name lowercased
(declare the member `x-tenant` to read `X-Tenant`). A scalar member takes
one line (a repeated line is `JC2015`; the `fetch` adapter cannot see
repeats — the platform combines them — while the `node` adapter passes
distinct lines as an array); an array-typed member (listed in
`transport.members.repeated`) collects repeated lines, or splits one line
on commas (RFC 9110 list syntax). No other request header is read, and
none is echoed. `x-jaren-trace` on a request is never read — the trace is
the server's; `x-attempt` or any client attempt id is never read either.

### §7.5 Entity tags and conditionals

**Armed tags — post-handler, a cache device.** `ctx.etag(tag)` arms a
weak tag (`etag: W/"tag"`), `ctx.etag(tag, { strong: true })` a strong
one (`etag: "tag"`). `If-None-Match` is compared weakly (`*` matches;
`W/` indicators are ignored) → `304` with the `etag` header and no body
on GET/HEAD, `412` (`JC2014`) on other methods; `If-Match` is compared
strongly (`*` matches; a weak candidate or a weak armed tag never
matches) → `412` on a mismatch. Both are evaluated after the handler
ran, and only when it armed a tag — so **this path is never a write
guard**: a command's handler has already run, and may already have
mutated, when its stale `If-Match` answers 412, and a handler that arms
no tag has its conditionals silently pass. On a claimed command such a
post-handler 412 is recorded non-retryable with its response (§8), so a
blind retry replays the 412 instead of mutating again.

**The `preconditions` option — pre-handler, the write guard.**
`serveHttp(contract, handlers, { preconditions: { '<op>': (input, ctx)
=> … } })` declares the CURRENT entity-tag resolver of an operation
(refused at construction, `JC1001`, on a subscribe or opaque
operation). The resolver answers a plain string — a **strong** tag (the
deliberate asymmetry with `ctx.etag`, whose bare form is weak:
`If-Match` needs strong comparison to mean anything) — or `{ tag,
strong }`, or `null` for "no current representation", or a promise of
any of those; a throw, a rejection or another shape is the host's fault
(`JC2008`, a claimed key released retryable). A command consults its
resolver only under a conditional header; a safe method always
resolves, so its response carries the tag. The decision runs BEFORE the
handler: `If-Match` first (strong; RFC 9110 §13.2.2) — a mismatch or a
`null` resolution (`*` included) refuses `JC2014` with **zero handler
invocations**, the current tag riding the 412's `etag` header for
recovery; then `If-None-Match` (weak) — a match answers `304` before
the handler on GET/HEAD (the cached-read win: the representation is
never computed) and `JC2014` on other methods, while a `null`
resolution passes it (`If-None-Match: *` is the create-guard). On a
pass, a safe method arms the resolved tag — the handler's own
`ctx.etag` then re-arms the RESPONSE tag only — and a command arms
nothing (a mutated representation must not echo its pre-state tag, RFC
9110 §8.8.3). Idempotency composes claim-first (§8): a committed key
replays before the resolver runs, and a pre-handler 412 releases the
key retryable — nothing ran. This is how a `policy.revision` command
becomes HTTP-enforceable (§3.1): resolve the resource's current
revision into a tag, and the domain transaction stays the final
authority.

### §7.6 HEAD, the well-known path, options

`head: true` (default) answers `HEAD` for every `GET` operation by
running the handler and dropping the body (a declared `HEAD` operation
wins); with `head: false` a HEAD is a 405 listing `GET`. The `wellKnown`
path (`/.well-known/jaren-contract`, or another absolute path, or `false`)
answers `describe()` — `revision: null` until the revision lands, `compat`
present — for negotiation. `trace` (default the runtime record's `uuid`,
`crypto.randomUUID` with no record) generates the server trace; `scope(ctx)` derives the idempotency scope (§8);
`partial` allows missing handlers; `validateOutput` is `"always" |
"never"`; `preconditions` maps operation ids to pre-handler tag
resolvers (§7.5); `errorBody(wire, ctx)` and `onError(err, ctx)` are the
two host hooks (`ctx` is `null` before an operation is matched);
`catalog` is a message catalog (templates or compiled renderers)
consulted before the English one; `now` is the clock stamped into ledger
claims; `runtime` is the host's runtime record (`@jarenjs/core/runtime`),
whose `uuid` and `now` apply where `trace` and `now` are absent. Every
binding of this format takes the same `runtime` option with the same
precedence — an explicit option wins over the record's member, which
wins over the platform default — so one record configures a server, its
ledger and a client together: `servePort` and `openLocalClient` read its
`uuid` for their trace, `openPortClient` for its client id,
`openHttpClient` reads `uuid` for idempotency keys, `now` for key-record
stamps and `random` for retry jitter, and `createMemoryLedger` reads
`now` for claim stamps.

### §7.7 The host lifecycle: identify, acquire, release, settle

A host owns resources a handler needs — a principal, a tenant's store, a
transaction — and the binding owns the moments they may be taken and
must be given back. `serveHttp`, `servePort` and `openLocalClient` take
the same two hooks, validated at construction (`JC1001` otherwise) and
defaulted exactly:

```
identify(meta)                    → { host, release? } | declared failure | Promise<…>
acquire(input, identity, enter)   → enter({ host, release?, settlement? }) | declared failure | Promise<…>
settlement                        := { ledger, required: true }

default identify → { host: null }
default acquire  → enter({ host: identity.host })
```

`meta` is `{ op, trace, signal, carrier, method, path, headers, fail }`
— the matched operation, the trace, the request signal, the carrier
name, the request line and the raw request headers on HTTP (`null` on
port and local), and the declared-failure factory. It carries **no
parsed input and no authentication vocabulary**: what an identity is
made of is the host's. `identity` is the frozen identity context (the
request context with the identity's `host`); `scope(ctx)` sees that
context. A lease is an object with an own `host` — the value the
handler sees as `ctx.host` — and an optional `release` function; the
acquired lease may add `settlement`. A host that names only `identify`
sees its host in `scope` and in the handler; one that names `acquire`
owns the handler's host.

**Order.** (1) the request shape, the route and the trace; (2)
`identify`; (3) media, parse, assembly and validation; (4) the
idempotency key, scope, hash and claim of an HTTP JSON command; (5) a
replay, mismatch or in-progress answer returns here, `acquire` never
called; (6) `acquire(validatedInput, identity, enter)`; (7) inside
`enter`: the frozen handler context, the precondition, the handler, the
output validation and the serialization; (8) a required settlement,
then `enter` resolves and the host's continuation around it settles;
(9) the response is exposed, and the releases run at the lifetime
boundary. Opaque, subscribe, port and local paths skip the ledger steps
that do not apply and keep the order otherwise.

**Faults.** A hook that throws or rejects, answers something that is
not a lease (no own `host`, a `release` that is not a function, a
`settlement` without a ledger that commits and fails), never calls
`enter`, calls it twice, or resolves before `enter` settled is the
host's fault: observed through `onError` and answered as the binding's
host fault — `JC2008` on HTTP, `JC2070` on port and local. A declared
failure is recognized by the `ContractFailure` brand only (`meta.fail`,
or the package's `ContractFailure`), never by shape, and is validated
against the operation exactly as a handler's `ctx.fail` is. A
shape-compatible object is a malformed lease.

**Release.** The acquired release runs, then the identity's, each at
most once, on every exit that reached it: an ordinary response releases
after the whole pipeline (the required settlement included) and before
the response is exposed; a pull-source body of an opaque operation
carries the releases and runs them once at EOF, on a throw, on the
consumer's cancel, on HEAD's discard and on a disconnect; an SSE stream
and a port subscription release after the runner's stop/close/done
sequence. The identity releases on every early refusal too — malformed
JSON, unsupported media, the body limit, a malformed query or header,
invalid input, replay, mismatch, in-progress — and the acquired release
never runs when `acquire` did not enter. A release that fails before
the response is exposed is observed and answered as the host fault; one
that fails after exposure is observed only. A release failure after a
committed settlement therefore answers `JC2008` for work that was done:
under an idempotency key the retry replays the committed response.

**Required settlement.** An `acquire` that hands `enter` a lease with
`settlement: { ledger, required: true }` — the ledger being one over
the host's own transaction, `createDbLedger(tx)` from
`@jarenjs/linq/db` (§8) — has the claim of a newly claimed JSON command
recorded through that ledger inside `enter`: a success commits, a
declared failure and a post-handler `JC2014` record the same failed
receipt and retryability `settleClaim` would, and only then does
`enter` resolve, so a host transaction opened around it commits the
domain write and the receipt together or not at all. A pre-handler
refusal, a handler throw, an invalid output, a fault of the binding's
own continuation or a settlement that throws makes `enter` reject with
a private carrier of the intended wire fault: the host transaction rolls
back, the dispatcher releases the root claim retryable outside it, and
the fault is the answer. The lease's ledger never settles a replay or a
claim it did not enter for; a settlement on a non-idempotent operation,
on port or on local is accepted and unused. Without a required
settlement the root ledger settles after `enter`, best-effort, as it
always did.

```js
import { open, createDbLedger } from '@jarenjs/linq/db';

const db = await open(model, { driver: nodeDriver(), path: 'app.db' });
const server = serveHttp(contract, handlers, {
  ledger: createDbLedger(db),                                   // the root claim: immediate, one writer
  identify: (meta) => ({ host: { tenant: meta.headers['x-tenant'] ?? null } }),
  acquire: (input, identity, enter) => db.transaction(          // one transaction around the handler
    (tx) => enter({ host: { db: tx, tenant: identity.host.tenant }, settlement: { ledger: createDbLedger(tx), required: true } }),
    { mode: 'immediate' }),
});
```

**What this is, exactly.** The claim is taken before the transaction
and recovered outside it: a rolled-back `enter` leaves the key
retryable, a crashed host leaves it `started` until it expires, and a
retry under the same key finds the recorded receipt or a fresh claim.
Atomicity is the store's: a ledger and a domain write on ONE store
commit together; a ledger on one store and a write on another are two
commits, and nothing here makes an external effect — a mail, a payment
— exactly-once. The receipt says the command's response was recorded,
not that the world outside the store agrees.

## §8 Idempotency and the ledger

An operation with `policy.idempotency` of `optional` or `required` runs
under an **idempotency key**: the caller's, sent as `Idempotency-Key`,
scoped by the host's `scope(ctx)` (an installation, a principal — never a
rotating token) — one of the three identities this format keeps apart
(the **trace** is the server's per request; the **attempt** id is the
caller's per dispatch and never crosses). `serveHttp` refuses (`JC1003`)
an idempotent operation without a `ledger`.

The **request hash** is the lowercase hex SHA-256 over the RFC 8785
canonical bytes of the validated input (`canonicalSha256` in
`@jarenjs/json/canonical`) — so a body with its members in another order
is the same request. The binding then calls the ledger:

```jsonc
// the Ledger interface — every method may return its value or a promise of it
{ "claim":  "({ op, scope, key, hash, now }) → { state: 'new', ref } | { state: 'replay', response } | { state: 'in-progress' } | { state: 'mismatch' }",
  "commit": "(ref, response, now?) → void",
  "fail":   "(ref, retryable, response?, now?) → void",
  "lookup": "({ op, scope, key, now? }) → record | null" }
```

The `ref` a `new` claim hands back is `{ id, generation }` — the
record's id and the **generation** the claim minted for it — and is
portable: it names the record across processes rather than holding it.
A settlement is fenced by both: `commit`/`fail` settle the record whose
`id` AND `generation` the ref names while it is still `started` and its
`expiresAt` is greater than the settlement instant. Expiry is checked by
the settlement itself, without waiting for a lookup or sweep. A
ref whose record expired, was reclaimed under a newer generation, or was
settled already is refused with `JC1011` (thrown or rejected) — the
binding reports it to `onError` and the response still goes out, so a
stale settlement is visible instead of silently landing on a later
claim's record.

Semantics the binding relies on: same key + same hash → `replay` — the
stored `{ status, headers, body }` **verbatim** with a fresh
`x-jaren-trace` and `idempotent-replayed: true`; same key + different
hash → `mismatch` (409, `details: [{ "kind": "mismatch" }]`, not
retryable); `started` and not expired → `in-progress` (409, `retry-after:
1`, retryable); `failed` with `retryable: true` → treated as `new` (the
key may be retried); `failed` and not retryable → `replay` of the stored
failure. After the handler: a success **commits** the response; a
declared failure is recorded as **failed** with its response and its
`retryable`; a server fault (`JC2008`, `JC2010`, and a PRE-handler
`JC2014` from a `preconditions` resolver — nothing ran) **releases** the
key as retryable with no response; a POST-handler `JC2014` (the handler
already ran and may have mutated) is recorded as **failed**, not
retryable, with its 412 — a blind retry under the same key replays the
412 instead of running the handler again. `now` on a claim, a commit, a
failure and a lookup is the binding's clock (`options.now`, or the
runtime record's): ONE clock judges a record from claim to expiry, so a
ledger without a clock of its own follows the binding's instants, and a
ledger with one is given the same `runtime` as the binding — a claim
stamped by an injected server clock and expired by the platform's is a
command that runs twice. Opaque
operations bypass the ledger; reads never carry a key. A ledger that
throws or rejects is reported to `onError` and the response still goes
out (a throwing `claim` is `JC2008`).

`createMemoryLedger({ ttlMs = 86_400_000, now, runtime })` (`@jarenjs/contract/ledger`)
is the reference implementation over a `Map`: synchronous,
single-process, expiring on `claim` and `lookup`, with `sweep(now?)` for a
host timer and `size`. Built without `now` or `runtime` it keeps time by
the instants the binding passes it (a host-side `lookup`/`sweep` that
passes none uses the latest one); built with either, that clock judges
every record; the runtime record's `uuid` mints each generation, and
`lookup` answers a copy. The record it keeps is:

```jsonc
{ "id": "1:[\"product.save\",\"tenant-a\",\"k-1\"]",   // ledgerId(op, scope, key): version 1, the JSON tuple
  "generation": "0f3c…",                    // minted per started record; what a ref names
  "op": "product.save", "scope": "tenant-a", "key": "k-1",
  "hash": "9f2a…",                          // 64 lowercase hex characters
  "status": "committed",                    // started | committed | failed
  "response": { "status": 200, "headers": { "…": "…" }, "body": "{…}" },   // or null
  "retryable": null,                        // of a failed record
  "createdAt": 1755000000000, "updatedAt": 1755000000000, "expiresAt": 1755086400000 }
```

`ledgerId(op, scope, key)` (`@jarenjs/contract/ledger`) spells the id:
the version `1`, a colon, the JSON array of the tuple — injective, so a
`|`, a control character or any Unicode inside a member cannot collide
with another tuple. A record written under the earlier
`"<op>|<scope>|<key>"` spelling is matched by no claim again: it
expires by its own `expiresAt` (a `sweep` drops it), and a host that
must keep such records reachable rewrites their `id` once
(`ledgerId(record.op, record.scope, record.key)`) before the new
version serves.

Two documents ship the same shape as **data**, for a host that wants
durability (this package imports neither `@jarenjs/db` nor
`@jarenjs/flow`): `idempotencyLedgerModel` is a `$model` 0.1 document —
collection `ledger`, key `/id`, that record as its schema (closed, the
`generation` required), indexes on `expiresAt` and `status` — a host
opens it with `openStore` and implements the interface over the
collection, or takes `createDbLedger` from `@jarenjs/linq/db`, which is
that implementation over the typed client (root claims under
`mode: 'immediate'`, a transaction client's settlements inside the
host's own transaction; DB-CLIENT.md §2.6); `commandLifecycleFsm`
is a `$fsm` 0.1 document — `idle → started` on `claim`, `started →
committed` on `commit`, `started → failed` on `fail`, `failed → started`
on `claim` guarded by `$.context.retryable` — which the memory ledger
walks exactly.

### §8.1 A durable ledger over `node:sqlite` — an example, not an export

A host that retries commands needs a ledger that survives a restart, and
it does NOT need `@jarenjs/db` for that: `node:sqlite` is built into
Node ≥ 24 — the suite's floor — so the ~60 lines below are as
dependency-free as the package (a host on `@jarenjs/db` takes
`createDbLedger` from `@jarenjs/linq/db` instead). Two design points
carry the semantics: `BEGIN IMMEDIATE` makes each `claim` one writer
(two processes cannot both claim a key), and a settlement names the
record's id AND the generation the claim minted — persisted with the
record — so a stale ref matches no row and is refused `JC1011` rather
than settling over a record a later claim re-created. Everything else
mirrors `createMemoryLedger` exactly: the same `ledgerId`, expiry on
`claim` and `lookup`, `sweep()` for a host timer, mismatch before
status, a retryable failure handing the key back, a non-retryable one
replaying its stored response; the shared ledger contract in the test
suite runs all three. Remember the boundary (§8): this ledger
deduplicates DELIVERY — the domain's own durable records stay
authoritative for business state.

```js
import { DatabaseSync } from 'node:sqlite';
import { ledgerId } from '@jarenjs/contract/ledger';

/** A durable Ledger over one SQLite file — a host's example, not an export. */
export function createSqliteLedger(path, { ttlMs = 86_400_000, now: clock = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY, generation TEXT NOT NULL, op TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
      hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('started', 'committed', 'failed')),
      response TEXT, retryable INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_by_expires ON ledger (expiresAt);
    CREATE INDEX IF NOT EXISTS ledger_by_status ON ledger (status);`);
  const one = db.prepare('SELECT * FROM ledger WHERE id = ?');
  const put = db.prepare("INSERT INTO ledger (id, generation, op, scope, key, hash, status, createdAt, updatedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)");
  const drop = db.prepare('DELETE FROM ledger WHERE id = ?');
  // the fence: a settlement names the id AND the generation of the claim
  // that started the record, and the record must still be unexpired
  const settle = db.prepare("UPDATE ledger SET status = ?, response = ?, retryable = ?, updatedAt = ? WHERE id = ? AND generation = ? AND status = 'started' AND expiresAt > ?");
  const reap = db.prepare('DELETE FROM ledger WHERE expiresAt <= ?');
  const stored = (row) => (row.response === null ? null : JSON.parse(row.response));
  const at = (now) => (typeof now === 'number' ? now : clock());
  const settled = (ref, changes) => {
    if (changes !== 1) throw Object.assign(new Error(`ledger: ${ref?.id ?? 'a foreign ref'} settles no started record`), { code: 'JC1011' });
  };
  return {
    claim({ op, scope, key, hash, now }) {
      const id = ledgerId(op, scope, key);
      db.exec('BEGIN IMMEDIATE'); // one writer: two processes cannot both claim the key
      try {
        const row = (one.get(id));
        if (row !== undefined) {
          if (row.expiresAt <= at(now)) drop.run(id);
          else if (row.hash !== hash) { db.exec('COMMIT'); return { state: 'mismatch' }; }
          else if (row.status === 'started') { db.exec('COMMIT'); return { state: 'in-progress' }; }
          else if (row.status === 'committed') { db.exec('COMMIT'); return { state: 'replay', response: stored(row) }; }
          else if (row.retryable !== 1 && row.response !== null) { db.exec('COMMIT'); return { state: 'replay', response: stored(row) }; }
          else drop.run(id); // a retryable failure: the key runs again
        }
        const generation = crypto.randomUUID();
        put.run(id, generation, op, scope, key, hash, at(now), at(now), at(now) + ttlMs);
        db.exec('COMMIT');
        return { state: 'new', ref: { id, generation } };
      }
      catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    commit(ref, response, now) {
      const time = at(now);
      settled(ref, settle.run('committed', JSON.stringify(response), null, time, (ref)?.id ?? '', (ref)?.generation ?? '', time).changes);
    },
    fail(ref, retryable, response, now) {
      const time = at(now);
      settled(ref, settle.run('failed', response === undefined ? null : JSON.stringify(response), retryable === true ? 1 : 0, time, (ref)?.id ?? '', (ref)?.generation ?? '', time).changes);
    },
    lookup({ op, scope, key, now }) {
      const row = (one.get(ledgerId(op, scope, key)));
      if (row === undefined) return null;
      if (row.expiresAt <= at(now)) {
        drop.run(row.id);
        return null;
      }
      return { ...row, response: stored(row), retryable: row.retryable === null ? null : row.retryable === 1 }; // exactly LedgerRecord (§8)
    },
    sweep: (now) => Number(reap.run(at(now)).changes),
    close: () => db.close(),
  };
}
```

The executable copy — the same listing, plus the `@ts-check` casts a
test file carries — lives in `test/contract/ledger-sqlite.test.js`,
which proves the memory-ledger contract over it (claim/commit/replay,
mismatch, in-progress, retryable re-run, non-retryable replay), expiry
and `sweep`, the stale-ref identity, `serveHttp` idempotency
end-to-end, and durability across a second open of the same file. It is
deliberately NOT an export of this package: the `Ledger` interface is
the product, and an exported implementation would make `node:sqlite`'s
locking part of this package's API surface. Scope keys by installation
or principal through `options.scope`, give expiry a real TTL, and put
`sweep()` on a host timer.

## §9 Adapters

Two dependency-free, structurally typed adapters put a dispatcher behind
the platform:

- **`toFetchHandler(dispatcher)`** (`@jarenjs/contract/fetch`) →
  `(Request) => Promise<Response>` — Bun.serve, Deno, service workers,
  Cloudflare-style hosts, and Hono. It lowercases the headers into a
  plain object, matches the operation first (cheap) to decide whether
  the body is handed over at all — the request's stream reaches the
  dispatcher as a pull source for a matched body-carrying operation
  (a JSON operation drains it under its limit there, an opaque handler
  pulls it chunk by chunk), and **not at all** for an unmatched request
  or a declared `content-length` above the operation's limit (the
  dispatcher answers the 413 from the header) — forwards
  `request.signal`, and builds the `Response` from the dispatcher's
  status, headers and body; a streamed body becomes a `ReadableStream`
  that pulls one chunk per read and cancels the source once.
- **`toNodeHandler(dispatcher)`** (`@jarenjs/contract/node`) → `(req,
  res)` — `http.createServer`'s listener and Express middleware. The
  request reaches the dispatcher as a pull source over its own chunks —
  nothing is collected in the adapter, and an unpulled upload never
  fills memory. When an upload was pulled and left unread (a limit
  crossing, a response answered before EOF) the answer carries
  `connection: close`, then the socket lingers — draining and discarding
  the rest of the upload, bounded by a grace timer
  (`toNodeHandler(dispatcher, { lingerMs })`, default 1000 ms) — before
  the request is destroyed, so the close is a FIN the client can read
  the 413 through rather than an RST that discards it (winsock drops
  buffered receive data on RST); a declared `content-length` above the
  limit is never read; an unmatched request's body is never read. Bytes
  reach the dispatcher as received (its strict UTF-8 decode decides
  `JC2005`); repeated header lines arrive as arrays (`headersDistinct`);
  `ctx.signal` aborts when the client goes away before the response
  finished; `content-length` is set on every text or byte body, and a
  streamed body is written chunk by chunk behind the socket's `drain`,
  its source cancelled once when the peer goes away.

**A streaming response is written behind backpressure.** The dispatcher
hands the adapter's sink to `createAwaitedSink` (`@jarenjs/core/async`),
so every SSE event is written only after the previous write settled,
and the adapter's `write` says when that is: the node adapter answers
nothing when `res.write()` took the chunk and a promise resolved on the
next `drain` when it answered `false` (rejected when the response
closes or errors first, its listeners removed either way); the fetch
adapter's `ReadableStream` produces on demand — a write settles when
the consumer's `pull` takes the chunk, never from an eager loop in
`start()` — and `cancel()` rejects the write waiting for demand and
stops the subscription exactly once. Behind either, the carrier-neutral
runner calls its hooks one at a time (§17.1), so a slow reader parks
the source's emissions instead of growing the process's buffers. An
adapter of your own supplies `{ write, end, abort? }` where `write` may
answer a promise; `response.stream(sink)` answers `{ stop, done }` —
`stop()` ends the stream when the consumer cancels, `done` settles once
the subscription is released and the sink has ended.

Fastify, Hono and Express are recipes in the README, each ≤15 lines and
executed by a test that imports the framework from the benchmark
workspace only — no framework is a dependency of this package. Each
recipe rides one of the two adapters (Fastify hijacks the raw
request/response pair before any parser runs), so body limits, SSE
streaming and peer abort behave identically through all three.

## §10 The HTTP client binding

`openHttpClient(contract, options)` (`@jarenjs/contract/client`) is the
client half of the http driver pair: `open(contract, options) → Client`
with `Client = { invoke, bytes, url, negotiate, pending, capabilities,
contract, describe(), close() }`. It is **binding-agnostic in shape** — the app
binding (§11) and later the AI tools read only `invoke`, `contract` and
`capabilities` — and **total in behavior**: `invoke` resolves an
**outcome** for everything a server or a network can do and rejects
only for the host's own mistake (`JC1005`: an operation the contract
does not declare, or an opaque one — `invoke` carries JSON; an opaque
operation is reached through `bytes` (§10.6) and `url`).

```jsonc
// options — every one has a default
{ "fetch": "globalThis.fetch",            // (url, init) => Promise<Response>; injectable (a toFetchHandler, a recorder)
  "baseUrl": "",                          // prefixed to every path; '' = relative
  "headers": {},                          // static headers, merged UNDER per-call ones
  "keys": "runtime.uuid",                 // the idempotency key generator (crypto.randomUUID with no record)
  "storage": null,                        // { read(), write(value) } — the @jarenjs/app docstore adapter shape — for durable key records
  "timeoutMs": 0,                         // per request; 0 = none; composed with ctx.signal
  "sleep": "(ms, signal) => Promise",      // the retry backoff sleeper (injectable)
  "catalog": null,                        // a message catalog consulted before the English one
  "wellKnown": "/.well-known/jaren-contract",   // where negotiate() asks
  "now": "runtime.now",                   // the clock stamped into key records (Date.now with no record)
  "runtime": "createRuntime()" }          // the host's runtime record; its random draws the retry jitter
```

`capabilities` is `{ name: "http", status: true, headers: true, media:
true, etag: true, idempotency: true, durableKeys: <storage given>,
stream: true, cancel: "signal" }` — frozen, the driver rule; `stream`
is the `subscribe` half (§19).

### §10.1 The outcome and the three identities

`invoke(op, input, ctx) → Promise<Outcome>` with `ctx = { signal?,
attempt?, idempotencyKey?, headers?, ifNoneMatch?, ifMatch? }`. An
outcome is **JSON** (no `Error`, `Response`, `Headers` or
`AbortController` ever), tagged:

```jsonc
{ "ok": true,  "value": { "...": "the output, validated" }, "meta": { "...": "" } }
{ "ok": false, "kind": "failure" | "network" | "contract" | "cancelled",
  "error": { "code": "conflict", "message": "…", "status": 409, "details": null, "retryable": false },
  "meta":  { "op": "product.save", "attempt": 3, "trace": "3f2c…", "revision": null, "etag": null, "notModified": false } }
```

- `failure` — the server answered a **declared** operation error, or a
  `JC2xxx` taxonomy error (§7.3): the peer spoke the contract and said no;
- `network` — the transport rejected or timed out (`JC2051`, retryable);
- `contract` — the peer (or, pre-send, the input) violated the contract:
  invalid input (`JC2050`), an invalid success body (`JC2053`), a key
  store that threw (`JC2054`), an undeclared response (`JC2055`);
- `cancelled` — `ctx.signal` aborted or `close()` was called (`JC2052`).

**The fixed shapes — every binding (D6).** An outcome never carries an
`undefined` member: an optional member that is absent is `null`
(`isJsonValue` — the predicate `@jarenjs/app`'s task effect and state
honor — rejects `undefined`, and an outcome with one would fall back to
a string in the task effect). `error` is always

`{ code, message, status, details, retryable }` — `OUTCOME_ERROR_MEMBERS`

and `meta` is always

`{ op, attempt, trace, revision, etag, notModified }` — `OUTCOME_META_MEMBERS`

in that member order, on **every** binding — http, and the `local`/
`port`/`stream` bindings that follow. A binding that cannot carry a
member carries `null` (`status` on a binding without statuses, `etag`,
`trace`) or `false` (`notModified`) and says so in its `capabilities`;
it **never omits the member**. The two lists are exported from
`@jarenjs/contract/client` (frozen arrays) so a binding asserts against
them rather than restating them, and `isOutcome` refuses a value whose
`error` or `meta` lacks a member or carries `undefined` in one.

`meta` keeps the three identities apart, by construction: **`attempt`** is
the caller's (`ctx.attempt`, echoed verbatim, `null` when none) — it is
never sent and **never read from any response header**; **`trace`** is
the server's `x-jaren-trace` (`null` when the wire carried none) — it is
never generated here; the **idempotency key** (§10.3) is the client's
and travels only as `Idempotency-Key`. `revision` is reserved for the
contract revision; `etag` carries a success's entity tag; `notModified`
is true exactly for a 304.

### §10.2 What `invoke` does, in order

1. **Route.** An unknown `op` or an opaque one throws `JC1005`.
2. **Validate** `input` with the operation's compiled input validator —
   the SAME validator the server runs. `null`/`undefined` is `{}` for an
   operation with input; an input-less operation refuses any non-null
   input. A failure resolves `kind: "contract"` `JC2050` with `details`
   by `policy.errors.details`; **nothing was sent**.
3. **Split by location** (`http.in`): path variables → `encodeURIComponent`
   per segment into the canonical template; query members →
   `URLSearchParams` (`queryJson` members use one JSON value, including
   null and empty arrays; undefined is omitted; scalar transport members
   omit null/undefined and otherwise use their string); header members → the header named by the
   member lowercased (an array as a `, `-joined list); the body: `http.body`
   names a member → `JSON.stringify` of that member's value; otherwise
   the object of the body-located members, stringified. `method` from
   `http.method`; `content-type: <http.media>` only when a body is sent.
   Static `headers`, then `ctx.headers`, then the declared header
   members, then the protocol headers the client owns (`if-none-match`,
   `if-match`, `content-type`, `idempotency-key`) — later wins. A value
   JSON or a URL cannot carry is `JC2050` (`keyword: "encoding"`).
4. **Idempotency** (§10.3) when `policy.idempotency` is `optional` or
   `required`: key = `ctx.idempotencyKey ?? keys()`, sent as
   `Idempotency-Key`; with `storage`, recorded before the send (`JC2054`
   when the store throws — nothing is sent blind).
5. **Send** through `fetch` with the composed signal (`ctx.signal`,
   `timeoutMs`, the client's `close()`). A rejection is `kind:
   "cancelled"` when the caller's signal aborted (or the rejection is an
   `AbortError`), else `kind: "network"` `JC2051` whose message carries
   the error's **name only** — never its text, which may embed the URL
   and credentials. A timeout is therefore `network`, not `cancelled`.
6. **Assemble** the outcome from status + headers + body (the table
   below); `meta.trace` from `x-jaren-trace`, `meta.etag` from `etag`.
7. **Retry** (§10.4) only under a declared `policy.retry`.
8. Settle the durable record (§10.3) and resolve.

The assembly, row by row — `assembleOutcome` in the package is this
table as code; the test column names the test case that pins the row
(`test/contract/client-outcomes.test.js`, checked against this table):

| status | body | kind | code | retryable | test |
|---|---|---|---|---|---|
| 2xx | empty; the output schema accepts `null` | ok, `value: null` | — | — | `2xx empty body is a null value when the output allows it` |
| 2xx | empty; the output schema rejects `null` | contract | `JC2053` | no | `2xx empty body against a non-null output is JC2053` |
| 2xx | JSON that validates against `output` | ok | — | — | `2xx valid JSON is ok with meta.etag from the header` |
| 2xx | JSON that fails `output` | contract | `JC2053` (details by policy) | no | `2xx invalid output is JC2053 with details by policy` |
| 2xx | not JSON | contract | `JC2053` | no | `2xx non-JSON is JC2053` |
| 304 | — | ok, `value: null`, `meta.notModified`, `meta.etag` | — | — | `304 is ok null with notModified and the etag` |
| other | JSON `{ code }` the operation declares | failure | the declared code; `status`, `details`, `message` from the body (else rendered), `retryable` from the body (else `policy.retry.on`) | body | `an error body with a declared code is a failure` |
| other | JSON `{ code }` a `JC2xxx` taxonomy code | failure | the taxonomy code; `status`, `retryable` from the body | body | `an error body with a taxonomy code is a failure` |
| other | JSON with an unknown/undeclared `code` | contract | `JC2055` (`status` kept) | 5xx/429 | `an undeclared code is JC2055` |
| other | JSON without a string `code` | contract | `JC2055` | 5xx/429 | `an error body without a code is JC2055` |
| other | not JSON, or empty | contract | `JC2055` | 5xx/429 | `a non-JSON error body is JC2055` |
| none | the transport rejected | network | `JC2051` | yes | `a transport rejection is a network outcome named by the error name only` |
| none | the caller aborted | cancelled | `JC2052` | no | `an abort is a cancelled outcome` |
| none | the input failed pre-send | contract | `JC2050` | no | `invalid input is JC2050 and nothing is sent` |
| none | the key store threw pre-send | contract | `JC2054` | no | `a throwing key store is JC2054 and nothing is sent` |

"other" is every status that is neither 2xx nor 304 — 1xx, a redirect
the platform did not follow, 4xx, 5xx. A status outside 100–599 on the
response object is `JC2053` (the transport is broken, not the server).

### §10.3 The client codes and the durable keys

The client codes — `CLIENT_ERRORS` (`@jarenjs/contract/client`) is this
table as data; `CONTRACT_CODES` lists every code; the English catalog
has exactly these msgids beside §7's; a test holds them equal:

| code | kind | msgid | retryable | when |
|---|---|---|---|---|
| `JC2050` | contract | `contract/client-invalid-input` | no | the input fails the operation's input validator (or cannot be encoded) before anything was sent |
| `JC2051` | network | `contract/network` | yes | the transport rejected or the per-request timeout fired; the message names the error's name only |
| `JC2052` | cancelled | `contract/cancelled` | no | `ctx.signal` aborted, the client was closed, or an abort interrupted a retry backoff |
| `JC2053` | contract | `contract/invalid-response` | no | a 2xx body is not JSON or fails the output validator; a response object whose status is not 100–599 |
| `JC2054` | contract | `contract/key-storage-failed` | no | the durable key store threw before the send |
| `JC2055` | contract | `contract/undeclared-response` | 5xx/429 | an error response whose body is not a declared or taxonomy code; `error.status` is kept |
| `JC2056` | — | `contract/not-a-contract` | no | `negotiate`: no description at the well-known path, not a `$contract: "0.1"` description, or another contract `id` |
| `JC2057` | — | `contract/incompatible` | no | `negotiate`: a version neither end declares compatible |
| `JC2058` | contract | `contract/host-failed` | no | the contract effect (§11) projected a thrown host value into an outcome |

`JC2059–JC2069` are reserved for later client-side codes.

**The idempotency key**, client half. For an operation whose
`policy.idempotency` is `optional` or `required` the client **always**
sends a key — `ctx.idempotencyKey` when given (a caller that retries by
hand keeps the same key), else `keys()` — so the server's ledger (§8)
can deduplicate every command the client sends, and a declared `retry`
on a command is safe (the compiler refuses `retry` on a command whose
idempotency is not `required`, `JC0014`). With a `storage` (the
`@jarenjs/app` `createDocStore` adapter shape, `{ read(), write(value) }`,
sync or async) the client records `{ op, key, hash, at }` under
`<store>["jaren-contract"][<contract id>][<op>][<key>]` **before the
request** — `hash` is the request hash of §8 (the same SHA-256 over the
canonical input the server computes), `at` is `now()`, and the input
itself is **never stored** — and drops the record after a terminal
outcome: `ok`, any `failure`, or a `contract` outcome that is not
retryable. A `network` or `cancelled` outcome **leaves it**, so a
process that restarts can ask `client.pending() → [{ op, key }]` and
reconcile each with the server (the ledger's `lookup` by op/scope/key
is the server-side half). A store that throws on the pre-send write is
`JC2054` and nothing is sent; a store that throws on the drop leaves
the record (the conservative side) and the outcome is unaffected.

Concurrent writes and releases are serialized across clients sharing the
same storage adapter object, so each mutation sees the previous write.
A failed mutation does not block later ones. Separate adapter objects,
tabs and processes need coordination in the storage implementation.
`pending()` has no ordering guarantee: concurrent requests can finish hashing
in either order before entering the storage queue. Callers that need a display
order sort the returned records themselves.

### §10.4 Retry

Only under a declared `policy.retry` (`{ max, on }`); never for an
operation without one. Retried: a `network` outcome, and a `failure`
outcome whose `error.code` is in `retry.on` (declared codes and
`JC2xxx` taxonomy codes alike — `JC2009` in-progress is a natural
member). At most `max` further attempts; the backoff before attempt
`n+1` is `min(1000 · 2^n, 8000)` ms plus up to 250 ms of jitter through
`sleep(ms, signal)`; an abort during the backoff resolves `cancelled`.
The idempotency key stays the same across the attempts (that is what
makes them safe); `meta.attempt` stays the caller's — retries are
inside one attempt, not new ones.

### §10.5 `url(op, input)` and `negotiate()`

`url(op, input)` builds `baseUrl + path + ?query` for **any** operation,
opaque ones included, validating only the path/query members of the
input (against their declared schemas, compiled on first use);
`JC1005` for an unknown operation, `JC1008` for a non-object input or
members that fail their schema. It is what an `<img src>` or a link uses
for an opaque operation; the bytes themselves are the host's to fetch.

`negotiate({ signal })` fetches the server's well-known description
(§7.6) and answers `{ compatible, reason, server, error }` with `reason`
one of:

| reason | when | compatible | error |
|---|---|---|---|
| `same-version` | `server.version === contract.version` (both `null` included) | yes | — |
| `server-accepts` | `contract.version ∈ server.compat` | yes | — |
| `client-accepts` | `server.version ∈ contract.compat` | yes | — |
| `version-mismatch` | none of the above | no | `JC2057` |
| `not-a-contract` | no 200, not JSON, not a `$contract: "0.1"` description with an `operations` array, or the server's `id` differs from the client's (both non-null) | no | `JC2056` |
| `unreachable` | the transport rejected | no | `JC2051` |

`server` is `{ id, version, compat, revision }` as the server described
itself (`null` when unreachable or not a contract). **Nothing else is
inferred**: an unrelated service on the port is exactly `not-a-contract`;
two unversioned contracts are `same-version`.

### §10.6 `bytes(op, input, ctx)` — the opaque operations

`bytes(op, input, ctx) → Promise<Outcome>` is `invoke`'s twin for an
**opaque** operation (§4.5): the same pre-send validation of the
transport members (`JC2050`), the same URL and header assembly, one
request through the injected `fetch`, and a D6 outcome — but its
success owns a **live stream**, never a JSON value. `op` must be opaque
(`JC1005` for a JSON operation: use `invoke`); `ctx` is `{ signal?,
attempt?, headers?, ifNoneMatch?, ifMatch?, body? }` — no idempotency
key, an opaque operation carries none — where `body` is the request
body to send: text, bytes, a Web `ReadableStream`, an async iterable of
`Uint8Array` chunks (wrapped in a stream that pulls one chunk per
demand and cancels the iterator once), or none (`JC1008` for anything
else). A streamed upload goes out with `duplex: "half"`; a body without
a caller's `content-type` is sent as the operation's `media`.

The outcome: a `2xx` is `{ ok: true, value: { status, headers, media,
body }, meta }` — `headers` the response headers under lowercase names,
`media` its `content-type` (`null` when none), `body` the response's
`ReadableStream<Uint8Array>` (`null` when the platform has none) which
the **caller** reads; the client never calls `text()` or
`arrayBuffer()` on a success. A `304` is `ok: true` with `body: null`,
`media: null` and `meta.notModified`. Every other status is classified
exactly as §10.1 classifies an `invoke` answer — a declared or taxonomy
code is a `failure`, anything else `contract` `JC2055` — from the error
body's text. A transport rejection before the headers is `network`
(`JC2051`), an abort `cancelled` (`JC2052`). **`bytes` never retries**,
whatever `policy.retry` declares: an upload stream cannot be replayed
and a body already exposed cannot be re-read — a failure after the
headers reaches the caller as the rejection of its own read of `body`.
`meta` carries the trace, the attempt and the `etag`.

## §11 The app binding

`contractAppBinding(contract, { namespace = "contract/", statePath =
"/contract", ops = contract.ids })` (`@jarenjs/contract/app`) returns
**pure JSON** — `{ slice, actions, subs, schema, effect: "contract",
subscription: "contract-stream" }` — the `fsmToApp`/`liveAppBinding`
shape: a state slice the host mounts at `statePath`, action documents
it spreads into its `actions`, subscription entries it spreads into its
`subs` (one per subscribe operation, `[]` otherwise — §11.4), and the
slice's JSON Schema for `validateState`. Neither package imports the
other; the documents cross as JSON and the task-effect factory
(`createTaskEffect` from `@jarenjs/app`) crosses as a function the host
passes to `createContractEffect`. `ops` may name a subset (`JC1007` for
an operation the contract does not declare).

### §11.1 The generated document

Per operation, **one task slot** in the slice — `{ id: 0, status: "idle",
kind: null, value: null, error: null, meta: null }` — and **three
actions**, in the async-task convention of `@jarenjs/app`'s TASKS.md
(state-side identity, guard-first completion):

```jsonc
// <namespace><op>/start — $payload is the operation's input
{ "patch": [
    { "op": "replace", "path": "/contract/catalog.load/id",     "value": { "$add": ["$.contract['catalog.load'].id", 1] } },
    { "op": "replace", "path": "/contract/catalog.load/status", "value": "loading" },
    { "op": "replace", "path": "/contract/catalog.load/kind",   "value": null },
    { "op": "replace", "path": "/contract/catalog.load/error",  "value": null } ],
  "effects": [ { "run": "contract", "with": {
    "op": "catalog.load", "input": "$payload",
    "id": { "$add": ["$.contract['catalog.load'].id", 1] },      // the SAME increment as the patch — everything evaluates pre-transition
    "done": "contract/catalog.load/done", "slot": "catalog.load" } } ] }

// <namespace><op>/start of an operation whose policy.task is exhaust — the same document behind a state-side guard
{ "$if": [ { "$ne": ["$.contract['product.save'].status", "loading"] },      // a $if without else is the empty sequence (APP-FORMAT §3.2):
  { "patch": [ "…the four replaces…" ], "effects": [ "…the one contract effect…" ] } ] }   // no patch, no effect, no render while loading

// <namespace><op>/done — $payload is { id, result: outcome } (or { id, error: outcome } for a projected host throw)
{ "$if": [ { "$eq": ["$payload.id", "$.contract['catalog.load'].id"] },        // the id guard: a stale response is the empty sequence
  { "$let": { "outcome": { "$coalesce": ["$payload.result", "$payload.error"] } },
    "$return": { "$if": [ { "$eq": ["$outcome.ok", true] },
      { "patch": [ { "op": "replace", "path": "/contract/catalog.load/status", "value": "done" },
                   { "op": "replace", "path": "/contract/catalog.load/kind",   "value": null },
                   { "op": "replace", "path": "/contract/catalog.load/value",  "value": "$outcome.value" },
                   { "op": "replace", "path": "/contract/catalog.load/meta",   "value": "$outcome.meta" },
                   { "op": "replace", "path": "/contract/catalog.load/error",  "value": null } ] },
      { "patch": [ { "op": "replace", "path": "/contract/catalog.load/status", "value": "error" },
                   { "op": "replace", "path": "/contract/catalog.load/kind",   "value": "$outcome.kind" },
                   { "op": "replace", "path": "/contract/catalog.load/error",  "value": "$outcome.error" },
                   { "op": "replace", "path": "/contract/catalog.load/meta",   "value": "$outcome.meta" } ] } ] } } ] }

// <namespace><op>/reset — releases the slot; id, value and meta are untouched
{ "patch": [ { "op": "replace", "path": "/contract/catalog.load/status", "value": "idle" },
             { "op": "replace", "path": "/contract/catalog.load/kind",   "value": null },
             { "op": "replace", "path": "/contract/catalog.load/error",  "value": null } ] }
```

Rules the generator keeps:

- The slot id read is `$<statePath>['<op>']` — a dotted operation id is
  a bracketed RFC 9535 member name, so `statePath` MUST be a chain of
  identifier-safe segments (`JC1007` otherwise); the patch paths are
  plain JSON Pointers (`/contract/catalog.load/id`). Action names carry
  the operation id verbatim (`contract/catalog.load/start`); the app
  places no restriction on action names.
- **The id guard is the guarantee.** The `done` action compares
  `$payload.id` with the slot's id first; a payload whose id is not the
  current one yields the empty sequence — no state change, no render, no
  subscriber — so an out-of-order older response can never overwrite a
  newer one. Cancellation (below) is the optimization.
- **The state slot and the effect agree in every mode (D10).** A task
  mode is never *named* in the document or in the effect props; the
  generator derives the document's state-side guards from `policy.task`
  exactly as it derives the document's shape from `kind`. With one slot
  per operation, what a second `start` does while the slot is `loading`:

  | `policy.task` | in state | in the effect | which completion lands |
  |---|---|---|---|
  | `switch` | the id increments (newest wins) | the predecessor is aborted (its cancelled outcome dispatches nothing) | the newest; a predecessor's completion that arrives anyway is rejected by the guard |
  | `exhaust` | **nothing** — the `start` is wrapped in `$if: [{ $ne: [<slot>.status, "loading"] }, …]`, so the id stays, no effect runs, no render | the duplicate start would be ignored (TASKS.md); it never reaches the effect | the one in flight: it carries the current id and **lands** — a double-click runs once and its result reaches state |
  | `concat` | the id increments | the start queues and runs after its predecessors, in order | **latest wins**: only the completion carrying the current id lands; earlier results and errors are dropped from state; `status` stays `loading` until the newest lands |
  | `parallel` | the id increments | the start runs concurrently | **latest wins**, as `concat` — the newest id lands whenever it arrives, the others are provable no-ops |

  A consumer that needs every result of a `parallel` fan-out needs a
  slot per key (one slot per operation is the rule here; keyed slots
  are a roadmap candidate).
- **`reset` releases a slot.** It writes `status: "idle"`, `kind: null`,
  `error: null` and leaves `id`, `value` and `meta` alone — the id stays
  monotonic so a late completion of a cancelled attempt is still
  rejected, and the last good value survives a reset as it survives an
  error. It is the one way out of a slot a host `cancel(slot)` left
  `loading` on an `exhaust` operation (a cancelled outcome dispatches
  nothing, and the guarded `start` is a no-op while `loading`), and the
  ordinary "dismiss the error" action, mode-independent.
- **A failed reload keeps the last good `value`**: the error branch
  writes `status`, `kind`, `error`, `meta` and touches `value` not at all.
- **`kind` says which class of failure the slot holds** — the outcome's
  `kind` (`"failure"` a declared or taxonomy error, `"network"`,
  `"contract"`; `"cancelled"` never lands) while `status` is `"error"`,
  `null` otherwise (`start`, the ok branch and `reset` write `null`) —
  so a view shows "you are offline" beside "the server refused this"
  without parsing `error.code`.
- `schema` is the slice's JSON Schema: per operation `id` (integer ≥ 0),
  `status` (`idle | loading | done | error`), `kind` (`null | failure |
  network | contract` — the enum is pinned, the cross-member invariant
  "`kind` is `null` exactly when `status` is not `error`" is not: a JSON
  Schema `if/then` would cost every transition and the generated actions
  are the only writer), `value` (the operation's output schema **or
  null**), `error` (the §10.1 error object or null), `meta` (the §10.1
  meta or null); when the contract has `$defs` the schema carries them
  under its own `$defs` and declares an `$id`
  (`urn:jaren:contract-app:<contract id>`) so the output schemas'
  `#/$defs/…` references resolve wherever the host mounts the slice
  schema inside its `validateState` schema.

### §11.2 The effect

`createContractEffect(client, { createTaskEffect, projectError?, catalog? })`
returns **one** effect handler — register it as `effects: { contract: … }`
— carrying `cancel(slot)`, `cancelAll()` and `dispose()` (which
`app.destroy()` calls). It owns one `createTaskEffect` per distinct
`policy.task` mode the client's contract uses, built lazily on the
first descriptor of that mode, each with `run = (props, signal) =>
client.invoke(props.op, props.input, { signal, attempt: props.id })`;
a descriptor is routed by `props.op` to its operation's mode (a `switch`
read and an `exhaust` command live in one effect; the mode never
appears in the app document). An unknown `op` is `JC1005` — a
`TypeError` the loop reports as `JA2007`. `props` reach the inner
effect unchanged (`id`, `done`, `fail`, `slot` are TASKS.md's).

Settlement, exactly: `run` resolves the outcome → the task effect
dispatches `done` with `{ id, result: outcome }`; a `kind: "cancelled"`
outcome makes `run` throw an `AbortError` → **nothing is dispatched**
(a superseded task is dead by design) — a slot left `loading` by a host
`cancel(slot)` is released by `<namespace><op>/reset` (or by the next
`start` on a non-`exhaust` operation); `dispose()` is terminal, nothing
to release; a value that is not an outcome
(a foreign client) and a **thrown** host value go through `projectError`
— the host's own projector first, then the `JC2058` outcome — so the
error member of `{ id, error }` is always an outcome, never a string,
and the generated `done` action reads it through the same `$coalesce`.
A `JC2058` message carries nothing of the thrown value.

### §11.3 Composition

```js
import { createApp, createTaskEffect } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { openHttpClient } from '@jarenjs/contract/client';
import { contractAppBinding, createContractEffect } from '@jarenjs/contract/app';

const client = openHttpClient(contract, { baseUrl });
const { slice, actions, schema } = contractAppBinding(contract, { ops: ['catalog.load', 'product.save'] });
const validate = new JarenValidator().compile({ type: 'object', required: ['contract'], properties: { contract: schema } });

const app = createApp({ state: { contract: slice, draft: null }, view, actions: { ...actions, ...own } }, {
  effects: { contract: createContractEffect(client, { createTaskEffect }) },
  validateState: (state) => validate(state),
});
app.dispatch('contract/catalog.load/start', { since: '2026-01-01T00:00:00Z' });
// … later: app.getState().contract['catalog.load'] → { id: 1, status: 'done', kind: null, value: {…}, error: null, meta: {…} }
```

The runnable version of this composition, driven against a real
`serveHttp` dispatcher, is [APP-INTEGRATION.md](APP-INTEGRATION.md),
executed verbatim by the test suite.

### §11.4 Subscribe operations: the generated subscription

A subscribe operation becomes a **subscription**, not a task slot. Its
slice member is `{ id, status: "idle" | "live" | "error", kind, input,
value, error, meta, seq }` — `input` is what `start` was dispatched
with, kept in state so the generated subscription entry can resolve it;
`value` is the maintained snapshot; `seq` the last applied emission's.
The generated actions:

- `<ns><op>/start` — guarded on `status !== "live"` (the state-first
  rule of an exhaust command's start: no second subscription while one
  is live): increments `id`, sets `status: "live"`, clears
  `kind`/`error`, stores `$payload` as `input`. It emits **nothing** —
  the subscription below starts because its `when` sees the liveness.
- `<ns><op>/stop` — `status: "idle"`; the app's own reconciliation runs
  the subscription's cleanup (the client's `stop()`, exactly once).
- `<ns><op>/snapshot` — guarded on `$payload.id` against the slot id;
  sets `value` and `seq`.
- `<ns><op>/patch` — guarded on the id **and** `$payload.seq` strictly
  greater than the slot's; replaces `value` with `$payload.value` and
  advances `seq`. The payload's `value` is the WHOLE patched document:
  an action's `patch` member is a literal op list whose members are
  query expressions — it cannot splice a runtime array of RFC 6902 ops
  — so the handler applies the emission with `@jarenjs/json/patch`
  (copy-on-write; structural sharing preserved) and the action replaces.
- `<ns><op>/error` — guarded on the id; `status: "error"`, the
  outcome's `kind`/`error`/`meta`.
- `<ns><op>/reset` — as for tasks: `status "idle"`, `kind`/`error`
  cleared, everything else kept.

Reconnect is an opt-in **binding choice**, not a new stream policy:
`contractAppBinding(contract, { subs: { "data.live": { reconnect: { max: 2 } } } })`
embeds the per-operation option in its generated `withQuery` props and
`createContractSubscription` forwards it to `client.subscribe`. During
retry/backoff the slot stays `live`, retaining its id, value and sequence;
replay patches continue against the same cached document. Exhaustion
surfaces `JC2097` in the slot. Explicit server end and non-network errors
are terminal. Stop/reset/destroy cancel the active stream and prevent
further retries. Without the option a lost stream surfaces immediately.
Unknown/unselected/non-subscribe operations and malformed reconnect
options are `JC1007`. Reconnection is supplied by the HTTP client; port
and local clients retain their existing terminal channel lifecycle.

The subscription handler rejects stale sequence numbers **before**
applying a patch to its cached document, and ignores callbacks after
cleanup; the generated action guards provide the state-side check too.

The binding additionally returns `subs` — one entry per subscribe
operation — and names its handler in `subscription`:

```jsonc
{ "run": "contract-stream",
  "when": { "$eq": ["$.contract['data.live'].status", "live"] },
  "withQuery": { "op": "data.live", "id": "$.contract['data.live'].id",
                 "input": "$.contract['data.live'].input",
                 "snapshot": "contract/data.live/snapshot",
                 "patch": "contract/data.live/patch",
                 "error": "contract/data.live/error" } }
```

`withQuery` (not `with`) because the resolved props carry the slot's
`id` and `input` from state — APP-FORMAT §5.3's restart rule then keys
the instance by the resolved props by value. The handler is
`createContractSubscription(client)` (`@jarenjs/contract/app`), a plain
`(props, dispatch) => cleanup` — no task-effect factory is needed. It
calls `client.subscribe`, applies each emission host-side, and
dispatches the named actions with `{ id, … }` payloads; an `onError`
outcome lands in the error action as-is, and a server `end` lands there
as a `network`-kind outcome with the channel-closed code (`JC2074`) —
the stream is gone and the slot says so; reconnection is a fresh
`start`, never automatic. The slice schema pins the subscribe slot like
the task slots (`status` to its three states, `input` to the
operation's input schema or `null`, `seq` to a non-negative integer).

## §12 Projections

Everything a consumer wants **beside** the runtime is a projection of the
same compiled contract (`@jarenjs/contract/project` — the one subpath of
this package that imports `@jarenjs/emit`, and the CLI loads it lazily,
only for `types` and `docs`, so a bundle that never projects never
carries it): the public projection every other artifact
is built on (§12.1), OpenAPI 3.1 (§12.2), TypeScript declarations
(§12.3), Markdown reference documentation (§12.4) and AI tool
definitions (§12.5), with the `jaren-contract` CLI (§12.6) writing and
`--check`ing them in CI. A projection takes a **compiled** contract —
never a raw document — so it renders resolved bindings and materialized
policies, and every projection is **deterministic**: the same contract
renders byte-identical artifacts.

### §12.1 The public projection — normative, the revision hashes it

`publicProjection(contract, { ops? })` is a JSON document that is itself
a **valid `$contract` 0.1** (it compiles, and projecting the compile
yields the same bytes): the browser-safe subset a client needs and no
more, and the exact bytes the contract revision will hash. Because the
hash is a compatibility claim, the member order is **normative**:

- root: `$contract`, `id`, `version`, `compat`, `$defs`, `operations` —
  each present only when the contract carries it (`$defs` only when a
  retained schema reaches one);
- operation (document order): `kind`, `input`, `output`, `errors`,
  `policy`, `http`, `doc` — `input`, `errors` and `doc` only when
  declared;
- error declaration: `status` (always, resolved), `schema` (when
  declared);
- policy: `task`, `idempotency`, `revision` (when declared), `cache`,
  `retry` (when declared), `audience` — every default materialized;
  **`limits` and `errors.details` are server-side knobs and never
  appear**;
- http: `method`, `path` (canonical `{name}` template), `in` (every
  member's location), `body` (when a whole-body member is declared),
  `status`, `media` — the canonical binding is written out like any
  declared one;
- `$defs`: exactly the entries reachable from the retained operations'
  `input`/`output`/error schemas by same-document `$ref` (transitively;
  an anchor or a pointer into an entry counts as the entry), in
  **first-reference order** — walking operations in document order,
  each operation's `input`, `output`, then its errors in declaration
  order.

Retained = the operations whose `policy.audience` is not `"server"`,
narrowed further by `ops` when given (`JC1008` for an id the contract
does not declare; a listed `server` operation is still not retained).
Schema subtrees are the compiled document's own (frozen); the
composition is fresh.

### §12.2 OpenAPI 3.1

`toOpenApi(contract, { info?, servers?, lenient? })` →
`{ document, dropped }`: a valid OpenAPI **3.1.0** document rendered by
a JSLT stylesheet shipped as JSON (`src/project/openapi.jslt.json`,
compiled once at module scope), built on the public projection. The
test suite validates the rendered document against the vendored
official OpenAPI 3.1 meta-schema with `JarenValidator`
(`test/contract/fixtures/openapi-3.1.schema.json`, Apache-2.0 — the
suite validating its own projection with its own validator is the
point). The mapping:

| contract | OpenAPI |
|---|---|
| — | `openapi: "3.1.0"`, `jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema"`, `info` (title/version defaulting to the contract id/version), `servers` when given |
| operation | `paths[<canonical path>][<lowercased method>]`, paths sorted by path then method; `operationId` = the id; `summary` = `doc`'s first line (`description` = the whole `doc` when it has more); `tags` = the id's first dotted segment |
| `http.in` `path`/`query`/`header` members | `parameters` (name, `in`, `schema`, or `content.application/json.schema` for JSON query members; `required` from the effective input's `required`, a path parameter always required); an idempotent operation gains the `Idempotency-Key` header parameter (required under `"required"`) |
| body members | `requestBody`: the object of the body-located members (their `required` intersection, the input's `additionalProperties`); the whole input schema when every member is body-located; the member's own schema under `http.body`; `content[<http.media>]` |
| `output`, `http.status` | `responses[<status>]` with the output schema; no content on `204`; opaque → `content[<media>]: { type: "string", format: "binary" }` |
| declared `errors` | one response per status: the D7 wire-error schema (`code` **enum-pinned** to the codes of that status, `details` the declared schema when present) |
| the binding's own statuses | shared `components.responses` (`BadRequest` 400, `NotFound` 404, `IdempotencyConflict` 409 on idempotent operations, `PayloadTooLarge` 413, `UnsupportedMediaType` 415 on body-carrying operations, `InternalError` 500), `$ref`'d per operation unless a declared error already answers that status |
| `$defs` | `components.schemas`, every `#/$defs/X…` rewritten `#/components/schemas/X…` |
| policy | the `x-jaren-policy` extension: `{ task, idempotency, cache, revision?, retry? }` verbatim (an `x-` extension is OpenAPI's sanctioned place) |

An opaque operation never meets a `requestBody` here: the compiler
refuses a body-located member on one (`JC0017`, §4.5), so the mapping
needs no rule for it.

**The keyword policy — map-or-reject, nothing silent.** Every schema the
projection carries is walked once:

| keyword | treatment |
|---|---|
| `nullable: true` | mapped: `"null"` added to `type` (dropped + reported when there is no `type` to widen) |
| `nullable: false` | dropped + reported (asserts nothing in 3.1) |
| boolean `required` | **rejected** `JC0060` at the keyword; under `lenient` dropped + reported (the array form is JSON Schema's own and passes) |
| `$query`, `$data`, `errorMessage`, `x-form` and every `x-*` | dropped + reported (Jaren-side; the wire never enforced them for a peer) |
| `components` inside a schema | **rejected** `JC0060`, `lenient` or not (a document member has no schema reading) |
| a same-document `$ref` that lands outside the projection's `$defs` (an anchor, `#`, a pointer into an operation) | **rejected** `JC0060`; under `lenient` dropped + reported (the schema is honestly wider) |
| `const`, `enum`, `default`, `examples`, `example` | data — copied verbatim, never walked |
| everything else | copied, subschemas walked |

`dropped` is the audit trail: `[{ docPath, keyword, reason }]` with the
`docPath` of the keyword **in the contract document**, in document
order. The projection's own code, in the `JC0050–JC0069` range beside
§6's table:

| code | condition |
|---|---|
| JC0060 | the OpenAPI projection met a schema keyword it cannot map honestly: a boolean `required` or a same-document `$ref` that lands outside `$defs` (both dropped and reported under `lenient`), or a `components` member inside a schema (`ContractCompileError`, `docPath` into the contract document) |

### §12.3 TypeScript

`toTypeScript(contract, { banner? })` renders one `.d.ts` on
`@jarenjs/emit`'s type model (`compileEmitModel` + `renderTypeScript`,
the suite's one declaration renderer): per public operation
`<PascalOp>Input` / `<PascalOp>Output` / `<PascalOp><PascalCode>Details`
(collisions uniqued with a numeric suffix; a `$defs` entry keeps its own
name), the reachable `$defs` once, then — fixed text in a JTLT
stylesheet (`src/project/typescript.jtlt.json`) — `Operations` (the
typed operation map: kind, input, output, the declared error codes as a
literal union), `UrlOperations` (opaque operations included, for
`Client.url`), `ByteOperations` (the opaque operations only, for
`HttpClient.bytes`), and `Meta`, `WireError`, `Outcome<T>`,
`InvokeContext`, `Client`, `ByteContext`, `ByteResponse`, `HttpClient`
(`Client` plus `bytes` over `ByteOperations`, §10.6 — the
binding-neutral `Client` never requires a byte method), `Failure`,
`CarrierName`, `HandlerContextBase<Host>`, `HttpHandlerContext<Host>`,
`ChannelHandlerContext<Host, Carrier>`, `HandlerContext<Host = null,
Carrier = 'http'>` and `Handlers<Host = null, Carrier = 'http'>` — the
handler context selected by carrier (§7.7): omitted generics are the
HTTP context with `host: null`, exactly the shape it always was plus
`carrier` and `host`; a port or local context spells the request-line
members, the body, the key, `etag` and `status` as `null` rather than
omitting them, so an HTTP-only member is a compile error there; a
carrier union is a discriminated union to narrow on `ctx.carrier`. `Meta` and
`WireError` spell **exactly** the fixed D6 shapes (§10.1) —
`OUTCOME_META_MEMBERS`/`OUTCOME_ERROR_MEMBERS` are the runtime twins and
a test holds the text to them; `details` is `unknown` and `status`
`number | null`, never optional members. An input-less operation's
`input` is `null`; an opaque operation appears in `UrlOperations` and
`ByteOperations`, never in `Operations`; a contract without one still
declares an empty `ByteOperations`, so `bytes` is uncallable rather
than absent.

One convention rides on top of emit's reading, and it is the suite's:
a string with `format: "date-time"` or `format: "date"` is declared as
`DateTime` — `string & { __jarenTag: 'date-time' }` — rendered once per
document and referenced from every position, an array item as much as a
member. Emit itself records a format only as a dropped constraint; the
brand is applied by this projection so a consumer's generated types
agree with `@jarenjs/db`'s entity types (`entityEmitModel`) and with
`@jarenjs/linq`'s schema and contract pens, which read a date format the
same way. A contract that already declares a `$defs` entry named
`DateTime` keeps it; the brand takes the next free name.

### §12.4 Markdown

`toMarkdown(contract, { title? })` renders one reference document: the
title and version, an operations table (id, method, path, kind, task,
idempotency), one section per public operation (its `doc`, the policy
line, parameters, body, responses, declared errors) and a Types part
rendered by emit's Markdown target over the **same** type model as
§12.3 — so every type name a section links to is a heading that exists.

### §12.5 AI tools

`contractTools(contract, client, { ops?, name? })` → an array of
`{ name, description, inputSchema, execute }` — the `ToolDef` shape
`@jarenjs/ai`'s `createToolbox().add` takes and WebMCP's `registerTool`
reads, **without importing that package** (the generated-document rule:
the shape is a plain object; the test suite registers them into a real
toolbox). Per public, invokable operation (opaque and subscribe
operations are skipped by the default set and refused when `ops` names
one — a tool carries one invoke, not bytes and not a stream), in
document order:

- `name`: the id with `.` → `_` (injective — an id carries no `_`), or
  `options.name(id)`; every name MUST match OpenAI's
  `^[a-zA-Z0-9_-]{1,64}$` and two operations mapping to one name is
  `JC1008`;
- `description`: the `doc`, or a derived `<kind> operation <id>
  (<METHOD> <path>)`;
- `inputSchema`: the operation's input schema made **self-contained** —
  the `$defs` it reaches inlined under the schema's own `$defs`
  (`bundleSameDocument`, the suite's one same-document bundler) — or a
  closed empty object schema for an input-less operation;
- `execute`: `(args) => client.invoke(op, args)` (`null` for an
  input-less operation), resolving the outcome JSON — a model sees the
  same `{ ok, value | error, meta }` an app does, and a failed outcome
  is a resolved value, never a rejection.

Opaque operations are skipped by default and refused (`JC1008`) when
`ops` names one — a tool carries JSON; an opaque operation is reached
through `client.url`.

### §12.6 The CLI

`jaren-contract <describe|public|openapi|types|docs> --contract <file>
[--out <dir|file>] [--check] [--info-title T] [--info-version V]
[--lenient]` (the package `bin`). `describe` prints `describe()`;
`public`/`openapi` print or write JSON (two-space indent, trailing
newline); `types`/`docs` the text artifacts; `--out` names a file, or a
directory that gets `<contract id><extension>`
(`.describe.json`/`.public.json`/`.openapi.json`/`.d.ts`/`.md`).
`--check` writes nothing and exits **1** when the file differs from
what the document projects today — the CI drift gate; exit **0** when
current or written; exit **2** on a usage error, an unreadable document,
or a compile refusal, printed as `code docPath reason`. `openapi`
reports every dropped keyword on stderr; without `--lenient` a
rejectable keyword is exit 2 with `JC0060` and its `docPath`.

## §13 The breaking-change diff

`diffContracts(a, b)` (`@jarenjs/contract/diff`) classifies every change
from contract `a` (what consumers hold today) to contract `b` (what they
would meet) into `{ breaking, additive, neutral, unknown }` by the rule
table below. It takes compiled contracts or raw documents (a document is
compiled first, so a malformed one refuses with its own `JC00xx` before
any comparison). Each entry is a
`Change = { kind, op, docPath, from?, to?, rule, note? }` where `kind` is
a stable slug, `rule` names the row, and `docPath` points into the
document that carries the change — into `a` for a removal, into `b`
otherwise — composed over the *resolved* structure, so a constraint
reached through a bare `{ "$ref": "#/$defs/X" }` hop reports the path a
validator error would name.

| # | Change | Class |
|---|---|---|
| R1 | operation removed | breaking |
| R2 | operation added | additive |
| R3 | `kind`, `http.method`, `http.path` (shape — variable *names* are not shape), `http.status`, `http.media` (opaqueness included), a member's `http.in` location, or `http.body` changed | breaking |
| R4 | input: a member added to `required` (or a new required member) | breaking |
| R5 | input: a member removed while the new input schema is `additionalProperties: false` (or the input removed entirely) | breaking; otherwise `neutral` with a note (the member is now ignored, not validated) |
| R6 | input: a member's schema narrowed (type set shrinks, `enum`/`const` shrinks, `maximum` lowers, `minimum` rises, `maxLength` lowers, `minLength` rises, `pattern` added) | breaking |
| R7 | input: a member's schema widened (the inverse of R6), an optional member added, or a member dropped from `required` | additive |
| R8 | output: a member removed, made optional (dropped from `required`), or narrowed | breaking |
| R9 | output: a new member (optional or required), a member added to `required`, or widened | additive |
| R10 | error code removed, or its `status` changed | breaking |
| R11 | error code added | additive |
| R12 | `policy.idempotency` `none/optional → required` (a client must now send a key) | breaking; `required → optional/none` and `none ↔ optional` additive |
| R13 | `policy.task`, `policy.retry`, `policy.cache`, `policy.revision` or `doc` changed | neutral |
| R14 | `policy.audience` `public → server` | breaking; the reverse additive |
| R15 | a schema construct the checker does not model differs between the two (`anyOf`/`oneOf`/`allOf`/`if`/`not`/`$dynamicRef`, a `format`, a *changed* `pattern`, an external or sibling-carrying `$ref`, a changed error `details` schema, …) | **unknown** — reported, never silently classed |

Riders the rows carry:

- **R3 covers the whole wire shape.** The order's five members plus a
  member's `in` location and the whole-body `body` member — a member
  that moves from `query` to `header` rewrites the request exactly like
  a moved path, so it classifies with the binding row. Renaming a path
  *variable* alone is not an R3 change (the shape compares with
  variables blanked); the renamed input member surfaces through
  R4/R5/R7 instead.
- **R12 and `retry`.** The `required → optional` additive row holds for
  operations without `policy.retry`: an `optional`-idempotency command
  with `retry` cannot compile (`JC0014`, §3.1), so `diffContracts`
  never meets that pair.
- **The schema walk models exactly R6 plus structure.** Object members
  (`properties`, `required`, `additionalProperties`) and `items`
  recurse; the R6 keyword set compares as constraints; pure annotations
  (`title`, `description`, `examples`, `$comment`, `deprecated`) never
  move a wire byte and are ignored; **everything else that differs is
  R15**. Nested member changes classify by narrowing/widening (adding a
  constrained optional member to an open nested object narrows it;
  removing one from an open object widens it); the *top-level* input
  members classify by R4/R5/R7, and output members by R8/R9 at every
  depth.
- **Audience is the compatibility surface.** Operations whose
  `policy.audience` is `server` on **both** sides are skipped entirely;
  an audience flip is R14 and subsumes the operation's other changes.
  `policy.limits` and `policy.errors.details` are server-side knobs
  outside the public projection and are never reported.

`isCompatible(clientContract, serverContract)` (exported from
`@jarenjs/contract/diff`, one implementation shared with the client's
`negotiate()`) is the complementary *declared* answer: `true` when the
two ends state the same `version`, or when either end's `compat` names
the other's `version` — `compatReason` returns which rule held
(`'same-version' | 'server-accepts' | 'client-accepts' | null`).
`diffContracts` computes what changed; `isCompatible` reads what the
authors claim. Never derive one from the other: a `version` is bumped
by a person, a revision (§14) moves by itself.

The CLI's compatibility gate: `jaren-contract diff --from a.json --to
b.json [--fail-on breaking[,unknown,…]]` prints the classified diff as
JSON and exits **1** when any `--fail-on` class is non-empty (exit 0
otherwise; exit 2 on a usage error, an unreadable file or a compile
refusal).

## §14 The revision

`contract.revision() → Promise<string>` is the lowercase hex SHA-256
over the RFC 8785 canonical bytes of the **public projection** (§12.1)
— computed with the platform's `crypto.subtle`, memoized per compiled
contract, so `compileContract` stays synchronous and the digest is paid
at most once per process (measured here: ~4–5 ms for a 123-operation,
160 KB document). Because it hashes the projection and the projection
materializes defaults in a normative member order:

- two compiles of equal documents agree, across processes and platforms;
- a change to any client-observable member — a public operation's
  schemas, binding, declared errors, client-facing policy — moves it;
- a change a client cannot observe — a `server`-audience operation, a
  `policy.limits` value, an `errors.details` level, a `doc`-only edit
  *does* move it (`doc` is projected) but a declared binding rewritten
  to its own defaults does **not** (the projection materializes
  defaults, so two documents that behave alike hash alike).

`describe()` carries `revision: <hex | null>` — `null` until someone
awaited `revision()`; `describe()` stays synchronous and never computes
it. The HTTP server computes it **lazily on the first well-known
request** (§7.6): `GET /.well-known/jaren-contract` awaits the digest
once and answers the description with `revision` filled; the client's
`negotiate()` reads it and carries it in `meta.revision` of every
subsequent outcome — correlation data, never the compatibility decision
(that is `version`/`compat`, §13). The revision is not a `version`:
never bump `version` merely because the revision moved, and never
compare revisions to decide compatibility.

A public projection that cannot be canonicalized has no revision:

| code | condition |
|---|---|
| JC0061 | the public projection is not canonicalizable, so no revision exists — a string member carrying an unpaired surrogate, say (`ContractCompileError` rejected from `revision()`; its `docPath` points at the offending value *inside the projection*) |

(The compiler's document snapshot already refuses non-finite numbers,
functions and cycles at `JC0001`, so an unpaired surrogate in a string
is the reachable case.) The well-known responder reports the refusal to
`onError` once and honestly answers `revision: null`. The revision and
the idempotency request hash (§8) are the same computation —
`canonicalSha256` in `@jarenjs/json` — never a 32-bit content
fingerprint, which collides.

## §15 The local binding

`openLocalClient(contract, handlers, options) → Client` — the same
operation pipeline as every server binding, with no wire: the test
seam, SSR, a CLI calling its own operations. The client and the server
are one object; `serveLocal` is the same factory under the serve name,
for symmetry with the driver pairs of the other bindings. The `Client`
is the binding-agnostic shape of §10 minus what cannot exist here:
`invoke`, `capabilities`, `contract`, `describe`, `close` — no `url`,
no `negotiate`, no `pending`.

`invoke(op, input, ctx)` with `ctx = { signal?, attempt? }`:

1. an unknown operation, or an opaque one, throws `JC1005` — non-JSON
   media does not exist in-process (`capabilities.media: false`); so
   does a subscribe operation — this binding carries no streams
   (`capabilities.stream: false`), and needs no handler for one;
2. the input is validated with the operation's compiled validator; a
   refusal is the pre-send `JC2050` outcome (kind `contract`, details
   by `policy.errors.details`) and nothing ran — the same refusal every
   client binding shares;
3. the host lifecycle's `identify` runs (§7.7, `carrier: "local"`,
   the request-line members `null`), then the validation, then
   `acquire`, and the handler runs inside `enter` through the neutral
   pipeline with the frozen context `{ op, trace, carrier: "local",
   host, signal, method: null, path: null, params: null, headers: {},
   body: null, fail, idempotency: null, etag: null, status: null }` —
   `trace` from the `trace` option (default `crypto.randomUUID`),
   `signal` the caller's composed with the client's closer. `etag`,
   `status` and `body` are `null`, never callable: statuses, entity tags
   and bytes do not exist here, and a handler that reaches for them
   fails honestly (`JC2070`) instead of pretending; a hook fault is
   `JC2070` too, a hook's declared failure is a `failure` outcome, and
   the releases run before the outcome is exposed;
4. the outcome (§10.1 shapes, assembled by the same assembler):

| settlement | outcome |
|---|---|
| the output, valid | `{ ok: true, value, meta }` — `meta.trace` the generated trace |
| a declared failure (`ctx.fail`, or a thrown `ContractRuntimeError` whose code the operation declares) | kind `failure` with `{ code, message, status: null, details, retryable }` — `status` is `null` and PRESENT (D6: a binding that cannot carry a member carries `null`, never omits it); the message is `contract/error/<code>` from the host catalog or the generic `contract/handler-error` |
| any handler fault — a throw, a rejection, an undeclared code, an output or error-details schema violation | kind `contract` `JC2070`, message `contract/local-handler-failed`; the distinguishing cause goes to `onError(error, { op, trace })`, never into the outcome |
| `ctx.signal` aborted before or while running, or the client closed | kind `cancelled` `JC2052`; a handler that settles later settles into nothing |

Options: `trace`, `runtime` (the record `trace` defaults from), `validateOutput` (`'never'` is a declared downgrade,
reported in `capabilities.validatedOutput`; the output is validated
ONCE, in the pipeline — the assembler does not re-validate what never
crossed a wire), `catalog`, `onError`. Capabilities:

```jsonc
{ "name": "local", "status": false, "headers": false, "media": false,
  "etag": false, "idempotency": false, "validatedOutput": true,
  "stream": false, "cancel": "signal" }
```

Two readings that keep one handler table serving http AND locally:

- **a declared `policy.idempotency` is allowed and inert.** The same
  contract must serve over http (where the ledger enforces it) and
  locally (where "the wire retried" cannot happen — a re-run is the
  caller's own hand). The binding does not refuse it (`JC1003` is for a
  feature a binding was asked to carry and cannot, like http without a
  ledger); it carries `capabilities.idempotency: false` so the
  downgrade is declared, never silent.
- **an opaque or subscribe operation needs no handler and may still
  have one.** `serveLocal` exempts both from the `JC1002` handler
  requirement (neither can be invoked here), and accepts a handler
  table that carries them — so an http server's table is reusable
  verbatim; those handlers are simply never called.

The local codes (the table shared with §16; `PORT_LOCAL_ERRORS` in
`@jarenjs/contract/local` and `/port` is this table as data):

| code | kind | msgid | retryable | when |
|---|---|---|---|---|
| `JC2070` | contract | `contract/local-handler-failed` | no | the serving host's handler failed in any class — a throw, an undeclared code, a broken output or error-details schema; `onError` sees the cause |

## §16 The port binding

A request and a subscription on this carrier run the host lifecycle
of §7.7 with `carrier: "port"`: `identify` after the operation
resolved and before the input is validated, `acquire` after it, the
handler inside `enter` with the frozen context `{ op, trace, carrier:
"port", host, signal, method: null, path: null, params: null,
headers: {}, body: null, fail, idempotency: null, etag: null, status:
null }`. A hook fault is `JC2070`, a hook's declared failure the
declared error frame; the releases run after the response frame was
posted, and for a subscription after the runner's stop/close/done
sequence.

`servePort(contract, handlers, { channel, trace?, validateOutput?,
catalog?, onError?, runtime? })` and `openPortClient(contract, { channel,
timeoutMs = 15000, catalog?, runtime? })` — request/response over anything with
`postMessage` and a message-listener surface: a `MessagePort` (started
automatically), a `Worker`, a `BroadcastChannel`, a worker's own
`self`, or a plain object of that shape. The server prepares the same
pipeline routes as §7 and refuses the same host mistakes (`JC1001`,
`JC1002` — opaque operations exempt exactly as in §15; a subscribe
operation NEEDS its handler, it streams here — §18.2); the client is
the §10 shape minus `url`/`negotiate`/`pending`, plus `subscribe`
(§19). A request frame naming a subscribe operation is answered
`JC2071` like an opaque one — a stream is never a request/response.
Exactly ONE server should serve a shared channel — two would both
answer every request.

### §16.1 Frames

The grammar is `schemas/jaren-contract-port.schema.json` (draft-07 twin
beside it), and every frame the binding emits validates against it.
Frames are JSON-safe plain objects marked `jaren: "contract/0.1"`:

```jsonc
{ "jaren": "contract/0.1", "id": "<clientId>:<seq>", "op": "data.rows",
  "input": { "collection": "notes" } }                      // request; attempt?/key? reserved
{ "jaren": "contract/0.1", "id": "<clientId>:<seq>", "ok": true,
  "value": [ /* … */ ], "trace": "3f2c…" }                  // success
{ "jaren": "contract/0.1", "id": "<clientId>:<seq>", "ok": false,
  "error": { "code": "conflict", "message": "…", "details": { }, "retryable": false },
  "trace": "3f2c…" }                                        // error
{ "jaren": "contract/0.1", "cancel": "<clientId>:<seq>" }   // cancel; never answered
```

**Id scoping is the correctness rule.** `id` is `"<clientId>:<seq>"` —
`clientId` a fresh identifier per client instance from the runtime
record's `uuid` (a v4 UUID with no record; a deterministic record MUST
still answer a distinct value per client, or two clients on one channel
take each other's frames), `seq` a per-client counter — so
two clients on one shared channel can never collide, and a client
ignores every frame whose id does not start with its own `clientId +
":"` (one cheap prefix test before any map lookup). A late response
for a cancelled or timed-out id finds no pending entry and is dropped
silently. The request members `attempt` and `key` are reserved by the
grammar and ignored by servers of this version: the attempt id stays
caller-side in `meta` (D6 — the identities live in state, never in the
transport) and idempotency is not carried on this binding.

**What the wire cannot carry, it does not pretend to.** No statuses,
no headers, no entity tags, no non-JSON media (an opaque operation is
`JC1005` at `invoke` and answered `JC2071` if some other client asks);
a declared failure's `status` is `null` in the outcome, member present
(D6). `input` is the whole input object (`null` for an input-less
operation); an `undefined` handler value crosses as `null` (frames are
JSON). Cancellation is `cancel: "message"`: an abort posts the cancel
frame — an optimization that stops wasted work; the id scoping is the
guarantee.

### §16.2 The server, per request frame

A frame without the marker is IGNORED, never answered — other traffic
may share the channel (an owner-discovery ping, a live push). So is a
frame carrying `ok` (another server's response on a shared channel)
and a marked frame without a usable string `id` (nothing to address).
Then: an unknown or opaque `op` is answered `JC2071` **without echoing
what was asked** (a request value never enters a message, §7.3's
rule); an input failing its validator is `JC2006` with details by
policy; otherwise the request runs through the pipeline under one
`AbortController` per id — a `cancel` frame aborts it — and the
settlement is posted back with the server `trace`: the §7.3
classification with `JC2070` in place of §7's 500s (a declared failure
keeps its code, message, details and retryability; every host fault is
`JC2070` with the cause to `onError`). A response for an id whose
controller was aborted is not posted. `close()` detaches the listener
and aborts every in-flight request.

### §16.3 The client, per outcome

Pre-send exactly as §15 steps 1–2 (`JC1005` thrown, `JC2050`
pre-send). Then one request frame; the outcome:

| the channel answered | outcome |
|---|---|
| `ok: true` with `value` | validated against the output schema → `{ ok: true, value, meta }` (`JC2053` kind `contract` on a mismatch, as §10); `meta.trace` from the frame |
| `ok: false` with a declared or §7 taxonomy `code` | kind `failure`, `status: null`, the frame's message/details/retryable (a peer's `JC2006` means the two ends validated differently — visible, not hidden) |
| `ok: false` with `JC2070`/`JC2071` | kind `contract`, the code kept — a served-host fault or a contract the two ends disagree about is never dressed as a declared failure |
| `ok: false` with any other code | kind `contract` `JC2055` (§10.3 — an undeclared response) |
| a frame addressed to this client that does not match the grammar | kind `contract` `JC2073` |
| nothing within `timeoutMs` | kind `network` `JC2072` (retryable); `0` disables the timer |
| `postMessage` threw (closed, detached) | kind `network` `JC2074` |
| `ctx.signal` aborted, or `close()` | kind `cancelled` `JC2052`; the cancel frame is posted when the channel still accepts one |

The port codes (with `JC2070` of §15; `PORT_LOCAL_ERRORS` is the table
as data):

| code | kind | msgid | retryable | when |
|---|---|---|---|---|
| `JC2071` | contract | `contract/unknown-operation` | no | the server answered "no operation of that name is served on this channel" — unknown, or opaque |
| `JC2072` | network | `contract/port-timeout` | yes | no answer within `timeoutMs` |
| `JC2073` | contract | `contract/malformed-frame` | no | a response frame addressed to this client fails the frame grammar |
| `JC2074` | network | `contract/channel-closed` | no | the channel refused the request frame |

## §17 Subscribe operations

A **subscribe** operation declares a live query: its `output` is the
**snapshot** schema — the document a subscriber holds — and after the
snapshot the server streams LIVE-FORMAT emissions `{ patch, seq }`
(RFC 6902 `add`/`remove`/`replace` only) that the consumer applies to
it. `input` travels as for a read (path variables → `path`, the rest →
`query` by default); `errors` are declared as usual and end the stream
as an `error` event (§18). The compiler enforces the shape the wire
requires: `policy.task` MUST be `switch` (`JC0018` — a subscription
slot is replaced, never queued), the binding MUST be `GET` (`JC0019`;
the canonical binding of a subscribe without `http` is `GET /<op-id>`
with every member in the query), `policy.idempotency` MUST be `none`
(`JC0020`), and `http.media` is **forced** to `text/event-stream` — a
declared conflicting media is `JC0012`, and `describe()` shows the
forced value. A subscribe operation is never opaque: its events are
JSON the contract decodes and validates. `policy.stream` (§3.1) is its
knob set — `resume`, `heartbeatMs`, `maxPatchBytes` — and is refused
on any other kind.

### §17.1 The handler — a duck-typed LIVE subscription

`handlers[op] = (input, ctx) => Subscription | Promise<Subscription>`
where

```
Subscription = {
  result | snapshot(),        // the current snapshot document; snapshot() preferred when both exist
  subscribe(cb) → stop,       // cb receives LIVE-FORMAT emissions { patch, seq } or { error }
  close(),                    // release the registration
  replay?(after, { limit, maxBytes, signal }),   // optional: ONE page of the emissions after `after`
                              //   → { items, next?, earliestAvailable, highWatermark, hasMore, resetRequired }
  mode?,                      // ignored by the binding
}
```

`replay` answers a **page**, never an array — the exact shape
`@jarenjs/db`'s `changes.page()` answers (LIVE-FORMAT §5), so a store's
bounded change reader is a replay source as returned: `items` are
`{ patch, seq }` emissions in ascending seq above `after`, at most
`limit` of them and at most `maxBytes` serialized patch bytes; `next`
is the seq to continue from; `earliestAvailable`/`highWatermark` are
the log's watermarks; `hasMore` says records remain; `resetRequired:
true` is the total refusal — `items` empty, `next` absent — for a
cursor that fell behind the log's retention. Every member is read
defensively: a page that breaks the shape or its bounds is a host fault
(`JC2008` / `JC2070`) that ends the stream, and a `replay` that answers
an array is that fault too (an array would materialize a history the
bounds exist to keep out).

— a `@jarenjs/db` `live()` object satisfies it **as returned** (`result`
+ `subscribe` + `close`; it has no `replay`), so a handler is one line:
`(input) => store.collection('x').live(doc, { externals: input })`. No
import of `@jarenjs/db` exists anywhere in the package; the shape is
duck-typed. The handler runs through the same settlement boundary as
every operation: a `ContractFailure` (or a thrown `ContractRuntimeError`
with a declared code) is a declared failure, any other throw or hostile
value is a host fault, and a settled value that does not carry
`subscribe` + `close` + (`result` or `snapshot()`) is a host fault too.
On HTTP these pre-stream failures answer as ordinary §7.3 responses
(declared status, or 500); on `port` they answer as `error` push frames
(§18). Once the stream is live, the binding reads the snapshot
(`snapshot()` when present, else `result`), validates it against
`output` (a failure ends the stream with an `error` event `JC2091` —
the server broke the contract; the cause goes to `onError`, never the
wire), forwards each emission verbatim (the binding never mutates a
patch), and calls `stop()` then `close()` **exactly once** — on peer
disconnect (`ctx.signal`), on an `unsubscribe`/stream cancel, on server
close, and after an `error` emission ends the stream. Both may answer
a promise: the binding awaits `stop()`, then `close()`, then releases
the carrier, and reports completion only after all three settled. The
carrier's writes are serialized — one event at a time, the next only
after the previous write settled (`createAwaitedSink`,
`@jarenjs/core/async`) — so an emission that arrives while the carrier
is waiting on the socket is queued in order, never overlapped and never
dropped; a carrier write that fails (the peer dropped the socket, the
consumer cancelled the stream) releases the subscription silently. The
queue is **bounded** (§18.1): what it holds is charged until each write
settled, and the emission that would cross the bound ends the stream
with `JC2096` instead of growing memory or dropping an event.

An `{ error }` emission ends the stream, and the binding classifies it
once, carrier-neutrally. When the error's `code` — read guardedly — is
a string the operation **declares**, the stream ends with that declared
failure: the `error` event carries the code, the operation's declared
message rendered from the host catalog (never the error's own text),
the error's `details` when they are JSON-safe, and `retryable` — the
error's own boolean, else whether `policy.retry.on` names the code —
and the client delivers a `failure` outcome under that code. Any other
error — an undeclared code, a code that is not a string, a hostile
accessor — is the host fault (`JC2008` / `JC2070`): the cause goes to
`onError`, the wire carries the generic message, and the client reports
`JC2093`. Declared codes are lowercase by grammar (`JC0011`), so a
store's own coded error — `@jarenjs/db`'s `JD2060` when a live query
crosses `live.maxMaintained` — is declared by **mapping** it in the
handler, the cause riding along for the observer:

```js
// errors: { overflow: { status: 507 } } declared on the operation
'data.live': async (input) => {
  const live = await store.collection(input.collection).live(query);
  return {
    get result() { return live.result; },
    subscribe: (cb) => live.subscribe((e) => cb(
      'error' in e && e.error?.code === 'JD2060' ? { error: { code: 'overflow', cause: e.error } } : e)),
    close: () => live.close(),
  };
},
```

Returned as is, the same error reaches the client as `JC2093` and the
server's `onError` as the `DbRuntimeError` it is.

## §18 The stream wire

### §18.1 HTTP: Server-Sent Events

Request: `GET <path>` with `accept: text/event-stream`. **A client
without that accept header gets the snapshot as plain JSON** — the same
operation serves a one-shot read through the ordinary §7 pipeline
(handler → subscription → snapshot validated → `stop()`/`close()` →
JSON response), which is also what `invoke` on a subscribe operation
does; `capabilities.stream: true` says the streaming half exists.

Response: `200`, `content-type: text/event-stream`, `cache-control:
no-store`, `x-jaren-trace`. Events, in order:

- `snapshot` — `id: <seq>` (the stream's starting seq; `0` for a source
  that names none), data `{ "value": <snapshot>, "resumed": false,
  "reset": false, "earliestAvailable": null, "highWatermark": null }`.
  The envelope exists because a resume verdict cannot ride *inside* the
  snapshot value without breaking a closed output schema; `resumed:
  false` states this snapshot is a fresh document (a refused resume —
  `JC2095` — looks exactly like this, which is how the client learns).
  The shape is stable: `reset: true` marks the snapshot that re-seeds a
  consumer whose cursor fell behind the server's retention (below), and
  the two watermarks are the replay source's when it reported them.
- `patch` — `id: <seq>`, data `{ "patch": [...], "seq": n }`: the
  LIVE-FORMAT emission verbatim.
- heartbeat comment lines (`:`) every `policy.stream.heartbeatMs`.
- `error` — data the §7.3 wire error (no `status` member matters here);
  the stream ends with it.
- `end` — data `{ "reason": "closed" | "server-shutdown" }`.

`seq` is strictly increasing per stream; a violation is the client's
`JC2092`. An emission whose serialized patch's UTF-8 byte length exceeds
`policy.stream.maxPatchBytes` is replaced by a fresh `snapshot` event
at that emission's seq — the consumer swaps its document instead of
patching it; nothing is dropped.

**Resumption.** A request carrying `Last-Event-ID: <seq>` asks to
resume. Under `resume: "replay"` with a `replay` on the subscription
the binding **pages**: it subscribes live first, then calls
`replay(seq, { limit, maxBytes, signal })` and delivers each page's
items as `patch` events (no snapshot), continuing from `next` until the
**first page's** `highWatermark` is reached or the log has no more —
a watermark that keeps rising on later pages cannot make replay chase a
busy writer forever — and then continues live, discarding the
emissions that arrived meanwhile whose seq the pages already covered.
A page with `resetRequired: true` ends the replay without a suffix:
the binding reads a fresh snapshot and emits it with `resumed: false`,
`reset: true`, `earliestAvailable`, and `highWatermark` — where the
event id and the `highWatermark` are the higher of the page's watermark
and the highest live emission already buffered, because the snapshot
just read reflects those emissions (§17.1's contract), and replaying
one of them would apply a change twice. The consumer resumes from that
id. Otherwise — `resume: "snapshot"`, or no `replay` — the stream starts
with a fresh `snapshot` whose data carries `resumed: false` (`JC2095`,
informational, never an outcome).

**Bounds.** `serveHttp`/`servePort` take `streamLimits: { replay: {
limit, maxBytes }, queue: { events, bytes } }` (defaults 256 / 1 MiB
for both): a replay page asks for at most `replay.limit` emissions and
`replay.maxBytes` serialized patch bytes, measured in UTF-8; the undelivered
queue — the events that arrived while a carrier write was pending or a page was
loading, the SSE text or port frame as it will go on the wire — holds
at most `queue.events` frames and `queue.bytes` UTF-8 bytes (the JSON
encoding of a port frame), each charged
until its write settled. When the next event would cross either bound
the stream ends with the terminal `error` event `JC2096` (`kind:
network`, retryable — the consumer reads slower than the source
emits), then the subscription is released and the carrier tears its
sink down (the node adapter destroys the socket, the fetch bridge
errors the stream) rather than wait for a consumer that stopped
reading; nothing is dropped silently, oldest or newest.

`toNodeHandler` writes SSE with `flushHeaders()` + `res.write`, waits
for `drain` whenever `res.write()` answered `false` before the next
event, and ends on close; `toFetchHandler` answers a `ReadableStream`
body that produces on the consumer's `pull`; both abort `ctx.signal`
when the peer goes away (`request.signal`, `req` close), which runs the
exactly-once `stop()`/`close()`, and both tear the connection down
after a `JC2096`. A heartbeat is never queued behind a
heartbeat: while one waits on the sink, the interval skips. A
dispatcher's `close()` ends every live SSE stream with `end`
(`server-shutdown`) before releasing it (§9 has the adapter contract).

### §18.2 Port: push frames

The §16 frame family gains three shapes (the grammar artifact carries
them):

```jsonc
{ "jaren": "contract/0.1", "subscribe": "<clientId>:<seq>", "op": "data.live",
  "input": { "collection": "notes" }, "lastSeq": 41 }        // client → server; lastSeq? resumes
{ "jaren": "contract/0.1", "unsubscribe": "<clientId>:<seq>" } // client → server; never answered
{ "jaren": "contract/0.1", "id": "<clientId>:<seq>", "event": "snapshot",
  "seq": 0, "data": { "value": { "rows": [] }, "resumed": false } } // server → client push
```

A push frame's `event` is `snapshot | patch | error | end` with the
same data shapes as §18.1 (`error` data is the wire error; `end` data
the reason record); `seq` mirrors the event's seq (`error`/`end` carry
the last delivered seq). Ids are scoped exactly as §16's request ids,
so two clients on one channel hold independent subscriptions and an
`unsubscribe` from one cannot touch the other's. Pre-stream failures —
unknown or non-subscribe `op` (`JC2071`), invalid input (`JC2006`),
handler faults (`JC2070`), an invalid snapshot (`JC2091`) — arrive as
`error` push frames. There is no heartbeat on a port (delivery is
in-process); `server.close()` pushes `end` (`server-shutdown`) to every
live subscription before stopping it.

### §18.3 The stream codes

`STREAM_ERRORS` (`@jarenjs/contract/stream`) is the table as data;
these rows join `CONTRACT_CODES` and the English catalog like every
other range:

| code | kind | msgid | retryable | when |
|---|---|---|---|---|
| `JC2090` | contract | `contract/not-a-stream` | no | the server answered a subscribe request with a non-stream response (client-side) |
| `JC2091` | contract | `contract/invalid-snapshot` | no | a snapshot fails the output validator — the server broke the contract; sent as the `error` event that ends the stream |
| `JC2092` | contract | `contract/seq-regression` | no | an event's seq is not strictly greater than the last delivered (client-side) |
| `JC2093` | contract | `contract/stream-error` | no | the stream ended with a server `error` event whose code the operation does not declare — a **declared** code lands as a `failure` outcome under its own code instead |
| `JC2094` | network | `contract/heartbeat-missed` | yes | no bytes for `2 × heartbeatMs` (client-side, SSE only) |
| `JC2095` | — | — | — | a requested resume was refused; informational, carried as `resumed: false` in the fresh snapshot's event data, never an outcome |
| `JC2096` | network | `contract/slow-consumer` | yes | the stream's bounded queue would overflow — the consumer reads slower than the source emits; sent as the terminal `error` event, then the carrier tears the connection down |
| `JC2097` | network | `contract/reconnect-exhausted` | no | the HTTP client's reconnect budget is spent: every further attempt after a network loss ended in another loss (client-side); `details` is `{ attempts, lastCode }` — the further attempts made and the last loss's code |

`JC2098–JC2109` are reserved for later stream codes. `JC1009` (an SSE
data string the frame cannot carry) and `JC1010` (`subscribe` of a
non-subscribe operation) are the stream's host programming errors
(§7.3's host table).

## §19 The client: `subscribe`

`client.subscribe(op, input, { onSnapshot, onPatch, onError, onEnd,
signal, lastSeq, reconnect }) → { stop(), lastSeq }` — on the `http`
and `port` clients alike (`capabilities.stream: true`); `serveLocal` keeps
`capabilities.stream: false` and needs no handler for a subscribe
operation (`invoke` of one throws `JC1005` there). A non-subscribe
operation is `JC1010`, thrown — the host named the wrong operation.

- `onSnapshot(value, { seq, resumed, reset, earliestAvailable,
  highWatermark })` — a fresh, validated snapshot; the consumer
  replaces its document. `resumed` is `false` exactly as §18.1 defines
  it; `reset: true` marks the re-seed after a retention gap — its `seq`
  is the cursor to resume from — and the watermarks are the server
  log's when it reported them, `null` otherwise. The shape is the same
  for every snapshot.
- `onPatch({ patch, seq })` — the LIVE emission, **not applied**: the
  client forwards patches; the app binding (§11.4) and the consumer
  apply them (`@jarenjs/json/patch`). `seq` is strictly increasing or
  the stream ends with `JC2092`.
- `onError(outcome)` — a D6 `ok: false` outcome (`failure` for a
  declared error event; `network` for a transport failure, a missed
  heartbeat, the server's `JC2096` — the consumer fell behind the
  stream's bounded queue — or `JC2097`, a spent reconnect budget;
  `contract` for `JC2090`/`JC2092`/`JC2093`, an invalid snapshot value,
  or a pre-send input refusal `JC2050`). Its `error` and `meta` carry
  every member (`status: null` where the wire has none). After
  `onError` the stream is finished and cleaned up.
- `onEnd({ reason })` — the server's `end` event; a stream that ends
  without one is reported as `reason: "closed"`.

Every callback is optional and total for the client: a callback that
throws does not break the stream machinery. `signal` aborts the
subscription silently (the caller asked); `stop()` does the same and,
on `port`, posts the `unsubscribe` frame. The subscription's read-only
`lastSeq` is the last delivered seq — `null` before the first event,
the passed `lastSeq` until an event moves it — and the `lastSeq` option
is what a re-entered `subscribe` passes (§18's resumption).

**Reconnection is opt-in and HTTP-only.** `reconnect: { max }` — a
non-negative integer of *further* attempts, `0` when absent — makes the
HTTP client re-establish the stream after a **network loss**: a
rejected request (`JC2051`), a missed heartbeat (`JC2094`), the
server's `JC2096`, or a body that ends before an `end` event. Each
further attempt waits the retry backoff of §10.4 (`min(1000 · 2^n,
8000)` ms plus up to 250 ms of the runtime's jitter, `n` counting from
0) and sends the last delivered seq as `Last-Event-ID` — the seq a
reset snapshot advanced included — with no callback for the loss in
between; every attempt is a fresh request with a consumer, reader and
watchdog of its own, so a stale attempt's late bytes and settlements
reach no callback and close no newer reader. A declared failure, a
contract outcome, the server's `end`, `stop()` and the signal are
terminal on every setting. When the budget is spent the subscription
ends with one `onError` — `JC2097` (`kind: network`, not retryable),
its `details` `{ attempts, lastCode }` naming the further attempts
made and the last loss's code — after the reader, the watchdog and the
backoff were released. Without `reconnect` (or with `max: 0`) a
`network` outcome is delivered as is and re-entering is the host's;
a body that ends without an `end` event is then `onEnd({ reason:
"closed" })`, not a loss. The port client validates the option exactly
as the HTTP client does and then does nothing with it: a channel has no
network loss to reconnect from (a closed channel is `JC2074`, final),
and one options object serves both clients.
