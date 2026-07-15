# JarenJS Architecture

This document describes the internal architecture of JarenJS, a high-performance JSON Schema validator for JavaScript.

## Table of Contents

- [Overview](#overview)
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
- [Debugging Guide](#debugging-guide)

---

## Overview

JarenJS is a JSON Schema validator that compiles schemas into optimized validation functions. The architecture separates schema loading (URI resolution), compilation (validator creation), and validation (data checking) into distinct phases to enable compile-time optimizations and fast runtime performance.

### Key Files

| File | Purpose |
|------|---------|
| `packages/validate/src/index.js` | Main validator classes (`JarenValidator`, `ValidationRoot`, `ValidationObject`) |
| `packages/validate/src/traverse.js` | Schema traversal and ref resolution (`storeSchemaIdsInMap`, `restoreSchemaRefsInMap`) |
| `packages/validate/src/schema.js` | Schema compilation dispatcher (`compileSchemaObject`), `$recursiveRef`/`$dynamicRef` |
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

## Debugging Guide

### Using the Debug Tool

The `benchmark/debug.js` tool is the primary way to investigate test failures:

```bash
# Find the failing test
node benchmark/debug.js '/anchor.json' --list --draft 2019

# Run the specific failing test with verbose output
node benchmark/debug.js '/anchor.json' 'same $anchor' --draft 2019 --verbose

# Compare Jaren vs AJV behavior
node benchmark/debug.js '/anchor.json' 'same $anchor' --draft 2019 --compare

# Export the test case for isolated debugging
node benchmark/debug.js '/anchor.json' 'same $anchor' --draft 2019 --export-test debug.json
```

### "Can not resolve schema for 'X'"

**Cause**: The ref `X` is not in schemasMap

**Check**:
- Was the schema containing `X` added via `addSchema()`?
- Is the ref path correct in the schema?
- After `restoreSchemaRefsInMap`, all refs should have non-null values

### Performance Degradation on First Validation

**Cause**: Refs being resolved at validation time instead of compile time

**Check**:
- Is `#precompileRefs` being called in `compile()`?
- Are ValidationObjects being created for all refs?
- Verify: `compileValidator` should find targets immediately without fallback

### Test Interference (tests pass individually but fail together)

**Cause**: Global shared state between validators

**Check**:
- Are you using a global cache? (Don't)
- Solution: All state should be per-ValidationRoot or per-JarenValidator

### Debugging Ref Resolution

Enable debug logging in traverse.js:

```javascript
// In packages/validate/src/traverse.js
console.log('Resolving ref:', ref, 'against baseUri:', baseUri);
```

Performance comparison between Jaren and AJV.

```bash
# Profile specific test suite with draft selection
node benchmark/profiler.js '/ref.json' --profile --draft 2019 --iterations 1000

# Profile all tests for multiple drafts
node benchmark/profiler.js --profile-all --draft draft7,draft2019-09,draft2020-12

# Export results to JSON with custom file path
node benchmark/profiler.js --profile-all --output json --filepath results.json

# Show only top 10 slowest tests
node benchmark/profiler.js '/ref.json' --profile --top 10

# Only include tests where all engines succeed
node benchmark/profiler.js '/ref.json' --profile --success-only

# Full options
Options:
  --profile              Profile a specific test file
  --profile-all          Profile all test files
  --iterations, -i N     Number of iterations (default: 1000)
  --output, -o FORMAT    Output format: console, csv, json (default: console)
  --draft, -d VERSION    JSON Schema draft version(s), comma-separated
                         Supported: draft6, draft7, draft2019-09, 2019, draft2020-12, 2020
  --filepath, -f PATH    Output file path for csv/json
  --top N                Show only top N slowest tests
  --success-only         Only include tests where all agents succeed
  --verbose, -v          Verbose output
```

### coverage.js

Code coverage analysis using c8 to find which functions are touched during test execution.

```bash
# Show files with >25% function coverage
node benchmark/coverage.js '/required.json' --threshold 25

# Show touched vs NOT touched functions
node benchmark/coverage.js '/required.json' --threshold 25 --functions

# Show only touched functions
node benchmark/coverage.js '/required.json' --threshold 25 --touched-only

# Adjust iterations for better coverage data
node benchmark/coverage.js '/required.json' --iterations 5000

# Full options
Options:
  --threshold <n>    Filter files with coverage <= n% (default: 0)
  --functions        Show TOUCHED and NOT touched functions with hit counts
  --touched-only     Show only TOUCHED functions
  --iterations <n>   Number of profiling iterations (default: 1000)
  --temp-dir <dir>   Temporary directory for c8 coverage data
```

### callgraph.js

Call graph analysis using Node.js built-in `--prof` profiler. Generates text-based call graphs showing hot paths and call chains.

```bash
# Generate call graph for a test suite
node benchmark/callgraph.js '/ref.json'

# More iterations for better accuracy
node benchmark/callgraph.js '/ref.json' --iterations 5000 --top-functions=30

# Show deeper call chains
node benchmark/callgraph.js '/ref.json' --max-depth=15

# Include Node.js internal functions
node benchmark/callgraph.js '/ref.json' --include-internals

# Filter by specific pattern
node benchmark/callgraph.js '/ref.json' --filter 'validate'

# Full options
Options:
  --iterations, -i N       Number of iterations (default: 1000)
  --top-functions N        Show top N hottest functions (default: 20)
  --max-depth N            Maximum call chain depth (default: 10)
  --filter <pattern>       Filter functions by pattern (default: jaren)
  --include-internals      Include Node.js internal functions
  --verbose, -v            Show detailed output
```

### debug.js

Powerful debugging utility for investigating test failures and understanding schema validation behavior.

```bash
# List all test files for a draft
node benchmark/debug.js --list-files --draft 2019

# List all test cases in a file with keyword summaries
node benchmark/debug.js '/anchor.json' --list --draft 2019

# Run a specific test suite with draft selection
node benchmark/debug.js '/anchor.json' --draft 2019

# Run a specific test by description (partial match)
node benchmark/debug.js '/anchor.json' 'same $anchor' --draft 2019

# Run a specific test by index
node benchmark/debug.js '/anchor.json' --index 3 --draft 2019

# Export test suite to JSON
node benchmark/debug.js '/anchor.json' --export anchor-tests.json --draft 2019

# Export specific test case
node benchmark/debug.js '/anchor.json' --index 3 --export-test test.json --draft 2019

# Dry run - show schema and assertions without validating
node benchmark/debug.js '/anchor.json' --dry-run --draft 2019

# Show detailed validation errors
node benchmark/debug.js '/ref.json' 'nested refs' --show-errors

# Interactive mode - step through assertions
node benchmark/debug.js '/ref.json' 'nested refs' --interactive

# Detailed comparison between Jaren and AJV
node benchmark/debug.js '/ref.json' 'nested refs' --compare

# Run only Jaren (skip AJV comparison)
node benchmark/debug.js '/ref.json' 'nested refs' --jaren-only

# Minimal output (errors only)
node benchmark/debug.js '/ref.json' --silent
```

### jsonpath.js

Compliance and performance benchmark for the JSONPath (RFC 9535) compiler in
`packages/core/src/json/path.js`. It runs the official [JSONPath Compliance
Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite)
(a git submodule at `benchmark/jsonpath-suite/`, like the JSON-Schema-Test-Suite
at `benchmark/suite/`; including normalized-path verification) against Jaren
and the RFC 9535-conformant contender
[json-p3](https://www.npmjs.com/package/json-p3). This is a separate tool from
`profiler.js` because the schema-draft/remotes machinery does not apply to
JSONPath queries.

```bash
# after cloning, or when the suite is missing:
git submodule update --init benchmark/jsonpath-suite
```

```bash
# Compliance run over all engines (exit code 1 when Jaren fails a test)
node benchmark/jsonpath.js

# Only tests whose name contains a string, with failure details
node benchmark/jsonpath.js 'functions, match' --verbose

# Performance comparison per CTS query, plus synthetic 1000-item scenarios
node benchmark/jsonpath.js --profile --scale

# Full options
Options:
  --profile              Profile query performance instead of checking compliance
  --verbose, -v          Show every compliance failure in detail
  --iterations, -i N     Iterations per profiled query (default: 1000)
  --top N                Show top N slowest queries in profile mode (default: 15)
  --scale                Add synthetic 1000-item document scenarios to the profile
  --engines a,b          Engines to run (default: jaren,json-p3)
  --output, -o FORMAT    Output format: console, csv, json (default: console)
  --filepath, -f PATH    Output file path for csv/json
```

### Tool Separation

Each benchmark tool has a distinct purpose:

| Tool | Purpose | Use When |
|------|---------|----------|
| `debug.js` | Test inspection and assertion-level debugging | Investigating specific test failures |
| `profiler.js` | Performance measurement and comparison | Measuring Jaren vs AJV speed |
| `coverage.js` | Code coverage analysis | Finding untested code paths |
| `callgraph.js` | Call graph generation | Analyzing hot paths and call chains |
| `jsonpath.js` | JSONPath RFC 9535 compliance and performance | Verifying/benchmarking the JSONPath compiler vs json-p3 |

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
