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

Paths are absolute (strings for keys, numbers for indices), so events
are directly JSON-Pointer-able. In the JSONX reader a container value
does NOT additionally fire `pair`/`item` — its start/end events carry
that; in the line-oriented JOSL reader inline tables arrive as
completed `pair` values and containers have no end events.

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
| `@jarenjs/josl/stream` | `createStreamReader`, `parseJoslStream` |
| `@jarenjs/josl/stringify` | `stringifyJosl`, `stringifyToml`, `formatValue`, `formatSection` |
| `@jarenjs/josl/write` | `createStreamWriter`, `stringifyJoslChunks` |
| `@jarenjs/josl/jsonx` | `parseJsonx`, `stringifyJsonx` |
| `@jarenjs/josl/jsonx-stream` | `createJsonxStreamReader`, `parseJsonxStream` |
| `@jarenjs/josl/values` | `LocalDate`, `LocalTime`, `LocalDateTime` |

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

| engine | compliance | parse, 1k-record doc | parse, suite corpus |
| --- | --- | --- | --- |
| **jaren** | **100.0%** | 10.8 ms | 1.33 ms |
| smol-toml | 96.8% | 5.6 ms | 0.80 ms |
| @iarna/toml | 93.4% | 11.3 ms | 2.20 ms |
| toml | 98.6% | 37.3 ms | 4.76 ms |

jaren is the only engine at 100% and the only one that parses chunk
streams; smol-toml's remaining speed edge is the price of the streaming
cutter's second pass (a single-walk scanner is the roadmap).

## Status

Published alongside the rest of the suite. Remaining roadmap: single-walk char
scanning (fold the cutter and the line parser into one pass), a CST
mode that preserves comments and formatting, partial-string streaming
events for progressive LLM text display, and a JOSL grammar published
as a JSON Schema for LLM constrained decoding, like the query/JSLT
grammars.
