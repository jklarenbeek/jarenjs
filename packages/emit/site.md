---
package: "@jarenjs/emit"
card:
  title: Schemas as TypeScript
  blurb: >-
    Build-time artifacts from JSON documents: a schema graph flattened into
    a published type model and rendered by a JTLT stylesheet per target —
    TypeScript declarations, Markdown reference docs — with a check mode
    that fails CI when a schema moved and the types did not.
---

The gap a schema-first codebase has where a Zod codebase has z.infer. The
observation is small: a JSON Schema is JSON, TypeScript is text, and JTLT is
JSON-to-text — so generating a declaration file is a stylesheet, not a new
engine. Point `jaren-emit` at a directory of schemas and get .d.ts files with
doc comments, unions, tuples, index signatures and recursive references;
--check fails CI when a schema moved and the types did not.

```bash
npx jaren-emit --schema ./schemas --out ./src/types
```

```js
import { emitTypeScript } from '@jarenjs/emit';
emitTypeScript(schema, { name: 'User' });
// export interface User { id: string; role?: "admin" | "user"; [key: string]: unknown; }
// the index signature IS the schema: close it with additionalProperties: false and it goes
```

> **The cyclic verification** — What makes generated types trustworthy is that
> Jaren owns both sides. The same schema becomes a TYPE and a VALIDATOR, and
> the two must correspond over a corpus of instances: every schema-valid
> instance must type-check (so the type is never narrower than the schema),
> every structurally invalid one must not (never wider), and the cases
> TypeScript genuinely cannot express — minLength, pattern, format — are
> asserted as widened AND written into the generated file as a comment.
> Widening silently is the most common way a generated type misleads its
> reader. A standalone schema-to-TypeScript tool has no validator to disagree
> with; the suite here is itself checked by breaking the generator on purpose
> and confirming it fails.

Normalization makes a contract's input and output shapes differ — a defaulted
member is optional for the caller and present afterwards, a coerced one arrives
as a transport string. Pass the same normalize options to the generator and it
names both sides: Config is what you have after normalizing, `ConfigInput` is
what a caller may hand in. That pair is exactly what a typed contract boundary
wants, and a twin appears only where the type actually differs, so one
defaulted field does not double every declaration. The switch resolution is
imported from the normalizer rather than reimplemented, because a variant that
disagrees with it is worse than no variant.

Two stages, because a schema graph is not shaped like a declaration file: an
analysis pass flattens refs, cycles, composition and anonymous subschemas into
a published type model, and a JTLT stylesheet per target renders it. Markdown
reference docs ship as a second target — as unlike TypeScript as a target gets,
and it needed no change to the model, which is the evidence the split earned
its keep.
