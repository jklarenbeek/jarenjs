# Portable replacement evidence

The [frozen manifest](../test/adoption/manifest.json) defines synthetic reference
inputs, source/API families, exact oracle versions, consumer policies and finite
acceptance ceilings before native comparisons. It establishes an executable
comparison target. Native replacement, portable consumer acceptance, live hosts
and operator qualification remain separate evidence states.

Run from the repository root:

```sh
node --no-warnings=ExperimentalWarning --test 'test/adoption/*.test.js'
node --no-warnings=ExperimentalWarning benchmark/adoption.js
npm run test:packed
```

The benchmark prints a report without changing the freeze. An intentional new
measurement uses `node benchmark/adoption.js --write`, followed by
`npm run docs:derive`. Review the report and its runner hash together. A different
runtime or machine is a different measurement environment; compare only matching
workload and environment identities. Missing measurements are `pending`, never
zero or pass. Reference costs above the fixed ceilings remain published losses;
the runner does not raise the ceilings. New fixture semantics or budgets require
a reviewed new freeze identity and an explicit disposition of the earlier one.

| Mechanism | Executable reference | Current qualification boundary |
|---|---|---|
| Relational SQL | SQLite settings, rowid receipt/BLOB/history, composite keys, nullable inventory, joins, aggregates, conditional writes, no-op upserts, insert-select and committed WAL recovery | Public drivers execute the reference SQL; native column mappings and removal of domain SQL remain pending |
| Search | Exact development-only MiniSearch, labelled multilingual and identifier queries, incremental changes and serialized reload | Existing regex search is separately pinned; native lexical APIs and real labelled corpus remain pending |
| Virtualization | Exact development-only virtual-core with fixed and measured keyed windows | Headless ranges do not prove mounted DOM, browser interaction or a bounded database provider |
| Saved formulas | Static trusted module whose function bodies match the saved originals byte for byte, including CRLF; disabled invalid text never executes | This is a finite synthetic compatibility host; converter, native profile and complete real saved corpus remain pending |
| Providers and durable operations | Offline REST, GraphQL and Link transcripts, partial observations, changed destinations, ambiguous effects, existing Query IR policy predicates and SQL receipts | No provider calls, credentials, new retry engine, authoritative ledger or ingestion implementation; real effects and reconciliation remain pending |

The [source census](../test/adoption/source-census.json) records its revision and
the exact `rg` patterns and matching lines. The deterministic generator lives in
`scripts/lib/adoption.js` and reuses `@jarenjs/core/random`. Reference search and
grid wrappers live together in `test/adoption/oracles.js`; they adapt installed
oracles without implementing their algorithms. Runtime packages import neither
the instrument nor its dependencies.

The independently declared larger consumer has its own seed, environment,
protected-row policy, rounding step, sort policy and report-only write policy.
Both generated datasets are checksum-pinned. The packed gate copies these inputs
and `test/consumer/adoption.js` into the isolated database package closure, then
executes the public-driver SQL and public-query subset under Node and Bun when
available. That subset is useful installed-API evidence; it cannot retire the
reference mechanisms whose native APIs have not been implemented.

## Range-provider contract kit

`test/adoption/range-provider-contract.js` exports `rangeProviderContract(name,
factory)`. A factory supplies an isolated source seeded with stable keys and
returns a provider, a snapshot-invalidation control and a remaining-resource
counter. The same requests and assertions apply to fake and future real adapters;
an adapter may translate setup, never weaken assertions.

Requests carry generation, request ID, query identity, source-backed snapshot,
half-open range or opaque continuation, and finite page/row/byte/work credits.
The signal is a separate argument. Responses echo every identity and use
`ready`, `loading`, `error`, `invalidated` or `budget-exhausted`. Errors distinguish
`unsupported-seek`, `invalid-range`, `invalid-credits`, `cancelled` and `disposed`;
these are structural test-contract reasons, not newly allocated numeric package
error codes. Known totals carry a nonnegative value; unknown totals never use
loaded-row count. Ready responses account for UTF-8 JSON row bytes and preserve
stable, unique keys. The kit rejects stale responses at the publication boundary,
tests cancellation before and during requests, and checks idempotent drained
disposal. Its fake source deliberately declares no live capture or complete
export capability. Monotone live events, real capture consistency, coordinator
cache/prefetch limits and complete snapshot exports need future real adapters.

## Measured reference costs and limitations

<!--fact:adoption.reference-->

Reference-only measurements on v24.19.0, linux/x64, AMD Ryzen 9 5900HX with Radeon Graphics.

| Consumer | Rows | Cold index ms | Reload ms | Worst query median ms | Sampled heap MiB | Peak RSS MiB | Search gzip bytes | Grid gzip bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| catalog | 10000 | 146.04 | 63.37 | 7.90 | 146.97 | 301.74 | 5873 | 7053 |
| archive-stock | 75000 | 1023.79 | 417.81 | 66.37 | 960.71 | 1147.32 | 5873 | 7053 |

catalog: 21 measured limits met, 0 losses, 7 pending measurements. archive-stock: 19 measured limits met, 2 losses, 7 pending measurements.

<!--/fact-->

The full machine-readable report includes SQL plans, statement counts, per-query
result hashes, startup and recovery times, headless range counts, serialized
source/index bytes, teardown and each budget assessment. Browser byte figures
are gzip-compressed, minified ESM bundles of the retained packages. They do not
measure an application bundle delta. RSS is the process high-water mark; sampled
heap is a lower bound, so exact peak heap stays pending. Memory covers the entire
reference process, including source rows, serialized bytes, cold and reloaded
indexes, query results and bundle instrumentation, rather than an isolated index.
Each consumer runs in a fresh process. Query cost is the worst per-query median over repeated runs;
index costs are single cold-build and JSON-reload observations. Formula and
provider measurements use the small labelled subsets, not the generated larger
dataset. Those omissions cannot pass a replacement exit.

MiniSearch's retained configuration allows fuzzy identifier matches: exact
identifiers can lead results while similar identifiers also match. Its JSON
reload also changes some equal-score ordering. The fixtures retain separate cold
and reload outputs; any native tie policy needs an explicit compatibility or
migration decision. Neither discrepancy is silently corrected in the reference.

The relational diagnosis test records the currently missing integer-rowid key
and trigger inventory while proving read-only behavior and strict `JD0002`
refusal from the existing DB registry. A discovery repair updates that diagnosis
test deliberately; it must preserve the physical reference outputs and frozen
workload. No real production data or external repository is involved.
