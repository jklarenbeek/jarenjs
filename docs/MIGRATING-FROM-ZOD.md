# Migrating from Zod

A practical map from Zod to Jaren, for a codebase that already has Zod
schemas and wants JSON Schema underneath them.

Read the trade first: this is not a drop-in replacement, and it should not
be. Zod bundles four things — validation, normalization, TypeScript
inference and an error API. Jaren gives you the first two, a typed,
narrowing surface for the third, and — through the schema pen,
`@jarenjs/linq/schema` — inference for schemas built in code; it does not
infer types from schema literals, and it never runs arbitrary transforms.
What you get in exchange is that your contracts stop being a library
dialect: what the pen writes is standard JSON Schema, and the pen is one
`import` you can drop.

## Should you?

**Reasons to move.** Your schemas become standard JSON Schema — publishable
to OpenAPI tooling, consumable by other languages and other validators, and
usable as the constraint for an LLM's structured output. The same compiled
validators run in the browser under a strict Content Security Policy (no
`eval`, no `new Function`) and on the server, so there is one semantics to
characterize instead of two. There are no third-party runtime dependencies.
And on the operation a service actually performs — normalize, validate, map
errors — Jaren is measurably faster than every Zod flavor (numbers below).

**Reasons not to.** If your value is `z.infer` over schema *literals*, Jaren
does not replace that; a literal is asserted or generated, and only a schema
built through the pen carries `Infer<>`. If your contracts lean on
`.transform()` chains, those stay application code by design. And if you are
not otherwise using JSON Schema, the portability argument is worth little
to you.

## The idiom map

The third column is the schema pen (`import * as s from
'@jarenjs/linq/schema'`), which writes the second column for you and
carries the type; every pen spelling here is one the pen's corpus emits.

| Zod | JSON Schema | The pen |
| --- | --- | --- |
| `z.string()` | `{ "type": "string" }` | `s.string()` |
| `z.number()` / `z.number().int()` | `{ "type": "number" }` / `{ "type": "integer" }` | `s.number()` / `s.number().int()`, `s.integer()` |
| `z.boolean()`, `z.null()` | `{ "type": "boolean" }`, `{ "type": "null" }` | `s.boolean()`, `s.nil()` |
| `z.literal('a')` | `{ "const": "a" }` | `s.literal('a')` |
| `z.enum(['a','b'])` | `{ "enum": ["a","b"] }`, or typed: `{ "type": "string", "enum": ["a","b"] }` | `s.enumOf(['a', 'b'])`, or `s.string().enumOf(['a', 'b'])` |
| `z.array(T)` | `{ "type": "array", "items": T }` | `s.array(T)` |
| `z.tuple([A, B])` | `{ "type": "array", "prefixItems": [A, B], "items": false, "minItems": 2 }` | `s.tuple([A, B]).rest(s.never())` (without `.rest()` the tuple stays open, as JSON Schema reads it) |
| `z.object({...})` | `{ "type": "object", "properties": {...}, "required": [...], "additionalProperties": false }` | `s.object({...})` — closed by default, like `.strict()` |
| `.optional()` | omit the key from `required` | `.optional()` |
| `.nullable()` | `{ "type": ["string","null"] }` | `.nullable()` |
| `z.record(T)` | `{ "type": "object", "additionalProperties": T }` | `s.record(T)` |
| `z.union([A, B])` | `{ "anyOf": [A, B] }` | `s.union([A, B])` |
| `z.discriminatedUnion('k', [...])` | `{ "oneOf": [...] }`, or `if`/`then` on the discriminator | `s.discriminated('k', [...])` |
| `z.intersection(A, B)` | `{ "allOf": [A, B] }` | `s.intersection([A.open(), B.open()])` — closed objects do not intersect; `A.extend(...)` merges them |
| `.min(n)` / `.max(n)` on strings | `minLength` / `maxLength` | `.min(n)` / `.max(n)` |
| `.min(n)` / `.max(n)` on numbers | `minimum` / `maximum` | `.min(n)` / `.max(n)` (`.gt()`/`.lt()` for the exclusive pair) |
| `.regex(re)` | `{ "pattern": "..." }` | `.pattern(re)` |
| `z.uuid()`, `z.email()`, `z.url()` | `{ "type": "string", "format": "uuid" \| "email" \| "uri" }` | `s.string().uuid()`, `.email()`, `.uri()` |
| `z.iso.datetime()` | `{ "type": "string", "format": "date-time" }` | `s.datetime()` — typed as the linq `DateTime` brand |
| `.default(v)` | `{ "default": v }` + the normalizer's `useDefaults` | `.default(v)` — present in `Infer<>`, optional in `Input<>` |
| `.strict()` (and Zod's default stripping) | `additionalProperties: false` + `removeAdditional` | the default; `.open()` to lift it |
| `.passthrough()` | leave `additionalProperties` open, `removeAdditional: false` | `.open()` |
| `z.coerce.number()` | `{ "type": "number", "x-coerce": true }` + `coerceTypes` as a predicate | `s.number().coerce()` — `Input<>` admits the string form |
| `.trim()` | the normalizer's `trimStrings`, as a **predicate** — see below | `s.string().trim()` (`x-trim: true`) |
| `.refine()` / `.superRefine()` | conditionals (`if`/`then`), or the [`$query` keyword](../packages/validate/README.md#query--cross-field-assertions) for cross-field rules | `.check((o) => o.total.eq(o.lines.all().amount.sum()))` — captured into `$query`; a function `refine` is refused (`JL0102`) |
| `.transform()` | **stays application code** — see below | not a method (`JL0102` names the reason) |
| `z.lazy()` + recursion | `$ref: '#'` or `$ref: '#/$defs/Name'` | `s.named('Node', …)` + `s.lazy(() => Node)` |

### Three that do not map cleanly

**`.transform()` has no equivalent, on purpose.** An arbitrary function is
application code, not schema semantics; putting it in the schema is what
makes a schema non-portable. Run it after validation, where it is visible.

**`.refine()` splits in two.** A rule about one value is usually a keyword
you already have (`pattern`, `multipleOf`, `minimum`). A rule *across*
fields — "end must be after start", "the line items must sum to the total" —
is what [`$query`](../packages/validate/README.md#query--cross-field-assertions)
is for, and unlike a refinement it stays inside the schema and stays data.

**`z.infer` has no equivalent for schema *literals*.** Jaren does not derive
TypeScript types from a JSON literal. A schema built through the pen carries
`Infer<>` — proven against `@jarenjs/emit`'s generated declarations and the
validator's verdicts by one corpus, so the type is never wider or narrower
than the document it wrote:

```typescript
import * as s from '@jarenjs/linq/schema';
import type { Infer } from '@jarenjs/linq/schema';

const User = s.object({ id: s.string().uuid(), name: s.string().min(1) });
type User = Infer<typeof User>;   // { id: string; name: string }
```

For a literal, either assert the type at the call site, which is checked:

```typescript
const isUser = validator.compile<User>(userSchema);
if (isUser(input)) input.name;   // input is User here
```

...or generate types from your canonical schemas with `@jarenjs/emit`
(`emitTypeScript(schema)`), which composes with the above.

## The error-shape map

Zod's `issue.path` is a `(string|number)[]`. Jaren's `instancePath` is an
RFC 6901 JSON Pointer string. `parseJSONPointerPath` converts one to the
other, narrowing canonical array indexes to numbers:

```javascript
import { parseJSONPointerPath } from '@jarenjs/json';

const issues = result.errors.map(e => ({
  path: parseJSONPointerPath(e.instancePath),  // ['items', 0, 'qty']
  code: e.keyword,                             // 'minimum'
  message: e.message,
}));
```

| Zod | Jaren |
| --- | --- |
| `issue.path` (array) | `error.instancePath` (pointer) → `parseJSONPointerPath` |
| `issue.code` | `error.keyword` |
| `issue.message` | `error.message` |
| — | `error.msgid` + `error.params`, for report-time i18n |
| — | `error.schemaPath`, the absolute URI of the failing keyword |
| `result.success` | `result.valid` |
| `error.issues` (v4) / `error.errors` (v3) | `result.errors` |

### Two mappings your adapter has to write

**A `required` error points at the owning object, Zod points at the member.**
There is no location for a member that is not there, so Jaren reports the
object and names the absent key in `params.missingProperty`. Zod synthesizes
the child path. Append it:

```javascript
function toPath(error) {
  const path = parseJSONPointerPath(error.instancePath);
  return error.keyword === 'required'
    ? [...path, error.params.missingProperty]
    : path;
}
```

**An array yields per-item errors *plus* an aggregate `items` error** at the
array itself, carrying the count of failing elements. Zod emits only the
per-item issues. Decide once, centrally, whether the aggregate is signal
(useful for "3 of 50 rows are invalid" summaries) or noise, and filter it in
the adapter rather than at each call site:

```javascript
const issues = result.errors
  .filter(e => !(e.keyword === 'items' && dropAggregates))
  .map(toIssue);
```

There is one more ambiguity worth knowing about, and it is inherent rather
than a defect: `parseJSONPointerPath` turns a canonical numeric token into a
number, so an object key `'0'` and array index `0` both become `0`. RFC 6901
has no types, so the pointer alone cannot distinguish them. If your contracts
have objects with numeric-looking keys, resolve the path against the input
document in the adapter instead of trusting the lexical answer.

Two behavioral differences to characterize rather than assume. Jaren points
`instancePath` at the offending member for `additionalProperties`, where Ajv
points at the parent. And `params` deliberately carries the offending values,
so do not forward it to an untrusted caller unfiltered.

## The configuration recipe

Zod counts UTF-16 code units, always collects every issue, and always
asserts formats. This reproduces those three answers:

```javascript
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import * as formats from '@jarenjs/formats';

export const jaren = new JarenValidator({
  collectErrors: true,      // { valid, errors } instead of a boolean
  useGrapheme: false,       // UTF-16 code units, like Zod's .min()/.max()
  formatAssertion: true,    // assert format even under draft 2020-12
  contentValidation: true,  // assert contentEncoding/contentMediaType
})
  .addFormats(formats.stringFormats)
  .addFormats(formats.dateTimeFormats);

export function contract(schema) {
  const normalize = compileNormalizer(schema, {
    useDefaults: true,
    removeAdditional: true,   // 'all' to match Zod's strip-by-default
    // Zod trims per field, so mirror that with a predicate rather than a
    // global `true` — otherwise every string in the contract gets trimmed,
    // including ones whose whitespace is data.
    coerceTypes: (node) => node['x-coerce'] === true,
    trimStrings: (node) => node['x-trim'] === true,
  });
  const validate = jaren.compile(schema);
  return (input) => {
    const value = normalize(input);
    const result = validate(value);
    return result.valid
      ? { ok: true, value }
      : { ok: false, issues: result.errors.map(toIssue) };
  };
}
```

**`.trim()` and `z.coerce` are per-field in Zod, so keep them per-field
here.** `trimStrings: true` trims every string the walk reaches. If your
contracts trim 34 of 219 string fields — the usual ratio — a global switch
silently rewrites the other 185. Mark the fields in the schema (`x-trim`, or
any annotation you like) and pass a predicate; it is evaluated at compile
time, so it costs nothing per request.

**`useGrapheme: false` is not optional if you want parity.** Jaren counts
grapheme clusters by default, so a string of emoji that failed `maxLength`
under Zod will pass under Jaren unless you set it. Put a characterization
test on that specific boundary.

Two more differences worth a test each. Zod strips unknown keys by *default*
(`removeAdditional: 'all'` is the equivalent; plain `true` only strips where
the schema says `additionalProperties: false`). And `z.coerce.boolean()` is
JavaScript's `Boolean()`, so `'false'` coerces to `true` — Jaren's table
accepts only `'true'` and `'false'` and passes anything else through for
validation to reject, which is a behavior change in your favor but still a
behavior change.

## Performance

From `npm run benchmark:contracts` (Node v22, 20 000 iterations; reproduce it
yourself rather than trusting the table). The row that matters is the third —
normalize, validate, and map errors, which is what a request handler does.
Times are per operation; lower is better.

**Adapter row (invalid input), the comparable measurement:**

| Scenario | Jaren | Zod 4 | Zod 3 | zod/mini | Ajv |
| --- | --- | --- | --- | --- | --- |
| command (uuid/enum/date-time) | **5.1 µs** | 20.5 µs | 9.6 µs | 13.5 µs | 2.7 µs |
| config (defaults + coercion) | **3.8 µs** | 14.5 µs | 7.5 µs | 10.6 µs | 2.6 µs |
| collection (50 records) | **20.6 µs** | 27.1 µs | 27.6 µs | 30.9 µs | 27.8 µs |

Jaren is 1.3–4.0× faster than every Zod flavor on all three. **Ajv is faster
than Jaren on two of the three** (1.9× on command, 1.5× on config) and slower
on the third (1.3×) — that is the honest picture, and it is the expected
shape: Ajv generates source with `new Function`, Jaren compiles closures
because the no-`eval` rule is what makes it CSP-safe. Taken as a geometric
mean across the three scenarios against the *fastest rival per scenario*,
Jaren comes out **1.3× slower** — which is what the benchmarks page reports
rather than quoting only the scenarios it wins. The remaining gap on small
schemas is tracked as an optional codegen backend in the roadmap.

Compilation is paid once per process and is where Jaren is generally slowest
— Zod 3 builds a schema 2.2–8.5× faster. If you compile thousands of schemas
at boot, measure it; if you compile them once at module load, it does not
matter.

## Staging a migration

The order that keeps risk low, and the reason for it:

1. **Put a boundary in first.** A `Contract<Input, Output>` facade your route
   handlers depend on, with a neutral error type. Migrate the facade's
   internals, not 130 call sites.
2. **Make the error handler library-neutral before anything else.** A
   framework that recognizes `instanceof ZodError` will turn the first Jaren
   failure into a 500.
3. **Characterize before you migrate.** Dual-run both engines over your real
   payload corpus and diff validity, normalized output, and error paths.
   Error parity in particular must be measured, not inferred from validity
   parity.
4. **Start with a contract that has no defaults, transforms or refinements** —
   a uuid/enum command object. Then simple commands in groups, then
   frontend consumers, then cross-field rules, and configuration last,
   because it combines coercion, defaults and environment-dependent rules.
5. **Remove Zod only when** every public schema goes through the facade and
   your bundle contains no accidental Zod import.

Reference: [Compatibility settings](../packages/validate/README.md#compatibility-settings),
[Normalization](../packages/validate/README.md#normalization),
[CONSUMING.md](CONSUMING.md).
