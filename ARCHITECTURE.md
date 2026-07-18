# JarenJS Architecture

This document describes the architecture of the JarenJS monorepo: how the packages fit together, the compile-to-closures design philosophy they all share, and the internal architecture of the JSON Schema validating compiler at the center of it. Deeper per-package internals live in each package's own ARCHITECTURE document (linked below); the user-facing stories are the package READMEs.

## Table of Contents

- [Overview](#overview)
- [Monorepo Layout](#monorepo-layout)
- [Core Design Principles](#core-design-principles)
- [Four-Phase Architecture](#four-phase-architecture)
  - [Phase 1: Schema Registration](#phase-1-schema-registration)
  - [Phase 2: Schema Traversal](#phase-2-schema-traversal)
  - [Phase 3: Compilation](#phase-3-compilation)
  - [Phase 4: Validation](#phase-4-validation)
- [Key Components](#key-components)
  - [JarenValidator](#jarenvalidator)
  - [ValidationRoot](#validationroot)
  - [ValidationObject](#validationobject)
- [$ref Resolution](#ref-resolution)
- [Annotation Tracking](#annotation-tracking-unevaluatedproperties--unevaluateditems)
- [Dynamic References](#dynamic-references)
- [Drafts and Vocabularies](#drafts-and-vocabularies)
- [Data Structures](#data-structures)
- [Performance Optimizations](#performance-optimizations)
- [Error Handling](#error-handling)
- [Testing, Benchmarks and Debugging](#testing-benchmarks-and-debugging)

---

## Overview

JarenJS is a JSON toolchain built around a JSON Schema validator that compiles schemas into optimized validation functions. The architecture separates schema loading (URI resolution), compilation (validator creation), and validation (data checking) into distinct phases to enable compile-time optimizations and fast runtime performance.

The sections from [Core Design Principles](#core-design-principles) onward describe the validator (`@jarenjs/validate`); the compile-to-closures philosophy laid out there is shared by every compiler in the repository — the JSONPath, pointer, query and JSLT engines apply the same two-stage split.

## Monorepo Layout

The workspace is a dependency chain; every `packages/*` workspace declares its Jaren dependencies as peer dependencies and carries **zero runtime dependencies** outside the repository:

```mermaid
flowchart BT
    CORE["@jarenjs/core<br/>type guards, Unicode strings,<br/>text validators, scan, math"]
    JSON["@jarenjs/json<br/>Pointer, JSONPath, Query, JSLT"]
    VALIDATE["@jarenjs/validate<br/>the JSON Schema compiler"]
    FORMATS["@jarenjs/formats<br/>format keyword validators"]
    REFS["@jarenjs/refs<br/>bundled meta-schemas"]
    FORMS["@jarenjs/forms<br/>form model + x-form rules"]
    LOCALES["@jarenjs/locales<br/>error-message locale packs<br/>(zero deps, platform Intl only)"]

    JSON --> CORE
    VALIDATE --> CORE
    VALIDATE --> JSON
    FORMATS --> CORE
    FORMATS --> JSON
    FORMS --> CORE
    FORMS --> JSON
    FORMS --> FORMATS
```

| Package | Role | Internals documented in |
|---|---|---|
| [`@jarenjs/core`](packages/core) | Zero-dependency foundation; no JSON Schema knowledge | [core ARCHITECTURE](packages/core/ARCHITECTURE.md) |
| [`@jarenjs/json`](packages/json) | The addressing/query/stylesheet compilers; no JSON Schema dependency (schema *literals* compile through a host-supplied `compileTypeTest` hook) | [json ARCHITECTURE](packages/json/ARCHITECTURE.md) |
| [`@jarenjs/validate`](packages/validate) | The validating compiler; consumes core primitives and json's compiled pointers/queries | [validate ARCHITECTURE](packages/validate/ARCHITECTURE.md) |
| [`@jarenjs/formats`](packages/formats) | The canonical format-tester registry plus validator-contract compilers | — (single-layer; see its [README](packages/formats/README.md)) |
| [`@jarenjs/refs`](packages/refs) | Data-only meta-schema bundle | — |
| [`@jarenjs/forms`](packages/forms) | Schema → form model; never imports the validator (apps wire the authoritative layer) | — (see its [README](packages/forms/README.md)) |
| [`@jarenjs/locales`](packages/locales) | Locale packs (message catalogs) for validate & forms errors; deliberately dependency-free — key parity with the built-in English catalogs is enforced by repo tests, not imports | — (see its [README](packages/locales/README.md) and [ERROR-MESSAGES](packages/validate/docs/ERROR-MESSAGES.md)) |
| [`@jarenjs/website`](packages/website) | The GitHub Pages site and playground (not part of the library chain) | [website ARCHITECTURE](packages/website/ARCHITECTURE.md) |

Two deliberate inversions keep the graph acyclic while letting the layers cooperate:

- **JSON Schema as the query type system**: `@jarenjs/json`'s `$valid`/`$assert`/`$as` and JSLT schema matches accept schema literals but compile them through an injected `compileTypeTest` hook; [`@jarenjs/validate/query`](packages/validate/src/query.js) supplies the reference hook. Dependency direction stays validate → json.
- **Queries inside schemas**: `@jarenjs/validate`'s `$query` keyword compiles a Jaren JSON Query per schema location — validate consumes json, never the other way around.

### Key Files of the validator

The rest of this document describes `@jarenjs/validate`. Its main source files:

| File | Purpose |
|------|---------|
| `packages/validate/src/index.js` | Main validator classes (`JarenValidator`, `ValidationRoot`, `ValidationObject`) |
| `packages/validate/src/traverse.js` | Schema traversal and ref resolution (`storeSchemaIdsInMap`, `restoreSchemaRefsInMap`) |
| `packages/validate/src/schema.js` | Schema compilation dispatcher (`compileSchemaObject`), `$recursiveRef`/`$dynamicRef` |
| `packages/validate/src/messages.js` | Report-time error conversion, message catalogs & the `errorMessage` keyword (`ValidationError`, `messagesEn`, `localizeErrors`) |
| `packages/validate/src/query-keyword.js` | The `$query` extension keyword (Jaren JSON Query assertions inside schemas) |
| `packages/validate/src/array.js` | Array validation logic |
| `packages/validate/src/object.js` | Object validation logic |
| `packages/validate/src/string.js` | String validation logic |
| `packages/validate/src/number.js` | Number validation logic |
| `packages/validate/src/combine.js` | `allOf`/`anyOf`/`oneOf`/`not` |
| `packages/validate/src/condition.js` | `if`/`then`/`else` |
| `packages/validate/src/unevaluated.js` | `unevaluatedProperties`/`unevaluatedItems` final-stage validators |
| `packages/validate/src/dynamic-ref.js` | Dynamic-scope helpers and `$dynamicAnchor` collection |
| `packages/validate/src/tools.js` | Shared helpers, `EvalLog` annotation log, `ValidationResult` |
| `packages/validate/src/format.js` | The `format` keyword and format-compiler registry |
| `packages/validate/src/dollar-data.js` | Ajv-style `$data` references |
| `packages/validate/src/data.js` | json-everything `data` (data-ref) keyword |

---

## Core Design Principles

### 1. Compile-Time Optimization

The most important insight from Jaren's development: **all ref resolution must happen at compile time**. This means:

- `$ref` chains are flattened during schema loading
- Validation functions are pre-compiled before any data is validated
- No URI resolution happens during validation

### 2. Eager Evaluation

Refs are resolved eagerly at compile time, never lazily on first validation. This keeps the first `validate(data)` call as fast as every subsequent one:

```javascript
const validate = compile(schema); // All refs resolved here
validate(data); // Direct function call, no resolution
```

### 3. Three-Layer Caching Strategy

| Layer | What | Lifetime |
|-------|------|----------|
| Schema Map | Schemas by URI | Per `JarenValidator` instance |
| Validation Objects | Compiled validators | Per `compile()` call |
| Regex Cache | Compiled RegExp objects | Global (1000 entry limit) |

### 4. Function Inlining

To reduce call stack depth, simple schemas compile to inline validation functions rather than delegating to helper functions:

```javascript
// Before: Multiple function calls
function validate(data) {
  return validateType(data) && validateString(data);
}

// After: Inlined for simple cases
function validate(data) {
  if (typeof data !== 'string') return false;
  if (data.length > maxLength) return false;
  return true;
}
```

---

## Four-Phase Architecture

### Phase 1: Schema Registration

**Purpose**: Build a map of all reachable schemas by URI.

**Entry Point**: `JarenValidator.addSchema(schema, key)`

**Flow**:
```
addSchema(schema, key)
  ├── Store schema under key (and alt key with/without #)
  └── #traverseAndStoreIds(baseUri, schema)
        └── storeSchemaIdsInMap(schemasMap, baseUri, schema)
              ├── Store root schema under baseUri
              └── BFS traverse schema structure:
                    ├── On $id: Store subschema, update baseUri
                    ├── On $anchor: Store anchor
                    ├── On $ref: Store null placeholder (mark as ref)
                    └── On schema objects/arrays: Continue traversal
```

**Key Data Structure**: `#schemas Map<string, schema|null>`

- Keys are normalized URIs (e.g., `http://example.com/schema#`, `#/$defs/foo`)
- Values are either the schema object or `null` (for refs that point elsewhere)
- Stored at `JarenValidator` instance level (survives multiple `compile()` calls)

**Important**: At this phase, refs are stored as `null` placeholders. The actual resolution happens later.

### Phase 2: Schema Traversal

**Purpose**: Create a schemas map for a specific compilation, merging instance schemas with passed schemas.

**Entry Point**: `JarenValidator.compile(schema, schemas)`

**Flow**:
```
compile(schema, schemas)
  └── #traverseSchema(schema, schemas, instanceSchemas)
        ├── Create new schemaMap from instanceSchemas
        ├── storeSchemaIdsInMap(schemaMap, origin, schema)
        ├── (Optional) storeSchemaIdsInMap for additional schemas
        └── restoreSchemaRefsInMap(schemaMap)
              └── For each null entry:
                    ├── Try resolveRefSchemaDeep (flatten chains)
                    └── On failure: resolveRefSchemaShallow (single hop)
```

**Key Data Structure**: `schemaMap Map<string, schema>` (local to this compilation)

- Merges instance-level schemas (`this.#schemas`) with compile-time schemas
- After `restoreSchemaRefsInMap`, all ref values are resolved schemas (not null)
- **Ref chains are flattened**: `A → B → C` becomes `A → C`

**The Critical Optimization**: `restoreSchemaRefsInMap` uses `resolveRefSchemaDeep` to follow the entire ref chain at load time and store the final schema directly.

### Phase 3: Compilation

**Purpose**: Create compiled validator functions from schemas.

**Entry Point**: `JarenValidator.#compileSchemaWithRoot(...)`

**Flow**:
```
compile()
  ├── Create ValidationRoot(origin, schemaMap, formats, options)
  ├── #precompileRefs(root, schemaMap, origin)
  │     └── For each ref in schemaMap:
  │           ├── Skip if already compiled
  │           └── root.createObject(id, schema, origin)
  │                 └── ValidationObject(root, id, schema, baseUri)
  │                       └── compileValidator() → returns validator function
  └── Return jarenValidateSchema(data) function
```

**Key Classes**:

#### ValidationRoot
- Manages the `Map<string, ValidationObject>` called `#objects`
- Entry point: `validate(data)` clears errors and calls `#firstSchema.validate(data, data)`
- Creates objects via `createObject()` and caches them in `#objects`
- **Pre-compilation**: creates ValidationObjects for ALL refs before returning

#### ValidationObject
- Represents a single schema location (identified by URI)
- **Constructor**: Immediately compiles validator via `compileValidator()`
- **Key property**: `#validator` - the compiled function that validates data
- For refs: `#validator` is the target validator function (direct reference)

**The Critical Optimization**: `#precompileRefs()` iterates through `schemaMap` and creates `ValidationObject` instances for every ref. This moves object creation from validation-time to compile-time.

### Phase 4: Validation

**Purpose**: Validate data against compiled schema.

**Entry Point**: `jarenValidateSchema(data)`

**Flow**:
```
jarenValidateSchema(data)
  └── root.validate(data)
        └── #firstSchema.validate(data, dataRoot)
              └── this.#validator(data, dataRoot)
                    └── Either:
                          ├── compileSchemaObject() result (for non-ref schemas)
                          └── Target validator function (for refs, pre-compiled)
```

**Key Insight**: For refs, `this.#validator` is **already** the target validator function (set during Phase 3 pre-compilation). No resolution happens at validation time.

---

## Key Components

### JarenValidator

The main entry point for schema compilation and validation.

```javascript
const validator = new JarenValidator()
  .addFormats(formats)
  .addSchema(metaSchema);

const validate = validator.compile({
  type: 'object',
  properties: { name: { type: 'string' } }
});

const isValid = validate({ name: 'John' });
```

**Key Methods**:
- `addSchema(schema, key)` - Register a schema for reuse
- `addFormats(formats)` - Register format validators
- `compile(schema, schemas)` - Compile a schema into a validation function

### ValidationRoot

Manages the validation context for a single `compile()` call.

**Responsibilities**:
- Store all `ValidationObject` instances in `#objects` Map
- Provide `validate(data)` entry point
- Manage error collection (when `skipErrors: false`)

**Key Properties**:
- `#objects: Map<string, ValidationObject>` - All compiled validators
- `#errors: InternalValidationError[]` - Collected errors
- `#firstSchema: ValidationObject` - Entry point schema

### ValidationObject

Represents a single schema location and its compiled validator.

**Constructor**:
```javascript
new ValidationObject(root, id, schema, baseUri)
  └── compileValidator() // Compiles schema to function immediately
```

**Key Properties**:
- `#path: string` - The URI identifying this schema location
- `#schema: object` - The schema object
- `#validator: function` - The compiled validation function
- `#root: ValidationRoot` - Parent root

**For `$ref` schemas**:
- The `#validator` is set to the target's validator function directly
- No indirection or lookup at validation time

---

## $ref Resolution

### Complete Flow Example

Given schema:
```json
{
  "$ref": "#/$defs/foo"
}
```

**Phase 1 (Registration)**:
- `storeSchemaIdsInMap` stores `#/$defs/foo` as a null placeholder in schemasMap

**Phase 2 (Schema Traversal)**:
- `restoreSchemaRefsInMap` sees the null entry for `#/$defs/foo`
- Calls `resolveRefSchemaDeep` to find the final schema
- If `/$defs/foo` contains `{ "$ref": "#/$defs/bar" }`, it follows that too
- Eventually finds the final schema (e.g., `{ "type": "string" }`)
- Stores final schema directly: `schemasMap.set("#/$defs/foo", { type: "string" })`

**Phase 3 (Compilation)**:
- `#precompileRefs` iterates through schemasMap
- For entry `#/$defs/foo`, creates ValidationObject
- `compileValidator` sees this is a ref (has `$ref` property)
- Resolves the ref to the target ValidationObject (which was just created)
- Sets `this.#validator = targetValidator` (direct function reference)

**Phase 4 (Validation)**:
- Validator function is called with data
- For the ref schema, directly calls the target validator (no lookup)

### Base URI Resolution

When schemas have `$id` that changes the base URI:

```json
{
  "$id": "http://example.com/schema",
  "$defs": {
    "nested": {
      "$id": "nested/",
      "$defs": {
        "deep": {
          "$ref": "folder/file.json"  // Resolves against http://example.com/nested/
        }
      }
    }
  }
}
```

**Resolution Rules**:
1. `$id` changes the base URI for itself and all children
2. `$ref` is resolved against the current base URI. In draft 2019-09 and later this includes a sibling `$id` on the same schema object; in draft 7 and earlier `$ref` replaces the whole schema, so a sibling `$id` does not affect it
3. Relative `$id` values resolve against the parent's base URI
4. Trailing `#` is stripped for URL resolution

---

## Annotation Tracking (unevaluatedProperties / unevaluatedItems)

The `unevaluatedProperties` and `unevaluatedItems` keywords apply to whatever the rest of the schema did NOT evaluate. Supporting them requires knowing, at validation time, which properties and items were successfully evaluated by sibling keywords and by in-place applicators (`allOf`/`anyOf`/`oneOf`/`if-then-else`/`$ref`/`$recursiveRef`/`dependentSchemas`).

### EvalLog

`EvalLog` (in `tools.js`) is a per-`ValidationRoot` log of `(instance, key)` pairs:

- **Producers**: `properties`, `patternProperties`, `additionalProperties`, `items`, `prefixItems` and `additionalItems` record each successful evaluation. String keys mark object properties; numeric keys mark array indexes; the numeric key `-1` means "all items of this array". `contains` contributes item annotations in draft 2020-12 only. `propertyNames` contributes nothing.
- **Instance identity**: entries are keyed by object reference, so annotations naturally scope to the correct instance through `$ref` chains and recursion.
- **mark/rollback**: applicators that discard annotations take a `mark()` before running a subschema and `rollback(mark)` afterwards. Failed `anyOf`/`oneOf` branches roll back, `not` always rolls back, and a failed `if` rolls back before `else` runs. With tracking active, `anyOf` runs every branch (annotations from ALL successful branches count), and a lone `if` without `then`/`else` still runs for its annotations.
- **The check runs last**: `wrapUnevaluated` (in `unevaluated.js`) wraps the compiled schema validator, takes its mark before the schema starts (including a sibling `$ref`, so the ref target's annotations are visible), runs everything, and then validates the leftovers. `unevaluatedProperties`/`unevaluatedItems` themselves annotate what they validate, so outer `unevaluated*` keywords see their work too.

### Zero cost when unused

At compile time the schema set is scanned once for `unevaluatedProperties`/`unevaluatedItems` keywords (the scan knows that keys inside `properties`/`$defs`-style maps are names, not keywords). When absent, no tracking code is compiled into any validator and the log is never touched.

---

## Dynamic References

`$recursiveRef`/`$recursiveAnchor` (draft 2019-09) and `$dynamicRef`/`$dynamicAnchor` (draft 2020-12) resolve against the **dynamic scope**: the chain of schema resources entered during evaluation.

- **Resource entry**: validation of the root schema, and every `$ref` crossing into another resource, pushes ALL `$dynamicAnchor`s of that resource onto per-anchor-name stacks (`collectDynamicAnchorsDeep` gathers them wherever they sit — `$defs`, `allOf` branches, `properties` — stopping at embedded `$id` boundaries). The stacks are popped when the resource is exited (`try/finally`).
- **Resolution**: a `$dynamicRef "#name"` first checks the bookending requirement (the resolved lexical target must carry a matching `$dynamicAnchor`), then resolves to the anchor in the **outermost** resource of the dynamic scope — the bottom of the stack. `$recursiveRef "#"` behaves similarly with the anonymous anchor.
- **Pointer fragments**: a `$dynamicRef` whose fragment is a JSON pointer (e.g. `#/$defs/x`) behaves identically to `$ref`, with no dynamic resolution.

---

## Drafts and Vocabularies

The draft a schema is processed under is detected from its `$schema` declaration (`detectSchemaDraft`), with draft 7 as the default.

- **Per-document drafts (cross-draft references)**: every `ValidationObject` tracks the draft its *document* declares, inherited by subschemas. A referenced document that declares another draft is processed with that draft's keyword set: a draft-07 document ignores `dependentRequired`/`dependentSchemas`, and a pre-2020 document ignores `prefixItems`.
- **$vocabulary**: when the schema's `$schema` points to a registered custom metaschema, its `$vocabulary` selects keyword behavior. A metaschema that omits the validation vocabulary turns keywords like `type`, `enum` and `minimum` into annotations that assert nothing (applicator keywords keep working). A metaschema that declares the `format-assertion` vocabulary turns format assertion on.
- **format assertion**: through draft 2019-09 the `format` keyword asserts by default; from draft 2020-12 on it is annotation-only. The `formatAssertion` option overrides the default in either direction.
- **content keywords**: `contentEncoding`/`contentMediaType` assert in draft 7 and are annotation-only from 2019-09 on, controlled by the `contentValidation` option.

---

## Data Structures

### schemasMap Structure

```typescript
Map<string, schema | null> {
  // Root schemas
  "http://example.com/schema#" → { type: "object", properties: {...} }

  // Internal refs (after Phase 2, these point to final schemas)
  "#/$defs/foo" → { type: "string" }  // Flattened: was A→B→C, now A→C
  "#/$defs/bar" → { $ref: "#/$defs/foo" }  // If not yet resolved

  // Anchors
  "http://example.com/schema#myAnchor" → { type: "number" }
  "#myAnchor" → { type: "number" }  // Global anchor
}
```

### ValidationRoot.#objects Structure

```typescript
Map<string, ValidationObject> {
  "http://example.com/schema#" → ValidationObject {
    #path: "http://example.com/schema#",
    #validator: function validateObject(data, root) {...},
    #schema: { type: "object", ... },
    #root: ValidationRoot
  },

  "#/$defs/foo" → ValidationObject {
    #path: "#/$defs/foo",
    #validator: function validateString(data, root) {...},  // Direct reference
    #schema: { type: "string" },
    #root: ValidationRoot
  }
}
```

### Key Functions Reference

| Function | File | Purpose |
|----------|------|---------|
| `storeSchemaIdsInMap` | traverse.js | BFS traversal storing all schema IDs and refs |
| `resolveRefSchemaShallow` | traverse.js | Resolve single ref hop (baseUri + fragment) |
| `resolveRefSchemaDeep` | traverse.js | Follow ref chain to final schema |
| `restoreSchemaRefsInMap` | traverse.js | Flatten all ref chains at load time |
| `createJsonPointer` | traverse.js | Parse URI into components (id, leftUri, fragment) |
| `JarenValidator.compile` | index.js | Main entry point for schema compilation |
| `JarenValidator.#precompileRefs` | index.js | Pre-create ValidationObjects for all refs |
| `ValidationObject.compileValidator` | index.js | Compile validator, now with pre-compilation |
| `ValidationRoot.resolveObject` | index.js | Resolve ref to ValidationObject (fallback only) |

---

## Performance Optimizations

### 1. Allocation-Free Validation Calls

`ValidationRoot.validate()` performs no allocations: per-validation constants (the root validator, its dynamic-anchor registration, the root resource's `$dynamicAnchor` list) are precomputed at compile time, and reusable structures (the errors array, the dynamic-anchor stacks, the evaluation log) are cleared rather than reallocated.

### 2. Ref Chain Flattening

Ref chains (`A -> B -> C`) are flattened at load time by `restoreSchemaRefsInMap`, so a `$ref` costs a single direct function call at validation time instead of a chain of lookups.

### 3. Pre-compilation of All Refs

`#precompileRefs` creates `ValidationObject`s for every ref in the schema map during `compile()`, so the first validation is as fast as every subsequent one.

### 4. Fast Paths for Simple Schemas

Common schema shapes compile to specialized inline validators instead of composed closure chains:

- Type-only schemas (`{ "type": "string" }`) compile to a single `typeof` check.
- Single-constraint number, string, array and object schemas call their one validator directly, without pass-through stubs.
- Properties-only object schemas iterate the (fixed) schema keys with `Object.hasOwn` instead of allocating `Object.keys(data)` and doing a map lookup per data key.
- The default object-children loop is a fused per-key pass over `properties`/`patternProperties`/`additionalProperties`/dependencies that bails on the first failure without per-key result objects.

### 5. Skip Error Creation

When `skipErrors: true` (default), failed validations just return `false`; error handlers compile to constant-false functions and no error objects are ever created:

```javascript
return pattern.test(data); // No error creation
```

### 6. Compile-Time Feature Detection

The schema set is scanned once at compile time for features with runtime cost:

- `$data` references — without them, child data-path strings are never built during object validation.
- `unevaluatedProperties`/`unevaluatedItems` — without them, no annotation tracking code is compiled into any validator.

### 7. uniqueItems Without Deep Comparison

`uniqueItems` dedupes scalars through pairwise `===` (small arrays) or a `Set` (larger/mixed arrays); the pairwise deep comparison runs only among items that are actually objects or arrays.

### 8. Unicode String Length Fast Paths

Grapheme-aware string length (`useGrapheme: true`, the default) avoids `Intl.Segmenter` whenever it can:

- ASCII-only strings use `str.length` directly.
- Non-ASCII strings without cluster-forming characters (combining marks, ZWJ, variation selectors, regional indicators, Hangul jamo, emoji modifiers) count code points with a simple surrogate-aware loop.
- Only strings that can actually form multi-codepoint grapheme clusters pay for the segmenter.

### 9. Format Fast Paths

Format validators try a cheap common-case check before a comprehensive one, e.g. email validates the dot-atom form with a single regex and only falls back to RFC 5321 quoted-string/address-literal parsing when that fails; IRI validation uses a simple regex for ASCII-only input.

---

## Error Handling

### Error Collection

When `skipErrors: false`, errors are collected in `ValidationRoot.#errors`:

```javascript
const validator = new JarenValidator({ skipErrors: false });
const validate = validator.compile(schema);

const isValid = validate(data);
const errors = validator.errors;  // Array of ValidationError objects
```

### Error Structure

```typescript
interface ValidationError {
  keyword: string;        // 'type', 'minLength', etc.
  message: string;        // Human-readable message
  params: object;         // Keyword-specific params
  dataPath: string;       // Path to error in data
  schemaPath: string;     // Path to schema keyword
}
```

### Error Handler Optimization

The `createErrorHandler` method returns different functions based on `skipErrors`:

```javascript
createErrorHandler(expected, key) {
  // Fast path: just return false
  if (this.#root.options.skipErrors) {
    return () => false;
  }

  // Full path: create and store error
  return (data, ...meta) => {
    this.#root.errors.push(new InternalValidationError(...));
    return false;
  };
}
```

---

## Testing, Benchmarks and Debugging

Unit tests live in `test/` at the repository root, organized per package (`npm test`, or `npm run test:core` / `test:json` / `test:validate`). The conformance suites, performance profilers and analysis tools all live in the benchmark workspace and are documented in [benchmark/README.md](benchmark/README.md):

- `profiler.js` — JSON Schema performance vs Ajv over the official test suite (the source of the README's conformance table);
- `debug.js` — inspect, run, export and step through individual suite test cases, with Jaren-vs-Ajv comparison;
- `coverage.js` — merged function-coverage analysis over the suite and/or unit tests (untouched-function and dead-code reports);
- `callgraph.js` — hot-path call graphs via the Node.js profiler;
- `jsonpath.js`, `jsonpointer.js`, `jsonquery.js`, `jslt.js` — compliance and performance for the `@jarenjs/json` engines;
- `qt3-runner.js` — the tiered W3C QT3 scorecard (see [benchmark/qt3-README.md](benchmark/qt3-README.md)).

Validator-specific troubleshooting recipes — "Can not resolve schema for 'X'", first-validation slowness, test interference, ref-resolution logging — are collected in the [validate ARCHITECTURE debugging guide](packages/validate/ARCHITECTURE.md#debugging-guide).

---

## Implementation Notes

### How $ref Works

1. **Draft 7 and earlier - $ref ignores siblings**: when a schema has `$ref`, all other keywords are ignored, the referenced schema completely replaces the current schema, and a sibling `$id` does not affect `$ref` resolution
2. **Draft 2019-09 and later - $ref has siblings**: `$ref` is just another keyword; sibling keywords (including `unevaluatedProperties`/`unevaluatedItems`) apply together with the referenced schema, and a sibling `$id` DOES establish the base URI the `$ref` resolves against
3. **Location-independent identifiers**: Anchors like `#foo` should be resolvable within their document
4. **Ref chain resolution happens at compile time**: pre-resolved via `restoreSchemaRefsInMap` and `#precompileRefs`

### ECMAScript Regex in JSON Schema

1. **Unicode flag required**: All regex patterns use the `u` flag for proper Unicode support
2. **Unicode property escapes**: Patterns using `\p{...}` require the `u` flag
3. **Surrogate pairs**: Non-BMP characters (like emojis) are represented as surrogate pairs in JavaScript

---

## Summary

JarenJS validates all of draft-06, draft-07, 2019-09 and 2020-12 - passing 100% of the official JSON-Schema-Test-Suite for draft-07, 2019-09 and 2020-12 - and achieves high performance through:

1. **Compile-time ref resolution** - All refs resolved before validation
2. **Function inlining** - Simple schemas compile to direct checks
3. **Fast paths** - ASCII-only checks skip expensive Unicode operations
4. **Error skipping** - Default mode avoids error object creation
5. **Efficient data structures** - Maps for O(1) lookups, allocation-free validation calls
6. **Compile-time feature detection** - annotation tracking and data-path building only exist in compiled validators that need them

The architecture cleanly separates concerns:
- **Schema loading** handles URI resolution and ref flattening
- **Compilation** creates optimized validation functions, selects draft and vocabulary behavior
- **Validation** executes compiled functions with minimal overhead, tracking annotations and dynamic scope only when the schema requires it
