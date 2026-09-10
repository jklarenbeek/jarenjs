# Structural collection providers

A provider is a host-injected service. Presentation code consumes its shape;
storage code never imports app or components. Rows, cursors and handles stay
private to the provider. App state carries JSON intent and bounded observations.

## Database adapter

```js
import { createDbRangeProvider } from '@jarenjs/linq/db';

const provider = await createDbRangeProvider(store, 'Row', {
  orderBy: '$it.rank'
}, { keys: ['id'], maxRows: 256, maxBytes: 262144 });
try {
  const reply = await provider.request({
    generation: 1, requestId: 'first', query: provider.query,
    snapshot: provider.snapshot, range: { start: 0, end: 20 },
    credits: { pages: 1, rows: 20, bytes: 65536, work: 20 }
  }, signal);
  // Publish only if all echoed identities still match current intent.
  consume(reply);
} finally { await provider.dispose(); }
```

`handle.range(spec, options)` is the same adapter. Open the root store with
committed capture enabled; create the provider from that root, outside a scoped
transaction. The adapter currently supports captured hybrid entity roots.
Adopted physical capture and physical keyset paging remain refused.

`keys` names distinct stable logical key members. Compound keys are canonical
JSON tuples; single keys are strings. Keys must exist and be unique in returned
rows. A load spec supplies filter/order; the provider owns take/skip/after and
serves root rows without includes. The spec is cloned on construction.

## Identities and outcomes

Query identity includes source, entity, filter/sort, keys, schema version and
profile. `source` defaults to a host UUID; custom `query`/`source` strings must
uniquely identify that source configuration and provider lifetime. Snapshot
identity is the source epoch, incremented by committed capture or a changed
database data-version detected at request time. It is not a durable MVCC token.
External writers are detected on the next request, not polled continuously.

Request generation fences superseded client work; it is never a source snapshot.
Every reply echoes generation, requestId, query and snapshot. The latest admitted
request supersedes earlier replies, including requests within the same generation.
Callers must also fence publication against their current intent.

A request supplies a half-open `range: { start, end }` or opaque `continuation`,
and nonnegative safe-integer page/row/byte/work credits. Cancellation is the second
argument, an injected `AbortSignal`, never a JSON member. Outcomes are:

| State | Meaning |
|---|---|
| `ready` | Stable keys, frozen rows, echoed identities, continuation and total are available. |
| `invalidated` | Query, snapshot, continuation or request identity became stale; start from current source identity. |
| `budget-exhausted` | Admission or result exceeds finite credits; nothing may be published as complete. |
| `error` | Invalid input, unsupported seek, cancellation, disposal or source failure. |
| `loading` | Reserved structural state; this promise-based adapter resolves terminal outcomes. |

`total` is `{ kind: 'known', value }` or `{ kind: 'unknown' }`; loaded row count
never means logical total. Sequential mode offers continuation, live resets and
unknown total, with no index/key seek or complete export. A nonzero initial index
refuses `reason: 'unsupported-seek'` without scanning. Full pages use an unknown
continuation sentinel; a later empty page proves exhaustion, without a hidden
lookahead row. Continuations are private, bounded and may expire by eviction.

Opt-in `resident: true` first reads one complete source, bounded by `maxRows` and
`maxBytes`, then offers index seek and exact total (`seekIndex: false` and
`exactTotal: false` can withhold them). Oversize initialization fails and cleans up.
It never presents a truncated source as complete. A source reset discards the
resident rows and the next request must requalify the complete bounded source.
That request must reserve at least `maxRows + 1 + requestedLength` work credits
before the refill starts; otherwise it returns `budget-exhausted` without reading.

## Resources, events and lifecycle

Defaults are 256 source/page rows, 262144 bytes, 4 retained continuation handles,
2 in-flight requests and 8 subscriptions. All bounds are positive safe integers.
Per-request `used` reports pages, returned rows/bytes and consumed root work,
including a row consumed at a byte boundary and any resident refill plus slice.
The provider conservatively reserves array punctuation for the full requested
length before reading; a near-limit partial page can therefore refuse early.
`stats()` separately reports source reads/rows/bytes, resident storage, retained
handles, pending requests and subscriptions. SQL visited rows and internal database
allocations are unavailable; these credits measure admitted application work.
Source bytes count consumed root payloads, including an item refused at the byte
boundary. `page(..., { lookahead: false })` exposes these counts as `work: { rows,
bytes }`; default pages preserve their existing shape and one-row lookahead.

`subscribe(fn)` returns an unsubscribe function. Events carry monotone revision,
query/snapshot and explicit `type: 'reset'`, with source capture qualification.
These events do not imply incremental keyed maintenance. Keyed insert/update/
delete/move events are reserved for sources that independently prove them.

`dispose()` stops admission, unsubscribes, cancels and drains pending requests,
clears rows/handles and fences late callbacks. It is idempotent. A provider must
be disposed before closing its store.

One host coordinator owns finite prefetch, request and page/byte credits; one
component owns DOM/cell/pin and measurement credits. Selection is stable-key or
query/snapshot-scoped intent with exclusions. The authoritative mutation rechecks
membership and revision. Focus/scroll restoration carries key, offset and query
identity, plus a declared fallback when the key disappears. Complete print/export
requires a separate bounded stream over a declared complete snapshot; mounted
rows cannot prove completeness. Sequential mode declares `completeExport: false`; bounded resident mode supplies the complete snapshot stream described below.

## App coordinator and resident arrays

`createArrayRangeProvider(rows, options)` creates an immutable resident source copy
and key index. This full source remains resident, and `stats().rows/bytes` reports
it honestly. `keyOf` defaults to the string form of `row.id`. Query/source identities
default to a new host UUID; `runtime`, `source`, `query` and `snapshot` can be
injected. Explicit query identities must distinguish source, ordering/filter and
relevant profile/schema versions. `replace(rows,newSnapshot)` requires a new source
identity, increments event revision and resets cursors. Return values are copied
so consumers cannot mutate the source snapshot. `indexOf(key)` uses the resident
index. `seekIndex:false` and `exactTotal:false` exercise restricted capabilities.

`createCollectionCoordinator(provider, options)` privately owns cancellation,
generation/request fencing and caches. Defaults: 64 rows/page, 4 cached pages,
256 cached rows, 262144 cached bytes, 2 in-flight requests, 256 work credits/request,
one simultaneous output (`maxOutputs`), eight subscribers (`maxSubscriptions`),
and zero prefetch pages. `prefetchPages` is finite, below the page limit and clamped
to row credits. `requestRange({start,end},signal)` refuses oversized ranges before
source work. Every response must echo all four identities and fit row/byte/work
credits before it can publish. A provider that ignores cancellation still cannot
replace current rows. Source events need a monotone integer revision; this
coordinator treats keyed events conservatively as reset rather than claiming
incremental maintenance. `reset` fences old work and clears cached resources.

`observation()` and `subscribe` expose JSON query/snapshot/generation, status,
logical total and bounded loaded row/byte counts. `rowAt`, `keyAt` and `indexOf`
access private cache rows. `logicalCount()` returns the known total, or the loaded
frontier plus a continuation sentinel; it never manufactures a known total.
`next(signal)` requests the next sequential page. A sequential source refuses
arbitrary jumps as `unsupported-seek` without scanning. `pinKeys(keys)` protects
editor pages within existing page/row/byte limits; an impossible admission returns
`budget-exhausted / pinned-page-credits`. `stats()` separately reports cache pages,
rows/bytes, in-flight requests and outputs. By default async `dispose` drains both
the coordinator and provider; `disposeProvider:false` retains host ownership.

## Transactional export and print sinks

Complete sources expose `export({query,snapshot,pageRows,pageBytes},signal)` as an
async iterable. Each page is `{state:'ready',query,snapshot,rows,keys}`; the terminal
record is `{state:'complete',query,snapshot,total}`. The terminal count proves how
many source rows were read, independently of selection. A missing terminal record,
changed identity, byte/row overflow, cancellation or missing selected key/range
endpoint is an incomplete output and must not be reported as success.

The coordinator's `output(sink,{selection,signal,pageRows})` awaits `begin(identity)`,
serial `write(rows)` calls and finally `commit({query,snapshot,rows})`. Any failure
calls `abort(error)` and returns `error / incomplete-export`. The sink must stage
work privately and make it visible only at commit. It supplies its own finite
spool or streaming storage; building a whole output array is not implicitly
bounded. Backpressure is the awaited `write` promise. The same sink contract
supports printing a completed snapshot artifact. Disposal cancels and drains
outstanding output before clearing resources.

Arrays support complete output at their immutable snapshot. SQLite resident mode
also supports complete output over its already qualified bounded source; it checks
source data-version before and after export, and refuses a changed/unloaded epoch.
Sequential database mode continues to refuse complete export. The website download
sink has a finite spool, so an oversized output fails before creating a download.
