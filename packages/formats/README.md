# @jarenjs/formats

Format validators for the JSON Schema `format` keyword, built on the text validators of [`@jarenjs/core`](../core). Includes all standard string formats (`date-time`, `date`, `time`, `duration`, `email`, `idn-email`, `hostname`, `idn-hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uri-template`, `iri`, `iri-reference`, `uuid`, `regex`) plus many extras (`iregexp`, `isbn10`, `mac`, `base64`, `alpha`, `color`, ...) and numeric formats (`int8` ... `uint64`, `float16` ... `float64`).

The JSON addressing formats are grouped separately in `jsonFormats`: `json-pointer`, `json-pointer-uri-fragment` and `relative-json-pointer` (RFC 6901), and `json-path`, which validates query strings against the complete [RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html) grammar using the parser of the JSONPath compiler in `@jarenjs/json`, plus `json-path-segments` for the variable-rooted path strings of the Jaren query format.

The geospatial formats are grouped in `geoFormats`: `geohash`, `wkt` and `geojson`, backed by the spatial kernel in `@jarenjs/core/geo`.

The name → predicate bindings live in one canonical table, exported as `formatTesters` (plus the per-group `stringFormatTesters`, `jsonFormatTesters`, `geoFormatTesters`, `dateTimeFormatTesters`, `numberFormatTesters`): bare synchronous predicates without validator coupling. The format compilers above wrap these testers in the validator contract, and [`@jarenjs/forms`](../forms) merges its rendering hints over the same table for per-keystroke field validation — one registry, so the two layers can never drift apart.

## Usage

```javascript
import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

const jaren = new JarenValidator()
  .addFormats(formats.stringFormats)
  .addFormats(formats.numberFormats)
  .addFormats(formats.dateTimeFormats)
  .addFormats(formats.jsonFormats)
  .addFormats(formats.geoFormats);

const validate = jaren.compile({ type: 'string', format: 'json-path' });
validate('$.store.book[?@.price < 10]'); // true
```

Format assertion follows the specification per draft: asserted through draft 2019-09, annotation-only from draft 2020-12 on unless enabled via the `formatAssertion` option (`new JarenValidator({ formatAssertion: true })`) or a metaschema that declares the `format-assertion` vocabulary.

**Register the group before you use a name from it, and register the right one.** The groups are split, so `date-time` lives in `dateTimeFormats` and *not* in `stringFormats`, and `json-path` lives in `jsonFormats`. Registering only `stringFormats` and then writing `format: 'date-time'` leaves the keyword accepting every value — per spec, an unregistered format is an annotation and asserts nothing, so nothing anywhere reports it. For schemas you own, compile with `new JarenValidator({ unknownFormats: 'error' })`: the missing registration then fails at compile time instead of silently. This repository does that for every schema it ships, gated by `test/validate/our-schema-formats.test.js`.

**Register the compilers, not the testers.** `stringFormats` and `formatTesters` are both objects full of functions, but only the *compilers* take `(schemaObj, jsonSchema)` and return the per-value validator; a tester registered in a compiler's place compiles to nothing. That one throws under either `unknownFormats` setting, because it is never intentional. Use `formatTesters` directly — as [`@jarenjs/forms`](../forms) does for per-keystroke field validation — rather than through `addFormats`.

## ✍ The complete format list

### ✍ Formats for strings

These format validators are based on the [json-schema.org](https://json-schema.org/understanding-json-schema/reference/string.html#built-in-formats) website. They are grouped in `stringFormats` (with the date/time formats also available separately as `dateTimeFormats`).

#### 🗨 Formats for datetime

- `date-time` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory
- `date` | a `full-date` (`YYYY-MM-DD`) according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6); it carries no time zone. *Upgrade: `2024-02-29Z` used to pass, as did a date-time whose date half ended in a zone (`2024-02-29ZT12:00:00Z`); both are refused now.*
- `time` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory

- `duration` | duration from RFC3339
- `iso-date-time` | ISO 8601 date-time with optional timezone
- `iso-time` | ISO 8601 time with optional timezone — the timezone offset is uniformly optional, so a zone-less time such as `12:30:00` validates

*Note: All date time formats can use formatMinimum / formatMaximum and formatExclusiveMinimum and formatExclusiveMaximum. The bounds are folded to epoch milliseconds at compile time and string values compare as numbers, so a validation allocates no `Date`; a raw `Date` instance as the value is still accepted and compares numerically.*

*Note: `iso-time` takes any offset whose hour is 00–23 and minute 00–59 (`12:00:00+05:30` validates, `12:00:00+24:00` does not) in its compiler and its bare tester alike, and a zone-less `iso-date-time` or `iso-time` is read as UTC when it meets a `formatMinimum` or `formatMaximum`, whatever zone the host is in. Upgrade: offsets with a non-zero minute used to be refused, `+24:00` and above used to pass the bare tester, and a zone-less value was compared in the host's own zone.*

*Note: `date-time` and `time` take a fraction of any number of digits and a leap second (`:60`) only at 23:59:60 UTC — `12:59:60Z` and `47:59:60Z` are refused. `iso-date-time` and `iso-time` cap the fraction at six digits and refuse `:60`.*

#### 🗨 Formats for url's, hostnames and emails

- `url` | http/https URL — a `uri` narrowed to the web schemes, so it must carry an authority and the RFC 3986 grammar still applies (`http://localhost:8080` and `http://127.0.0.1/` are URLs; `http://x/a|b` is not)
- `uri` | full URI according to [RFC3986](https://datatracker.ietf.org/doc/html/rfc3986), parsed against the grammar by character code — an ASCII grammar throughout, so a string carrying non-ASCII characters is an `iri` and not a `uri`
- `uri-reference` | URI reference, absolute or relative, according to [RFC3986](https://datatracker.ietf.org/doc/html/rfc3986)
- `uri-template` | URI template according to [RFC6570](https://datatracker.ietf.org/doc/html/rfc6570)
- `iri` | full URI with international characters, according to [RFC3987](https://datatracker.ietf.org/doc/html/rfc3987) — parsed against the grammar by character code, so percent-encoding must be well formed and `iprivate` is accepted in the query only
- `iri-reference` | full IRI reference, absolute or relative, according to [RFC3987](https://datatracker.ietf.org/doc/html/rfc3987)

- `email` | email address according to [RFC5321](https://datatracker.ietf.org/doc/html/rfc5321), including quoted-string local parts and `[192.0.2.1]` / `[IPv6:::1]` address literals
- `hostname` | host name according to [RFC1034](https://datatracker.ietf.org/doc/html/rfc1034#section-3.5)
- `idn-hostname` | host name with international characters
- `idn-email` | email address with international characters according to [RFC6531](https://datatracker.ietf.org/doc/html/rfc6531): the `email` grammar with non-ASCII text in the local part and an IDN hostname as the domain. *Upgrade: it used to accept any `x@y.z` shape, including spaces, line breaks and empty labels; those are now refused as in `email`.*

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
- `relative-json-pointer` | relative JSON-pointer according to draft-handrews-relative-json-pointer-01, the revision JSON Schema 2020-12 references; with the validator's `relativePointerDialect: 'bhutton-00'` option, draft-bhutton-relative-json-pointer-00, which also accepts index manipulation (`0+1`, `1-1/name`, `0-1#`)
- `json-path` | JSONPath query according to [RFC9535](https://www.rfc-editor.org/rfc/rfc9535.html), checked against the complete grammar (including filter well-typedness) by the parser of the JSONPath compiler in `@jarenjs/json`
- `json-path-segments` | a variable-rooted path string — `$name` followed by optional [RFC9535](https://www.rfc-editor.org/rfc/rfc9535.html) segments (`$book.price[?@.isbn]`), the form the Jaren query format uses to address a bound variable. Not a valid RFC 9535 query on its own (the RFC's root identifier is `$` alone), so `json-path` rejects it; both formats recognize the five built-in function extensions and no others, because a format has to mean the same thing in every schema

#### 🗨 Miscellaneous formats

- `alpha` | allow only ASCII alpha characters (a-zA-Z)
- `numeric` | allow only numeric characters (0-9)
- `alphanumeric` | allow only ASCII alpha numeric characters
- `hexadecimal` | allow only hexadecimal characters (0-9a-fA-F)
- `uppercase` | allow only upper case alpha characters
- `lowercase` | allow only lower case alpha characters
- `color` | web color hex string (starts with #, must be 3 or 6 hax characters)
- `regex` | tests whether a string is a valid regular expression
- `iregexp` | tests whether a string is a valid I-Regexp according to [RFC9485](https://www.rfc-editor.org/rfc/rfc9485.html) — the interoperable subset that means the same thing in every regexp dialect, so it is stricter than `regex`: shorthand classes (`\d`, `\w`), lazy quantifiers and lookaround are all rejected, and so is a pattern the grammar admits but no `RegExp` can be built from (`[z-a]`, `a{3,2}`, a quantified `^` or `$`, which this module reads as anchors, as JSONPath `match()` does). *Upgrade: those last used to pass, and JSONPath `match()` then treated them as false; they are refused now.*
- `base64` | base64 encoded data
- `byte` | same as `base64` format

- `isbn10` | International Standard Book Number, 10 digits — bare (`0306406152`) or in four groups joined by one hyphen or space (`0-306-40615-2`), with an optional `ISBN` label, and the check digit must hold (`X` is ten)
- `isbn13` | International Standard Book Number, 13 digits starting 978 or 979 — bare or in five groups joined by one hyphen or space (`978-0-306-40615-7`), with an optional `ISBN` label, and the check digit must hold. *Upgrade: both formats used to require the literal `ISBN` label and ignored the check digit, so a bare valid number was refused and a mistyped one accepted.*

- `country2` | country code by alpha-2 according to [ISO3166-1](https://www.iso.org/iso-3166-country-codes.html) — the 249 assigned codes plus `XK`, the user-assigned code for Kosovo; matched case-insensitively
- `iban` | International Bank Account Number according to [ISO13616](https://www.iso.org/standard/81090.html) — checks the country's registered length, the alphanumeric body and the ISO 7064 MOD 97-10 check digits, so a transposed digit is caught; accepts both the compact electronic format (`NL91ABNA0417164300`) and the print format grouped in fours (`NL91 ABNA 0417 1643 00`)

### ✍ Geospatial formats

These are grouped in `geoFormats`, backed by the spatial kernel in [`@jarenjs/core/geo`](../core).

- `geohash` | a base-32 geohash cell name, any length (`u173z`); the alphabet is lowercase and deliberately omits `a`, `i`, `l` and `o`
- `wkt` | a Well-Known Text geometry (ISO 19125 / OGC Simple Features): the seven tagged types with optional `Z`/`M`/`ZM` modifiers, `EMPTY`, consistent coordinate counts and closed polygon rings; an unmodified tag accepts 2 or 3 coordinates per point, as the field (PostGIS) does
- `geojson` | a structurally valid GeoJSON object per [RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946) — unlike every other format this one applies to **objects**, and it enforces the invariant JSON Schema provably cannot: every linear ring closed

`geojson` exists *next to* the GeoJSON meta-schema artifacts in [`@jarenjs/json`](../json), not instead of them, and the division of labour is deliberate: the format is the one-keyword annotation that answers yes or no in a single call, while the meta-schema locates the failure and (in the `$query`-extended variant) also checks ring winding. Reach for the schema when you want a diagnosis; reach for the format when you only want the gate.

### ✍ Formats for numbers

These are grouped in `numberFormats`. Formats for numbers validate both numbers and strings as number types; combine them with the `type` keyword (e.g. `{ "type": "integer", "format": "int32" }`) when only real number types should be allowed. An instance that cannot be read as a number at all, such as parsed JSON `{"toString": true}`, fails the format like any other object; upgrade: it used to throw out of the validator.

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

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.formats-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/formats` | JavaScript | declared |
| `@jarenjs/formats/package.json` | metadata | — |
<!--/fact-->

## Development

Unit tests live in `test/formats/` at the repository root; `test/formats/testers.test.js` enforces that every compiler registry's key set equals its tester group's, so the validator layer and the bare-predicate layer can never drift. The predicates themselves are implemented and tested in [`@jarenjs/core`](../core). See the repository [README](../../README.md) for the monorepo picture and the [ROADMAP](../../docs/ROADMAP.md) for planned formats.
