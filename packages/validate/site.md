---
package: "@jarenjs/validate"
card:
  title: JSON Schema
  blurb: >-
    Compiles schemas to specialized closures: annotation-driven unevaluated*
    with statically-elided checks, dynamic refs, $data, the $query
    cross-field keyword and structured, localizable errors.
  perf: >-
    scored on the official suite per draft; the Ajv ratio is measured, not
    claimed
engines:
  - key: validate
    suite: validate
---

A validating COMPILER, not an interpreter: compilation does all the deciding —
which keywords apply, which annotations have to be collected, which checks are
statically dead — and hands back a closure that only runs what can still fail.
No eval, no new Function.

### Quick start

Compile a schema once, validate as often as you like. Compilation does all the
deciding; validation runs a specialized closure.

```js
import { JarenValidator } from '@jarenjs/validate';

const jaren = new JarenValidator();
const validate = jaren.compile({
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['name'],
});

validate({ name: 'John', age: 30 });  // true
validate({ age: -5 });                // false
```

### Validation options

The validator constructor takes the operational switches: `collectErrors`
gathers every failure instead of stopping at the first; `skipErrors: false`
makes the compiled function return { valid, errors }; `formatAssertion`
controls whether the format keyword asserts or only annotates.

```js
const jaren = new JarenValidator({
  skipErrors: false,
  collectErrors: true,
  formatAssertion: true,
});
const validate = jaren.compile(schema);
const { valid, errors } = validate(data);
```

### Errors & i18n

Every error is structured: `instancePath`, keyword, a stable msgid and raw
params — human text renders at report time through a message catalog, so
switching language never re-validates. `@jarenjs/locales` ships packs for
Dutch, French, Spanish, Portuguese, German, Japanese, Korean, Traditional
Chinese (Taiwan), Russian, Turkish and Arabic; the locale switcher on Play’s
result card runs exactly this mechanism.

```js
import { compileMessageCatalog, localizeErrors } from '@jarenjs/validate';
import { fr } from '@jarenjs/locales';  // nl, fr, es, pt, de, ja, ko, zhTW, ru, tr, ar

const catalog = compileMessageCatalog(fr);
localizeErrors(result.errors, catalog);  // the same errors, French text
```

> **Schema-authored messages** — The errorMessage keyword and its `$msgid` form
> keep even schema-authored texts translatable — see `ERROR-MESSAGES.md` in the
> validate package.

### External schemas & $ref

Register schemas by `$id` and reference them; bundled meta-schemas
(`@jarenjs/refs`) make draft detection and `$vocabulary` work offline. Dynamic
references and per-document draft handling are spec-compliant.

```js
jaren.addSchema({ $id: 'https://example.com/address.json', type: 'object', properties: { city: { type: 'string' } } });
const validate = jaren.compile({
  type: 'object',
  properties: { address: { $ref: 'https://example.com/address.json' } },
});
```

### The $query keyword

Cross-field assertions — sums, date ordering, quantification — inside the
schema itself: the `$query` extension keyword embeds a Jaren JSON Query as an
assertion over the whole instance. This is the class of constraint JSON Schema
is notoriously bad at.

```json
{ "type": "object",
  "properties": {
    "lines": { "type": "array", "items": { "type": "number" } },
    "total": { "type": "number" }
  },
  "$query": { "$eq": ["$.total", { "$sum": "$.lines[*]" }] } }
```

The scorecard for the official JSON-Schema-Test-Suite — every benchmarked
draft, this engine and Ajv beside each other, each counted over the tests it
could run — is published in [Draft support](#/docs?s=draft-support), from the
same generated run the Benchmarks page reads.

**Try it.** [Play's JSON Schema engine](#/play?engine=validate) compiles as you
type, shows the structured errors with their msgids, re-renders them in another
language without re-validating, and can swap the data pane for a form generated
from the schema beside it.
