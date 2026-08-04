# @jarenjs/db

Document storage for the Jaren suite, over SQLite. A **model
document** declares collections — each a JSON Schema plus declared
indexes — and `openStore` creates or opens a database, applies the
physical mapping, and gives transactional, schema-validated reads and
writes. The same code runs on Node, on Bun, and in a browser against
an injected wasm handle, with zero dependencies outside `@jarenjs/*`.

```js
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const store = await openStore({
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string' },
          email: { type: 'string', format: 'email' },
          age: { type: 'integer' },
        },
      },
      key: '/id',
      indexes: [
        { name: 'by_email', path: '$.email', unique: true },
        { name: 'by_age', path: '$.age' },
      ],
    },
  },
}, { driver: nodeDriver(), path: 'app.db' });

const users = store.collection('users');
await users.insert({ id: 'u1', email: 'ada@example.test', age: 36 });
await users.patch('u1', [{ op: 'replace', path: '/age', value: 37 }]);
const ada = await users.get('u1');
await store.transaction(async (s) => {
  await s.collection('users').put({ id: 'u2', email: 'lin@example.test' });
});
```

- **Storage is declarative.** Indexed paths become generated columns
  plus real indexes; the collection's schema types them. Opening an
  existing database verifies the declared shape and refuses to alter
  it (`JD0002`) — reshaping is a migration concern, not a side effect.
- **Writes validate** through an injected hook (for example
  `@jarenjs/validate`'s `createTypeTestCompiler`); without one,
  `store.capabilities.validated` is `false` and the docs say what that
  costs. This package never imports a validator.
- **The public API is asynchronous** — the browser's OPFS story forces
  that — with a declared synchronous fast path: where the driver is
  synchronous, the same operations exist promise-free under
  `store.sync`. Where it is not, `store.sync` is absent, not stubbed.
- **`patch` updates in place.** RFC 6902 operations translate to
  JSON-set primitives so a one-field update does not rewrite a large
  document; untranslatable operations fall back to a whole-document
  write, and the fallback is counted at `collection.stats()`.
- **Capabilities over sniffing.** `store.capabilities` reports what
  the opened library and binding can actually do — including, honestly,
  what SQLite cannot (`statementTimeout: false`,
  `rowEstimates: false`).

The normative format is [`docs/MODEL-FORMAT.md`](docs/MODEL-FORMAT.md);
the seams are documented in [`ARCHITECTURE.md`](ARCHITECTURE.md).
SQLite — 3.45 or newer — is the supported backend; nothing else is
promised.
