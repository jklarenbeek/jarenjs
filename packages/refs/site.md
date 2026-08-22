---
package: "@jarenjs/refs"
card:
  title: Draft meta-schemas
  blurb: >-
    The bundled JSON Schema draft meta-schemas and their vocabularies, so
    draft detection, $vocabulary processing and meta-validation answer
    offline — a validator that never fetches a schema from the network to
    find out which draft it is reading.
---

The four official JSON Schema meta-schemas — draft-06, draft-07, 2019-09 and
2020-12 — bundled as data, so everything a validator needs to know about the
dialect it is reading is already in the process. 2019-09 and 2020-12 publish
their vocabularies as several documents each, and a draft entry carries all of
them.

```js
import { JarenValidator } from '@jarenjs/validate';
import { getSchemaDraftByName } from '@jarenjs/refs';

const meta = getSchemaDraftByName('draft2020-12');
const jaren = new JarenValidator().addMetaSchema([...meta.schema], meta.draft);
```

The lookups accept the spellings people actually write: `getSchemaDraftById`
resolves a `$schema` URI, `getSchemaDraftByName` the common names (`draft7`,
`draft-07`, `2019-09`, `draft2020-12`), `getSchemaDraftByVersion` the bare
years. Each answers `{ draft, schema }`.

What this buys is offline behaviour, not convenience: draft detection,
`$vocabulary`-aware keyword selection (`format-assertion` included) and
cross-draft references all resolve from these documents, so compiling a schema
never reaches the network to find out which dialect it is in — the property
that lets the validator run in a browser tab under a strict connect policy.
