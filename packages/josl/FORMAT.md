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
| `{type:'root-item', path, index, line}` | a `[[]]` element started |
| `{type:'pair', path, key, value, line}` | a key-value completed |

Paths are absolute — strings for keys, numbers for array indices — so
they are directly convertible to JSON Pointers. The partially built root
is available at any time via `root()`.

This is the deliberate opposite of `JSON.parse(text, reviver)`, which
visits leaves bottom-up, only after the full text has arrived, and never
tells you where you are.

The write side mirrors this: `createStreamWriter` emits text chunks
event by event (`pair`, `table`, `tableArray`, `rootItem`; `buffer:
false` retains none of them), `stringifyJoslChunks` streams an existing
value one `[[]]` record at a time, and `stringifyJoslStream` pulls
records from an async source one per chunk — all byte-identical to
`stringifyJosl` output. `iterateJoslStream` is the reading twin: a
`[[]]` root array as a pull source of records, each detached from the
root as the next header completes it; a table root is refused, being one
retained value rather than a record stream.

**Limits.** A reader refuses a document by size only when asked. Every
limit defaults to `Infinity`, counts UTF-8 bytes, and is judged while
the text is still in cutter, token or container state; a crossing is a
`JoslLimitError` with a stable code — never a repair.

| reader | option | code |
| --- | --- | --- |
| JOSL / TOML | `maxTotalBytes` | `JOSL2001` |
| JOSL / TOML | `maxRecordBytes` — one logical line | `JOSL2002` |
| JOSL / TOML | `maxTokenBytes` — a string or key as written, quotes included | `JOSL2003` |
| JOSL / TOML | `maxDepth` — inline nesting and header path depth | `JOSL2004` |
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
