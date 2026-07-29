# JarenJS How-To Guide

A practical guide for using JarenJS in your projects, from basic usage to advanced scenarios.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Creating a Lightweight Instance](#creating-a-lightweight-instance)
- [Configuration Options](#configuration-options)
- [Working with Formats](#working-with-formats)
- [Advanced Usage](#advanced-usage)
- [Performance Tips](#performance-tips)
- [Common Pitfalls](#common-pitfalls)
- [API Reference](#api-reference)

---

## Installation

### Full Installation (Recommended)

```bash
npm install @jarenjs/validate @jarenjs/refs @jarenjs/formats
```

### Lightweight Installation

If you only need basic validation without format support or schema references:

```bash
npm install @jarenjs/validate
```

---

## Quick Start

### Basic Usage

```javascript
import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

// Create validator with formats support
const jaren = new JarenValidator()
  .addFormats(formats.stringFormats);

// Compile a schema
const validate = jaren.compile({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    age: { type: 'integer', minimum: 0 },
    email: { type: 'string', format: 'email' }
  },
  required: ['name', 'age']
});

// Validate data
const isValid = validate({
  name: 'John Doe',
  age: 30,
  email: 'john@example.com'
});

console.log(isValid); // true
```

### Getting Validation Errors

Set `collectErrors: true` and the compiled validator returns a result object
instead of a boolean:

```javascript
const jaren = new JarenValidator({
  collectErrors: true  // return { valid, errors } instead of a boolean
}).addFormats(formats.stringFormats);

const validate = jaren.compile({
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' }
  }
});

const result = validate({ email: 'invalid-email' });

if (!result.valid) {
  console.log(result.errors);
  // [
  //   {
  //     keyword: 'format',
  //     instancePath: '/email',
  //     schemaPath: 'https://github.com/jklarenbeek/jarenjs#/properties/email',
  //     params: { format: 'email' },
  //     msgid: 'format',
  //     message: 'must match format "email"'
  //   }
  // ]
}
```

Errors are returned, never stashed on the validator instance — there is no
`jaren.errors` property. That is what keeps a compiled validator reentrant
and safe to share across concurrent requests.

`instancePath` is an RFC 6901 JSON Pointer into the *data*; `schemaPath` is an
absolute URI into the *schema*. The `msgid` + `params` pair is what
[`@jarenjs/locales`](packages/locales/README.md) re-renders in another
language. The full error contract, and the options that change these answers,
are documented under
[Compatibility settings](packages/validate/README.md#compatibility-settings).

---

## Creating a Lightweight Instance

For scenarios where bundle size matters, you can create a lightweight validator without the `@jarenjs/refs` and `@jarenjs/formats` packages.

### Minimal Setup

```javascript
import { JarenValidator } from '@jarenjs/validate';

// No formats, no external refs - just basic JSON Schema validation
const jaren = new JarenValidator();

const validate = jaren.compile({
  type: 'object',
  properties: {
    count: { type: 'integer' },
    name: { type: 'string' }
  }
});

console.log(validate({ count: 42, name: 'test' })); // true
```

### Bundle Size Comparison

| Configuration | Approximate Size |
|--------------|------------------|
| `@jarenjs/validate` only | ~25 KB |
| `@jarenjs/validate` + `@jarenjs/formats` | ~35 KB |
| `@jarenjs/validate` + `@jarenjs/refs` + `@jarenjs/formats` | ~45 KB |

### When to Use Lightweight Mode

✅ **Use lightweight when:**
- You only need basic type validation
- You don't use `format` keyword
- You don't need to reference external schemas
- Bundle size is critical (e.g., browser applications)

❌ **Don't use lightweight when:**
- You need email/URI/hostname validation
- You use `$ref` to external schemas
- You need JSON Schema draft detection

---

## Configuration Options

### JarenValidator Options

```javascript
const jaren = new JarenValidator({
  // Return { valid, errors } instead of a boolean (default: false)
  collectErrors: true,

  // Skip error object creation for better performance
  // (default: !collectErrors, so setting collectErrors is enough)
  skipErrors: false,

  // Use grapheme counting instead of code units (default: true)
  // Affects minLength/maxLength for strings with emojis
  useGrapheme: true,

  // Assert contentEncoding/contentMediaType (default: per draft -
  // asserted in draft 7 and earlier, annotation-only from 2019-09 on)
  contentValidation: true,

  // Assert the format keyword (default: per draft - asserted through
  // 2019-09, annotation-only from 2020-12 on)
  formatAssertion: true,

  // Render English message text on collected errors (default: true).
  // false leaves message: '' with msgid and params still set, for
  // applications that render exclusively through a locale pack.
  messages: true,
});
```

The JSON Schema draft is detected automatically from the schema's `$schema`
declaration (`draft-06`, `draft-07`, `2019-09` or `2020-12`), defaulting to
draft 7 when absent. Referenced documents that declare a different draft are
processed per their own declaration.

The options that decide answers other validators answer differently — the
return shape, string-length semantics, format and content assertion, and
format registration — are documented together, with a migration recipe, under
[Compatibility settings](packages/validate/README.md#compatibility-settings).

### ASCII vs Grapheme Mode

The `useGrapheme` option affects how string lengths are calculated:

```javascript
// With useGrapheme: true (default)
const jaren = new JarenValidator({ useGrapheme: true });
const validate = jaren.compile({ type: 'string', maxLength: 2 });

// Emoji "👨‍👩‍👧‍👦" is 1 grapheme cluster but multiple code units
console.log(validate('👨‍👩‍👧‍👦')); // true - counts as 1 grapheme
console.log(validate('abc')); // false - 3 graphemes exceeds limit

// With useGrapheme: false (faster, but incorrect for emoji)
const validator2 = new JarenValidator({ useGrapheme: false });
const validate2 = validator2.compile({ type: 'string', maxLength: 2 });

console.log(validate2('👨‍👩‍👧‍👦')); // false - counts as many code units
console.log(validate2('abc')); // false - 3 code units
```

**Recommendation**:
- Use `useGrapheme: true` (default) if your data may contain emojis or complex Unicode; ASCII and most Unicode strings still take a cheap fast path
- Use `useGrapheme: false` if you want lengths counted in UTF-16 code units

⚠️ **Migrating from another validator?** The JSON Schema specification counts
UTF-16 code units, and so do Ajv, Zod and Yup. Jaren's grapheme default is a
deliberate correctness choice, but it means a string of emoji that failed
`maxLength` before will now pass. Set `useGrapheme: false` to preserve the old
answers, and treat the switch to graphemes as its own reviewed change.

---

## Working with Formats

### Available Formats

The `@jarenjs/formats` package provides validators for common string formats:

```javascript
import * as formats from '@jarenjs/formats';

const jaren = new JarenValidator()
  .addFormats(formats.stringFormats);

const validate = jaren.compile({
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    website: { type: 'string', format: 'uri' },
    ip: { type: 'string', format: 'ipv4' },
    phone: { type: 'string', format: 'regex' },
    created: { type: 'string', format: 'date-time' }
  }
});
```

### Selective Format Loading

To reduce bundle size, load only the formats you need:

```javascript
import { stringFormats } from '@jarenjs/formats';

const jaren = new JarenValidator()
  .addFormats({
    'email': stringFormats.email,
    'uri': stringFormats.uri,
    'ipv4': stringFormats.ipv4
  });
```

### Custom Formats

You can register custom format validators:

```javascript
const jaren = new JarenValidator();

// Register a custom format
jaren.addFormat('uuid-v4', (schemaObj, jsonSchema) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  return function validateUUID(data, dataPath) {
    if (typeof data !== 'string') return true;
    return uuidRegex.test(data) || schemaObj.createErrorHandler('uuid-v4', 'format')(data, dataPath);
  };
});

const validate = jaren.compile({
  type: 'string',
  format: 'uuid-v4'
});

console.log(validate('550e8400-e29b-41d4-a716-446655440000')); // true
console.log(validate('invalid-uuid')); // false
```

---

## Advanced Usage

### Schema References ($ref)

#### Internal References

```javascript
const jaren = new JarenValidator();

const validate = jaren.compile({
  $defs: {
    address: {
      type: 'object',
      properties: {
        street: { type: 'string' },
        city: { type: 'string' }
      }
    }
  },
  type: 'object',
  properties: {
    home: { $ref: '#/$defs/address' },
    work: { $ref: '#/$defs/address' }
  }
});
```

#### External Schema References

```javascript
import { getSchemaDraftByVersion } from '@jarenjs/refs';

const defaultSchema = getSchemaDraftByVersion(7);

const jaren = new JarenValidator()
  .addSchema(defaultSchema.schema);

// Compile a schema that references external schemas
const validate = jaren.compile({
  $ref: 'http://json-schema.org/draft-07/schema#'
}, {
  // Additional external schemas
  'http://example.com/user.json': {
    $id: 'http://example.com/user.json',
    type: 'object',
    properties: {
      name: { type: 'string' }
    }
  }
});
```

### Reusing Validators

Validators can be reused across multiple validations:

```javascript
const jaren = new JarenValidator();

// Compile once
const validateUser = jaren.compile({
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' }
  },
  required: ['id', 'name']
});

// Validate many times
const users = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
  { id: 3 }  // Missing name
];

for (const user of users) {
  console.log(`User ${user.id}: ${validateUser(user) ? 'valid' : 'invalid'}`);
}
```

### Conditional Validation

Using `if/then/else` for conditional schemas:

```javascript
const jaren = new JarenValidator();

const validate = jaren.compile({
  type: 'object',
  properties: {
    type: { enum: ['person', 'company'] },
    name: { type: 'string' },
    age: { type: 'integer' },
    taxId: { type: 'string' }
  },
  if: {
    properties: { type: { const: 'person' } }
  },
  then: {
    required: ['name', 'age']
  },
  else: {
    required: ['name', 'taxId']
  }
});

console.log(validate({ type: 'person', name: 'John', age: 30 })); // true
console.log(validate({ type: 'company', name: 'Acme', taxId: '12345' })); // true
console.log(validate({ type: 'person', name: 'John' })); // false - missing age
```

### Recursive Schemas

For tree structures like file systems or org charts:

```javascript
const jaren = new JarenValidator();

const validate = jaren.compile({
  $id: 'http://example.com/tree',
  type: 'object',
  properties: {
    name: { type: 'string' },
    children: {
      type: 'array',
      items: { $ref: 'http://example.com/tree' }
    }
  },
  required: ['name']
});

const tree = {
  name: 'root',
  children: [
    { name: 'child1' },
    {
      name: 'child2',
      children: [
        { name: 'grandchild' }
      ]
    }
  ]
};

console.log(validate(tree)); // true
```

### Multiple Schema Versions

Jaren supports multiple JSON Schema drafts:

```javascript
import { getSchemaDraftByVersion } from '@jarenjs/refs';

// Create validators for different drafts
const draft7Schema = getSchemaDraftByVersion(7);
const draft2019Schema = getSchemaDraftByVersion('draft2019-09');

const validator7 = new JarenValidator()
  .addSchema(draft7Schema.schema);

const validator2019 = new JarenValidator()
  .addSchema(draft2019Schema.schema);

// Draft 7 uses 'definitions'
const validate7 = validator7.compile({
  definitions: {
    name: { type: 'string' }
  },
  $ref: '#/definitions/name'
});

// Draft 2019-09 uses '$defs'
const validate2019 = validator2019.compile({
  $defs: {
    name: { type: 'string' }
  },
  $ref: '#/$defs/name'
});
```

---

## Performance Tips

### 1. Compile Once, Validate Many

```javascript
// Good: Compile once
const validate = jaren.compile(schema);
for (const item of largeArray) {
  validate(item);
}

// Bad: Compile for every validation
for (const item of largeArray) {
  const validate = jaren.compile(schema);  // Expensive!
  validate(item);
}
```

### 2. Only Collect Errors Where You Report Them

Error collection costs allocation and defeats first-failure short-circuiting,
so pay for it only where a human or an API response actually reads the result:

```javascript
// Reporting a 400 to a caller: collect
const requestValidator = new JarenValidator({ collectErrors: true });

// A hot internal guard that only branches on the answer: don't
const guard = new JarenValidator();  // boolean, stops at the first failure
```

Use `collectErrors: true` rather than `skipErrors: false` for this. The two
are related but not interchangeable: `collectErrors` implies `skipErrors:
false` *and* converts each failure into the public `ValidationError` shape,
while `skipErrors: false` on its own leaves the raw internal records on the
compiled function — an implementation detail, not an API to read.

### 3. Grapheme Counting Is Cheap by Default

String length validation (`minLength`/`maxLength`) with `useGrapheme: true`
(the default) uses `str.length` for ASCII strings and a simple code-point
count for most Unicode strings; only strings containing cluster-forming
characters (combining marks, ZWJ emoji sequences, flags, ...) pay for
`Intl.Segmenter`. Set `useGrapheme: false` to always count UTF-16 code
units instead:

```javascript
const jaren = new JarenValidator({ useGrapheme: false });
```

### 4. Selective Format Loading

```javascript
// Load only needed formats
import { stringFormats } from '@jarenjs/formats';

const jaren = new JarenValidator()
  .addFormats({
    'email': stringFormats.email,
    'uri': stringFormats.uri
  });
```

### 5. Pre-compile Schemas at Build Time

For server-side applications, compile schemas during startup:

```javascript
// schemas.js - Compile at module load time
import { JarenValidator } from '@jarenjs/validate';

const jaren = new JarenValidator();

export const validateUser = jaren.compile({
  type: 'object',
  properties: {
    email: { type: 'string' }
  }
});

// server.js - Use pre-compiled validator
import { validateUser } from './schemas.js';

app.post('/users', (req, res) => {
  if (!validateUser(req.body)) {
    return res.status(400).json({ error: 'Invalid user' });
  }
  // Process valid user...
});
```

---

## Common Pitfalls

### Pitfall 1: Modifying Schemas After Compilation

```javascript
const schema = { type: 'string' };
const validate = jaren.compile(schema);

// Don't do this!
schema.minLength = 5;  // Has no effect on compiled validator

// The validator was compiled from the original schema
console.log(validate('ab'));  // Still returns true
```

**Solution**: Treat schemas as immutable after compilation.

### Pitfall 2: Using `__proto__` in Object Literals

```javascript
// This doesn't create an own property!
const schema = {
  properties: {
    __proto__: { type: 'number' }  // Sets prototype, not a property!
  }
};

// Use computed property syntax instead
const schema = {
  properties: {
    ['__proto__']: { type: 'number' }  // Creates actual property
  }
};
```

### Pitfall 3: Validation never modifies your data

```javascript
const validate = jaren.compile({
  type: 'object',
  properties: {
    count: { type: 'integer', default: 0 }
  }
});

const data = {};
validate(data);

// Jaren does NOT modify data or apply defaults
console.log(data.count);  // undefined, not 0
```

A compiled validator is a pure predicate: it applies no `default` values,
coerces no types, trims no strings and strips no unknown properties. This is
deliberate — it is what makes validators reentrant, shareable and free of the
surprise in-place mutation that data-modifying validators are known for.

The consequence is real, though, and worth planning for: if you are coming
from a library whose parse step *returns normalized output* (Zod, Yup,
io-ts), that normalization is yours to own. Do it as an explicit step before
validation rather than reaching for a second validator to get defaults —
running two engines over the same schema is how their answers drift apart.

### Pitfall 4: Format Validation Without Adding Formats

```javascript
// This won't validate email format!
const jaren = new JarenValidator();  // No formats added
const validate = jaren.compile({
  type: 'string',
  format: 'email'
});

console.log(validate('not-an-email'));  // Returns true!
```

**Solution**: Always add formats if using the `format` keyword:

```javascript
const jaren = new JarenValidator()
  .addFormats(formats.stringFormats);
```

### Pitfall 5: Confusing Compilation and Validation Errors

```javascript
// Compilation error - invalid schema
const validate = jaren.compile({
  type: 'invalid-type'  // Throws during compile()
});

// Validation error - invalid data
const validate2 = jaren.compile({ type: 'string' });
validate2(123);  // Returns false, doesn't throw
```

**Note**: Schema errors throw during `compile()`. Data validation failures return `false`.

---

## API Reference

### JarenValidator

#### Constructor

```javascript
new JarenValidator(options?: ValidationOptions)
```

**Options:**
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `collectErrors` | boolean | false | Return `{ valid, errors }` instead of a boolean |
| `skipErrors` | boolean | `!collectErrors` | Stop at the first failure instead of recording every error |
| `useGrapheme` | boolean | true | Count grapheme clusters (not UTF-16 code units) for `minLength`/`maxLength` |
| `formatAssertion` | boolean\|null | null (per draft) | Assert `format`; auto-asserts below draft 2020-12 |
| `contentValidation` | boolean\|null | null (per draft) | Assert `contentEncoding`/`contentMediaType`; auto-asserts below 2019-09 |
| `messages` | boolean | true | Render English `message` text on collected errors |
| `formats` | object | `{}` | Format compilers to register at construction |
| `schemas` | object[] | `[]` | Schemas to register at construction |

The JSON Schema draft is **not** an option — it is detected per document from
`$schema`, defaulting to draft-07 when absent.

#### Methods

**addSchema(schema, key?)**
Register a schema for reuse in `$ref` references.

```javascript
jaren.addSchema({
  $id: 'http://example.com/user.json',
  type: 'object',
  properties: { name: { type: 'string' } }
}, 'http://example.com/user.json');
```

**addFormats(formats)**
Register format validators.

```javascript
jaren
  .addFormats(formats.stringFormats)   // email, uri, uuid, ...
  .addFormats(formats.numberFormats)   // int8 ... float64
  .addFormats(formats.dateTimeFormats) // date-time, duration, ...
  .addFormats(formats.jsonFormats);    // json-pointer, json-path, ...
```

**addFormat(name, compiler)**
Register a single custom format.

```javascript
jaren.addFormat('my-format', (schemaObj, jsonSchema) => {
  return (data, dataPath) => /* validation logic */;
});
```

**compile(schema, schemas?)**
Compile a schema into a validation function.

```javascript
const validate = jaren.compile({
  type: 'object',
  properties: { name: { type: 'string' } }
});

// With additional external schemas
const validate2 = jaren.compile(schema, {
  'http://example.com/other.json': otherSchema
});
```

**Return value**

A compiled validator returns a boolean, or — when the instance was created
with `collectErrors: true` — a result object. The validator instance never
holds errors:

```javascript
const jaren = new JarenValidator({ collectErrors: true });
const validate = jaren.compile({ type: 'string', minLength: 2 });

const result = validate('x');
// { valid: false, errors: [ { keyword: 'minLength', instancePath: '', ... } ] }
```

---

## Example: Complete API Server Setup

```javascript
// validation.js
import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

// Create shared validator instance. collectErrors gives every handler the
// full failure list; a compiled validator holds no state, so one instance is
// safe to share across concurrent requests.
const jaren = new JarenValidator({
  collectErrors: true,
  useGrapheme: true
}).addFormats(formats.stringFormats);

// Pre-compile all schemas
export const validators = {
  createUser: jaren.compile({
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 8 },
      name: { type: 'string', minLength: 1 }
    },
    required: ['email', 'password', 'name']
  }),

  updateUser: jaren.compile({
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      name: { type: 'string', minLength: 1 }
    }
  })
};

// Middleware helper
export function validate(schemaName) {
  return (req, res, next) => {
    const result = validators[schemaName](req.body);
    if (!result.valid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.errors
      });
    }
    next();
  };
}

// server.js
import express from 'express';
import { validate } from './validation.js';

const app = express();
app.use(express.json());

app.post('/users', validate('createUser'), (req, res) => {
  // req.body is valid
  res.json({ message: 'User created' });
});

app.patch('/users/:id', validate('updateUser'), (req, res) => {
  // req.body is valid
  res.json({ message: 'User updated' });
});
```

---

## More Examples

See the `/test/validate` directory in the repository for comprehensive examples of:
- All JSON Schema keywords
- Complex nested schemas
- Schema composition (`allOf`, `anyOf`, `oneOf`)
- Conditional validation (`if/then/else`)
- Custom formats
- Recursive schemas
