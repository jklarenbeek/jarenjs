# @jarenjs/josl

**JOSL — JavaScript Obvious Streaming Language.**
TOML 1.0, backward compatible, extended with JavaScript's obvious value
types (`null`, bigint, regexp, datetimes) and a streamable `[[]]` root
array — plus **JSONX**, the same extensions over JSON, and a **CSV**
reader/writer that heals damaged input instead of guessing at it. Built for
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
| `object-start` / `array-start` | jsonx | `path`, `line` | `{` / `[` opened |
| `object-end` / `array-end` | jsonx | `path`, `value`, `line` | `}` / `]` closed |
| `table` / `table-array` / `root-item` | josl | `path`, `line` (+`index`) | a header line completes |
| `text-partial` | jsonx | `path`, `text`, `line` | more of a string arrived (opt-in) |

Paths are absolute (strings for keys, numbers for indices), so events
are directly JSON-Pointer-able. In the JSONX reader a container value
does NOT additionally fire `pair`/`item` — its start/end events carry
that; in the line-oriented JOSL reader inline tables arrive as
completed `pair` values and containers have no end events.

### Documents larger than memory

Feeding a document in chunks bounds the *parse*, not the *result*: the
reader still ends up holding everything it has read. For a continent-
sized `FeatureCollection` or a million-line log that is the wrong
answer, and it is the reason `detach` exists.

A value whose absolute path matches the pattern is **never linked into
the tree**. Its completion event still carries the whole thing, so the
consumer sees every record exactly once — but letting go of the event
lets go of the record.

```js
const reader = createJsonxStreamReader({
  mode: 'json',
  detach: ['features', '*'],          // '*' matches any one segment
  onEvent(e) {
    if (e.type === 'object-end' && e.path.length === 2)
      consume(e.value);               // a whole GeoJSON Feature
  },
});

for await (const chunk of fileChunks) reader.feed(chunk);
reader.end();   // { type: 'FeatureCollection', name: '…', features: [] }
```

`root()` comes back holding the document's *frame* — its header members,
and an empty array where the records would have been — however many
records went past. The pattern matches an exact path, not a prefix, so a
feature's own rings are not separately detached: they belong to their
feature and are freed with it.

The JOSL twin is `iterateJoslStream`: a `[[]]` root array read as a pull
source of records, each detached from the root the moment the next
`[[]]` header (or the end) completes it, so the reader holds at most the
record in progress. A table root is one retained value, not a record
stream, and is refused by name.

```js
import { iterateJoslStream } from '@jarenjs/josl/stream';

for await (const record of iterateJoslStream(response.body, { signal }))
  await save(record);        // the source is closed exactly once on an abort or an early return
```

### Hostile input

Every reader refuses a document by size only when asked: the limits
default to `Infinity`, count **UTF-8 bytes** (never code units), and are
checked while the offending text is still in cutter, token or container
state. Limited streams inspect bounded slices and reject an oversized pending
span before accepting another slice; complete spans are checked before decoding
or linking values. Total bytes include a leading BOM, and splitting a surrogate
pair across chunks does not change the byte count. A crossing
throws `JoslLimitError` with a stable code and the limit; it is never a
repair, because a document that is too large is not damaged.

| reader | option | code |
| --- | --- | --- |
| CSV | `maxTotalBytes` | `CSV2001` |
| CSV | `maxRecordBytes` (one record, its terminator included) | `CSV2002` |
| CSV | `maxFieldBytes` (one field as written, quotes included) | `CSV2003` |
| CSV | `maxColumns` | `CSV2004` |
| JOSL / TOML | `maxTotalBytes` | `JOSL2001` |
| JOSL / TOML | `maxRecordBytes` (one logical line) | `JOSL2002` |
| JOSL / TOML | `maxTokenBytes` (a key or scalar token as written, quotes and regexp flags included) | `JOSL2003` |
| JOSL / TOML | `maxDepth` (inline nesting, header path depth) | `JOSL2004` |
| JOSL / TOML | `maxRetainedValues` (values the root holds; starts over per detached `[[]]` item) | `JOSL2005` |
| JSONX / JSON stream | `maxTotalBytes` | `JSONX2001` |
| JSONX / JSON stream | `maxTokenBytes` (a string, key, number or regexp as written) | `JSONX2002` |
| JSONX / JSON stream | `maxDepth` | `JSONX2003` |
| JSONX / JSON stream | `maxRetainedValues` (linked values only — a detached subtree is never counted) | `JSONX2004` |

The CSV and JOSL limits guard the whole-document parsers too, which run
the same machines; the JSONX limits are the stream reader's, which is
where a document arrives a chunk at a time. `CSV_LIMIT_CODES`,
`JOSL_LIMIT_CODES` and `JSONX_LIMIT_CODES` are the tables as data.

Field and token limits bound those spans, not an entire record containing many
small spans. Use `maxRecordBytes` or `maxTotalBytes` as well when the buffered
source itself needs a hard ceiling. Open strings, bare keys and scalar tokens
are checked as they arrive, including in the first chunk.

Measured on a synthetic OpenStreetMap-shaped extract (`node --expose-gc
benchmark/jsonx-stream.js`), reading 20 000 features of 40 vertices each:

| | peak live set | root holds |
| --- | --- | --- |
| default | 185.4 MB | 20 000 features |
| `detach: ['features','*']` | < 0.1 MB | 0 |

and the detached figure does not move at 80 000 features — the peak is
the 64 kB feed buffer plus one feature at a time, not the document.
"Peak live set" means the heap after a forced collection: sampling
`heapUsed` without collecting first measures how lazily V8 sweeps, which
grows with the heap and would make even a detached read look like it
accumulates.

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
import { createStreamWriter, stringifyJoslChunks, stringifyJoslStream } from '@jarenjs/josl/write';

const w = createStreamWriter({ onChunk: (c) => response.write(c), buffer: false });
w.pair('title', 'run 42')
  .table('server')
  .pair('host', 'localhost');
// root-array documents: w.rootItem(record) per completed record
w.end();                                     // '' — buffer: false retains nothing; the sink has it

// or stream an existing value, one chunk per [[]] record:
for (const chunk of stringifyJoslChunks(records))
  response.write(chunk);

// or pull records from an async source — a database cursor — one per chunk:
response.body = stringifyJoslStream(store.collection('rows').query(doc), { signal });
```

The writer validates what the reader would reject (duplicate keys and
headers, root table/array mixing, TOML downleveling) and shares its
serialization with `stringifyJosl`, so both produce identical text.
`stringifyJoslStream` is the pull form: the next record is requested only
when the consumer asks for the next chunk, so a cursor behind it never
runs ahead of the socket in front of it; its chunks are byte-identical to
`stringifyJoslChunks` for the same records, and an abort (`signal`), a
consumer that stops early or a throw closes the record source exactly
once. `buffer: false` (with an `onChunk` sink) keeps the event writer from
retaining a second copy of the document it streams.

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

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.josl-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/josl` | JavaScript | declared |
| `@jarenjs/josl/parse` | JavaScript | declared |
| `@jarenjs/josl/cst` | JavaScript | declared |
| `@jarenjs/josl/gbnf` | JavaScript | declared |
| `@jarenjs/josl/stream` | JavaScript | declared |
| `@jarenjs/josl/stringify` | JavaScript | declared |
| `@jarenjs/josl/write` | JavaScript | declared |
| `@jarenjs/josl/jsonx` | JavaScript | declared |
| `@jarenjs/josl/jsonx-stream` | JavaScript | declared |
| `@jarenjs/josl/csv` | JavaScript | declared |
| `@jarenjs/josl/csv-stream` | JavaScript | declared |
| `@jarenjs/josl/values` | JavaScript | declared |
| `@jarenjs/josl/schemas/jaren-josl-data.schema.json` | schema | — |
| `@jarenjs/josl/package.json` | metadata | — |
<!--/fact-->

What each subpath carries:

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
| `@jarenjs/josl/csv` | `parseCsv`, `parseCsvDocument`, `stringifyCsv`, `sniffCsvDialect` |
| `@jarenjs/josl/csv-stream` | `createCsvStreamReader`, `parseCsvStream`, `iterateCsvStream`, `createCsvStreamWriter` |
| `@jarenjs/josl/values` | `LocalDate`, `LocalTime`, `LocalDateTime` |
| `@jarenjs/josl/schemas/*` | schema artifacts (`jaren-josl-data.schema.json`) |

## CSV

The same machine shape as JOSL, applied to the format the world exports
by accident: one grammar path, wholesale and streaming, and a reader that
tells you what it had to fix.

```javascript
import { parseCsv, parseCsvDocument, stringifyCsv } from '@jarenjs/josl/csv';
import { createCsvStreamReader, iterateCsvStream } from '@jarenjs/josl/csv-stream';

parseCsv('a,b\n1,2');                     // [['a','b'], ['1','2']]
parseCsv('a,b\n1,2', { headers: true });  // [{ a: '1', b: '2' }]

// rows as they complete, without ever holding the table
for await (const row of iterateCsvStream(response.body, { headers: true, signal }))
  await save(row);

// and the other way: pull records from a cursor into CSV lines, header once
response.body = stringifyCsvStream(store.collection('rows').query(doc), { signal });
```

`stringifyCsvStream` is byte-identical to `stringifyCsvChunks` and
`stringifyCsv` for the same records and pulls one record per line, so the
source is never asked for a row the consumer has not asked for; `signal`
aborts between pulls, and an abort, an early return or a throw closes the
source exactly once. The reader's `signal` does the same for
`iterateCsvStream`. The hostile-input limits (`maxTotalBytes`,
`maxRecordBytes`, `maxFieldBytes`, `maxColumns`, the `CSV2xxx` codes) are
listed under Streaming.

**Strict by default.** Anything RFC 4180 forbids throws a
`CsvSyntaxError` carrying a `CSV1xxx` code, a line and a column — the
same machine-repairable error shape the JOSL parser uses.

**`repair: true` heals instead, and says so.** Every repair lands in a log
with the same code the strict error would have carried, so moving between
the modes never means re-learning the diagnosis:

```javascript
const doc = parseCsvDocument('a,b\n"he said "hi" ok",2\n', {
  repair: true, headers: true,
});
doc.rows;    // [{ a: 'he said "hi" ok', b: '2' }]
doc.repairs; // [{ code: 'CSV1003', line: 2, column: 10, message: … }, …]
```

| code | condition | how it is read |
| --- | --- | --- |
| `CSV1001` | a quoted field is never closed | close it at the end, keep the text |
| `CSV1002` | text after a closing quote | the field closed; absorb the stray text |
| `CSV1003` | an unescaped quote inside a quoted field | the quote is literal |
| `CSV1004` | a record shorter than the header | the columns stay **absent**, not empty |
| `CSV1005` | a record longer than the header | widen the header once |
| `CSV1006` | a bare carriage return | it ends the record (old-Mac endings) |
| `CSV1007` | a duplicate header name | suffix it (`a`, `a_2`) |
| `CSV1008` | an empty header name | name it (`column_3`) |

`CSV1002` and `CSV1003` are the same damage read two ways, and the reader
decides between them by looking for another quote before the next
delimiter. `"he said "hi" ok"` keeps its text; `"abc"junk,d` keeps its
**column count**, because a consumer indexes by column and a lost
boundary corrupts every field after it.

A short record leaves its missing columns absent rather than empty:
reading `undefined` says *this record did not carry the column*, where
`''` would claim it carried an empty one.

**Dialect sniffing.** `delimiter: 'auto'` scores each candidate by how
consistently it divides records — a real separator splits every record
the same way, a coincidental one splits them arbitrarily. Header
detection asks whether the first record looks unlike the rest, and
answers *no* when the table is text all the way down, because inventing a
header there would silently eat a data row.

**Typed values are the package's, not JSON's.** `typed: true` promotes an
integer past 2^53 to a **bigint** instead of rounding it, reads ISO dates
as the same `LocalDate`/`LocalDateTime` a JOSL document yields, and
leaves `007` a string — a zero-padded id does not survive becoming a
Number. A quoted cell is never coerced: the quotes are the author saying
this is text.

### CSV compliance & speed

`npm run benchmark:csv` scores the reader on
[csv-spectrum](https://www.npmjs.com/package/csv-spectrum), the de-facto
acceptance corpus, and on a scorecard of damaged documents.

<!--fact:csv.table-->
| engine | csv-spectrum | 10k×6 plain | 10k×3 quoted | 1k×50 wide |
| --- | --- | --- | --- | --- |
| **jaren** | **11/11** | 2.2 ms | 3.0 ms | 1.3 ms |
| udsv | 11/11 | **1.8 ms** | **2.9 ms** | **1.0 ms** |
| papaparse | 11/11 | 5.8 ms | 7.5 ms | 2.1 ms |
| csv-parse | 11/11 | 17.7 ms | 11.9 ms | 11.0 ms |
| d3-dsv | 11/11 | 2.9 ms | 3.9 ms | 1.7 ms |
| @vanillaes/csv | n/a | 5.9 ms | 7.3 ms | 4.6 ms |
<!--/fact-->

(The suite's twelfth fixture, `location_coordinates`, is excluded: its
expectation is a bare object where every other case is an array, its
phone number disagrees with its own CSV, and its degree sign is already
U+FFFD in the source bytes. No parser can satisfy it.)

**udsv is the honest loss: ~1.3× on the plain record stream, ~1.15× on
quoted, and ~2× when records become header-keyed objects.** It earns it —
udsv compiles a parser per schema with `new Function`, so each record
object is built with literal keys the engine can inline-cache, where this
reader assigns computed keys one by one. This package does not use
codegen, anywhere, by house rule: everything here runs under a strict
Content-Security-Policy, where runtime codegen is unavailable. That is
the same trade the schema validator and the query engine make, and it is
a trade rather than an excuse — against every parser that also avoids
codegen, jaren leads.

The plain-field scanner finds each cell end as the minimum of three
lazily-cached `indexOf` cursors (delimiter, LF, CR), so the source is
scanned by the engine's substring search rather than one character at a
time. Streaming is structurally a second walk — a chunk may stop
mid-field, so `feed` runs a side-effect-free cutter before the parser —
but the cutter cuts by the same substring search wherever no quote lies
ahead, and on the plain record stream the whole streaming read now costs
about 1.1× the wholesale path (2.1 ms vs 1.9 ms), level with udsv's
chunked reader.

Stringify leads everything that offers one: 3.6 ms against papaparse's
6.1 ms and d3-dsv's 4.1 ms.

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
   semantic rules above), and 3000 seeded derivations across both modes all parse.
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

Stringify leads: 2.5 ms against smol-toml's 2.7 ms and `@iarna/toml`'s
6.9 ms on the same document. The writer keeps its error path on a
mutable stack instead of allocating per key, emits each section header
from its parent's already-formatted prefix, and copies unescaped string
runs whole.

## Status

Published alongside the rest of the suite. Both constrained-decoding
twins ship — the JSON-Schema one over the data model and the GBNF one
over the text — along with the CST mode, progressive `text-partial`
events and single-walk whole-document parsing.
