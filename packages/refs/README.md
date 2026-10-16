# @jarenjs/refs

The official JSON Schema meta-schemas for `draft-06`, `draft-07`, `draft 2019-09` and `draft 2020-12`, bundled for offline use with [Jaren](https://github.com/jklarenbeek/jarenjs), and the Jaren 2020-12 dialect that checks `$query`.

## Usage

```javascript
import { JarenValidator } from '@jarenjs/validate';
import { getSchemaDraftByName, getSchemaDraftByVersion } from '@jarenjs/refs';

const meta = getSchemaDraftByName('draft2020-12'); // or getSchemaDraftByVersion(2020)

const jaren = new JarenValidator()
  .addMetaSchema([...meta.schema], meta.draft);
```

`getSchemaDraftByVersion` accepts `6`, `7`, `2019` and `2020` (any other value, including the names every object inherits such as `'constructor'`, throws; upgrade: those names used to answer the inherited member); `getSchemaDraftByName` accepts the common spellings (`draft7`, `draft-07`, `2019-09`, `draft2020-12`, ...). Each returns `{ draft, schema }` where `schema` is the array of meta-schema documents for that draft (2019-09 and 2020-12 ship multiple vocabulary documents).

## The Jaren 2020-12 dialect

`@jarenjs/refs/jaren-2020-12` ships one dialect of Jaren's own beside the
official ones: the 2020-12 meta-schema plus a required query vocabulary
(`queryVocabulary`, `https://jarenjs.dev/schemas/2020-12/vocab/query`), whose
meta-schema checks every `$query` value against the query grammar
[`@jarenjs/json`](../json) publishes. Its default export holds the dialect
meta-schema, the vocabulary meta-schema, that grammar (the same object
`@jarenjs/json/schemas/jaren-query.schema.json` exports, not a copy) and the
2020-12 documents; `dialect` is the URI a schema names in `$schema`:

```javascript
import { JarenValidator } from '@jarenjs/validate';
import jaren2020, { dialect } from '@jarenjs/refs/jaren-2020-12';

const jaren = new JarenValidator().addMetaSchema([...jaren2020], dialect);
jaren.validateSchema({ $schema: dialect, $query: { $le: ['$.start', '$.end'] } }); // true
jaren.validateSchema({ $schema: dialect, $query: { $lte: ['$.start', '$.end'] } }); // false
```

The validate README's [`$query` section](../validate/README.md#checking-query-itself--the-jaren-2020-12-dialect)
shows the errors and what the dialect does and does not change.

The meta-schemas matter beyond `$ref` resolution: [`@jarenjs/validate`](../validate) uses them for draft detection, `$vocabulary`-aware keyword selection (including `format-assertion`), and cross-draft references — all offline, with no network fetches.

See the repository [README](../../README.md) for full documentation and the [HOWTO](../../docs/HOWTO.md) for multi-draft setups.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.refs-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/refs` | JavaScript | declared |
| `@jarenjs/refs/draft-06` | schema | — |
| `@jarenjs/refs/draft-07` | schema | — |
| `@jarenjs/refs/draft-2019-09` | JavaScript | declared |
| `@jarenjs/refs/draft-2020-12` | JavaScript | declared |
| `@jarenjs/refs/jaren-2020-12` | JavaScript | declared |
| `@jarenjs/refs/package.json` | metadata | — |
<!--/fact-->
