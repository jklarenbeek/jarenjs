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

Format 0.1 covers the document, its compilation and the HTTP binding's
*shape*. Bindings that carry an operation over a wire (HTTP server and
client, in-process, message ports, streams), the revision hash, the
projections (OpenAPI, TypeScript, Markdown, AI tools) and the error
catalogs are the coming lines of this package and will append their
sections here.

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
| `retry` | `{ max: integer ≥ 0, on: [codes] }` | absent (`null`) | Which declared error codes a client may retry, and how often. |

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
`input.transport = { normalize, members: { path, query, header, repeated } }`
(`null` when nothing travels as a string), where `repeated` lists the
query members whose effective schema type is `array` — a query decoder
collects repeats of those into an array before normalizing; every other
query member is last-wins. The server validates the reassembled input
object with the operation's compiled validator; the client validates the
same object before it splits it.

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

The matcher is package-private (`compileRoutes` is not exported); it is
reached only through `contract.match`. Its measured cost on the reference
123-route table is published by the benchmark suite when that lands.

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
| JC0014 | a `policy` member is mistyped or outside its declared set (§3.1) |
| JC0015 | `id`, `version`, `compat` or an operation `doc` is mistyped |
| JC0016 | an operation bound to `GET` or `HEAD` carries a body-located member (a GET body) |

`JC0017–JC0049` are reserved for further document-level rules and are
appended to this table when they land. `JC1001` and its range are
reserved for host programming errors (thrown `TypeError`s: a malformed
`options.schemas` entry, a duplicate route shape reaching the matcher);
`JC2xxx` for request-time errors (`ContractRuntimeError`: `{ code, msgid,
params, status?, retryable? }`, never thrown across a binding) — both
ranges are populated by the bindings.

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
