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

Format 0.1 covers the document, its compilation, the HTTP binding's
*shape* (§2–§6), the HTTP **server** binding that carries it (§7–§9:
the request pipeline and its wire errors, idempotency and the ledger
interface, the `fetch` and `node` adapters), the HTTP **client** binding
(§10: outcomes, the client half of idempotency, retry, negotiation) and
the `@jarenjs/app` binding (§11: the generated documents and the one
effect). The in-process, message-port and stream bindings, the revision
hash, the projections (OpenAPI, TypeScript, Markdown, AI tools) and the
locale catalogs are the coming lines of this package and will append
their sections here.

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
    "Product": {
      "type": "object",
      "required": ["id", "name", "price"],
      "properties": {
        "id": { "type": "integer" },
        "name": { "type": "string", "minLength": 1 },
        "price": { "type": "number", "minimum": 0 }
      }
    },
    "Catalog": {
      "type": "object",
      "required": ["revision", "products"],
      "properties": {
        "revision": { "type": "integer" },
        "products": { "type": "array", "items": { "$ref": "#/$defs/Product" } }
      }
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
        "required": ["id", "revision", "product"],
        "properties": {
          "id": { "type": "integer" },
          "revision": { "type": "integer" },
          "product": { "$ref": "#/$defs/Product" }
        }
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
      "input": { "type": "object", "required": ["id"], "properties": { "id": { "type": "integer" } } },
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
operation, `policy` and its `limits`/`errors`/`retry`, `http`, and an
error declaration accept exactly the members listed for them; an unknown
member is `JC0013` at that member. A silently ignored `policy` is a
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

## §3 Operations, policy and the defaults

An operation is `{ kind, input?, output, errors?, policy?, http?, doc? }`.

| member | required | meaning |
|---|---|---|
| `kind` | yes | `"read"` or `"command"`. `"subscribe"` is reserved for the stream binding and is refused (`JC0004`) rather than silently downgraded. |
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
| `task` | `switch` \| `exhaust` \| `concat` \| `parallel` | `switch` for a read, `exhaust` for a command | Which task mode a host effect runs the operation in: replace an in-flight attempt, let the first one finish, queue, or run concurrently. |
| `idempotency` | `none` \| `optional` \| `required` | `none` | Whether a command carries an idempotency key. A **read MUST be `none`** (`JC0014`). |
| `revision` | `"input:<json-pointer>"` | absent (`null`) | Where in the input the revision a command asserts lives, as an RFC 6901 pointer after `input:` (`JC0014` on malformed). |
| `cache` | `none` \| `revision` | `none` | Whether a read's result may be cached by revision. |
| `limits.maxBodyBytes` | positive integer | `1048576` | The request-body ceiling a server binding enforces. |
| `errors.details` | `none` \| `paths` \| `full` | `paths` | How much of a validation failure crosses the wire: nothing, instance path + keyword, or the raw validator errors. |
| `retry` | `{ max: integer ≥ 0, on: [codes] }` | absent (`null`) | Which error codes a client may retry (declared codes, or `JC2xxx` taxonomy codes), and how often beyond the first attempt; a network failure is always retried under a declared `retry`. A **command MUST declare `idempotency: "required"` to carry `retry`** (`JC0014`) — a retried command without a key the server deduplicates on runs twice; a read is idempotent by nature. |

The compiled `policy` is always
`{ task, idempotency, revision, cache, limits: { maxBodyBytes }, errors: { details }, retry }`.

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
`idempotency`, `cache`. Operations appear in document order.

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

Path, query and header members arrive as strings and are decoded by a
normalizer compiled **over those members only** with `coerceTypes`
(`@jarenjs/validate/normalize`); **a body member is never coerced**. The
compiled operation carries this as
`input.transport = { normalize, members: { path, query, header, repeated }, schemas, required }`
(`null` when nothing travels as a string), where `schemas` holds each
transport member's declared schema and `required` the transport members
the input requires (what a URL builder validates without the body), and
`repeated` lists the
query and header members whose effective schema type is `array` — a
decoder collects repeats of those into an array (a repeated query key; a
repeated header line or a comma-separated header list, RFC 9110 §5.3)
before normalizing; every other query member is last-wins and every
other header member is one line (§7.4). The server validates the
reassembled input object with the operation's compiled validator; the
client validates the same object before it splits it.

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
MUST open a well-formed escape.

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
`POST /<id>`).

### §4.5 Opaque operations

A `media` other than `application/json` (or a `+json` structured-syntax
suffix, parameters ignored) marks the operation **opaque**: it is routed
and matched, its path/query still decoded, its body neither decoded nor
validated by the contract, and it is excluded from generated clients
except as a URL builder. `image.bytes` in §2 is one.

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
| JC0004 | `kind` is neither `read` nor `command` (`subscribe` is reserved and refused with the reason) |
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

`JC0017–JC0049` are reserved for further document-level rules and are
appended to this table when they land. `JC1001–JC1049` are host
programming errors (`ContractHostError`, a thrown `TypeError` with `code`
and `reason`) and `JC2001–JC2049` the HTTP request-time errors
(`ContractRuntimeError` in-process, a wire error on the response) — both
tables are in §7. Later ranges: `JC2050–JC2069` client-side,
`JC2070–JC2089` port/local, `JC2090–JC2109` stream.

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
        "required": ["id", "doc"],
        "properties": {
          "id": { "type": "string" },
          "doc": { "type": "array", "items": { "type": "object" } },
          "dry": { "type": "boolean" }
        }
      },
      "output": true,
      "policy": { "idempotency": "optional" },
      "http": { "method": "PUT", "path": "/docs/:id", "body": "doc", "in": { "dry": "query" }, "status": 204 }
    },
    "doc.remove": {
      "kind": "command",
      "input": { "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } },
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

The dispatcher is `{ dispatch, capabilities, contract, describe() }`;
`capabilities` is `{ name: "http", status: true, headers: true, media: true,
head, etag: true, idempotency: <ledger present>, validatedOutput:
<validateOutput === "always">, stream: false, cancel: "signal" }` — a
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
| `method`, `path` | the request line, path without the query |
| `params` | the raw decoded path strings, frozen |
| `headers` | **declared header members only** (by header name, string values) plus `if-match`/`if-none-match` when present — the binding reads no other request header on a handler's behalf |
| `body` | the raw request body of an **opaque** operation (`string | Uint8Array | null`); `null` for a JSON operation, whose body was decoded into `input` |
| `signal` | the request's `AbortSignal` when the adapter has one (the node adapter aborts it when the client goes away before the response finished), else `null` |
| `idempotency` | `{ key, scope }` when this request runs under an idempotency key, else `null` |
| `fail(code, params?, details?, { retryable? }?)` | a declared failure by code — returns a `ContractFailure` value the handler returns; `params` feed the message catalog, `details` become the wire `details` (validated against the declaration's schema when it has one), `retryable` overrides the default taken from `policy.retry.on` |
| `etag(tag, { strong? }?)` | arm the entity-tag path (§7.5); `tag` is the opaque tag without quotes |
| `status(n)` | override the success status; must be an integer in 200–299 (`JC1006` otherwise — a host error the handler boundary settles into `JC2008`, seen by `onError`) |

An **opaque** operation (`http.opaque`) takes a *raw* handler: `(input,
ctx) => { status, headers?, body? }` with the bytes in `ctx.body`; it
bypasses media, parse, body assembly, idempotency and output validation.
Its transport members are decoded and normalized into `input` and — when
no member is body-located, so they **are** the whole input — validated
like any other input (`JC2006`); an opaque operation that declares a
body-located member cannot be validated without decoding bytes, so its
`input` is handed over unvalidated and the raw handler owns the check
(`ctx.op.input.validate` is at hand). `input` is `null` when the operation
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
   `body` a string, `Uint8Array` or `null` (an absent body is `null`) — a
   malformed object is `JC1004`, **rejected**, never a response.
2. **Route.** `url` is split at the first `?`; the path goes to
   `contract.match(method, path)`; under `HEAD` with `head` on, `HEAD`
   is tried, then `GET`. No match: an undecodable path (a malformed
   percent-escape) is `JC2011`; the `wellKnown` path answers `describe()`
   under GET/HEAD (405 otherwise); `contract.allowed(path)` non-empty
   (with `HEAD` added beside `GET` when `head` is on) is `JC2002` with
   `Allow`; else `JC2001`. A matched operation without a handler (a
   `partial` server) is `JC2013`.
3. **The body limit.** A `content-length` above `policy.limits.maxBodyBytes`
   is `JC2003` **before** any read (the adapters honor this too, §9); a
   body whose byte length exceeds the limit is `JC2003` after. Applies to
   every matched operation, opaque and body-less included.
4. **Opaque** → the transport input validated as in step 8 when no
   member is body-located (`JC2006`), then the raw handler through the
   same boundary as step 10; done.
5. **Media.** A body-carrying operation (a body-located member or a
   whole-body member) with a non-empty body requires a `content-type`
   whose `type/subtype` is the operation's `http.media` (parameters
   ignored, case-insensitive; a `+json` structured-syntax suffix is
   accepted for `application/json`); else `JC2004`. A body-less
   operation with a body **ignores** the body. An empty body needs no
   media.
6. **Parse.** Bytes are decoded as strict UTF-8 first (invalid → `JC2005`;
   a leading BOM is stripped by the decoder); then `JSON.parse` (a failure
   is `JC2005`).
7. **Assemble** the input object through a prototype-safe setter only, in
   this order: path members (raw decoded strings), query members
   (`URLSearchParams` semantics — `+` is a space; a member listed in
   `transport.members.repeated` collects every occurrence into an array,
   every other member is last-wins; an **undeclared query key is
   ignored, never merged**; an undecodable query is `JC2012`), declared
   header members (by their lowercased name; §7.4), then the transport
   normalizer over exactly those members (`coerceTypes`), then the body,
   **never coerced**: `http.body` names a member → the parsed value is
   that member; otherwise the parsed value must be an object (`JC2006`
   with `path: ""` otherwise) and each of its own members is set unless
   it names a path/query/header member (which is **ignored** — the body
   cannot override a location the request already answered); an
   undeclared body member is set and left for the validator to judge
   under the schema's own `additionalProperties`. A JSON body's own
   `__proto__` member becomes an own data property, never a prototype.
8. **Validate** the input with the operation's compiled validator →
   `JC2006`, `details` by `policy.errors.details` (§7.3).
9. **Idempotency** when `policy.idempotency !== "none"` (§8): a missing
   `Idempotency-Key` is `JC2007` under `required` and runs plainly under
   `optional`; otherwise the input is hashed and the ledger claimed.
10. **The handler**, through **one uniform promise boundary** — a
    synchronous throw, a non-promise return and a rejection settle
    alike. A `ContractFailure` (from `ctx.fail`) or a thrown
    `ContractRuntimeError` with a declared code → the declared error
    response; anything else → `JC2008`, its cause handed to `onError`.
    A value whose `then` accessor throws is a rejection here — the
    hostile-value case of `JC2008`.
11. **Output validation** (`validateOutput: "always"`, the default): the
    value against the operation's output validator → `JC2010` on failure
    or on a throwing accessor; the validator's errors reach `onError`,
    never the wire. `"never"` is a declared downgrade
    (`capabilities.validatedOutput: false`).
12. **Entity tags** when the handler armed one (§7.5): `If-Match` first
    (strong comparison; mismatch → `JC2014`), then `If-None-Match` (weak
    comparison; match → `304` on GET/HEAD, `JC2014` on other methods).
    Because the tag is known only after the handler runs, both are
    evaluated **after** step 10 and only when a tag was armed — a
    handler that wants a pre-execution precondition compares
    `ctx.headers["if-match"]` itself.
13. **Serialize.** `JSON.stringify(value)`; a value JSON cannot carry
    (a cycle, a BigInt) is `JC2010`; `undefined` answers no body. Status
    is `ctx.status()` or `http.status`; headers `content-type: <media>;
    charset=utf-8` (when a body), `x-jaren-trace`, `etag` when armed;
    a `204` carries no body; a HEAD carries the `content-length` of the
    body it dropped and no body. Then the ledger claim is settled (§8).

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
| `JC2012` | 400 | `contract/malformed-query` | no | the query string is not decodable (a malformed escape, invalid UTF-8) |
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
| `JC1001` | `serveHttp`: `handlers` is not an object, a key names no operation of the contract, a value is not a function, or an option is malformed |
| `JC1002` | `serveHttp`: an operation has no handler and `partial` is not set |
| `JC1003` | a binding cannot carry a declared feature: an operation declares `policy.idempotency` and no `ledger` was given (say so, never degrade) |
| `JC1004` | `dispatch` received a malformed request object |
| `JC1005` | a client (`invoke`, `url`) or the contract effect was asked for an operation the contract does not declare, or `invoke` for an opaque operation (§10) |
| `JC1006` | `ctx.status(n)` with `n` not an integer in 200–299 |
| `JC1007` | `contractAppBinding`: `ops` names an operation the contract does not declare or cannot carry in the app binding, or `namespace`/`statePath` is malformed (§11) |
| `JC1008` | `openHttpClient`, `client.url` or `createContractEffect`: an argument or option is malformed (§10, §11) |

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

`ctx.etag(tag)` arms a weak tag (`etag: W/"tag"`), `ctx.etag(tag, {
strong: true })` a strong one (`etag: "tag"`). `If-None-Match` is
compared weakly (`*` matches; `W/` indicators are ignored) → `304` with
the `etag` header and no body on GET/HEAD, `412` (`JC2014`) on other
methods; `If-Match` is compared strongly (`*` matches; a weak candidate
or a weak armed tag never matches) → `412` on a mismatch. Both are
evaluated after the handler ran, and only when it armed a tag.

### §7.6 HEAD, the well-known path, options

`head: true` (default) answers `HEAD` for every `GET` operation by
running the handler and dropping the body (a declared `HEAD` operation
wins); with `head: false` a HEAD is a 405 listing `GET`. The `wellKnown`
path (`/.well-known/jaren-contract`, or another absolute path, or `false`)
answers `describe()` — `revision: null` until the revision lands, `compat`
present — for negotiation. `trace` (default `crypto.randomUUID`) generates
the server trace; `scope(ctx)` derives the idempotency scope (§8);
`partial` allows missing handlers; `validateOutput` is `"always" |
"never"`; `errorBody(wire, ctx)` and `onError(err, ctx)` are the two host
hooks (`ctx` is `null` before an operation is matched); `catalog` is a
message catalog (templates or compiled renderers) consulted before the
English one; `now` is the clock stamped into ledger claims.

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
  "commit": "(ref, response) → void",
  "fail":   "(ref, retryable, response?) → void",
  "lookup": "({ op, scope, key }) → record | null" }
```

Semantics the binding relies on: same key + same hash → `replay` — the
stored `{ status, headers, body }` **verbatim** with a fresh
`x-jaren-trace` and `idempotent-replayed: true`; same key + different
hash → `mismatch` (409, `details: [{ "kind": "mismatch" }]`, not
retryable); `started` and not expired → `in-progress` (409, `retry-after:
1`, retryable); `failed` with `retryable: true` → treated as `new` (the
key may be retried); `failed` and not retryable → `replay` of the stored
failure. After the handler: a success **commits** the response; a
declared failure is recorded as **failed** with its response and its
`retryable`; a server fault (`JC2008`, `JC2010`, `JC2014`) **releases**
the key as retryable with no response. `now` on a claim is the binding's
clock (`options.now`), which a ledger may prefer to its own. Opaque
operations bypass the ledger; reads never carry a key. A ledger that
throws or rejects is reported to `onError` and the response still goes
out (a throwing `claim` is `JC2008`).

`createMemoryLedger({ ttlMs = 86_400_000, now })` (`@jarenjs/contract/ledger`)
is the reference implementation over a `Map`: synchronous,
single-process, expiring on `claim` and `lookup`, with `sweep()` for a
host timer and `size`. The record it keeps is:

```jsonc
{ "id": "product.save|tenant-a|k-1",      // "<op>|<scope>|<key>"
  "op": "product.save", "scope": "tenant-a", "key": "k-1",
  "hash": "9f2a…",                          // 64 lowercase hex characters
  "status": "committed",                    // started | committed | failed
  "response": { "status": 200, "headers": { "…": "…" }, "body": "{…}" },   // or null
  "retryable": null,                        // of a failed record
  "createdAt": 1755000000000, "updatedAt": 1755000000000, "expiresAt": 1755086400000 }
```

Two documents ship the same shape as **data**, for a host that wants
durability (this package imports neither `@jarenjs/db` nor
`@jarenjs/flow`): `idempotencyLedgerModel` is a `$model` 0.1 document —
collection `ledger`, key `/id`, that record as its schema (closed),
indexes on `expiresAt` and `status` — a host opens it with `openStore`
and implements the interface over the collection; `commandLifecycleFsm`
is a `$fsm` 0.1 document — `idle → started` on `claim`, `started →
committed` on `commit`, `started → failed` on `fail`, `failed → started`
on `claim` guarded by `$.context.retryable` — which the memory ledger
walks exactly.

## §9 Adapters

Two dependency-free, structurally typed adapters put a dispatcher behind
the platform:

- **`toFetchHandler(dispatcher)`** (`@jarenjs/contract/fetch`) →
  `(Request) => Promise<Response>` — Bun.serve, Deno, service workers,
  Cloudflare-style hosts, and Hono. It lowercases the headers into a
  plain object, matches the operation first (cheap) to decide how the
  body is read — `text()` for a JSON operation, `arrayBuffer()` for an
  opaque one, and **not at all** for an unmatched request or a declared
  `content-length` above the operation's limit (the dispatcher answers
  the 413 from the header) — forwards `request.signal`, and builds the
  `Response` from the dispatcher's status, headers and body.
- **`toNodeHandler(dispatcher)`** (`@jarenjs/contract/node`) → `(req,
  res)` — `http.createServer`'s listener and Express middleware. It
  collects the body chunk by chunk up to the operation's limit; on
  overflow it stops reading, answers the 413 with `connection: close`
  and destroys the request once the response has flushed; a declared
  `content-length` above the limit is never read; an unmatched request's
  body is never read. Bytes reach the dispatcher as received (its strict
  UTF-8 decode decides `JC2005`); repeated header lines arrive as arrays
  (`headersDistinct`); `ctx.signal` aborts when the client goes away
  before the response finished; `content-length` is set on every body.

Fastify, Hono and Express are recipes in the README, each ≤15 lines and
executed by a test that imports the framework from the benchmark
workspace only — no framework is a dependency of this package.

## §10 The HTTP client binding

`openHttpClient(contract, options)` (`@jarenjs/contract/client`) is the
client half of the http driver pair: `open(contract, options) → Client`
with `Client = { invoke, url, negotiate, pending, capabilities, contract,
describe(), close() }`. It is **binding-agnostic in shape** — the app
binding (§11) and later the AI tools read only `invoke`, `contract` and
`capabilities` — and **total in behavior**: `invoke` resolves an
**outcome** for everything a server or a network can do and rejects
only for the host's own mistake (`JC1005`: an operation the contract
does not declare, or an opaque one — `invoke` carries JSON; an opaque
operation is reached through `url`).

```jsonc
// options — every one has a default
{ "fetch": "globalThis.fetch",            // (url, init) => Promise<Response>; injectable (a toFetchHandler, a recorder)
  "baseUrl": "",                          // prefixed to every path; '' = relative
  "headers": {},                          // static headers, merged UNDER per-call ones
  "keys": "crypto.randomUUID",            // the idempotency key generator
  "storage": null,                        // { read(), write(value) } — the @jarenjs/app docstore adapter shape — for durable key records
  "timeoutMs": 0,                         // per request; 0 = none; composed with ctx.signal
  "sleep": "(ms, signal) => Promise",      // the retry backoff sleeper (injectable)
  "catalog": null,                        // a message catalog consulted before the English one
  "wellKnown": "/.well-known/jaren-contract",   // where negotiate() asks
  "now": "Date.now" }                     // the clock stamped into key records
```

`capabilities` is `{ name: "http", status: true, headers: true, media:
true, etag: true, idempotency: true, durableKeys: <storage given>,
stream: false, cancel: "signal" }` — frozen, the driver rule.

### §10.1 The outcome and the three identities

`invoke(op, input, ctx) → Promise<Outcome>` with `ctx = { signal?,
attempt?, idempotencyKey?, headers?, ifNoneMatch?, ifMatch? }`. An
outcome is **JSON** (no `Error`, `Response`, `Headers` or
`AbortController` ever; no member is `undefined` — an absent `details`
is `null`), tagged:

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

`meta` keeps the three identities apart, by construction: **`attempt`** is
the caller's (`ctx.attempt`, echoed verbatim, `null` when none) — it is
never sent and **never read from any response header**; **`trace`** is
the server's `x-jaren-trace` (`null` when the wire carried none) — it is
never generated here; the **idempotency key** (§10.3) is the client's
and travels only as `Idempotency-Key`. `revision` is reserved for the
contract revision; `etag` carries a success's entity tag; `notModified`
is true exactly for a 304. The members are always present, in this
order.

### §10.2 What `invoke` does, in order

1. **Route.** An unknown `op` or an opaque one throws `JC1005`.
2. **Validate** `input` with the operation's compiled input validator —
   the SAME validator the server runs. `null`/`undefined` is `{}` for an
   operation with input; an input-less operation refuses any non-null
   input. A failure resolves `kind: "contract"` `JC2050` with `details`
   by `policy.errors.details`; **nothing was sent**.
3. **Split by location** (`http.in`): path variables → `encodeURIComponent`
   per segment into the canonical template; query members →
   `URLSearchParams` (an array-typed member repeats the key per element;
   `null`/`undefined` members are omitted; a scalar is its string, a
   non-scalar its JSON); header members → the header named by the
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

## §11 The app binding

`contractAppBinding(contract, { namespace = "contract/", statePath =
"/contract", ops = contract.ids })` (`@jarenjs/contract/app`) returns
**pure JSON** — `{ slice, actions, schema, effect: "contract" }` — the
`fsmToApp`/`liveAppBinding` shape: a state slice the host mounts at
`statePath`, action documents it spreads into its `actions`, and the
slice's JSON Schema for `validateState`. Neither package imports the
other; the documents cross as JSON and the task-effect factory
(`createTaskEffect` from `@jarenjs/app`) crosses as a function the host
passes to `createContractEffect`. `ops` may name a subset (`JC1007` for
an operation the contract does not declare or the binding cannot carry).

### §11.1 The generated document

Per operation, **one task slot** in the slice — `{ id: 0, status: "idle",
value: null, error: null, meta: null }` — and **two actions**, in the
async-task convention of `@jarenjs/app`'s TASKS.md (state-side identity,
guard-first completion):

```jsonc
// <namespace><op>/start — $payload is the operation's input
{ "patch": [
    { "op": "replace", "path": "/contract/catalog.load/id",     "value": { "$add": ["$.contract['catalog.load'].id", 1] } },
    { "op": "replace", "path": "/contract/catalog.load/status", "value": "loading" },
    { "op": "replace", "path": "/contract/catalog.load/error",  "value": null } ],
  "effects": [ { "run": "contract", "with": {
    "op": "catalog.load", "input": "$payload",
    "id": { "$add": ["$.contract['catalog.load'].id", 1] },      // the SAME increment as the patch — everything evaluates pre-transition
    "done": "contract/catalog.load/done", "slot": "catalog.load" } } ] }

// <namespace><op>/done — $payload is { id, result: outcome } (or { id, error: outcome } for a projected host throw)
{ "$if": [ { "$eq": ["$payload.id", "$.contract['catalog.load'].id"] },        // the id guard: a stale response is the empty sequence
  { "$let": { "outcome": { "$coalesce": ["$payload.result", "$payload.error"] } },
    "$return": { "$if": [ { "$eq": ["$outcome.ok", true] },
      { "patch": [ { "op": "replace", "path": "/contract/catalog.load/status", "value": "done" },
                   { "op": "replace", "path": "/contract/catalog.load/value",  "value": "$outcome.value" },
                   { "op": "replace", "path": "/contract/catalog.load/meta",   "value": "$outcome.meta" },
                   { "op": "replace", "path": "/contract/catalog.load/error",  "value": null } ] },
      { "patch": [ { "op": "replace", "path": "/contract/catalog.load/status", "value": "error" },
                   { "op": "replace", "path": "/contract/catalog.load/error",  "value": "$outcome.error" },
                   { "op": "replace", "path": "/contract/catalog.load/meta",   "value": "$outcome.meta" } ] } ] } } ] }
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
- **A failed reload keeps the last good `value`**: the error branch
  writes `status`, `error`, `meta` and touches `value` not at all.
- The outcome's `kind` is recoverable from `error.code`: `JC2051` is
  `network`, the other `JC205x` are `contract`, any other code is a
  declared or taxonomy `failure`; `cancelled` never reaches state.
- `schema` is the slice's JSON Schema: per operation `id` (integer ≥ 0),
  `status` (`idle | loading | done | error`), `value` (the operation's
  output schema **or null**), `error` (the §10.1 error object or null),
  `meta` (the §10.1 meta or null); when the contract has `$defs` the
  schema carries them under its own `$defs` and declares an `$id`
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
(a superseded task is dead by design); a value that is not an outcome
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
// … later: app.getState().contract['catalog.load'] → { id: 1, status: 'done', value: {…}, error: null, meta: {…} }
```

The runnable version of this composition, driven against a real
`serveHttp` dispatcher, is [APP-INTEGRATION.md](APP-INTEGRATION.md),
executed verbatim by the test suite.
