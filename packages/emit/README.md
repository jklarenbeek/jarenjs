# @jarenjs/emit

Build-time artifacts from JSON documents. Point it at your JSON Schemas, get
TypeScript declarations — or Markdown reference docs, or whatever a stylesheet
emits next.

```bash
npx jaren-emit --schema ./schemas --out ./src/types
```

```javascript
import { emitTypeScript } from '@jarenjs/emit';

emitTypeScript({
  type: 'object',
  description: 'A user',
  properties: {
    id: { type: 'string', format: 'uuid' },
    role: { enum: ['admin', 'user'] },
  },
  required: ['id'],
}, { name: 'User' });
```

```typescript
/**
 * A user
 */
export interface User {
  /**
   * Schema constraints this type cannot express: format="uuid"
   */
  id: string;
  role?: "admin" | "user";
}
```

## Why this exists

A schema-first codebase has a gap where a Zod codebase has `z.infer`: the
schema knows the shape, and TypeScript does not. The usual answers are to
assert the type by hand — which can silently certify something the schema
never said — or to reach for a type-level library.

The observation this package is built on is smaller than either: **a JSON
Schema is JSON, TypeScript is text, and [JTLT](../json/docs/JTLT-FORMAT.md) is
JSON-to-text.** Generating a declaration file is a stylesheet, not a new
engine. That is also why it is called `emit` and not `infer` — swap the
stylesheet and the same machinery emits documentation, DDL, or anything else
a target language needs.

## The cyclic verification

This is the part that matters, and the part a standalone
schema-to-TypeScript tool structurally cannot do.

One schema goes two ways, and the two answers have to correspond:

```
                    ┌─────────────────────┐
                    │     JSON Schema     │
                    └────┬───────────┬────┘
        @jarenjs/emit    │           │    @jarenjs/validate
                         ▼           ▼
                 TypeScript type   compiled validator
                         │           │
                         └─────┬─────┘
                               ▼
                    the SAME instances, and the
                    two answers must correspond
```

A generator that is merely *plausible* is worthless. It will emit a type that
says one thing while the validator enforces another, and you find out in
production — data that passed validation and violates its own declared type,
or a type so wide it certifies anything.

Because Jaren owns **both sides**, that can be tested rather than trusted.
The suite in `test/emit/agreement.test.js` takes a corpus of schemas plus
instances, generates the declarations, writes a probe file that assigns every
instance to its generated type, and runs `tsc` over it. Then it runs the
compiled validator over the same instances and requires three relationships to
hold:

| Instance | Validator | Generated type | What a failure would mean |
| --- | --- | --- | --- |
| valid | accepts | **must** type-check | the type is **narrower** than the schema — it rejects data your service accepts |
| structurally invalid | rejects | **must not** type-check | the type is **wider** than the schema — it certifies data your service rejects |
| constraint-invalid | rejects | **does** type-check | the documented widening — see below |

The third row is the honest one. TypeScript cannot express `minLength`,
`pattern` or `format`, so a value can be type-correct and schema-invalid.
Rather than hide that, the corpus asserts it, and the generator writes the
dropped constraint into the generated file:

```typescript
  /**
   * Schema constraints this type cannot express: minLength=3
   */
  id: string;
```

The type says `string`. The comment says the schema also demands a minimum
length that the type does not enforce. A reader learns both. **Widening
silently would be a lie of omission**, and it is the single most common way a
generated type misleads the person reading it.

The rig is checked against itself, too: deliberately breaking the generator so
it emits `unknown` everywhere makes the "not wider than the schema" assertion
fail. A verification suite that passes on a broken generator proves nothing.

## Two stages, and why

```
schema ──▶ compileEmitModel ──▶ TYPE MODEL ──▶ stylesheet ──▶ artifact
```

The templating is the easy half. The hard half is that a schema graph is not
shaped like a declaration file: `$ref`s point sideways and in cycles,
subschemas nest anonymously, `allOf` means intersection while `anyOf` means
union, and half the vocabulary has no type-level meaning. **Stage one** does
that flattening once — resolving refs, breaking cycles by name, deriving
identifiers, widening honestly — into a flat list of named declarations.

**Stage two** is a JTLT stylesheet per target. TypeScript and Markdown ship;
both read the same model, and neither has privileged access to it.

The [type model](./docs/EMIT-FORMAT.md) is a **published format** with its own
[JSON Schema](./schemas/jaren-emit-model.schema.json) — and the test suite
validates every model the package produces against it, so "published format"
stays true rather than becoming decoration. A third-party emitter targeting
the model is exactly as capable as the bundled ones.

Markdown exists mainly as evidence for that claim: it is as unlike TypeScript
as a target gets, and adding it required **no change to stage one**. If the
model had secretly been the TypeScript printer's private state, writing it
would have forced one.

## CLI

```bash
jaren-emit --schema <file|dir> --out <dir> [options]

  --target <name>   typescript (default) or markdown
  --name <Name>     root declaration name for a single schema
  --bundle <file>   one output file instead of one per schema
  --check           write nothing; exit 1 if any output is out of date
```

`--check` is the CI guard: it fails the build when a schema changed and the
generated types did not, which is the failure mode that makes generated code
untrustworthy in the first place.

## What it maps

| JSON Schema | TypeScript |
| --- | --- |
| `type: 'string' \| 'number' \| 'integer' \| 'boolean' \| 'null'` | the primitive (`integer` → `number`) |
| `const` / `enum` | a literal / a union of literals |
| `properties` + `required` | interface members, optional when not required |
| `additionalProperties` / `patternProperties` | an index signature, widened to cover the declared members |
| `items` | `Array<T>` |
| `prefixItems`, array-form `items` | a tuple, with `additionalItems`/`items` as the rest |
| `$ref` (same document, including cycles) | a reference to the named declaration |
| `allOf` | an intersection |
| `anyOf`, `oneOf` | a union |
| `description` | a doc comment |

**Widened, with the constraint recorded**: `minLength`, `maxLength`,
`pattern`, `format`, `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems`, `uniqueItems`,
`contains`, `minProperties`, `maxProperties`, `propertyNames`,
`dependentRequired`, and the Jaren extension keywords.

**Not mapped**: `if`/`then`/`else` and `not` have no sound type-level
equivalent, and cross-document `$ref`s are not followed — a model compiles the
document it was handed. Each of these leaves `unknown` rather than a guess.

## Honest comparison

[`json-schema-to-ts`](https://github.com/ThomasAribart/json-schema-to-ts)
computes types *in the type system* from schema literals. This generates
*source*. Different mechanism, different trade:

- **Theirs** needs no build step and stays exact as you edit a literal.
- **Ours** works on schemas that live in `.json` files, produces declarations
  a human can read and review in a diff, emits non-TypeScript targets, and can
  be checked against the validator that will actually run.

If your schemas are TypeScript literals and you want zero build steps, use
theirs. If your schemas are documents — published, shared with other
languages, or fed to an LLM's structured-output mode — this is the one that
fits.

## Development

Tests live in `test/emit/` at the repository root (`npm run test:emit`).
`agreement.test.js` is the cyclic verification and needs the workspace's
TypeScript. The internals are described in [ARCHITECTURE.md](./ARCHITECTURE.md);
the model contract is in [EMIT-FORMAT.md](./docs/EMIT-FORMAT.md).
