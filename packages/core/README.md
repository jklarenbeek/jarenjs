# @jarenjs/core

Foundation utilities for [Jaren](https://github.com/jklarenbeek/jarenjs): type tests and getters, deep equality, string and Unicode helpers (including grapheme-aware string length), number/integer/bigint helpers, math and vector classes, and an extensive text-validation toolbox (`@jarenjs/core/text`) covering emails, hostnames, IP addresses, URIs/IRIs, UUIDs, JSON pointers, base64 and more.

The text validators can be used standalone, without JSON Schema:

```javascript
import { isValidEmail, isValidIPv6 } from '@jarenjs/core/text';

isValidEmail('"joe bloggs"@example.com'); // true (RFC 5321)
isValidIPv6('::1');                       // true
```

Subpath exports include `@jarenjs/core/number`, `@jarenjs/core/string`, `@jarenjs/core/array`, `@jarenjs/core/object`, `@jarenjs/core/function`, `@jarenjs/core/text`, `@jarenjs/core/json` and `@jarenjs/core/calc`.

See the repository [README](../../README.md) and this package's [ARCHITECTURE](./ARCHITECTURE.md) for full documentation.
