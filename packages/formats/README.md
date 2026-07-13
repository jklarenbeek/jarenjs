# @jarenjs/formats

Format validators for the JSON Schema `format` keyword, built on the text validators of [`@jarenjs/core`](../core). Includes all standard string formats (`date-time`, `date`, `time`, `duration`, `email`, `idn-email`, `hostname`, `idn-hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uri-template`, `iri`, `iri-reference`, `uuid`, `json-pointer`, `relative-json-pointer`, `regex`) plus many extras (`isbn10`, `mac`, `base64`, `alpha`, `color`, ...) and numeric formats (`int8` ... `uint64`, `float16` ... `float64`).

## Usage

```javascript
import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

const jaren = new JarenValidator()
  .addFormats(formats.stringFormats)
  .addFormats(formats.numberFormats)
  .addFormats(formats.dateTimeFormats);

const validate = jaren.compile({ type: 'string', format: 'email' });
```

Format assertion follows the specification per draft: asserted through draft 2019-09, annotation-only from draft 2020-12 on unless enabled via the `formatAssertion` option or a metaschema that declares the `format-assertion` vocabulary.

See the repository [README](../../README.md) for the complete format list.
