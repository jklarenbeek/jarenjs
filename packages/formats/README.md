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

Format assertion follows the specification per draft: asserted through draft 2019-09, annotation-only from draft 2020-12 on unless enabled via the `formatAssertion` option (`new JarenValidator({ formatAssertion: true })`) or a metaschema that declares the `format-assertion` vocabulary.

## ✍ The complete format list

### ✍ Formats for strings

These format validators are based on the [json-schema.org](https://json-schema.org/understanding-json-schema/reference/string.html#built-in-formats) website. They are grouped in `stringFormats` (with the date/time formats also available separately as `dateTimeFormats`).

#### 🗨 Formats for datetime

- `date-time` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory
- `date` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory
- `time` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory

- `duration` | duration from RFC3339
- `iso-date-time` | ISO 8601 date-time with optional timezone
- `iso-time` | ISO 8601 time with optional timezone

*Note: All date time formats can use formatMinimum / formatMaximum and formatExclusiveMinimum and formatExclusiveMaximum*

#### 🗨 Formats for url's, hostnames and emails

- `url` | full URL
- `url--full` | same as `url`, but more comprehensive
- `uri` | full URI
- `uri--full` | same as `uri`, but more comprehensive
- `uri-reference` | URI reference, including full and relative URIs
- `uri-reference--full` | same as `uri-reference`, but more comprehensive
- `uri-template` | URI template according to [RFC6570](https://datatracker.ietf.org/doc/html/rfc6570)
- `iri` | full URI with international characters
- `iri-reference` | full URI reference with with international characters

- `email` | email address
- `email--full` | same as email, but more comprehensive
- `hostname` | host name according to [RFC1034](https://datatracker.ietf.org/doc/html/rfc1034#section-3.5)
- `idn-hostname` | host name with international characters
- `idn-email` | email address with international characters

#### 🗨 Formats for identifiers

- `uuid` | Universally Unique IDentifier according to [RFC4122](https://datatracker.ietf.org/doc/html/rfc4122)
- `guid` | Globally Unique IDentifier according to Microsoft

- `identifier` | C-type identifier
- `html-identifier` | html element `id` attribute identifier according to [RFC7992](https://datatracker.ietf.org/doc/html/rfc7992#section-5.1)
- `css-identifier` | css class name identifier according to [RFC7993](https://datatracker.ietf.org/doc/html/rfc7993)

- `mac` | ethernet interface identifier (EUI-48) according to [IEEE820](https://en.wikipedia.org/wiki/MAC_address)
- `ipv4` | IP v4 address according to [RFC791](https://datatracker.ietf.org/doc/html/rfc791)
- `ipv6` | IP v6 address according to [RFC2460](https://datatracker.ietf.org/doc/html/rfc2460)

#### 🗨 Formats for json pointers and paths

These are grouped in `jsonFormats`.

- `json-pointer` | JSON-pointer according to [RFC6901](https://datatracker.ietf.org/doc/html/rfc6901)
- `json-pointer-uri-fragment` | JSON-pointer fragment according to [RFC6901](https://datatracker.ietf.org/doc/html/rfc6901#section-6)
- `relative-json-pointer` | relative JSON-pointer according to [draft-luff-relative-json-pointer-00](https://datatracker.ietf.org/doc/html/draft-luff-relative-json-pointer-00)
- `json-path` | JSONPath query according to [RFC9535](https://www.rfc-editor.org/rfc/rfc9535.html), checked against the complete grammar (including filter well-typedness) by the parser of the JSONPath compiler in `@jarenjs/json`

#### 🗨 Miscellaneous formats

- `alpha` | allow only ASCII alpha characters (a-zA-Z)
- `numeric` | allow only numeric characters (0-9)
- `alphanumeric` | allow only ASCII alpha numeric characters
- `hexadecimal` | allow only hexadecimal characters (0-9a-fA-F)
- `uppercase` | allow only upper case alpha characters
- `lowercase` | allow only lower case alpha characters
- `color` | web color hex string (starts with #, must be 3 or 6 hax characters)
- `regex` | tests whether a string is a valid regular expression
- `base64` | base64 encoded data
- `byte` | same as `base64` format

- `isbn10` | International Standard Book Number 10 digit number
- `isbn13` | International Standard Book Number 13 digit number

- `country2` | Country code by alpha-2 according to ISO3166-1 _!No tests exists!_
- `iban` | International Bank Account Number _!No tests exists!_

### ✍ Formats for numbers

These are grouped in `numberFormats`. Formats for numbers validate both numbers and strings as number types; combine them with the `type` keyword (e.g. `{ "type": "integer", "format": "int32" }`) when only real number types should be allowed.

#### 🗨 Formats integer numbers

- `int8` | signed 8 bit integer
- `uint8` | unsigned 8 bit integer
- `int16` | signed 16 bit integer
- `uint16` | unsigned 16 bit integer
- `int32` | signed 32 bit integer
- `uint32` | unsigned 32 integer
- `int64` | signed 64 integer
- `uint64` | unsigned 64 integer

#### 🗨 Formats floating point numbers

- `float16` | 16 bit floating point number
- `float32` | 32 bit floating point number
- `float64` | 64 bit floating point number
- `float` | 32 bit floating point number
- `double` | 64 bit floating point number

## Development

Unit tests live in `test/formats/` at the repository root; `test/formats/testers.test.js` enforces that every compiler registry's key set equals its tester group's, so the validator layer and the bare-predicate layer can never drift. The predicates themselves are implemented and tested in [`@jarenjs/core`](../core). See the repository [README](../../README.md) for the monorepo picture and the [ROADMAP](../../ROADMAP.md) for planned formats.
