# Portable replacement evidence

The [frozen instrument](../test/adoption/manifest.json) remains the source of
synthetic inputs, original formula bytes, oracle versions and finite budgets.
Its historical pending flags describe the foundation measurement; this matrix
records the subsequently implemented public compositions. Actual application
cutover, real providers and manual acceptance remain pending.

| Capability | Combined portable evidence | Remaining qualification |
|---|---|---|
| Relational adoption | Existing column-only catalog, renamed archive columns and composite identity; unchanged schema, original bytes, settings and trigger histories across reopen | Arbitrary schemas, PostgreSQL, power-loss durability and actual downstream files |
| Native queries | Public mapped reads and updates; no domain SQL or private driver bridge in the adopted application | Unkeyed history stays an independent read-only SQL oracle; broader algebra retains its refusals |
| Collections | Reusable coordinator, virtual grid and stable review selection across pages | Physical devices, assistive technology and native OS input methods |
| Lexical search | One core ranker over an explicitly refreshed authoritative snapshot; bounded displayed results and original identifier strings | Adopted triggers have no qualified live capture; native FTS and real relevance corpora remain unqualified |
| Formulas and rules | Native draft/save/preview; current-row, authority and schema checks inside the receipt transaction; original-preserving migration and no-op repeat | Unresolved original sources retain review-required/disabled status and the trusted oracle |
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
navigation disposal. Offline page reload is qualified on Chromium and Firefox.
The Linux Playwright WebKit host reports an internal error for that navigation;
it separately exercises offline database reopen, ingestion and reconciliation,
with network restored for page reload. WebKit offline page-navigation acceptance
remains pending. Session storage preserves this tab's database through
reload; closing the tab is outside that persistence contract.

## Combined cost and source ownership

```sh
node benchmark/adoption.js --combined --write
npm run docs:derive
```

<!--fact:adoption.combined-->

| Host | Consumer | Rows | Journey ms | Search startup ms | Heap MiB | Peak RSS MiB | Second writes |
|---|---|---:|---:|---:|---:|---:|---:|
| node | catalog | 10000 | 811.83 | 382.33 | 63.52 | 267.13 | 0 |
| node | archive-stock | 75000 | 4188.55 | 2772.52 | 379.03 | 863.14 | 0 |
| bun | catalog | 10000 | 668.71 | 316.38 | 47.69 | 235.72 | 0 |
| bun | archive-stock | 75000 | 3368.54 | 2214.10 | 320.48 | 939.01 | 0 |

Retained reference adapters: 105 lines; adopted application policy: 182 lines. Third-party search/virtualization mechanisms in the application: 2 → 0.

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
Exact peak heap remains unmeasured. No benchmark raises a frozen ceiling.

## Retained reference costs

```sh
node benchmark/adoption.js --write
npm run docs:derive
```

<!--fact:adoption.reference-->

Reference-only measurements on v24.19.0, linux/x64, AMD Ryzen 9 5900HX with Radeon Graphics.

| Consumer | Rows | Cold index ms | Reload ms | Worst query median ms | Sampled heap MiB | Peak RSS MiB | Search gzip bytes | Grid gzip bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| catalog | 10000 | 125.32 | 54.96 | 5.37 | 146.87 | 303.30 | 5873 | 7053 |
| archive-stock | 75000 | 1131.99 | 530.33 | 73.40 | 972.90 | 1156.73 | 5873 | 7053 |

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
