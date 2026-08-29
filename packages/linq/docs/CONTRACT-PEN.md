# The Jaren contract pen (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. The rules every pen keeps, the
shared refusal table and the index of the other pens are the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

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
hoisting walk [the schema pen](SCHEMA-PEN.md) runs over one root, run
over every operation's `input`, `output` and error schemas instead.

Two rules make the pen's document and its own public projection
comparable member for member, and both are gates:

- **The member order is §12.1's** — the normative order the contract
  revision hashes: root `$contract, id, version, compat, $defs,
  operations`; operation `kind, input, output, errors, policy, http,
  doc`; error `status, schema`; http `method, path, in, body, status,
  media`; policy §12.1's public order with the two server-side knobs
  (`limits`, `errors`) in their §3.1 places; `$defs` in first-reference
  order. The pen writes members in that order whatever order they were
  declared in.
- **No default is ever written.** §3.1's defaults are the compiler's to
  materialize and `describe()` marks them inferred; a pen that wrote
  them would turn every default into a declaration and move the revision
  for nothing. The test asserts the exact difference: strip from
  `publicProjection(compileContract(doc))` what `describe().inferred`
  names, the locations §4.1 chose or the template forced, the policy
  members the source never declared and an error's resolved status, undo
  §4.2's path canonicalization — and what is left is the pen's own
  document.

The pen imports nothing of `@jarenjs/contract`: the compiler stays the
only judge of what the document means (a tree-shaking probe holds it).

## 2. The mapping table

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineContract({ id?, version?, compat? }, operations)` | `{ $contract: '0.1', id?, version?, compat?, $defs?, operations }` in §12.1's root order | `Contract<Ops>`; `ContractOf<typeof c>` is the map below | native; a head member the pen does not know, an `id` outside `[A-Za-z_][A-Za-z0-9_-]*`, no operation `JL0101` |
| `read({ … })` / `command({ … })` / `subscribe({ … })` | `{ kind, input?, output, errors?, policy?, http?, doc? }` in §12.1's operation order | `kind` is the literal; `subscribe`'s `output` is the SNAPSHOT schema (§17) | native; a member the spec does not take, a missing `output`, a non-string `doc` `JL0101`; a hand-written `kind` outside the three `JL0102` |
| `input:` / `output:` / an error's `schema:` | the builder's schema, its `named()` definitions hoisted to the root; or a JSON Schema (`true` included) copied verbatim | `Infer<>` of the builder; `unknown` for JSON by hand, exactly as §12.3 widens it | native; two distinct builders under one name, or a `ref()` nothing defines, `JL0103`; a value that is not JSON `JL0101` |
| `errors: { code: error({ status?, schema? }) }` | `{ status?, schema? }` per code, in that order | the declared codes are the operation's `errors` union — `'conflict' \| 'not-found'` | native; a code outside `^[a-z][a-z0-9-]*$`, a status outside 100–599, another member `JL0101` |
| `policy: { … }` | the declared members only, in the pen's order | `Policy` — §3.1's members and value sets | native; a member the table does not list, or a value outside its set, `JL0101` |
| `http({ method, path, in?, body?, status?, media? })` | the binding in §12.1's http order | `HttpBinding<H>`; a non-JSON `media` makes the operation `opaque: true` | native; a reserved path-template form (§4.2), or a member mapped to `path` the template does not declare, `JL0102`; another member, a method outside the set, a status outside 200–299 `JL0101` |
| `.document`, `toJSON()` | the deep-frozen `$contract` document | `ContractDocument` | native |
| `typedClient(client, contract)` | — (identity) | `TypedClient<C>`: `invoke` over the invokable operations, `subscribe` over the subscribe ones, `url` over all of them | native |
| `typedHandlers(contract, handlers)` | — (identity) | `TypedHandlerTable<C>`: one handler per invokable operation, `(input, ctx) => output \| Failure` | native; a missing or misspelled operation does not compile |
| `typedTools(tools, contract)` | — (identity) | `TypedTool<C>[]`: `name` is the id with `.` → `_`, `execute` takes the operation's ACCEPTED input | native |

What the pen does **not** judge, by design: the closed-vocabulary rules
of the document itself, the location rules of §4.1, route-shape
collisions (`JC0010`), and every cross-member policy rule — a read that
declares idempotency (`JC0014`), a GET carrying a body member
(`JC0016`), a subscribe bound to `POST` (`JC0019`). The pen EMITS those
documents and `compileContract` refuses them; a test builds each one
through the pen and asserts the compiler's code. What the pen refuses is
its own surface (a member it does not know, a value outside a declared
set) and the one rule it can see earlier and exactly: the path template.

## 3. Worked examples

Every `js` fence exports exactly one contract, and the `json` fence that
follows is what the pen emits — executed by
`test/linq/pen-docs.test.js`. CONTRACT-FORMAT's own three worked
examples are rebuilt the same way and held BYTE-equal to the doc's
fences by `test/linq/contract-pen.test.js`.

A read and a command over one shared definition, with a declared error:

```js
import * as s from '@jarenjs/linq/schema';
import { command, defineContract, error, http, read } from '@jarenjs/linq/contract';

const Note = s.named('Note', s.object({ id: s.string(), text: s.string().min(1) }).open());

export const notes = defineContract({ id: 'notes', version: '1' }, {
  'note.get': read({
    input: s.object({ id: s.string() }).open(),
    output: Note,
    errors: { 'not-found': error({ status: 404 }) },
    http: http({ method: 'GET', path: '/notes/{id}' }),
  }),
  'note.save': command({
    input: s.object({ id: s.string(), note: Note }).open(),
    output: Note,
    policy: { idempotency: 'required' },
    http: http({ method: 'PUT', path: '/notes/{id}', in: { note: 'body' } }),
  }),
});
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
      "input": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
      "output": { "$ref": "#/$defs/Note" },
      "errors": { "not-found": { "status": 404 } },
      "http": { "method": "GET", "path": "/notes/{id}" }
    },
    "note.save": {
      "kind": "command",
      "input": {
        "type": "object",
        "properties": { "id": { "type": "string" }, "note": { "$ref": "#/$defs/Note" } },
        "required": ["id", "note"]
      },
      "output": { "$ref": "#/$defs/Note" },
      "policy": { "idempotency": "required" },
      "http": { "method": "PUT", "path": "/notes/{id}", "in": { "note": "body" } }
    }
  }
}
```

A subscribe operation with its stream policy, and a command on the
canonical binding — the pen writes no `http` at all, and the compiler
binds it to `POST /<op-id>`:

```js
import * as s from '@jarenjs/linq/schema';
import { command, defineContract, http, subscribe } from '@jarenjs/linq/contract';

export const board = defineContract({ id: 'board' }, {
  'board.watch': subscribe({
    input: s.object({ id: s.string() }).open(),
    output: s.object({ seq: s.integer(), rows: s.array(s.string()) }).open(),
    policy: { task: 'switch', stream: { resume: 'replay', heartbeatMs: 2000 } },
    http: http({ method: 'GET', path: '/board/{id}' }),
    doc: 'The board, live.',
  }),
  'board.clear': command({ input: s.object({ id: s.string() }).open(), output: true }),
});
```
```json
{
  "$contract": "0.1",
  "id": "board",
  "operations": {
    "board.watch": {
      "kind": "subscribe",
      "input": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
      "output": {
        "type": "object",
        "properties": { "seq": { "type": "integer" }, "rows": { "type": "array", "items": { "type": "string" } } },
        "required": ["seq", "rows"]
      },
      "policy": { "task": "switch", "stream": { "resume": "replay", "heartbeatMs": 2000 } },
      "http": { "method": "GET", "path": "/board/{id}" },
      "doc": "The board, live."
    },
    "board.clear": {
      "kind": "command",
      "input": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
      "output": true
    }
  }
}
```

## 4. Refusals

The contract pen raises these `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/contract/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry |
| `JL0103` | a `$defs` name collision, or a reference no definition answers |

The message names the fix, and `docPath` is the JSON pointer of the node
being assembled where the refusal has one.

## 5. The types

```ts
import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { contractTools } from '@jarenjs/contract/project';
import { typedClient, typedHandlers, typedTools } from '@jarenjs/linq/contract';
import type { ContractOf, Outcome } from '@jarenjs/linq/contract';

type Ops = ContractOf<typeof shop>;
//   { 'product.save': { kind: 'command'; input: …; accepts: …; output: …;
//                       errors: 'conflict' | 'not-found'; opaque: false }, … }

const compiled = compileContract(shop.document);
const handlers = typedHandlers(shop, {
  'catalog.load': () => catalog,                       // must answer the declared output
  'product.save': (input, ctx) => saved ? input.product : ctx.fail('conflict'),
});
const api = typedClient(openLocalClient(compiled, handlers), shop);
const outcome: Outcome<Product> = await api.invoke('product.save', { id: 1, revision: 4, product });
api.url('image.bytes', { id: 3 });                     // an opaque operation: a URL builder only
api.invoke('image.bytes', { id: 3 });                  // does not compile — it carries bytes
for (const tool of typedTools(contractTools(compiled, api), shop)) toolbox.add(tool);
```

The agreement with §12.3 is a gate: `test/consumer/linq-contract.ts`
proves `ContractOf<>`'s `input`, `output` and error codes EQUAL to what
`toTypeScript` declares for the document the pen emitted
(`test/consumer/linq-contract-generated.ts`, regenerated byte-identically
by the runtime test), for every worked example — and pins `Meta`,
`WireError`, `Outcome<T>`, `InvokeContext`, `Failure` and
`HandlerContext` equal to the projection's rendering of §10.1's fixed D6
shapes.

The honest limits: an input-less operation reads `input: null`, as
§12.3's `Operations` does; a JSON Schema written by hand is `unknown` on
both sides (a literal is never inferred); an opaque operation is out of
`invoke` and of the tool set, and in `url` only. A date-formatted string
is the `DateTime` brand on both sides — the suite's one reading of
`format: "date-time"`, shared by `@jarenjs/db`'s generated entity types,
the schema pen and `toTypeScript`, so a contract whose input carries a
date types the same through the pen and through `jaren-contract types`.

## 6. What it cannot spell

Every construct the contract pen refuses as unspellable is `JL0102`. §2's
Status column names the ones that belong to a method of this pen, each
beside the spelling that works; the binder's shared table
([LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3) carries the condition in full.

## 7. Cost

`@jarenjs/linq/contract` builds to **44,446 bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md). It carries the schema pen (a contract's inputs and outputs are schemas), and no chain module, no `@jarenjs/contract` byte and no other pen.
