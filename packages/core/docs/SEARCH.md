# Resident lexical search

`@jarenjs/core/search` is an opt-in, dependency-free index. It compiles a
versioned definition, owns resident postings and field statistics, and returns
ranked string IDs. It imports no database, AI engine, worker or DOM code.

```js
import { compileLexical } from '@jarenjs/core/search';
const lexical = compileLexical({
  version: 1, fields: ['title', 'sku'], prefix: true, fuzzy: 0.15,
  combineWith: 'AND', normalization: 'application-decoded-text/1',
});
const index = lexical.create();
index.rebuild([{ id: 'tea', title: 'Green tea', sku: '00120' }],
  { generation: 1, sourceRevision: 'catalog-revision-1' });
const result = index.search('gren tea', { limit: 20 });
index.dispose();
```

## Definition and compatibility

The definition is closed: `version`, `fields`, `profile`, `prefix`, `fuzzy`,
`combineWith`, `boost`, `normalization` and `limits`. Fields are distinct names;
documents carry a nonempty string `id` and string fields. Missing/null fields
index as empty text. Numbers are refused rather than silently stripping leading
zeros. Applications decode HTML before indexing and give that policy a stable
`normalization` identity. Changing this identity invalidates snapshots.

The default profile, `minisearch-7.2.0-cold`, uses lowercase UTF-16 text,
Unicode punctuation/separator plus CR/LF token boundaries, preserved accents,
and BM25+ with k=1.2, b=0.7 and delta=0.5. Tabs and symbols follow the reference
tokenizer, not a different whitespace tokenizer. Field lengths count distinct
unprocessed tokens. Query token repetitions add their score repeatedly, while
the final quality multiplier counts distinct query terms. Empty/punctuation-only
queries return a complete empty result. A numeric identifier remains text, but
prefix/fuzzy matching can deliberately include nearby identifiers; exact identifier
lookup should use `prefix: false, fuzzy: 0` or the authoritative row lookup.

Fuzzy distance is `min(6, round(queryToken.length * fuzzy))`, measured by
Levenshtein distance over UTF-16 units. Prefix expansion wins a fuzzy overlap.
Exact, prefix and fuzzy weights are respectively 1, 0.375 and 0.45, with the
reference's length/distance attenuation. Field `boost` values are finite positive
numbers. Term combination is `AND` or `OR`.

Equal-score results in the cold profile preserve first matching posting order
under the last AND term (first union occurrence for OR). Vocabulary prefix
traversal is reverse depth-first and fuzzy traversal is forward depth-first,
both derived deterministically from authoritative document order. An update
reconstructs these orders from the current documents, so it agrees with a fresh
build; this is deliberately independent of a reference engine's deleted-posting
history. Snapshots preserve the same ties. The retained reference's JSON reload
can change ties: this divergence is published, never silently normalized.
The explicit `lexical-key/1` profile instead breaks score ties by string ID.
It is a declared ordering choice, not cold-profile parity.

## Results and completeness

`search(text, options)` returns `state`, `hits: [{id, score}]`, `total`,
`hasMore`, `continuation`, `generation`, `sourceRevision`, `identity` and `used`.
`complete` certifies that the complete membership was evaluated; `limit` bounds
the returned page, and `total` still counts every matched, filtered document.
`budget-exhausted`, `invalidated` and `error` return no hits and `total: null`.
They never look like complete empty searches.

Options include `limit`, smaller `credits: {work, expansions, candidates}`,
`sourceRevision`, `filter(hit)`, `compare(a,b)`, `onMatch(hit)`, `query` and
`after`. Filtering and `onMatch` run before sorting and slicing, so counts and
facets do not filter a truncated top-k. A custom comparator changes ordering
only. Callbacks are trusted synchronous application code; their own CPU,
allocations and side effects are outside engine credits. A callback that mutates
or disposes the index invalidates the pending result before publication.

A continuation identifies the final score and stable ID plus exact text,
request identity, configuration and source revision. Supply it as `after`.
Changed identities or missing cursor members invalidate the request. Every page
re-evaluates the complete bounded membership; this is resident pagination, not a
claim of indexed seek performance. Query/host layers supply `query` for the
filter, facet and ordering identity. Never reuse it with different callbacks.

## Updates and resource credits

`rebuild(rows, identity)`, `update({put, remove}, identity)` and `clear(identity)`
prepare before publishing. Failures leave the published generation intact.
Lower generations invalidate; an equal generation with different content refuses.
Equal content and source revision is a no-op: zero changes, unchanged generation,
no additional postings and no tombstones. A higher source revision can publish
unchanged indexed text, allowing a change in non-indexed authoritative fields to
invalidate query results. Explicit generations are nonnegative safe integers.

`SEARCH_LIMITS` declares finite document, source-byte, retained-index,
temporary-byte, token/posting, vocabulary, field/token/query, candidate,
expansion, output and work ceilings. `stats()` reports retained document,
posting, vocabulary, source and accounted-index quantities. Accounted bytes
are a conservative logical allocation model; they are not measurements of a
JavaScript VM's heap or its garbage collector. Temporary reservations include
the old published index, staged documents/postings, vocabulary construction and
snapshot decoding. Credits are checked before publication; source/token-sized
temporary allocations are reserved before tokenization. No deleted content is
retained for later vacuuming.

`rebuildAsync(rows, {yield, signal, onProgress, ...identity})` and
`updateAsync(changes, request)` use the same transactional preparation, yields in bounded work batches, and fences cancellation
and superseded requests before publication. A single document or posting reorder
that cannot fit one batch refuses. `yield` must yield to the host's event loop
when responsiveness is required; resolving a promise alone does not do that.
An injected worker host additionally enforces its process/VM memory ceiling.
One index's logical limits cannot bound another index or a caller-owned catalog.

## Snapshots and ownership

`snapshot()` produces a JSON string in `jaren-lexical/1`. It contains an explicit
complete marker, exact configuration identity, source revision, generation,
ordered derived field text and stable ordinals. A content checksum detects
accidental corruption; it does not authenticate untrusted storage.
`restore(string, {sourceRevision, generation?})` validates before atomic
publication. Corruption, incompatible configuration, stale source, partial
format and allocation limits return `rebuild-required` with a reason. Restore
reconstructs postings through the same engine; it is not a zero-cost mmap load.
An identical second restore reports zero changes.

The authoritative source owns revision validation. An index snapshot is a
discardable derived cache, never a second catalog. The db adapter publishes it
atomically, and the app search resource owns an injected worker and drains it
on disposal. `dispose()` is idempotent, clears resident references, rejects new
work and fences unfinished builds.

## Measured qualification

Run `npm run benchmark:lexical` for isolated retained-reference and native
measurements over both frozen synthetic consumers. The runner compares complete
membership, scores, cold ties and native reload results for every labelled query.
It reports reference reload divergence and slower native paths beside gains.
Heap/RSS qualification belongs to the named Node host and its enforced heap
ceiling; browser layout and real consumer relevance are separate evidence.

<!--fact:lexical.measurements-->

Measured on v24.19.0, linux/x64, AMD Ryzen 9 5900HX with Radeon Graphics.

| Consumer / engine | Rows | Cold / warm ms | Query p95 ms | One update ms | Snapshot gzip bytes | Sampled heap / RSS high-water MiB | V8 heap ceiling MiB |
|---|---:|---|---:|---:|---:|---|---:|
| catalog / reference | 10000 | 130.99 / 50.10 | 11.97 | 0.45 | 370591 | 95.97 / 190.46 | 240.00 |
| catalog / native | 10000 | 203.59 / 201.37 | 10.89 | 63.60 | 121054 | 104.08 / 208.89 | 240.00 |
| archive-stock / reference | 75000 | 1124.97 / 578.43 | 168.33 | 0.55 | 2820312 | 559.14 / 697.04 | 752.00 |
| archive-stock / native | 75000 | 1500.68 / 1775.38 | 98.43 | 681.98 | 920811 | 579.94 / 726.00 | 752.00 |

| Consumer | Native logical index MiB | Peak update accounted MiB | Native teardown ms / remaining handles | Membership / order / score / native reload differences | Reference reload tie changes |
|---|---:|---:|---|---|---:|
| catalog | 24.58 | 35.37 | 0.04 / 0 | 0 / 0 / 0 / 0 | 1002 |
| archive-stock | 186.22 | 267.03 | 0.03 / 0 | 0 / 0 / 0 / 0 | 6002 |

Browser gzip: native 5606 bytes; reference 5874 bytes.

Separate Node processes, identical source rows and queries, five query samples each; startup includes source generation, cold build, snapshot and warm restore. An earlier unconstrained native run exceeded the larger corpus heap and RSS ceilings; the explicit host heap settings are required for this qualification. RSS is the OS process high-water mark; heap is sampled after operations. peakHeapBytes is the V8 hard heap ceiling (a conservative bound, not an observed peak); both engines run with the same max-old-space-size derived from the frozen heap budget, reserving 64 MiB for young space and explicitly limiting each semi-space to 16 MiB. Unconstrained GC is not a bounded host. Reference indexBytes is serialized JSON; native indexBytes is conservative logical retained allocation, so those columns are not the same metric. Both retain a cold and a restored index during query qualification.

Native build, reload and update costs exceed the reference; source-bound snapshots compress better. Cold tie compatibility deliberately differs from reference reload ordering. These synthetic results qualify the named bounded host, not downstream relevance or universal latency.

<!--/fact-->
