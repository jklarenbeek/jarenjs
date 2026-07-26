# @jarenjs/josl

**JOSL — JavaScript Obvious Streaming Language.**
TOML 1.0, backward compatible, extended with JavaScript's obvious value
types (`null`, bigint, regexp, datetimes) and a streamable `[[]]` root
array — plus **JSONX**, the same extensions over JSON. Built for
LLM-to-LLM pipelines: chunk-feedable parsing, document-order events,
machine-repairable errors with line/column and a `hint`.

Zero dependencies, vanilla JS, CSP-safe, tree-shakeable subpath exports.
See [FORMAT.md](./FORMAT.md) for the language definition and rationale.

## Quick start

```js
import { parseJosl, stringifyJosl } from '@jarenjs/josl';

const doc = parseJosl(`
  title = "example"
  big = 9007199254740993n     # bigint literal
  match = /^ok$/i             # regexp literal
  middle-name = null          # TOML has no null; JOSL does
  when = 2026-07-18T12:00:00Z # a real Date

  [server]
  host = "localhost"
`);

stringifyJosl(doc); // round-trips
```

Strict TOML in and out of the same engine:

```js
import { parseToml, stringifyToml } from '@jarenjs/josl';

parseToml(tomlText);                            // rejects JOSL extensions
stringifyToml(doc, { onNull: 'omit' });         // downlevels a JOSL value
```

## Streaming (the point)

Two incremental readers share one API shape (`feed`/`end`/`root`) and
one `pair` event, so a consumer keyed on paths never branches on
syntax. Chunks may split ANY token — escapes mid-`\uXXXX`, numbers,
`tru` + `e` — which is what makes token-by-token LLM output feedable.

**JOSL / TOML** (line-oriented):

```js
import { createStreamReader } from '@jarenjs/josl/stream';

const reader = createStreamReader({
  onEvent(e) {
    // document order, absolute paths, fired the moment a line completes
    if (e.type === 'root-item') console.log('record', e.index, 'started');
    if (e.type === 'pair') console.log(e.path.join('/'), '=', e.value);
  },
});

for await (const chunk of llmTokenStream) // chunks may split ANY token
  reader.feed(chunk);
const records = reader.end();
```

**JSONX / strict JSON** (nested):

```js
import { createJsonxStreamReader } from '@jarenjs/josl/jsonx-stream';

const reader = createJsonxStreamReader({
  mode: 'json', // strict: rejects every JSONX extension, matches JSON.parse
  onEvent(e) {
    if (e.type === 'pair') console.log(e.path.join('/'), '=', e.value);
  },
});
reader.feed('{"run": [{"i": 1, "ops": 6');  // any split point works
reader.feed('1200}]}');
const doc = reader.end();                    // { run: [{ i: 1, ops: 61200 }] }
```

The unified event vocabulary:

| event | reader | fields | when |
| --- | --- | --- | --- |
| `pair` | both | `path`, `key`, `value`, `line` | a scalar member completes |
| `item` | jsonx | `path`, `index`, `value`, `line` | a scalar array element completes |
| `object-start` / `object-end` | jsonx | `path`, `line` | `{` opened / `}` closed |
| `array-start` / `array-end` | jsonx | `path`, `line` | `[` opened / `]` closed |
| `table` / `table-array` / `root-item` | josl | `path`, `line` (+`index`) | a header line completes |
| `text-partial` | jsonx | `path`, `text`, `line` | more of a string arrived (opt-in) |

Paths are absolute (strings for keys, numbers for indices), so events
are directly JSON-Pointer-able. In the JSONX reader a container value
does NOT additionally fire `pair`/`item` — its start/end events carry
that; in the line-oriented JOSL reader inline tables arrive as
completed `pair` values and containers have no end events.

### Progressive text

Scalars normally fire once, on completion — but a long string in an LLM
response is worth showing as it arrives. `partialText: true` adds
`text-partial` events carrying the *delta* since the previous one,
already unescaped:

```js
const reader = createJsonxStreamReader({
  partialText: true,
  onEvent(e) {
    if (e.type === 'text-partial') process.stdout.write(e.text); // append
    if (e.type === 'pair') console.log('\ncomplete:', e.path.join('/'));
  },
});
```

A value's deltas add up to exactly its string — nothing is left over in
the closing `pair`/`item` event, which still carries the whole value as
the completion signal. Deltas never split an escape or a surrogate pair,
so appending them to a display is always safe. Object keys emit none: a
key has no path until it is complete.

### Streaming charts with @jarenjs/charts

`@jarenjs/charts`' stream adapter consumes these events directly (it
never imports a parser — pair them at the call site):

```js
import { createJsonxStreamReader } from '@jarenjs/josl/jsonx-stream';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';
import { compileChart } from '@jarenjs/charts';

const adapter = createStreamAdapter('line', {
  recordPath: ['run'], xField: 'i', yField: 'ops', maxPoints: 200,
});
const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });

for await (const chunk of feed) {
  reader.feed(chunk);
  render(compileChart({ type: 'line', title: 'live' }, adapter.getData()).toVnode());
}
reader.end();
adapter.endDocument();
```

An LLM emitting a list of records streams naturally:

```toml
[[]]
name = "first"
score = 0.92

[[]]
name = "second"
score = 0.87
```

Each `[[]]` completes the previous record — `reader.root()` exposes the
partial array at any time, so record *N* can be processed while the
model is still emitting record *N+1*.

## Streaming writer

The write-side mirror of the reader — build a document event by event and
ship each chunk as it is produced:

```js
import { createStreamWriter, stringifyJoslChunks } from '@jarenjs/josl/write';

const w = createStreamWriter({ onChunk: (c) => response.write(c) });
w.pair('title', 'run 42')
  .table('server')
  .pair('host', 'localhost');
// root-array documents: w.rootItem(record) per completed record
const text = w.end();

// or stream an existing value, one chunk per [[]] record:
for (const chunk of stringifyJoslChunks(records))
  response.write(chunk);
```

The writer validates what the reader would reject (duplicate keys and
headers, root table/array mixing, TOML downleveling) and shares its
serialization with `stringifyJosl`, so both produce identical text.

## Editing a document (CST)

`parseJosl` + `stringifyJosl` round-trips *data*. When the document
itself matters — a config file a human wrote, with comments and
alignment — parse it as a CST instead. Reprinting an untouched document
returns the original bytes; an edit changes only the value's own bytes:

```js
import { parseTomlCst } from '@jarenjs/josl/cst';

const doc = parseTomlCst(readFileSync('config.toml', 'utf8'));
doc.set(['server', 'port'], 9090);
writeFileSync('config.toml', doc.toString());
```

```diff
  [server]
  host   = "localhost"  # keep me
- port   = 8080
+ port   = 9090
```

`get`/`set`/`delete` take absolute paths (numbers index an array of
tables); `set` on a key that does not exist appends it to the section
its path names, not to the end of the file. `toJSON()` gives the value
model, recomputed from the text after an edit so it can never drift
from the bytes. Byte-identical reprinting is verified against every
document in the official toml-test valid corpus.

## JSONX

```js
import { parseJsonx, stringifyJsonx } from '@jarenjs/josl/jsonx';

parseJsonx('{"big": 123n, "re": /a+/g, "when": 2026-07-18}');

// document-order events instead of JSON.parse's bottom-up reviver:
parseJsonx(text, { onEvent: (e) => console.log(e.type, e.path, e.value) });

parseJsonx(text, { mode: 'json' });      // bit-compatible JSON.parse
stringifyJsonx(v, { mode: 'json' });     // delegates to JSON.stringify
```

## Exports

| Subpath | What |
| --- | --- |
| `@jarenjs/josl/parse` | `parseJosl`, `parseToml` |
| `@jarenjs/josl/cst` | `parseJoslCst`, `parseTomlCst`, `JoslCstDocument` |
| `@jarenjs/josl/gbnf` | `toGbnf`, `tomlToGbnf` |
| `@jarenjs/josl/stream` | `createStreamReader`, `parseJoslStream` |
| `@jarenjs/josl/stringify` | `stringifyJosl`, `stringifyToml`, `formatValue`, `formatSection` |
| `@jarenjs/josl/write` | `createStreamWriter`, `stringifyJoslChunks` |
| `@jarenjs/josl/jsonx` | `parseJsonx`, `stringifyJsonx` |
| `@jarenjs/josl/jsonx-stream` | `createJsonxStreamReader`, `parseJsonxStream` |
| `@jarenjs/josl/values` | `LocalDate`, `LocalTime`, `LocalDateTime` |
| `@jarenjs/josl/schemas/*` | schema artifacts (`jaren-josl-data.schema.json`) |

## Generating JOSL with LLMs

JOSL is a *text* format, so "hand the grammar to a constrained decoder"
has two possible shapes, and they serve different providers:

1. **A JSON Schema over the data model** — the model emits JSON, and
   `stringifyJosl` renders canonical JOSL text. This works with every
   `json_schema`-capable provider today and composes directly with
   `@jarenjs/ai`'s `createStructuredOutput`. It is what this package
   ships: [`schemas/jaren-josl-data.schema.json`](./schemas/jaren-josl-data.schema.json)
   describes the JSON-safe JOSL document (a root table of strings,
   finite numbers, booleans, `null`, arrays and nested tables), and
   `parseJosl(stringifyJosl(doc))` round-trips every document in it
   exactly. JOSL's native date/time scalars parse to platform `Date`
   values, which JSON cannot carry — represent them as strings and
   parse downstream.
2. **A character-level grammar (GBNF class) over raw JOSL text** — for
   engines that constrain token sampling directly (llama.cpp family).
   `toGbnf()` emits it; `toGbnf({ mode: 'toml' })` drops the JOSL-only
   value forms.

   ```js
   import { toGbnf } from '@jarenjs/josl/gbnf';

   await llama({ grammar: toGbnf(), prompt });   // emits JOSL text directly
   ```

   A context-free grammar carries syntax only. Duplicate keys, a header
   that reopens a table, `2026-02-30` — every rule that needs to
   remember what the document already said, or to range-check a value
   inside a well-formed token, stays `parseJosl`'s job. Constrained
   sampling narrows the model to well-formed text; it does not make the
   parser optional.

   The grammar is checked both ways by `test/josl/gbnf.test.js`, which
   reads it back and recognizes text with an Earley parser: it accepts
   all 210 documents in the official toml-test valid corpus, rejects 400
   of the 499 invalid ones (the remaining 99 fail on exactly the
   semantic rules above), and 3000 seeded derivations per mode all parse.
   That last direction is the one that matters for sampling — a model
   steered by this grammar cannot be walked into text the parser
   rejects.

## Compliance & speed

Strict TOML mode is validated against the complete official
[toml-test](https://github.com/toml-lang/toml-test) 1.0.0 suite
(the git submodule at `benchmark/toml-test-suite/`) — every valid case with full
typed value verification (`npm run test:josl`), every invalid case
rejected. The only skips are eight byte-level UTF-8 encoding cases that
cannot be expressed once input is already a JS string.

`npm run benchmark:toml` runs the suite plus a parse/stringify profile
against `smol-toml`, `@iarna/toml` and `toml`. Representative run
(accept/reject compliance, 694 cases; Node 22):

| engine | compliance | parse, 1k-record doc | parse, small doc | parse, suite corpus |
| --- | --- | --- | --- | --- |
| **jaren** | **100.0%** | 7.4 ms | **0.014 ms** | 0.91 ms |
| smol-toml | 96.8% | **5.7 ms** | 0.021 ms | **0.80 ms** |
| @iarna/toml | 93.4% | 11.4 ms | 0.029 ms | 2.13 ms |
| toml | 98.6% | 38.4 ms | 0.080 ms | 4.83 ms |

jaren is the only engine at 100% and the only one that parses chunk
streams. Whole-document parsing walks the source once — the value
parsers already stop at the newlines TOML forbids a construct from
crossing, so with the whole text in hand the parser finds each logical
line's end itself and the cutter's separate pass is not needed. That is
worth ~1.45× over the two-pass version and puts jaren ahead on small
documents; on the 90 KB record stream smol-toml still leads, by ~1.3×
rather than the ~1.9× it led by before. Chunk feeding keeps the cutter,
because only a side-effect-free pre-pass can decide whether a line is
complete when a chunk may stop mid-token — and it is held to the same
694 cases, fed one character at a time.

Stringify is the honest loss: 6.9 ms against smol-toml's 2.7 ms on the
same document, roughly level with `@iarna/toml`. Nothing has been done
about it yet.

## Status

Published alongside the rest of the suite. Both constrained-decoding
twins ship — the JSON-Schema one over the data model and the GBNF one
over the text — along with the CST mode, progressive `text-partial`
events and single-walk whole-document parsing. Stringify speed is the
open item: see the table above.
