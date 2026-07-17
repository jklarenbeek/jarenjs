# @jarenjs/refs

The official JSON Schema meta-schemas for `draft-06`, `draft-07`, `draft 2019-09` and `draft 2020-12`, bundled for offline use with [Jaren](https://github.com/jklarenbeek/jarenjs).

## Usage

```javascript
import { JarenValidator } from '@jarenjs/validate';
import { getSchemaDraftByName, getSchemaDraftByVersion } from '@jarenjs/refs';

const meta = getSchemaDraftByName('draft2020-12'); // or getSchemaDraftByVersion(2020)

const jaren = new JarenValidator()
  .addMetaSchema([...meta.schema], meta.draft);
```

`getSchemaDraftByVersion` accepts `6`, `7`, `2019` and `2020`; `getSchemaDraftByName` accepts the common spellings (`draft7`, `draft-07`, `2019-09`, `draft2020-12`, ...). Each returns `{ draft, schema }` where `schema` is the array of meta-schema documents for that draft (2019-09 and 2020-12 ship multiple vocabulary documents).

The meta-schemas matter beyond `$ref` resolution: [`@jarenjs/validate`](../validate) uses them for draft detection, `$vocabulary`-aware keyword selection (including `format-assertion`), and cross-draft references — all offline, with no network fetches.

See the repository [README](../../README.md) for full documentation and the [HOWTO](../../HOWTO.md) for multi-draft setups.
