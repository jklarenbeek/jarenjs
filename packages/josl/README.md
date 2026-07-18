# @jarenjs/josl

**JOSL — JavaScript Obvious Streaming Language.** A research experiment:
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
| `@jarenjs/josl/stringify` | `stringifyJosl`, `stringifyToml` |
| `@jarenjs/josl/jsonx` | `parseJsonx`, `stringifyJsonx` |
| `@jarenjs/josl/values` | `LocalDate`, `LocalTime`, `LocalDateTime` |

## Status

Experimental and unpublished (`private: true`). Follow-ups if it
graduates: official `toml-test` suite validation, char-scanning hot
paths, a streaming writer, and benchmarks against `smol-toml`.
