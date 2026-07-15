# @jarenjs/core

Foundation utilities for [Jaren](https://github.com/jklarenbeek/jarenjs): type tests and getters, deep equality, string and Unicode helpers (including grapheme-aware string length), number/integer/bigint helpers, math and vector classes, and an extensive text-validation toolbox (`@jarenjs/core/text`) covering emails, hostnames, IP addresses, URIs/IRIs, UUIDs, base64 and more.

The text validators can be used standalone, without JSON Schema:

```javascript
import { isValidEmail, isValidIPv6 } from '@jarenjs/core/text';

isValidEmail('"joe bloggs"@example.com'); // true (RFC 5321)
isValidIPv6('::1');                       // true
```

The `@jarenjs/core/json` module handles the JSON addressing standards: JSON Pointer and Relative JSON Pointer resolution and validation ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)), and a JSONPath query compiler implementing all of [RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html) — selectors, descendants, slices, filter expressions and the built-in function extensions. Queries compile once into specialized closures and can then be applied to any document; singular queries reduce to a direct property walk:

```javascript
import { compileJSONPath, queryJSONPath, isValidJSONPathStrict } from '@jarenjs/core/json';

const query = compileJSONPath('$.store.book[?@.price < 10].title');
query(data);        // matched values
query.first(data);  // first match or undefined
query.nodes(data);  // { path, value } pairs with RFC 9535 normalized paths

queryJSONPath('$..author', data);      // one-shot, with a compiled-query cache
isValidJSONPathStrict('$[?@.a == 1]'); // strict grammar check, used by the 'json-path' format
```

The compiler passes all 703 tests of the official [JSONPath Compliance Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite); `node benchmark/jsonpath.js --profile` in the repository compares it against other engines.

Subpath exports include `@jarenjs/core/number`, `@jarenjs/core/string`, `@jarenjs/core/array`, `@jarenjs/core/object`, `@jarenjs/core/function`, `@jarenjs/core/text`, `@jarenjs/core/json` and `@jarenjs/core/calc`.

See the repository [README](../../README.md) and this package's [ARCHITECTURE](./ARCHITECTURE.md) for full documentation.
