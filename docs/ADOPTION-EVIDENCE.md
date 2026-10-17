# Portable replacement evidence

The [frozen instrument](../test/adoption/manifest.json) remains the source of
synthetic inputs, original formula bytes, oracle versions and finite budgets.
Its historical pending flags describe the foundation measurement; this matrix
records the subsequently implemented public compositions. Actual application
cutover, real providers and manual acceptance remain pending. The library deliverable
is complete for the documented scope; the full adoption program remains pending.

<!--fact:adoption.final-->

Program disposition: **library-ready; adoption-pending**.

| Retained mechanism | Library | Portable consumer | Required host/operator evidence | Retirement |
|---|---|---|---|---|
| Domain SQL/private driver bridge | pass | pass | pending / pending | pending |
| Virtualizer | pass | pass | pending / pending | pending |
| Lexical search | pass | pass | pending / pending | pending |
| Trusted formulas/rules | pass | pass | pending / pending | pending |
| Provider adapters/domain ledgers | pass | pass | pending / pending | pending |

<!--/fact-->

The host/operator column combines required platform and manual evidence. Linux
Node/Bun executables and automated Chromium/Firefox/WebKit behavior are qualified
only as described below; they cannot fill missing native OS IME, assistive
technology, actual provider, saved-source or downstream acceptance cells.

The table below scopes the original physical SQLite adoption applications.
Managed SQLite/PostgreSQL application composition now has a separate
[capability, executable and recovery matrix](../packages/db/docs/POSTGRESQL.md).
It does not migrate these adopted physical files or retire their SQL automatically.

| Capability | Combined portable evidence | Remaining qualification |
|---|---|---|
| Relational adoption | Existing column-only catalog, renamed archive columns and composite identity; unchanged schema, original bytes, settings and trigger histories across reopen | Arbitrary schemas, PostgreSQL, power-loss durability and actual downstream files |
| Native queries | Public mapped reads and updates; no domain SQL or private driver bridge in the adopted application | Unkeyed history stays an independent read-only SQL oracle; broader algebra retains its refusals |
| Collections | Reusable coordinator, virtual grid and stable review selection across pages | Physical devices, assistive technology and native OS input methods |
| Lexical search | One core ranker over an explicitly refreshed authoritative snapshot; bounded displayed results and original identifier strings | Adopted triggers have no qualified live capture; native FTS and real relevance corpora remain unqualified |
| Formulas and rules | Native draft/save/preview; current-row, authority and schema checks inside the receipt transaction; original-preserving translation with positioned reasons and differences, and no-op repeat | Untranslatable and disabled original sources retain their status and the trusted oracle |
| Providers | Complete offline REST and GraphQL snapshots, preserved observations, atomic publication and identical-input no-op | Actual destination authority, credentials, read-back and provider-platform behavior |
| Durable operations | Existing queue without startup DDL, permanent receipt replay, reviewed two-leg intent, abrupt termination after remote success, fenced reconciliation and original run recovery | Real remote delivery guarantees and operator approval for downstream retirement |

The catalog and archive-stock applications use the unchanged full source
workloads. Archive-stock changes physical column names, uses a composite key,
speaks GraphQL and refuses writes under its report-only policy. Query/search
loads a finite source snapshot separately from the collection page cache.
Provider snapshots and rule previews have their own smaller limits: the journey
does not claim that its preview or ingestion processes the entire search corpus.
The range source holds the complete bounded search membership; only the
coordinator's credited pages enter its cache. Loaded pages never stand in for
the logical total.

The application host is
[`examples/adoption.js`](../packages/website/src/examples/adoption.js).
[`adoption-model.js`](../packages/website/src/examples/adoption-model.js) declares
product fields and policy. Its seed fixture creates a synthetic existing file
before adoption; SQL used to construct and independently inspect that fixture
does not enter the adopted host. The existing db transaction owner, core lexical
engine, JSON formula evaluator, contract command/provider and flow/job engines
implement the shared mechanisms. The application keeps its authorization,
field mapping, arithmetic, saved-source resolution and read-back policy.

## Executable host evidence

```sh
node --no-warnings=ExperimentalWarning --test 'test/adoption/*.test.js'
node scripts/check-adoption-journeys.js
node scripts/check-adoption-journeys.js --native-only
npm run test:packed
npm run site:gate
```

The standalone gate builds a Bun executable and a Node single-executable
application, removes source files and module lookup paths, and runs both from
an isolated directory. The Node build uses the pinned postject injection tool
through npm exec; it is build tooling, not a package runtime dependency. These
are Linux executable proofs, not claims for every operating system or native GUI.
See the [Node executable construction contract](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html).

Each runtime executes both full workloads and an additional bounded catalog
process-termination fixture. The latter exits after the second synthetic remote
success, before local settlement, and then reopens the same file. The remote
journal must remain unchanged through reconciliation and subsequent verification.
Independent inspection hashes all original item fields, checks original BLOB
bytes and history, and compares the complete physical schema. Replayed commands,
migration, ingestion and reconciliation assert zero reported changes and zero
effective writes; adopted startup asserts zero DDL.

The installed gate copies the same application and assertions into a directory
containing only tarball package closures. It runs Node and Bun without repository
source imports. The browser journey at `#/collection?mode=adoption` uses the
same host and reusable components with SQLite session storage. Chromium,
Firefox and WebKit exercise draft editing, review across pages, receipt replay,
ingestion, interruption after remote success, reconciliation, reopen and
navigation disposal. Offline page reload is qualified with the site's server
really gone on Chromium, Firefox and the Linux Playwright WebKit build; Chromium
and Firefox additionally emulate offline. Playwright's WebKit offline emulation
fails a request before the page's service worker can answer it, so that build
takes the real outage alone; the website README records the reduced case.
Offline navigation in a shipping Safari remains pending. Session storage preserves this tab's database through
reload; closing the tab is outside that persistence contract.

## Combined cost and source ownership

```sh
node benchmark/adoption.js --combined --write
npm run docs:derive
```

<!--fact:adoption.combined-->

| Host | Consumer | Rows | Journey ms | Search startup ms | Heap MiB | Peak RSS MiB | Second writes |
|---|---|---:|---:|---:|---:|---:|---:|
| node | catalog | 10000 | 744.38 | 314.90 | 86.30 | 266.68 | 0 |
| node | archive-stock | 75000 | 3905.88 | 2449.89 | 316.83 | 860.33 | 0 |
| bun | catalog | 10000 | 596.99 | 243.54 | 67.83 | 267.33 | 0 |
| bun | archive-stock | 75000 | 3030.18 | 1826.38 | 331.47 | 996.11 | 0 |

Retained reference adapters: 105 lines; adopted application policy: 196 lines. Third-party search/virtualization mechanisms in the application: 2 → 0.

node/catalog: 0 measured budget losses. node/archive-stock: 0 measured budget losses. bun/catalog: 0 measured budget losses. bun/archive-stock: 0 measured budget losses.

<!--/fact-->

The [combined report](../benchmark/adoption-journey-result.json) records source
hashes, the exact rg source/import census, work and resource observations,
wire requests and each unchanged budget comparison. Reference-adapter line
counts describe retained test implementations; application-policy line counts
describe the new composition. They are not a claim that those oracle files were
physically deleted. The qualified application imports no MiniSearch,
virtual-core, trusted formula runner or private SQL driver bridge. The oracles
remain executable for regression comparison, and unresolved originals prevent
general trusted-runner retirement.

Source snapshot reads, compilation, validation, receipts and durable evidence
have real costs. The focused [formula](../benchmark/formula-result.json),
[provider](../benchmark/providers-result.json), [durable](../benchmark/durable-result.json),
[lexical](../benchmark/lexical-result.json) and [collection](../benchmark/collection-result.json)
reports retain their measured wins, losses and qualification boundaries.
Combined search startup includes the database read, content hash and index;
the historical reference index timing alone is a different workload. Heap is a
sample and RSS is a process high-water mark including assertion instrumentation.
The exact instantaneous peak heap remains unmeasured; the largest live set at the
journey's phase boundaries is reported [separately](#combined-live-set-and-remaining-handles).
No benchmark raises a frozen ceiling.

The [memory observation history](../benchmark/adoption-memory-history.json)
retains an earlier Bun archive-stock peak-RSS loss of 1,413,287,936 bytes against
the unchanged 1,073,741,824-byte ceiling. An unchanged-source repeat measured
999,518,208 bytes; two runs after serializing Store setup measured 1,019,547,648
and 1,012,097,024 bytes. Every workload runs in a fresh child, excluding carryover
of the catalog process's high-water mark. The assertion instrument retains full
rows, search membership and preview copies, so these values are broader than
library-only allocation. The unchanged-source pass prevents attributing the
improvement to startup serialization. Allocator/GC causality and exact peak heap
remain unmeasured; these passing repeats qualify the observation without proving
a general memory guarantee or removing the earlier failure.

After the opening retry correction, the complete combined workload measured
Bun archive-stock RSS at 1,012,051,968 bytes and passed all 20 unchanged
resource checks. The separate native-host run measured its Bun executable at
1,064,697,856 bytes. The history retains both complete native-host reports,
including the earlier executable peak of 1,078,005,760 bytes, which exceeded
the same 1,073,741,824-byte ceiling. These observations do not establish a
causal memory improvement from changing startup retries.

### Combined live set and remaining handles

```sh
node benchmark/adoption-resources.js --write
npm run docs:derive
```

The Node and Bun source hosts run each full workload once more, in a fresh
process whose only instrument is the
[resource entry](../benchmark/adoption-resources-entry.js), so no forced
collection lands inside a timed region: the timings, sampled heap and RSS above
come from the uninstrumented run, and the instrumented journey must return the
same search hash. The live set is `process.memoryUsage().heapUsed`
after two forced full collections (`gc()` under Node's `--expose-gc`,
`Bun.gc(true)` under Bun); without a collector the run refuses rather than read
a raw heap. It is taken at the journey's own phase boundaries: once the modules
load, after the frozen rows are generated, after the existing file is seeded,
after each application open, after every awaited application call the journey
makes (`migrateSaved`, `query`, `saveRule`, `rows`, `preview`,
`command.execute`, `ingest`, `prepare`, `runner.run`, `close`) and after
teardown. The peak is the largest of those samples. It is a lower bound on the
instantaneous peak, because a live set inside one application call is not
observed, and it includes the journey's own assertions, as the timed run does.
The sampled heap in the comparison counts garbage not yet collected and so can
exceed the live-set peak; neither value stands in for the other.

Remaining handles are read with `process.getActiveResourcesInfo()` after
teardown and one `setImmediate` turn, less the list taken before the workload
once the standard streams are open (the report is written to one, and loading
`node:assert` opens the other), counted as a multiset. That list omits
unreferenced timers and handles, so one of those is neither listed nor counted;
it does list the pipes of the standard streams, which do not hold the loop
open, so the baseline is taken after they are opened. A second check asks
whether the loop then drains (`beforeExit`) before an unreferenced 1 ms timer
fires; a loop that stays alive counts at least one remaining handle even when
the list is empty. Bun returns an empty list even with a listening server and a
pending timer, so its count rests on the drain check alone: it can show zero or
at least one, never which resource remains.

<!--fact:adoption.resources-->

| Host | Consumer | Rows | Boundaries | Peak live MiB | Peak after | Live after teardown MiB | Listed after teardown, less baseline | Loop drained | Remaining handles |
|---|---|---:|---:|---:|---|---:|---|---|---:|
| node v24.20.0 | catalog | 10000 | 35 | 58.06 | runner.run | 29.80 | none | yes | 0 |
| node v24.20.0 | archive-stock | 75000 | 26 | 265.14 | query | 49.20 | none | yes | 0 |
| bun 1.4.2 | catalog | 10000 | 35 | 52.08 | runner.run | 17.18 | none | yes | 0 |
| bun 1.4.2 | archive-stock | 75000 | 26 | 290.23 | query | 36.83 | none | yes | 0 |

node/catalog: 0 measured budget losses. node/archive-stock: 0 measured budget losses. bun/catalog: 0 measured budget losses. bun/archive-stock: 0 measured budget losses.

<!--/fact-->

These are the Linux source hosts. The standalone executables and other
operating systems have no live-set or remaining-handle measurement.

## Retained reference costs

```sh
node benchmark/adoption.js --write
npm run docs:derive
```

<!--fact:adoption.reference-->

Reference-only measurements on v24.20.0, linux/x64, AMD Ryzen 9 5900HX with Radeon Graphics.

| Consumer | Rows | Cold index ms | Reload ms | Worst query median ms | Sampled heap MiB | Peak RSS MiB | Search gzip bytes | Grid gzip bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| catalog | 10000 | 169.51 | 65.05 | 14.11 | 147.04 | 300.51 | 5873 | 7053 |
| archive-stock | 75000 | 970.36 | 479.46 | 88.96 | 972.80 | 1153.14 | 5873 | 7053 |

catalog: 21 measured limits met, 0 losses, 7 pending measurements. archive-stock: 19 measured limits met, 2 losses, 7 pending measurements.

<!--/fact-->

Reference search/grid costs measure the retained packages; mounted DOM and
provider caches belong to native/browser fixtures. The larger historical
reference exceeds its memory ceilings. MiniSearch cold and JSON-reload tie
orders differ; the native cold profile preserves its documented deterministic
order on reload. This is an explicit compatibility boundary, not a silently
adjusted expected result. Formula references are static trusted modules with
byte-identical stored originals; disabled malformed sources never execute.

## External acceptance

No actual downstream, provider-platform, assistive-technology or native-input
acceptance is supplied by these synthetic runs. Any later attachment must name
its anonymous fixture/profile, build revision, actual host, exercised behavior,
result and reviewing operator separately. Missing evidence remains pending;
passing another host cannot fill that cell. No customer identity, private path,
credential or production data belongs in public evidence.

## Request disposition ledger

Each original request has one accountable public owner below. “Implemented”
means the bounded library contract and synthetic portable composition; “narrowed”
keeps an unproved part of the original request open. The remaining work column
is preserved in [the open roadmap](ROADMAP.md). The evidence links are executable
fixtures or public contracts, independent of any private notes or checkouts.

| Request | Accountable owner | Final library disposition and matching evidence | Remaining intent |
|---|---|---|---|
| Native list and grid virtualization | `core/virtual` | Implemented: [fixed](../test/core/virtual.test.js), [measured](../test/core/virtual-measured.test.js) geometry and [grid](../test/collection/grid.test.js) | Segmented logical scrolling beyond CSS extent |
| Accessible virtual collection interaction | `collection/component` | Narrowed: [keyed keyboard/focus interaction](../test/collection/interaction.test.js) and [browser collection](../packages/website/e2e/collection.spec.js) | Physical devices, AT and native OS IME |
| Virtual views over bounded providers | `app/collection` | Narrowed: [coordinator/provider](../test/collection/provider.test.js), [db ranges](../test/linq/db-range.test.js), [lexical ranges](../test/linq/search.test.js) | Complete sequential DB snapshots, physical capture and arbitrary index seeks |
| Introspection outside model vocabulary | `db` | Narrowed: [physical inventory](../test/db/physical-inventory.test.js) and [loss reports](../test/db/introspect.test.js) | Lossless declarations for arbitrary SQL programs and PostgreSQL parity |
| Existing schemas without a document column | `db` | Implemented: [physical layouts/codecs](../test/db/physical.test.js), [model pen](../test/linq/physical.test.js), [keyset pages by integer, bigint, text and uuid keys](../test/db/physical-page.test.js) | Broader relation navigation |
| Declarative persistence invariants | `db` | Narrowed: [rules, keyed probes, revisions and audit effects, judged alike by the store and the database](../test/db/invariants.test.js), one oracle with [PostgreSQL](../test/db/postgres-invariants.test.js) | Arbitrary trigger programs, probes beyond a keyed row or of the rule's own table |
| One public transaction owner | `db` | Implemented: [SQL/entity/outbox ownership](../test/db/transaction-ownership.test.js) | Downstream owner/lifetime qualification |
| Native legacy query and mutation authoring | `db` | Narrowed: [read census](../test/db/adoption-sql.test.js), [mutation/no-op/rollback](../test/db/adoption-mutations.test.js) | Unkeyed history retains SQL; broader algebra/codec/dialect shapes refuse |
| Physical preservation and recovery | `db` | Narrowed: [preservation](../test/db/physical-preservation.test.js), [recovery](../test/db/relational-recovery.test.js) | Power-loss, bounded Bun backup, PostgreSQL and downstream files |
| Compiled lexical contract and resident index | `core/search` | Implemented: [ranking and identifier semantics](../test/core/search.test.js) | Actual labelled relevance corpus |
| Incremental search and durable index lifecycle | `db/search` | Implemented: [incremental kernel](../test/core/search-incremental.test.js), [persistence](../test/db/search.test.js), [worker disposal](../test/app/search.test.js) | Application-trigger capture and broader host resource qualification |
| One resident/database search meaning | `json/query` | Narrowed: [lexical provider](../test/adoption/lexical.test.js), [database adapter](../test/linq/search.test.js) | Native FTS; retained reload tie differences remain explicit |
| Versioned saved formulas | `json/formula` | Implemented: [profiles and refusals](../test/json/formula.test.js) | Application helper/result policies |
| Bounded per-record outcomes and dependencies | `json/formula` | Implemented: [batch outcomes](../test/json/formula-batch.test.js), [workers](../test/app/formula.test.js) | Actual saved corpus and host budgets |
| Migration from trusted JavaScript | `json/formula/migrate` | Narrowed: [translation with positioned reasons and differences](../test/json/formula-translate.test.js), [acceptance corpus and parity](../test/json/formula-corpus.test.js), [original-preserving repeat](../test/json/formula-migration.test.js) | Loops, throws, mutation, unproven callbacks, regular-expression captures and patterns outside the translated subset stay untranslatable with a named reason; trusted oracle retained |
| Reusable reviewed rules and authoring | `json/rules` | Implemented: [review plans](../test/json/rules.test.js), [installed review transaction](../test/consumer/journey.js) | Real source resolution and manual UI acceptance |
| Reusable provider execution policy | `core/retry` | Implemented: [attempt/scheduler/retry policy](../test/contract/provider-policy.test.js) | Qualification of actual SDK single-attempt transports |
| Protocol descriptors and complete ingestion | `flow` | Implemented: [dialects](../test/contract/provider-protocol.test.js), [complete staging/publication](../test/db/ingest.test.js) | Real providers; media, bulk and upload protocols refuse |
| Destination authority and private resources | `contract/provider` | Implemented: [current authority and release](../test/contract/provider-authority.test.js), [workflow resources](../test/flow/provider-resources.test.js) | Actual credentials, membership, destinations and restoration |
| Durable business receipts | `contract/command` | Implemented: [validated settlement](../test/contract/domain-command.test.js), [retention and migration](../test/db/receipt-retention.test.js) | Downstream historical mapping, hash versions, retention and transaction policy |
| External reconciliation on existing jobs | `flow` | Implemented: [fenced intent and decisions](../test/db/external-effects.test.js), [terminated-process recovery](../scripts/check-adoption-journeys.js) | Provider-specific absence/read-back/retention guarantees and operator decisions |
| Run adoption, observation and audit | `linq/db` | Implemented: [existing run engine](../test/flow/run-adoption.test.js), [bounded observation](../test/app/runs.test.js) | Historical statuses, public summaries, upgrade/reset/cancel and host policies |
| Reproducible replacement evidence | Repository evidence tools | Implemented: [installed journeys](../test/consumer/journey.js), [final comparison](../test/adoption/program-evidence.test.js) | All real downstream/platform/manual retirement decisions remain pending |

### Selected older clauses and reserved work

| Older clause | Accountable owner | Final disposition and evidence | Preserved remainder |
|---|---|---|---|
| SQL pushdown, projection/distinct | `db` | Narrowed to [native shapes](../packages/db/docs/NATIVE-PLANS.md) and [projection tests](../test/db/plan-projection.test.js) | Non-reconstructible trees and broader algebra |
| Incremental live queries | `db` | Narrowed to [qualified live strategies](../packages/db/docs/LIVE-FORMAT.md) and [range resets](../test/linq/db-range.test.js) | None open: entity windows, nested self joins and the other shapes that re-run are the [re-run contract](../packages/db/docs/LIVE-FORMAT.md#7-live-queries-the-maintenance-table) |
| Introspection losses | `db` | Inventory repaired; [losses remain explicit](../test/db/physical-inventory.test.js) | A loss is never permission to drop a physical object |
| Replication capture/cascades/snapshots | `db` | Adopted-trigger refusal preserved in [combined assertions](../test/consumer/journey.js); [replication contract](../packages/db/docs/REPLICATION-FORMAT.md) | None open: causal compaction and independent field merges are [replication limits](../packages/db/docs/REPLICATION-FORMAT.md#limits) |
| Interval declaration and overlap seeks | `db` | Cross-member enforcement supplied by [invariants](../test/db/invariants.test.js) | Dedicated interval declaration/index/seek proof |
| Accessibility and native IME | `view` | Automated [composition behavior](../packages/website/e2e/view-runtime.spec.js) and collection interaction qualified | Actual AT/OS IME audit remains open |
| Studio durability and syntax highlighting | `studio` | Reserved; [existing editor contract](../components/studio/README.md) unchanged | Entity projects and durable stores; highlighting is declined in the [editor contract](../components/studio/README.md#complete-reusable-editors) |
| Federation, third dialect, migration intermediate schema | `db` | Declined beyond [current query contracts](../packages/db/docs/NATIVE-PLANS.md) | None open: [fetch-order federation](../packages/linq/docs/QUERY-PEN.md#121-the-federation-boundary-federate), [two dialects](../packages/db/ARCHITECTURE.md) and the [ordered assertion fold](../packages/db/docs/MIGRATION-FORMAT.md) are the contracts |
| Awaiting documents and streaming DAG input | `flow` | Existing [task/workflow composition](../packages/flow/docs/WORKFLOW-FORMAT.md) reused | Streaming input is declined (FLOW-FORMAT §7.5); awaiting is the app format's awaiting action (APP-FORMAT §3.3) |
| Unrelated validation, query, diagrams, charts and AI | Respective package engines | Reserved, [open roadmap](ROADMAP.md) unchanged outside proved clauses | Existing owners retain all unrelated intent |

## Complete frozen-budget comparison

```sh
node benchmark/adoption-resources.js --write
node benchmark/adoption.js --final --write
npm run docs:derive
```

The [final report](../benchmark/adoption-program-result.json) accounts for every
frozen metric. Values retain their metric units (milliseconds, bytes or counts).
Focused reports measure their own declared work; combined reports measure the
application journey. A pending combined cell is not a failure of its focused
implementation and is not permission to claim a measured application result.
Resource samples are never substituted for the live-set peak, and a shorter
focused workload never supplies the combined memory value. Combined peak heap and
remaining handles come from the [instrumented run](#combined-live-set-and-remaining-handles)
of the same journey on the Linux source hosts; the peak is the largest live set
at phase boundaries, a lower bound on the instantaneous peak, so its pass does
not show the true peak under the ceiling. Provider attempts per request lack
matching combined measurements.

<!--fact:adoption.budgets-->

| Consumer | Frozen metric | Ceiling | Reference | Focused owner report | Combined Node | Combined Bun |
|---|---|---:|---|---|---|---|
| catalog | relational.statements | 9 | 9 (pass) | relational: 9 (pass) | pending | pending |
| catalog | relational.queryMs | 100 | 0.09 (pass) | relational: 0.49 (pass) | pending | pending |
| catalog | relational.recoveryMs | 5000 | 34.73 (pass) | relational: 43.50 (pass) | pending | pending |
| catalog | search.startupMs | 15000 | 372.60 (pass) | lexical: 385.67 (pass) | 314.90 (pass) | 243.54 (pass) |
| catalog | search.coldIndexMs | 15000 | 169.51 (pass) | lexical: 168.61 (pass) | pending | pending |
| catalog | search.warmIndexMs | 15000 | 65.05 (pass) | lexical: 185.44 (pass) | pending | pending |
| catalog | search.queryMs | 100 | 14.11 (pass) | lexical: 8.60 (pass) | pending | pending |
| catalog | search.sourceBytes | 8388608 | 2606620 (pass) | lexical: 2606620 (pass) | pending | pending |
| catalog | search.indexBytes | 33554432 | 1915119 (pass) | lexical: 25776764 (pass) | pending | pending |
| catalog | search.browserGzipBytes | 65536 | 5873 (pass) | lexical: 5767 (pass) | pending | pending |
| catalog | grid.interactionMs | 16 | 0.08 (pass) | collection: 1.36 (pass) | pending | pending |
| catalog | grid.mountedCells | 504 | pending | collection: 170 (pass) | pending | pending |
| catalog | grid.loadedRows | 256 | pending | collection: 256 (pass) | pending | pending |
| catalog | grid.loadedBytes | 262144 | pending | collection: 9732 (pass) | pending | pending |
| catalog | grid.browserGzipBytes | 65536 | 7053 (pass) | collection: 23508 (pass) | pending | pending |
| catalog | formulas.evaluationMs | 1000 | 24.44 (pass) | formula: 222.10 (pass) | pending | pending |
| catalog | formulas.errors | 1 | 1 (pass) | formula: 0 (pass) | pending | pending |
| catalog | formulas.originalByteChanges | 0 | 0 (pass) | formula: 0 (pass) | pending | pending |
| catalog | providers.pages | 3 | 2 (pass) | providers: 3 (pass) | pending | pending |
| catalog | providers.rows | 256 | 2 (pass) | providers: 256 (pass) | pending | pending |
| catalog | providers.bytes | 262144 | 269 (pass) | providers: 66426 (pass) | pending | pending |
| catalog | providers.attempts | 3 | pending | providers: pending | pending | pending |
| catalog | providers.unresolvedResends | 0 | pending | providers: pending | 0 (pass) | 0 (pass) |
| catalog | resources.sampledHeapBytes | 268435456 | 154179328 (pass) | —: pending | 90489448 (pass) | 71129003 (pass) |
| catalog | resources.peakRssBytes | 536870912 | 315109376 (pass) | —: pending | 279629824 (pass) | 280313856 (pass) |
| catalog | resources.peakHeapBytes | 268435456 | pending | —: pending | 60879520 (pass) | 54614151 (pass) |
| catalog | resources.teardownMs | 1000 | 0.07 (pass) | —: pending | 0.20 (pass) | 0.25 (pass) |
| catalog | resources.remainingHandles | 0 | pending | —: pending | 0 (pass) | 0 (pass) |
| archive-stock | relational.statements | 9 | 9 (pass) | relational: 9 (pass) | pending | pending |
| archive-stock | relational.queryMs | 250 | 0.16 (pass) | relational: 0.60 (pass) | pending | pending |
| archive-stock | relational.recoveryMs | 5000 | 49.20 (pass) | relational: 76.04 (pass) | pending | pending |
| archive-stock | search.startupMs | 45000 | 2096.09 (pass) | lexical: 2639.94 (pass) | 2449.89 (pass) | 1826.38 (pass) |
| archive-stock | search.coldIndexMs | 45000 | 970.36 (pass) | lexical: 1050.61 (pass) | pending | pending |
| archive-stock | search.warmIndexMs | 45000 | 479.46 (pass) | lexical: 1370.67 (pass) | pending | pending |
| archive-stock | search.queryMs | 250 | 88.96 (pass) | lexical: 73.47 (pass) | pending | pending |
| archive-stock | search.sourceBytes | 50331648 | 20021733 (pass) | lexical: 20021733 (pass) | pending | pending |
| archive-stock | search.indexBytes | 201326592 | 15820123 (pass) | lexical: 195268100 (pass) | pending | pending |
| archive-stock | search.browserGzipBytes | 65536 | 5873 (pass) | lexical: 5767 (pass) | pending | pending |
| archive-stock | grid.interactionMs | 32 | 7.88 (pass) | collection: 0.25 (pass) | pending | pending |
| archive-stock | grid.mountedCells | 840 | pending | collection: 160 (pass) | pending | pending |
| archive-stock | grid.loadedRows | 256 | pending | collection: 256 (pass) | pending | pending |
| archive-stock | grid.loadedBytes | 262144 | pending | collection: 10244 (pass) | pending | pending |
| archive-stock | grid.browserGzipBytes | 65536 | 7053 (pass) | collection: 23508 (pass) | pending | pending |
| archive-stock | formulas.evaluationMs | 5000 | 12.52 (pass) | formula: 1614.73 (pass) | pending | pending |
| archive-stock | formulas.errors | 1 | 1 (pass) | formula: 0 (pass) | pending | pending |
| archive-stock | formulas.originalByteChanges | 0 | 0 (pass) | formula: 0 (pass) | pending | pending |
| archive-stock | providers.pages | 6 | 2 (pass) | providers: 6 (pass) | pending | pending |
| archive-stock | providers.rows | 512 | 2 (pass) | providers: 512 (pass) | pending | pending |
| archive-stock | providers.bytes | 524288 | 269 (pass) | providers: 135886 (pass) | pending | pending |
| archive-stock | providers.attempts | 3 | pending | providers: pending | pending | pending |
| archive-stock | providers.unresolvedResends | 0 | pending | providers: pending | 0 (pass) | 0 (pass) |
| archive-stock | resources.sampledHeapBytes | 805306368 | 1020055816 (fail) | —: pending | 332223744 (pass) | 347575356 (pass) |
| archive-stock | resources.peakRssBytes | 1073741824 | 1209151488 (fail) | —: pending | 902119424 (pass) | 1044492288 (pass) |
| archive-stock | resources.peakHeapBytes | 805306368 | pending | —: pending | 278019696 (pass) | 304325732 (pass) |
| archive-stock | resources.teardownMs | 2000 | 0.10 (pass) | —: pending | 0.22 (pass) | 0.28 (pass) |
| archive-stock | resources.remainingHandles | 0 | pending | —: pending | 0 (pass) | 0 (pass) |

<!--/fact-->

The historical and current reference losses remain visible. In particular, the
larger retained search exceeds memory ceilings. Focused collection interaction,
lexical snapshots, validated formula evaluation, provider publication and durable
receipts do more work than their retained baselines; their linked reports publish
those costs. A passing finite ceiling is not a claim of being faster than an oracle.

The [original source census](../test/adoption/source-census.json) is immutable evidence tied to the frozen adoption revision. The [current owner census](../test/adoption/current-source-census.json) tracks retained source and the model transport retry transfer; regenerate it with `node scripts/generate-adoption-census.js`. This ownership update does not change the frozen workloads, oracle versions or measured results.
