# Persisted lexical search

`@jarenjs/db/search` exports `createDbSearchStorage` and `createDbSearch`.
The adapter imports the same core ranker and JSON predicate compiler as resident
execution. `explain()` reports resident residual work and finite source credits;
SQLite/PostgreSQL native FTS is unqualified and is not substituted silently.

```js
import { createDbSearch, createDbSearchStorage } from '@jarenjs/db/search';
// The model declares an Item entity and a snapshots collection keyed by /id.
const storage = createDbSearchStorage(store, 'snapshots', { maxBytes: 8388608 });
const search = await createDbSearch(store, 'Item', {
  version: 1, fields: ['title', 'sku'],
}, { source: 'catalog', maxRows: 10000, maxBytes: 8388608, storage });
const page = await search.search('gren tea', {
  where: { $eq: ['$.available', true] }, facets: ['category'], limit: 20,
});
await search.dispose();
```

The source entity must expose a string `id`; reads order by that key to make cold
build order reproducible. The store must have committed capture. A complete
bounded source is read inside a store transaction, and its canonical JSON is
hashed by host WebCrypto SHA-256 into a source-backed revision. The digest includes
non-indexed fields, so changed filter/facet facts invalidate search results too.
Captured source writes issue resets. SQLite defaults to `revision: 'dataVersion'`,
which detects external-connection SQL on requests. PostgreSQL defaults to
`revision: 'capture'`, which requires a durable log and follows enrolled Store
commits across clients. `explain().revision` names the provider and
`explain().externalChanges` states its coverage; `nativeFTS` remains false.
A cold open reads the source again, so uncaptured edits while the adapter was
closed cannot validate a stale cache. A host without capture refuses freshness.

`revision: 'authoritative'` re-reads the bounded source on every refresh. For
external writers the host can inject `{ name, read(tx) }`: the token must be a
finite number or a string of at most 1024 characters, read using the supplied
transaction view. Tokens bracket the source read through the shared revision
snapshot validator. A changed token produces `invalidated` and preserves the
previous published revision; the next request tries again. A provider must
advance for every source change it promises to cover. Enrolled log revisions
do not promise arbitrary external SQL or trigger/cascade coverage. An
authoritative refresh discovers current content but cannot prove a stable
external multi-statement snapshot without a provider or host isolation contract.

`search(text, request)` refreshes a dirty source, compiles the request through
`createLexicalProvider`, then evaluates complete membership before result limits.
`refresh()` reports zero changes on identical input. `row(id, revision)` supplies
a detached authoritative row only under the current clean snapshot. `subscribe`
receives explicit resets, not a claim of incremental SQL maintenance. Up to eight
observers each retain one active callback and one latest reset; slow callbacks
cannot accumulate an unbounded queue. `stats().observerPending` reports those
credits. Unsubscribe/disposal drops pending delivery and isolates rejection. Refresh
rebuilds rank statistics from the complete bounded source; core incremental
updates remain available to other hosts. Source rows and index costs are separate
from a collection's page cache and mounted cells.

The optional storage collection holds `{id, payload}` derived snapshots. Publication
is one transaction, and equal payloads perform zero writes. Corruption, stale
source and incompatible configuration trigger a source rebuild. Failed storage
publication is reported and retried; an incomplete snapshot cannot count as a
successful publication. Storage can be the same store or another declared store.
It is never queried as a catalog. `stats()` reports reads, writes, restores,
rebuilds, recovery reasons and retained resources. Disposal unsubscribes, cancels
and drains in-flight reads, clears rows and indexes, and leaves store ownership
with the caller.

`createLexicalRangeProvider` from `@jarenjs/linq/db` composes this source with the
shared range provider. It requires complete membership within explicit match and
source-byte credits; a truncated top-k refuses construction. The adapter preserves
query and source identities, exposes exact counts only for complete membership,
and invalidates continuations after changes. Call `refresh()` after invalidation.
