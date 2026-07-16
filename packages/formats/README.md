# @jarenjs/formats

Format validators for the JSON Schema `format` keyword, built on the text validators of [`@jarenjs/core`](../core). Includes all standard string formats (`date-time`, `date`, `time`, `duration`, `email`, `idn-email`, `hostname`, `idn-hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uri-template`, `iri`, `iri-reference`, `uuid`, `regex`) plus many extras (`isbn10`, `mac`, `base64`, `alpha`, `color`, ...) and numeric formats (`int8` ... `uint64`, `float16` ... `float64`).

The JSON addressing formats are grouped separately in `jsonFormats`: `json-pointer`, `json-pointer-uri-fragment` and `relative-json-pointer` (RFC 6901), and `json-path`, which validates query strings against the complete [RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html) grammar using the parser of the JSONPath compiler in `@jarenjs/json`.

The name → predicate bindings live in one canonical table, exported as `formatTesters` (plus the per-group `stringFormatTesters`, `jsonFormatTesters`, `dateTimeFormatTesters`, `numberFormatTesters`): bare synchronous predicates without validator coupling. The format compilers above wrap these testers in the validator contract, and [`@jarenjs/forms`](../forms) merges its rendering hints over the same table for per-keystroke field validation — one registry, so the two layers can never drift apart.

## Usage

```javascript
import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

const jaren = new JarenValidator()
  .addFormats(formats.stringFormats)
  .addFormats(formats.numberFormats)
  .addFormats(formats.dateTimeFormats)
  .addFormats(formats.jsonFormats);

const validate = jaren.compile({ type: 'string', format: 'json-path' });
validate('$.store.book[?@.price < 10]'); // true
```

Format assertion follows the specification per draft: asserted through draft 2019-09, annotation-only from draft 2020-12 on unless enabled via the `formatAssertion` option or a metaschema that declares the `format-assertion` vocabulary.

See the repository [README](../../README.md) for the complete format list.
