---
package: "@jarenjs/josl"
card:
  title: JOSL, JSONX & CSV
  blurb: >-
    TOML 1.0 as a superset with JavaScript's obvious values first-class, the
    same extensions over JSON as JSONX, and a self-healing CSV reader — each
    with an incremental streaming reader whose chunks may split any token,
    all reporting one unified event with pointer-able paths.
engines:
  - key: josl
    suite: toml
    title: JOSL
    blurb: >-
      A strict TOML 1.0 superset with JavaScript-obvious values and
      streaming document-order events. The only engine in our benchmark
      passing the full toml-test suite — and the same reader family streams
      JSONX, strict JSON and CSV. Opt into detach and a record is handed
      over and forgotten, so a document larger than memory reads in a flat
      0.1 MB.
    perf: >-
      scored on the whole toml-test corpus
  - key: csv
    suite: csv
    title: CSV
    blurb: >-
      RFC 4180 strict by default, and self-healing on demand: an unclosed
      quote, a stray quote inside a value or a ragged row is read the way
      that loses the least — and every fix is reported with a code, a line
      and a column, where other parsers heal silently or reject the file.
      Wholesale and chunk-streaming share one grammar path.
    perf: >-
      reports what it repaired, instead of guessing quietly
---

### JOSL & JSONX

A strict TOML 1.0 superset with JavaScript's obvious values first-class — null,
bigint, regexp, all four datetime flavours — plus a streamable [[]] root array.
The parser passes the complete official toml-test suite in strict TOML mode,
consumes chunk streams that may split any token, and reports document-order
events with pointer-able paths.

```toml
# JOSL: TOML plus the obvious
id = 123n
pattern = /^ok$/i
missing = null

[[records]]
name = "streaming"
```

JSONX — the same extensions over JSON — streams too: `createJsonxStreamReader`
is an incremental reader whose chunks may split any token (escapes mid-\uXXXX,
numbers, tru + e), with a strict-JSON mode that makes it a streaming
JSON.parse. Both readers emit one unified pair event with absolute paths, so a
consumer never branches on syntax.

```js
import { createJsonxStreamReader } from '@jarenjs/josl/jsonx-stream';
const reader = createJsonxStreamReader({ mode: 'json',
  onEvent: (e) => e.type === 'pair' && console.log(e.path, e.value) });
reader.feed('{"run": [{"ops": 61');   // any split point works
reader.feed('200}]}');
reader.end();                          // { run: [{ ops: 61200 }] }
```

Feeding a document in chunks bounds the parse, not the result — the reader
still ends up holding everything it has read, which is the wrong answer for a
continent-sized FeatureCollection or a million-line log. `detach` names a path
pattern whose values are never linked into the tree: the completion event still
carries the whole record, so the consumer sees every one of them, but letting
go of the event lets go of the record. `root()` comes back holding the
document’s frame however many records went past.

```js
const reader = createJsonxStreamReader({
  mode: 'json',
  detach: ['features', '*'],        // '*' matches any one segment
  onEvent: (e) => {
    if (e.type === 'object-end' && e.path.length === 2)
      consume(e.value);             // a whole GeoJSON Feature
  },
});
for await (const chunk of fileChunks) reader.feed(chunk);
reader.end();  // { type: 'FeatureCollection', features: [] }
```

Measured on a synthetic OpenStreetMap-shaped extract of 20 000 features (`node
--expose-gc benchmark/jsonx-stream.js`): the default read peaks at 185.4 MB of
live heap and ends holding all 20 000, while the `detach`ed read stays under
0.1 MB and holds none — and that figure does not move at 80 000 features,
because the peak is the 64 kB feed buffer plus one feature at a time, not the
document.

**Try it.** [Play's JOSL engine](#/play?engine=josl) parses as you type and
shows how the document streamed — every event, in document order, with the path
it landed at.

### CSV

The same machine shape as JOSL, applied to the format the world exports by
accident. One grammar path serves both directions — `parseCsv` walks the source
once, and the chunk reader runs a side-effect-free cutter first because a chunk
can stop mid-field — so a document read in pieces and the same document read
whole produce identical rows.

```js
import { parseCsv, parseCsvDocument } from '@jarenjs/josl/csv';
import { iterateCsvStream } from '@jarenjs/josl/csv-stream';

parseCsv('a,b\n1,2');                     // [['a','b'], ['1','2']]
parseCsv('a,b\n1,2', { headers: true });  // [{ a: '1', b: '2' }]

// rows as they complete, never holding the table
for await (const row of iterateCsvStream(response.body, { headers: true }))
  await save(row);
```

Reading is strict by default: anything RFC 4180 forbids throws a
`CsvSyntaxError` with a stable `CSV1xxx` code, a line and a column. `repair:
true` reads the same damage the way that loses the least and logs it under the
SAME code, so moving between the modes never means re-learning the diagnosis.

```js
const doc = parseCsvDocument('a,b\n"he said "hi" ok",2\n', {
  repair: true, headers: true,
});
doc.rows;    // [{ a: 'he said "hi" ok', b: '2' }]
doc.repairs; // [{ code: 'CSV1003', line: 2, column: 10, message: … }, …]
```

Two of those codes describe the same byte read two ways, and the reader decides
by looking for another quote before the next delimiter: '"he said "hi" ok"'
keeps its text, while '"abc"junk,d' keeps its column count — a lost field
boundary corrupts every value after it, where a mangled cell corrupts one. A
record shorter than its header leaves the missing columns absent rather than
empty, because undefined says the record did not carry the column while an
empty string would claim it carried nothing.

`delimiter: 'auto'` sniffs the dialect by scoring each candidate on how
consistently it divides records, and calls a header row only when the first
record looks unlike the rest — a table that is text all the way down gives no
evidence, and inventing a header there would silently eat a data row. `typed:
true` uses the package value model rather than JSON's: an integer past 2^53
becomes a bigint instead of rounding, ISO dates become the same
LocalDate/LocalDateTime a JOSL document yields, and 007 stays a string.

> **Try it** — Play’s CSV engine opens on a deliberately broken document: flip
> mode from strict to repair to watch it parse anyway and list every fix with
> its code, line and column. [Open Play](#/play?engine=csv)
