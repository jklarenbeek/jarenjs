# JOSL — JavaScript Obvious Streaming Language

**Status: published (format version 0.x — the surface may still evolve).**

JOSL is a strict superset of [TOML 1.0.0](https://toml.io/en/v1.0.0) that
adds JavaScript's obvious value types as first-class citizens and makes
the most common LLM output shape — a list of records — streamable at the
root. Every valid TOML 1.0 document is a valid JOSL document with the
same meaning. The delta is deliberately tiny: a model that knows TOML
only has to be taught the extensions below.

The name follows Tom's lead: *Tom's Obvious Minimal Language* →
*JavaScript's Obvious Streaming Language*.

## Why

- **Streaming.** A truncated TOML/JOSL document is valid up to the last
  complete line; a truncated JSON document is unparseable until the last
  brace closes. Line-oriented, section-chunked syntax lets a consumer act
  on record *N* while an LLM is still emitting record *N+1*, and lets
  syntax errors surface (with line/column and a repair `hint`) the moment
  they are produced.
- **Fidelity.** JSON has no datetime, no bigint, no regexp, and TOML has
  no null. JavaScript has all four; JOSL makes them literals.
- **Small-model ergonomics.** Line-oriented key/value syntax with minimal
  escaping is easy for small models to emit reliably; the JOSL delta is
  small enough for a short system prompt to carry.

## The delta over TOML 1.0

### 1. `null`

```toml
middle-name = null
```

TOML has no null. In JOSL, `null` in value position is JavaScript's
`null`. In strict TOML mode (`mode: 'toml'`) it is a syntax error, and
the writer either errors or omits the key (`onNull: 'omit'`).

### 2. bigint

```toml
big = 123n
mask = 0xffff_ffff_ffff_ffffn
```

JavaScript bigint literal syntax: an integer in any TOML radix with an
`n` suffix. A fraction or exponent with `n` is an error. Additionally, a
*plain* integer that exceeds JavaScript's safe-integer range
auto-promotes to bigint in both modes, so integers always parse
losslessly; strict TOML mode additionally enforces the spec's signed
64-bit range, while the `n` literal syntax itself stays JOSL-only.

### 3. regexp

```toml
match = /^[a-z]+_\d{2,}$/im
```

JavaScript regexp literal syntax: body and flags, `/` inside a character
class needs no escape, `\/` works everywhere. The value is a native
`RegExp`, validated at parse time (construction only — never executed).

### 4. Root arrays: `[[]]`

```toml
[[]]
name = "first record"
score = 0.92
[meta]
source = "model-a"

[[]]
name = "second record"
score = 0.87
```

A list of records is the most common LLM output shape, and plain TOML
cannot express it at the root without a wrapper key. `[[]]` declares the
document root to be an array and appends one table element per
occurrence — each `[[]]` completes the previous record, which is exactly
the streaming boundary a consumer wants.

Scoping rule: after `[[]]`, subsequent `[table]` and `[[array]]` headers
are resolved *relative to the current root element*, so records can have
subsections. A document that starts with key-value pairs has an object
root; mixing the two is an error.

Root array elements are tables. Root arrays of scalars are intentionally
not supported (use a wrapper key); this keeps `[[]]` unambiguous.

A root array with no element is written `[]` on a line of its own, which
is how `stringifyJosl([])` spells it and how it reads back (`{}` is the
empty document, so the two cannot share a spelling). `[]` declares the
root an array and appends nothing; `[[]]` elements may follow it, and a
`[table]`, `[[array]]` or key-value pair before the first `[[]]` is an
error as it is in any root array. It is written once, as the first
header: after a `[[]]` element, after a second `[]`, or in a document
that has an object root it is an error. Strict TOML mode refuses it with
the rest of the root-array extension (`[]` was never a valid TOML header,
so no TOML document changes meaning). The writer uses `[]` for an empty
root array only; every table and every non-empty root array is written
with the headers above.

### Datetimes (inherited, clarified)

TOML's four datetime flavours are kept as-is; JOSL pins the JavaScript
representation:

| Literal | JS value |
| --- | --- |
| `1979-05-27T07:32:00Z` (offset) | `Date` (offset normalized to instant) |
| `1979-05-27T07:32:00` (local) | `LocalDateTime` |
| `1979-05-27` | `LocalDate` |
| `07:32:00.999` | `LocalTime` |

`LocalDate` / `LocalTime` / `LocalDateTime` are small frozen value
classes that round-trip via `toString()` and serialize under
`JSON.stringify` via `toJSON()`. Sub-second precision is kept as the
literal fraction string.

### What was deliberately left out

Bytes, sets, references/anchors, comments-as-data, scalar root arrays.
Every added type is prompt-tax on every model and code-tax on every
consumer; "obvious" is the load-bearing word. TOML 1.1 features (e.g.
`\e`, `\x`, second-optional times) are not included until 1.1 ships.

## Streaming semantics

The reader consumes chunks that may split *any* token (including a `"""`
delimiter). Events fire in document order the moment each construct
completes:

| Event | Meaning |
| --- | --- |
| `{type:'table', path, line}` | a `[header]` opened |
| `{type:'table-array', path, line}` | a `[[header]]` appended an element |
| `{type:'root-array', path, line}` | a `[]` empty root array declared (`path` is `[]`) |
| `{type:'root-item', path, index, line}` | a `[[]]` element started |
| `{type:'pair', path, key, value, line}` | a key-value completed |

Paths are absolute — strings for keys, numbers for array indices — so
they are directly convertible to JSON Pointers. The partially built root
is available at any time via `root()`.

This is the deliberate opposite of `JSON.parse(text, reviver)`, which
visits leaves bottom-up, only after the full text has arrived, and never
tells you where you are.

The write side mirrors this: `createStreamWriter` emits text chunks
event by event (`pair`, `table`, `tableArray`, `rootArray`, `rootItem`; `buffer:
false` retains none of them), `stringifyJoslChunks` streams an existing
value one `[[]]` record at a time, and `stringifyJoslStream` pulls
records from an async source one per chunk — all byte-identical to
`stringifyJosl` output. `iterateJoslStream` is the reading twin: a
`[[]]` root array as a pull source of records, each detached from the
root as the next header completes it; a table root is refused, being one
retained value rather than a record stream.

The concrete syntax tree is whole-document only. `parseJoslCst` and
`parseTomlCst` take the complete text and record each node's source span;
there is no streaming CST, and none is planned. A CST exists to rewrite a
document in place, and rewriting a document means holding all of it, so a
streamed one buys nothing a consumer has asked for. The chunk cutter has the
same slices in hand, but reports them per line without the terminator. To
edit a large document, read it whole into `parseJoslCst`; to transform a
stream, read events or records and write a new stream with
`createStreamWriter`.

**Limits.** A reader refuses a document by size only when asked. Every
limit defaults to `Infinity`, counts UTF-8 bytes, and is judged while
the text is still in cutter, token or container state; a crossing is a
`JoslLimitError` with a stable code — never a repair.

| reader | option | code |
| --- | --- | --- |
| JOSL / TOML | `maxTotalBytes` | `JOSL2001` |
| JOSL / TOML | `maxRecordBytes` — one logical line | `JOSL2002` |
| JOSL / TOML | `maxTokenBytes` — a string or key as written, quotes included | `JOSL2003` |
| JOSL / TOML | `maxDepth` — inline nesting, header path depth, and the tables a dotted key opens (counted from its table) | `JOSL2004` |
| JOSL / TOML | `maxRetainedValues` — values the root holds, starting over per detached `[[]]` item | `JOSL2005` |
| JSONX / JSON (stream reader) | `maxTotalBytes` | `JSONX2001` |
| JSONX / JSON (stream reader) | `maxTokenBytes` — a string, key, number or regexp as written | `JSONX2002` |
| JSONX / JSON (stream reader) | `maxDepth` | `JSONX2003` |
| JSONX / JSON (stream reader) | `maxRetainedValues` — linked values only; a detached subtree never counts | `JSONX2004` |

## JSONX

JSONX is the same set of first-class citizens grafted onto JSON, for
when brace syntax is the better fit:

- bigint: `123n`, with the same unsafe-integer auto-promotion
- regexp: `/pattern/flags`
- bare RFC 3339 datetimes: `2026-07-18T12:00:00Z`, `2026-07-18`,
  `12:30:00` (all four flavours, same JS mapping as JOSL)
- non-finite numbers: `inf`, `-inf`, `nan` (the JS spellings
  `Infinity` / `NaN` are also accepted)
- numeric separators (`1_000_000`) and a leading `+`

`mode: 'json'` is bit-compatible strict JSON: parsing matches
`JSON.parse`, stringifying delegates to `JSON.stringify`. The parser
reports the same document-order `open` / `value` / `close` events with
absolute paths.

**Syntax refusals.** Each condition below throws a `JsonxSyntaxError` with
a stable `JSONX1xxx` `code`, a `line` and `column`, and an `offset` — the
0-based position in the text in UTF-16 code units. `parseJsonx` and the
stream reader report the same code at the same place, however the stream
is chunked; the `message` names the condition in words without the code.
The codes are exported as `JSONX_CODES`. *Upgrade: the error used to carry
no `code` and no `offset`; its message is unchanged.*

| code | condition |
| --- | --- |
| `JSONX1001` | the text ends before its value is complete |
| `JSONX1002` | text follows the complete value |
| `JSONX1003` | an object member does not start with a string key |
| `JSONX1004` | a key is not followed by `:` |
| `JSONX1005` | a member is not followed by `,` or the container's closing bracket |
| `JSONX1006` | an object or array is never closed |
| `JSONX1007` | no value starts here |
| `JSONX1008` | a value is followed by a character that cannot end it |
| `JSONX1009` | a string is never closed |
| `JSONX1010` | an invalid escape sequence in a string |
| `JSONX1011` | an unescaped control character in a string |
| `JSONX1012` | an invalid number |
| `JSONX1013` | a bigint literal with a fraction or an exponent |
| `JSONX1014` | a date or time that does not exist (`2026-02-30`, `25:00:00`) |
| `JSONX1015` | a regexp literal is never closed |
| `JSONX1016` | a regexp literal the platform cannot compile |
| `JSONX1017` | a regexp literal, a leading `+` or a non-finite word (`inf`, `nan`, `Infinity`, `NaN`) in strict JSON mode; the other JSONX spellings (`1n`, `1_000`, a bare date) stop as `JSONX1008` |
| `JSONX1018` | an object names the same member twice (only under `duplicateKeys: 'error'`) |

**Reading a model's reply.** Two `parseJsonx` options, both off by default,
read the text a language model returns when asked for JSON:

- `fences: 'strip'` reads a text that is one Markdown code fence — an
  opening run of three or more backticks or tildes with an optional info
  string such as `json` on its own line, the body, and a closing run of the
  same character at least as long on a line of its own, with nothing but
  whitespace around them — as the fence's body. Every line, column and
  offset is still counted in the text as given. A text that is not fenced
  that way (prose around the fence, a fence never closed, a closing run
  that does not start its line) is read as it is. The default,
  `fences: 'error'`, reads the fence as text, and no value starts with it
  (`JSONX1007`).
- `duplicateKeys: 'error'` refuses a member whose name an earlier member
  of the same object has, decoded (`"a"` and `"\u0061"` are one name), with
  `JSONX1018` at the second member's key. The default, `duplicateKeys:
  'last'`, keeps the last member, as `JSON.parse` does.

The stream reader takes neither option and refuses both, naming `parseJsonx`.

## CSV

CSV is not a JOSL dialect and has no shared grammar with it — it lives in
this package because it has the same *shape of problem*: a record-oriented
text format that has to be readable a chunk at a time, and a value model
that JSON cannot express. What it shares is the machine architecture
(`parseAll` and `feed`/`end` run one record parser) and the value types.

There is no CSV specification worth conforming to. RFC 4180 describes a
narrow dialect that real exporters routinely violate, and it ships no test
suite. So the contract here is stated rather than referenced:

**Reading is strict by default.** The eight conditions below throw a
`CsvSyntaxError` with a stable `CSV1xxx` code, a line and a column.
`repair: true` reads each one the way that loses the least and records it
under the same code — the modes differ in what happens, never in the
diagnosis.

| code | condition | repair-mode reading |
| --- | --- | --- |
| `CSV1001` | a quoted field is never closed | close at end of input |
| `CSV1002` | text after a closing quote | field closed; absorb the text |
| `CSV1003` | an unescaped quote inside a quoted field | the quote is literal |
| `CSV1004` | record shorter than the header | missing columns stay absent |
| `CSV1005` | record longer than the header | widen the header once |
| `CSV1006` | a bare carriage return | ends the record |
| `CSV1007` | a duplicate header name | suffix (`a`, `a_2`) |
| `CSV1008` | an empty header name | synthesize (`column_3`) |

`CSV1002` and `CSV1003` describe the same byte read two ways. The reader
chooses by scanning for another quote before the next delimiter or
terminator: one found means the quote is text (`"he said "hi" ok"` keeps
its content), none found means the field had closed (`"abc"junk,d` keeps
its two columns). Column count breaks the tie, because a lost field
boundary corrupts every value after it while a mangled cell corrupts one.

**Deliberate readings**, each chosen because the alternative destroys
information that cannot be recovered downstream:

- A blank line is a record of one empty field (RFC 4180 has no blank
  line). `skipEmptyLines` drops them, and repair mode turns it on.
- A trailing terminator does not produce a final empty record.
- A quoted cell is never trimmed and never coerced: the quotes are the
  author marking the content as text.
- Header names remain text even with `typed: true`; coercion applies only
  to data rows, in both whole-document and streaming reads.
- A missing column is **absent**, not empty — `undefined` says the record
  did not carry it, `''` would claim it carried nothing.
- `typed: true` promotes an integer beyond 2^53 to bigint rather than
  rounding, reads unambiguous ISO-8601 as the value classes above, and
  leaves numbers with a leading zero a string. Offset date-times use
  the same instant conversion as JOSL, preserving four-digit years and
  truncating precision beyond milliseconds; invalid offsets stay text.
- A BOM is stripped without comment; it is an encoding mark, not data.

**Writing** quotes a field only when it contains the delimiter, the quote
character, a newline, or edge whitespace a lenient reader might trim. The
default terminator is CRLF, per RFC 4180 §2.1 and what spreadsheet
software expects. `stringifyCsv`, `stringifyCsvChunks`, the stream writer
and the pull form `stringifyCsvStream` share one row formatter and are
byte-identical for the same records; the pull form requests a record only
when its consumer asks for the next line.

`neutralizeFormulas: true` selects a spreadsheet export transformation in that
shared formatter. After normal value conversion and before CSV quoting, it
prefixes one apostrophe (`'`) exactly when the first character is `=`, `+`, `-`,
`@`, tab (U+0009), CR (U+000D) or LF (U+000A). Headers, including a header-only
document with explicit fields, follow the same rule. A leading apostrophe is
left unchanged. Null/undefined and empty cells remain empty. A negative number
or bigint becomes apostrophe-prefixed text in this mode: `-12` becomes `'-12`.
The default is lossless with respect to this policy and leaves these prefixes
unchanged; `formatCsvValue` itself does not apply it.

```js
stringifyCsv([['=1+2', -12, "'=already", 'x,y']], { neutralizeFormulas: true });
// "'=1+2,'-12,'=already,\"x,y\"\r\n"
```

The policy does not trim whitespace, recognize full-width variants or inspect
formula syntax. Delimiter, quote and newline settings retain their existing
meanings; disabling quoting still disables escaping and does not produce safe
cell boundaries for values containing a separator. Ordinary CSV quoting alone
does not neutralize formulas. This exact text transformation is not a guarantee
for every spreadsheet or subsequent save/reimport. Qualify the intended consumer
and dialect; locale-sensitive forms and spreadsheet rewrites need their own
policy. [OWASP's CSV injection reference](https://community.owasp.org/attacks/CSV_Injection)
describes those limits. CSV readers preserve the added apostrophe as data.

**Limits.** Optional, `Infinity` by default, in UTF-8 bytes, judged before
the text is kept; a crossing is a `JoslLimitError`, never a repair:

| option | code |
| --- | --- |
| `maxTotalBytes` | `CSV2001` |
| `maxRecordBytes` — one record, its terminator included | `CSV2002` |
| `maxFieldBytes` — one field as written, quotes included | `CSV2003` |
| `maxColumns` | `CSV2004` |

## Compliance notes

- Strict TOML mode passes the complete official
  [toml-test](https://github.com/toml-lang/toml-test) 1.0.0 suite
  (the git submodule at `benchmark/toml-test-suite/`): all valid cases with
  typed value verification, all invalid cases rejected. The only skips
  are eight byte-level UTF-8 encoding cases, unreachable once input is
  a JS string. `npm run test:josl` runs the suite;
  `npm run benchmark:toml` compares compliance and speed against other
  JS TOML parsers.
- Integers parse losslessly: plain integers beyond JavaScript's safe
  range promote to bigint in both modes, and strict TOML mode enforces
  the spec's signed 64-bit **range** (the `n` literal *syntax* remains
  JOSL-only).
- `__proto__` keys are stored as own properties (no prototype
  pollution) in both JOSL and JSONX.
- Round-trips are faithful for data, not formatting: comments and key
  order aesthetics are not part of the value model, and an array whose
  elements are all plain objects is re-emitted in `[[array]]` form.
