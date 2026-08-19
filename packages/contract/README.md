# @jarenjs/contract

Operation contracts for the Jaren suite. A **`$contract` document** — the
sibling of `$model`, `$fsm` and `jaren-app` — declares the operations two
Jaren ends may exchange: JSON in, JSON out, each with a *kind* (`read` or
`command`), an input object schema, an output schema, declared errors, a
behavior *policy* and an HTTP *binding*. `compileContract` compiles it
**once** into per-operation validators, transport normalizers and a path
matcher whose static segments beat variables regardless of registration
order. Everything else a consumer wants beside the runtime — the bindings
that carry an operation over HTTP, a message port or no wire at all, the
OpenAPI/TypeScript/Markdown projections, the AI-tool view, the revision
and the breaking-change diff — is coming in this line as a projection of
the same document.

Zero dependencies outside the suite: `@jarenjs/core`, `@jarenjs/json`,
`@jarenjs/validate`. No `eval`, CSP-safe. The normative contract is
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

## What is here, and what is coming

Here: the document and its grammar, `compileContract`, `contract.match`,
`describe()`, the `JC0001–JC0016` compile errors. Coming in this line:
the HTTP server binding (`fetch` and `node` adapters) and client, the
app-effect binding, `local`/`port`/`stream` bindings, projections
(OpenAPI 3.1, TypeScript, Markdown, AI tools), the revision hash and
`diffContracts`, and the locale catalogs for wire errors.
