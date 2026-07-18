# JOSL — JavaScript Obvious Streaming Language

**Status: research experiment.**

JOSL is a strict superset of [TOML 1.0.0](https://toml.io/en/v1.0.0) that
adds JavaScript's obvious value types as first-class citizens and makes
the most common LLM output shape — a list of records — streamable at the
root. Every valid TOML 1.0 document is a valid JOSL document with the
same meaning. The delta is deliberately tiny: a model that knows TOML
only has to be taught the extensions below.

The name follows Tom's lead: *Tom's Obvious Minimal Language* →
*JavaScript's Obvious Streaming Language*.

## Why (the experiment)

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
event by event (`pair`, `table`, `tableArray`, `rootItem`), and
`stringifyJoslChunks` streams an existing value one `[[]]` record at a
time — byte-identical to `stringifyJosl` output.

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
