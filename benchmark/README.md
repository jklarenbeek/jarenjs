# Jaren benchmark & tooling workspace

Everything for measuring, debugging and verifying the Jaren packages lives in
this directory: the official conformance suites (as git submodules), the
performance profilers, a test-failure debugger, code-coverage and call-graph
analysis, and the W3C QT3 scorecard harness. All tools run from the repository
root with plain `node`; none of them are needed to *use* the packages.

Every claim in the repository documentation is reproducible from here — each
number in a README performance table names the command that produced it.

## Contents

| Tool | Purpose | Use when |
|------|---------|----------|
| [`profiler.js`](./profiler.js) | JSON Schema performance vs Ajv over the official test suite | Measuring Jaren vs Ajv speed |
| [`debug.js`](./debug.js) | Test inspection and assertion-level debugging | Investigating specific test failures |
| [`coverage.js`](./coverage.js) | Merged code-coverage analysis (suite + unit tests) | Finding untested code paths and dead code |
| [`callgraph.js`](./callgraph.js) | Call-graph generation via the Node.js profiler | Analyzing hot paths and call chains |
| [`jsonpath.js`](./jsonpath.js) | JSONPath RFC 9535 compliance + performance vs json-p3 | Verifying/benchmarking the JSONPath compiler |
| [`jsonpointer.js`](./jsonpointer.js) | Compiled JSON Pointer performance | Benchmarking pointer/`$data` resolution |
| [`formats.js`](./formats.js) | String `format` validation vs ajv-formats | Benchmarking the format testers |
| [`contracts.js`](./contracts.js) | Contract validation vs Zod 4 / Zod 3 / zod&#47;mini / Ajv | Benchmarking the real adapter shape a service runs |
| [`jsonquery.js`](./jsonquery.js) | Jaren JSON Query performance vs fontoxpath/jsonata | Benchmarking FLWOR joins, grouping, reshaping |
| [`geo.js`](./geo.js) | Spatial kernel performance vs turf / geolib / flatbush | Benchmarking distance, area, containment and the bbox index |
| [`spatial.js`](./spatial.js) | Spatial storage in `@jarenjs/db`: `$within` over 50 000 stored points every way it can run — scan, UDF, the two-stage plan, the exact promotions, the nine-cell probe, the in-memory engine, and a hand-built R\*Tree — gated on the committed spatial corpus; no head-to-head rival exists and the suite says so | Deciding whether a derived spatial index, the UDF hatch, or an R\*Tree earns its place |
| [`jslt.js`](./jslt.js) | JSLT performance vs native JS/JSONata | Benchmarking identity sharing, recursive dispatch, modes |
| [`csv.js`](./csv.js) | CSV conformance, self-healing and performance vs the sync npm parsers | Benchmarking the josl CSV reader/writer |
| [`markdown.js`](./markdown.js) | CommonMark scorecard + performance vs marked/markdown-it/micromark | Benchmarking the Markdown engine |
| [`mermaid.js`](./mermaid.js) | Mermaid coverage scorecard + parse speed | Benchmarking the headless Mermaid engine |
| [`flow-fsm.js`](./flow-fsm.js) | FSM compile/transition vs XState v5 + the serializability wedge | Benchmarking `@jarenjs/flow` machines |
| [`flow-dag.js`](./flow-dag.js) | Dag abstraction price vs a hand-written baseline | Benchmarking `@jarenjs/flow` dataflow |
| [`long-horizon.js`](./long-horizon.js) | What survives `@jarenjs/ai`'s history compaction — needle + pairwise, ceiling and live model | Measuring agent context retention |
| [`retrieval.js`](./retrieval.js) | Did the right memory reach the prompt — recall@k and MRR for `@jarenjs/ai`'s recall policies (tag+recency, and the seam-gated ranked path) over a seeded corpus, against an oracle | Measuring ledger retrieval, default and ranked, on one instrument |
| [`vector.js`](./vector.js) | k-nearest over a `derive: 'vector'` column every physical way it runs — resident sweep, the shipped plan, its own statement, `ORDER BY` over a UDF, the same query with no column — against **sqlite-vec**, equivalence-gated, with what the column costs to write and to store | Choosing between a vector column, a JSON member and an extension |
| [`series.js`](./series.js) | The temporal ground and what was built on it: a range, a fixed bucketing, a rolling window and an as-of read over a seeded series, answered by plain references, by `@jarenjs/core/series`, by a generic query document, by stock SQLite under a declared epoch column and by the store's own plan — gated on the committed series corpus and on every route agreeing with the others before a timer starts, with the resident ceiling and the durable loss both published | Deciding what a temporal fast path has to beat, what the kernel costs against the one-pass loops it replaces, and what a declared epoch column buys over the document it came from |
| [`db.js`](./db.js) | The store and the LINQ front door: documents in SQLite through the pushdown planner against PouchDB/RxDB/lowdb, the pushdown headline, the chain in memory, and what one DEFINITION costs to build through a pen beside the hand-written document | Deciding what pushdown buys, and what writing a document by code costs |
| [`orm.js`](./orm.js) | Entities and the typed client against Prisma/Drizzle/Kysely over SQLite, on Node and on Bun, with statement counts beside the timings | Comparing the store and its front door with the tools they will be compared to |
| [`qt3-runner.js`](./qt3-runner.js) | W3C QT3 scorecard through the XQuery front-end | Checking query-engine compliance (see [qt3-README.md](./qt3-README.md)) |
| [`index.js`](./index.js) | The json-schema-benchmark style suite run | Quick Jaren-vs-Ajv suite pass (`npm run benchmark`) |

The tools share one harness library, [`lib/`](./lib/): option parsing
(`args.js`), timing and table rendering (`measure.js`, `fmt.js`), tracked
result files (`results.js`), and the JSON-shape equivalence check
(`equals.js`) used to verify rival engines agree before timing them.

## Test suites (git submodules)

Five official suites are vendored as submodules. After cloning, initialize
the ones you need:

```bash
git submodule update --init benchmark/suite            # JSON-Schema-Test-Suite
git submodule update --init benchmark/jsonpath-suite   # JSONPath Compliance Test Suite
git submodule update --init benchmark/qt3tests         # W3C QT3 (XQuery/XPath 3.1), ~60 MB
git submodule update --init benchmark/toml-test-suite  # toml-test (TOML 1.0.0)
git submodule update --init benchmark/commonmark-spec  # CommonMark spec (embedded examples)
```

| Path | Suite |
|------|-------|
| `benchmark/suite/` | [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) — drives `profiler.js`, `debug.js`, `coverage.js`, `callgraph.js` |
| `benchmark/jsonpath-suite/` | [JSONPath Compliance Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite) — drives `jsonpath.js` (703 tests, normalized paths included) |
| `benchmark/qt3tests/` | [W3C QT3 tests](https://github.com/w3c/qt3tests) — drives `qt3-runner.js` (31,821 cases; convert once with `npm run qt3:convert`) |
| `benchmark/toml-test-suite/` | [toml-test](https://github.com/toml-lang/toml-test) — drives `toml.js` and `test/josl/compliance.test.js` (709 TOML 1.0.0 cases via `tests/files-toml-1.0.0`) |
| `benchmark/commonmark-spec/` | [CommonMark spec](https://github.com/commonmark/commonmark-spec) — drives `markdown.js` (655 examples extracted from `spec.txt`) |

## Running the unit tests

Unit tests live in `test/` at the repository root, organized per package:

```bash
# Run all tests
npm test

# Run all tests with coverage (c8, lcov report)
npm run cover

# Run a single package's tests
npm run test:core
npm run test:json
npm run test:validate
```

## profiler.js — JSON Schema performance vs Ajv

Runs Jaren against the official JSON Schema Test Suite and compares results
and timings with Ajv.

```bash
# Profile a specific test suite with draft selection
node benchmark/profiler.js '/ref.json' --profile --draft 2019 --iterations 1000

# Profile all tests for multiple drafts
node benchmark/profiler.js --profile-all --draft draft7,draft2019-09,draft2020-12

# Export results to JSON with custom file path
node benchmark/profiler.js --profile-all --output json --filepath results.json

# Show only top 10 slowest tests
node benchmark/profiler.js '/ref.json' --profile --top 10

# Only include tests where all engines succeed
node benchmark/profiler.js '/ref.json' --profile --success-only

# Full options
Options:
  --profile              Profile a specific test file
  --profile-all          Profile all test files
  --iterations, -i N     Number of iterations (default: 1000)
  --output, -o FORMAT    Output format: console, csv, json (default: console)
  --draft, -d VERSION    JSON Schema draft version(s), comma-separated
                         Supported: draft6, draft7, draft2019-09, 2019, draft2020-12, 2020
  --filepath, -f PATH    Output file path for csv/json
  --top N                Show only top N slowest tests
  --success-only         Only include tests where all agents succeed
  --verbose, -v          Verbose output
```

The conformance table in the repository [README](../README.md) is produced by
`node benchmark/profiler.js --profile-all --draft draft2020-12` (and the other
drafts). `npm run benchmark` runs the simpler suite pass in `index.js`; its
results are written to `benchmark/results/results.html`.

**How the pass/fail columns are counted.** Each engine is scored over the
tests *it* ran: a test where the other engine could not compile the schema
is still a test this one passed or failed, and it is counted here — so
`passed + failed + errors` equals the corpus for both columns, and neither
column is silently narrowed to the intersection. Ajv errors on more than a
dozen cases of the official suite, and counting only what both engines could
run hid real failures on Jaren's side for months.

## debug.js — investigating test failures

A debugging utility for investigating test failures and understanding schema
validation behavior, test case by test case, assertion by assertion.

```bash
# List all test files for a draft
node benchmark/debug.js --list-files --draft 2019

# List all test cases in a file with keyword summaries
node benchmark/debug.js '/anchor.json' --list --draft 2019

# Run a specific test suite with draft selection
node benchmark/debug.js '/anchor.json' --draft 2019

# Run a specific test by description (partial match)
node benchmark/debug.js '/anchor.json' 'same $anchor' --draft 2019

# Run a specific test by index
node benchmark/debug.js '/anchor.json' --index 3 --draft 2019

# Export test suite to JSON
node benchmark/debug.js '/anchor.json' --export anchor-tests.json --draft 2019

# Export specific test case
node benchmark/debug.js '/anchor.json' --index 3 --export-test test.json --draft 2019

# Dry run - show schema and assertions without validating
node benchmark/debug.js '/anchor.json' --dry-run --draft 2019

# Show detailed validation errors
node benchmark/debug.js '/ref.json' 'nested refs' --show-errors

# Interactive mode - step through assertions
node benchmark/debug.js '/ref.json' 'nested refs' --interactive

# Detailed comparison between Jaren and AJV
node benchmark/debug.js '/ref.json' 'nested refs' --compare

# Run only Jaren (skip AJV comparison)
node benchmark/debug.js '/ref.json' 'nested refs' --jaren-only

# Verbose output with full schema and data
node benchmark/debug.js '/ref.json' 'nested refs' --verbose

# Minimal output (errors only)
node benchmark/debug.js '/ref.json' --silent
```

A typical failure investigation: find the test with `--list`, run it with
`--verbose`, compare engines with `--compare`, then `--export-test` for an
isolated reproduction. Validator-internal troubleshooting (ref resolution,
annotation tracking) is covered in the
[validate ARCHITECTURE debugging guide](../packages/validate/ARCHITECTURE.md#debugging-guide).

## coverage.js — code coverage analysis

Analyzes which functions are touched — and which are not — when profiling one
official-suite fixture or auditing the repository test suite. Every invocation
starts with a fresh coverage report. A child failure exits nonzero and prints
its full diagnostics, even if no report was produced; any partial coverage
shown belongs to that failed run.

```bash
# Whole-repository test suite: fail on untouched shipped functions
node benchmark/coverage.js --dead-code

# Machine readable output for diffing between runs
node benchmark/coverage.js --dead-code --json

# What does a single suite file touch?
node benchmark/coverage.js '/required.json' --threshold 25

# Show TOUCHED and NOT touched functions with hit counts
node benchmark/coverage.js '/required.json' --functions

# Single-fixture options
  --iterations <n>   Profiling iterations (default: 1000)
  --threshold <n>    Only show files with function coverage > n% (default: 0)
  --functions        Show TOUCHED and NOT touched functions
  --touched-only     Show only TOUCHED functions
  --temp-dir <dir>   Temporary directory for c8 coverage data

# Dead-code audit options
  --json            Print the audit data as JSON after the run banner
  --no-fail         Report dead-code findings without failing on them;
                    test failures and missing coverage still fail
```

The dead-code audit reports **fully dead files**, **untouched functions** in
otherwise-used files, and the total function hit count. An empty report or
zero instrumented functions fails the audit.

## callgraph.js — call graph analysis

Call graph analysis using the Node.js built-in `--prof` profiler. Generates
text-based call graphs showing hot paths and call chains.

```bash
# Generate call graph for a test suite
node benchmark/callgraph.js '/ref.json'

# More iterations for better accuracy
node benchmark/callgraph.js '/ref.json' --iterations 5000 --top-functions=30

# Show deeper call chains
node benchmark/callgraph.js '/ref.json' --max-depth=15

# Include Node.js internal functions
node benchmark/callgraph.js '/ref.json' --include-internals

# Filter by pattern
node benchmark/callgraph.js '/ref.json' --filter 'validate'

# Full options
Options:
  --iterations, -i N       Number of iterations (default: 1000)
  --top-functions N        Show top N hottest functions (default: 20)
  --max-depth N            Maximum call chain depth (default: 10)
  --filter <pattern>       Filter functions by pattern (default: jaren)
  --include-internals      Include Node.js internal functions
  --verbose, -v            Show detailed output
```

## jsonpath.js — JSONPath compliance and performance

Compliance and performance benchmark for the RFC 9535 JSONPath compiler in
`packages/json/src/path.js`. Runs the official compliance suite (including
normalized-path verification) against Jaren and the RFC 9535-conformant
contender [json-p3](https://www.npmjs.com/package/json-p3). This is a separate
tool from `profiler.js` because the schema-draft/remotes machinery does not
apply to JSONPath queries.

```bash
# Compliance run over all engines (exit code 1 when Jaren fails a test)
node benchmark/jsonpath.js

# Only tests whose name contains a string, with failure details
node benchmark/jsonpath.js 'functions, match' --verbose

# Performance comparison per CTS query, plus synthetic 1000-item scenarios
node benchmark/jsonpath.js --profile --scale

# Full options
Options:
  --profile              Profile query performance instead of checking compliance
  --verbose, -v          Show every compliance failure in detail
  --iterations, -i N     Iterations per profiled query (default: 1000)
  --top N                Show top N slowest queries in profile mode (default: 15)
  --scale                Add synthetic 1000-item document scenarios to the profile
                         (full nodelist, plus first-match/exists early exit)
  --engines a,b          Engines to run (default: jaren,json-p3)
  --output, -o FORMAT    Output format: console, csv, json (default: console)
  --filepath, -f PATH    Output file path for csv/json
```

`--scale` prints two tables over the same synthetic document. The first
asks each engine for the whole nodelist; the second asks only for the
first match, or whether any match exists. Read them against each other:
the gap between a row and its twin is what early exit saves.

Rival selection matters more than usual there, because *how* you ask an
engine for one answer changes the number by an order of magnitude. So
`first`/`exists` are declared as several routes per engine and each is
timed on the **fastest of its own** — json-p3's purpose-built `match()`
is beaten by its plain `query()` on a singular selector and by its
`lazyQuery()` generator on a descendant one, and picking any single one
of those for it would have decided the comparison. The singular selector
is carried as a control row: it addresses one node either way, so a
result there that looks like a win would mean the harness is wrong.

npm shortcuts: `npm run benchmark:jsonpath`, `npm run benchmark:jsonpath:profile`.

## csv.js — CSV conformance, self-healing and performance

Scores `@jarenjs/josl`'s CSV reader against the sync-capable CSV parsers
on npm: the [csv-spectrum](https://www.npmjs.com/package/csv-spectrum)
acceptance corpus, a self-healing scorecard over damaged documents, and
parse / incremental-read / stringify throughput.

```bash
node benchmark/csv.js                  # conformance + healing scorecard
node benchmark/csv.js --verbose        # show every failing case
node benchmark/csv.js --profile        # add the timing tables
node benchmark/csv.js --engines jaren,udsv
```

Rival selection decides these numbers, so it is deliberate:

- **`udsv` is the rival that matters.** It has a fraction of papaparse's
  downloads but it is the acknowledged JS speed leader and the only other
  parser with a *synchronous* incremental API. Benchmarking against
  papaparse alone would be picking a soft target — and udsv wins the
  parse rows, which is reported rather than buried.
- **`fast-csv`, `csv-parser`, `csvtojson` and `neat-csv` are excluded**
  because they are stream-only: their rows arrive on a later tick, so
  timing them beside a synchronous parser measures Node's stream
  machinery, not a CSV grammar.
- **Nothing is timed until it agrees with jaren on the result.** A parser
  that quietly produced fewer rows would otherwise post the best number.
- `location_coordinates`, the twelfth csv-spectrum fixture, is excluded
  and the reason printed: its expectation contradicts its own input, so
  no parser can satisfy it.

The healing scorecard runs **each probe in a child process with a
deadline**, because udsv loops forever on a record shorter than its
header and an in-process probe would take the whole benchmark down with
it. A hang is a result worth reporting, not a crash.

npm shortcuts: `npm run benchmark:csv`, `npm run benchmark:csv:profile`.

## formats.js — string formats vs ajv-formats

Benchmarks `@jarenjs/formats` against
[`ajv-formats`](https://www.npmjs.com/package/ajv-formats), compiled
validator to compiled validator, in two tables: the formats both engines
implement (where a ratio means something) and the formats only Jaren
implements — the internationalized `iri`/`idn-hostname` family and Jaren's
extras — where Ajv has no validator and the column reads `n/a`.

Each scenario carries a value that must be accepted and one that must be
rejected, and both engines are checked against both before being timed: an
engine that waves the invalid value through is not doing the work being
measured, so its column is dropped rather than reported. That check is what
keeps a format Ajv silently ignores from appearing as an Ajv win.

```bash
npm run benchmark:formats
node benchmark/formats.js --filter iri
```

## contracts.js — contract validation vs Zod and Ajv

The rival here is not another JSON Schema engine but the
validate-and-normalize library a TypeScript service actually uses, so this
suite runs **Zod 4**, **Zod 3** and **zod/mini** alongside **Ajv** (the
incumbent JSON Schema engine — excluding it would flatter Jaren).

Three scenarios — a uuid/enum/date-time command, a defaults-and-coercion
config object, and 50 nested records — each measured three ways:

1. **compile** — paid once per process, and the table where Jaren is
   generally slowest. It is reported because hiding it would be dishonest.
2. **verdict** — the cheapest "is this valid?" for input that is valid.
   **This table is deliberately not apples-to-apples and the ratio flatters
   Jaren**: Jaren answers with a predicate that allocates nothing, while Zod
   has no predicate mode and builds its normalized output on the way. That
   output is not wasted work in a real handler, which is why table 3 exists.
3. **adapter** — the shape a service actually runs: normalize the input,
   validate it, and map failures to a library-neutral issue list, timed on
   invalid input because that is the allocating path. **This is the
   comparable table and the one to quote.**

Two fairness mechanics are worth knowing about. Ajv normalizes by mutating
its input, so it is handed a fresh `structuredClone` each iteration and
charged for it — Jaren and Zod both return a new value and leave the
caller's alone, and not cloning would measure a different (and, for a shared
request body, incorrect) program. And Ajv caches compiled validators by
schema object identity, so the compile table rotates through a pool of
distinct schema clones; without that, Ajv's compile row measures a cache
lookup and reads ~1000x too fast.

Every engine must accept the well-formed input, reject the invalid one, and
produce the same normalized value before it is timed; one that disagrees is
dropped with the reason printed.

```bash
npm run benchmark:contracts
node benchmark/contracts.js collection --iterations 20000
```

## jsonpointer.js — compiled JSON Pointer performance

Benchmarks the compiled JSON Pointer / Relative JSON Pointer engine of
`@jarenjs/json` against the interpretive resolver it replaced (inlined
verbatim as the baseline) and the [`jsonpointer`](https://www.npmjs.com/package/jsonpointer)
npm package, over absolute pointers, relative pointers (the `$data` hot path)
and the `compileDataRef` dispatch.

```bash
npm run benchmark:jsonpointer
```

## jsonquery.js — Jaren JSON Query vs fontoxpath/jsonata

Performance benchmark for the Jaren JSON Query engine in
`packages/json/src/query/` against
[fontoxpath](https://www.npmjs.com/package/fontoxpath) (XQuery 3.1 in
JavaScript) and [jsonata](https://www.npmjs.com/package/jsonata). Runs a
scenario matrix (singular access, filter + project, join, group + aggregate,
deep reshape, compile time) over a scalable bookstore document, asserting
result equivalence across engines before timing anything; the per-engine
queries and fairness notes live in [`adaptors/jsonquery/`](./adaptors/jsonquery/).

```bash
# Equivalence check over all engines (exit code 1 on any semantic mismatch)
node benchmark/jsonquery.js

# Performance comparison, plus 1000- and 10000-book documents
node benchmark/jsonquery.js --profile --scale
```

npm shortcuts: `npm run benchmark:jsonquery`, `npm run benchmark:jsonquery:profile`.

## jslt.js — JSLT vs native JS/JSONata

Performance benchmark for the JSLT stylesheet dispatcher in
`packages/json/src/jslt/` against hand-written recursive JavaScript and
JSONata's transform operator. It checks identity sharing, a surgical price
override, a two-mode reshape, schema-based fresh annotation and compile time
over the same scalable bookstore family as `jsonquery.js`
([`fixtures/bookstore.js`](./fixtures/bookstore.js)); every expressible result
is compared before timing, and unsupported JSONata mode dispatch is printed as
`n/a`, never silently substituted.

```bash
# Equivalence check over all engines
node benchmark/jslt.js

# Performance comparison, plus 1000- and 10000-book documents
node benchmark/jslt.js --profile --scale
```

npm shortcuts: `npm run benchmark:jslt`, `npm run benchmark:jslt:profile`.

## markdown.js — @jarenjs/md vs marked/markdown-it/micromark

Compliance scorecard and performance comparison for the Markdown engine in
`components/md/`. The scorecard extracts the 655 examples embedded in the
official CommonMark `spec.txt` (submodule) and compares each engine's HTML
after the spec's whitespace normalization. Two fairness notes are built in:
`@jarenjs/md` is scored on its *pragmatic dialect* (components/md/docs/
MD-FORMAT.md §1.3) — its number is honest coverage, not a compliance claim —
and examples that require raw HTML pass-through can never pass, because the
vnode format has no unescaped output by design. Performance measures
parse + render-to-HTML (every engine's natural unit) over synthetic
documents at ~2/10/100 kB, with GFM enabled for the engines that support
it; `--profile` adds jaren-only rows for parse-to-AST and the compiled
document's cached vnode fast path (O(1) once built — the row the view
patcher actually consumes).

```bash
git submodule update --init benchmark/commonmark-spec   # once

# Scorecard + performance
node benchmark/markdown.js

# Only one half; more iterations; failing example numbers
node benchmark/markdown.js --score-only --verbose
node benchmark/markdown.js --perf-only --profile --iterations 500

# Restrict engines
node benchmark/markdown.js --engines jaren,markdown-it
```

npm shortcut: `npm run benchmark:markdown`.

## mermaid.js — @jarenjs/mermaid coverage + parse speed

Coverage scorecard and parse-speed comparisons for the headless Mermaid
engine in `components/mermaid/`. Three measurements, each labeled for
what it fairly compares:

1. **Coverage scorecard** over a curated corpus
   (`benchmark/fixtures/mermaid.js`): the fraction of each diagram type
   `@jarenjs/mermaid` parses *and* renders to SVG without error.
   Secondary types (mindmap, gitGraph, …) parse-accept into a placeholder
   and are counted honestly as "parsed, not laid out".

2. **Parse-speed head-to-head, two competitors** — and this is the part
   worth understanding, because Mermaid has *two* parsers:
   - **`@mermaid-js/parser`** is the standalone **Langium** parser. It is
     the home of the grammars migrated off the old system, and at the
     time of writing it covers only the newer diagrams (pie, gitGraph,
     packet, radar, …). It **cannot parse flowchart or sequence at all**.
     So the apples-to-apples row against it is **pie**.
   - **Flowchart and sequence** are still parsed by Mermaid's original
     in-tree **Jison** grammars
     (`packages/mermaid/src/diagrams/{flowchart,sequence}/parser/*.jison`),
     which live inside the full `mermaid` package, not in
     `@mermaid-js/parser`. The fair head-to-head there is
     **`mermaid.parse()`** from the full library. `mermaid.parse` is
     DOM-coupled, so the benchmark provides a **jsdom** global; it is
     also async and runs Mermaid's whole parse front-end (type detection
     + Jison + validation), so it is labeled as such, not as a bare-Jison
     microbenchmark. `@jarenjs/mermaid` parses the same flowchart/sequence
     sources roughly **two orders of magnitude faster**.

3. **Jaren-only capability** — parse→AST and **parse→layout→SVG string**
   (headless, no browser): the full pipeline mermaid.js cannot run
   without a DOM (`getBBox`).

```bash
# scorecard + both head-to-heads + jaren-only rows
node benchmark/mermaid.js

# more iterations; JSON for the website
node benchmark/mermaid.js --profile --iterations 500
node benchmark/mermaid.js --output json --filepath out.json
```

Competitors are **benchmark devDependencies only**
(`@mermaid-js/parser`, `mermaid`, `jsdom`); if any is missing the run
degrades gracefully (each is dynamically imported and its rows are
skipped). npm shortcut: `npm run benchmark:mermaid`.

## flow-fsm.js / flow-dag.js — @jarenjs/flow vs XState and a hand-written baseline

Two runners, one `npm run benchmark:flow`. Each is labeled for what it
fairly compares:

1. **FSM head-to-head against XState v5** (`flow-fsm.js`). The *same
   logical machine* — an N-state cycle, one guard per transition — is
   built with `@jarenjs/flow` and XState v5 and **asserted to agree
   before any timing**. Three things are measured at 5 / 50 / 500 states:
   - **compile**: `compileFsm` vs `createMachine` + `createActor`. Not
     like-for-like, and the row says so — XState builds a scheduling
     actor with snapshots, so this is each engine's description→drivable
     cost, not a bare compile.
   - **transition**: our pure total-function `step` *and* the
     `createFsmSession` wrapper (both routes on the page, so it is not
     pure-function-vs-actor by omission) against an XState actor's `send`.
   - **memory** as the live set after a forced GC (needs
     `node --expose-gc`, which `npm run benchmark:flow-fsm` passes). This
     is a **published loss**: a compiled Jaren machine holds more than the
     actor, because every guard compiles to its own query closure.

2. **The serializability wedge** — a conformance fact, not a timing. A
   jaren-fsm document is JSON *including its guards*, so it survives
   `JSON.stringify` → `JSON.parse` and still compiles and still fires its
   guard (asserted). An XState machine's guards are functions in the
   second `createMachine` argument; `JSON.stringify` drops them, and the
   round-tripped machine throws "Guard not implemented" at the guarded
   transition. Reported as a yes/no row in the toml-test register.

3. **Dag abstraction price** (`flow-dag.js`). No npm library executes
   schema-validated JSON dataflow, so — exactly like the view suite's
   hand-written-vs-stylesheet rows — the honest rival is the *same
   pipeline written straight in JavaScript*. Filter → join → project at
   100 / 10 000 rows, no-task and mixed-async variants, output asserted
   byte-identical before timing. The ratio is the documented price of
   dataflow as one serializable, constrained-decodable JSON value; the
   dag is compiled once and the hand-written baseline is wrapped so both
   await once (no await-vs-no-await artifact).

Fairness notes: XState is pinned as a `benchmark` devDependency and the
machines are asserted equivalent before timing; both Jaren routes and
both engines' losses are on the page; the hand-written JS is a floor, not
a rival, because nothing else runs JSON dataflow. npm shortcuts:
`npm run benchmark:flow`, `benchmark:flow-fsm`, `benchmark:flow-dag`.

## long-horizon.js — agent context retention

What `createAgent`'s `historyBudget` compaction keeps, and what it destroys.
The measurement drives the **real agent** through N tool rounds against a
recording stub client, then asks whether the fact needed to answer is present
in the request the client receives.

Two tasks, because they scale differently:

- **needle** (linear) — the question asks for one record's value. Answerable
  if that one round survives, and it degrades gracefully with the budget. This
  is the task compaction is designed for.
- **pairwise** (quadratic) — the question is a relation over *every* pair
  ("which two records have the closest values"). It needs all N facts at once,
  which makes it all-or-nothing: with one value missing the answer is not
  determined by what is visible, because an absent record could be closer to a
  visible one than the visible best pair is to each other.

Two numbers for each, and both are published:

- **ceiling** — model-free and deterministic: is the fact needed to answer
  present in the request at all? It needs no key, costs nothing and cannot
  flake, which makes it the tier CI runs and the right way to state a
  structural claim.
- **actual** — what a real model scores over the same contexts. The **gap** is
  the interesting quantity: a large gap means the information was there and the
  model failed to use it, which is a prompt problem rather than a context
  problem. Publishing only one of the two would let a later change claim a win
  it did not earn.

The two ceilings are **not the same kind of number**, and the run says so
rather than letting a reader assume:

- the **needle** ceiling is a hard upper bound — a value that is not in the
  context cannot be read out of it. Its *actual* is a `JAREN_AI_TRIALS`-sample
  estimate, though, so at three trials it carries a wide error bar and the
  hit count is printed beside every percentage;
- the **pairwise** ceiling is **determinacy**: does the context determine the
  answer at all? A model can still name the true closest pair out of a subset
  that happens to contain it, so a pairwise actual may legitimately land above
  its own ceiling. The model-free `pair survived` column reports exactly when
  that was available, and the run prints every above-ceiling row with the
  reason attached.

And two payload shapes, because the shape changes the answer. The built-in
synopsis excerpts the **first 60 characters** of a dropped tool result, so a
fact at the front usually rides out inside that excerpt and a fact behind the
padding does not. Both run; the table labels them `front` and `late`, and
`late` is the realistic one. Reporting only `front` would flatter the package,
which is why neither shape may be dropped.

```bash
node benchmark/long-horizon.js                    # the ceilings; no key needed
npm run benchmark:long-horizon                    # the same, with .env loaded
node --env-file-if-exists=.env benchmark/long-horizon.js --live
node benchmark/long-horizon.js --live --trials 1 --budgets 6000 --verbose
```

The live tier is **opt-in and never mandatory**: with no key the ceilings still
print and the run says the live tier was skipped and why, then exits 0. Its
configuration comes from the environment through one helper
([`lib/env.js`](./lib/env.js) — the only live-model environment reader in the
workspace), loaded by Node itself with `--env-file-if-exists=.env`; there is no
dotenv dependency and there must never be one. See [`.env.example`](../.env.example)
for the variables and the spend guards (`JAREN_AI_MAX_CALLS`,
`JAREN_AI_MAX_CONCURRENCY`, `JAREN_AI_TRIALS`), which are hard ceilings rather
than hints. The model id is printed beside the numbers, so a published result
can never be misattributed, and the key itself is never logged.

A live call that fails or runs past its deadline is counted, reported in full
(the listing is capped, the count is not) and leaves its row's `actual` **null**
rather than a guess. The live tier **streams**, and that is a measured decision
rather than a default: unstreamed, this benchmark lost 13 of 72 calls to a
300-second deadline, all on the tightest budgets — which reads convincingly like
a model thinking harder about a compacted context, and is not. The identical
request answered in 2.9 seconds streamed after hanging past 300 seconds
unstreamed. The deadline is now only a backstop.

Two measurement decisions worth knowing about:

- **The live tier replays the gathering and asks one question.** The forty tool
  rounds are produced by the same deterministic stub the ceiling uses; the model
  is then asked a single question over exactly the context that was scored. That
  isolates the quantity the ceiling bounds — given this context, can the model
  answer? — and costs one call per trial instead of forty.
- **Values are globally unique six-digit integers.** Unique so presence is
  testable with a plain `includes` and no proximity window; six digits so every
  record serializes to the same byte length whatever the seed, since compaction
  cuts at byte-counted round boundaries.

The probe has its own self-tests in `test/ai/benchmark-probe.test.js`, and they
are not decoration: two probe bugs (searching the *stringified* transcript,
where a tool result's quotes are escaped; and a proximity regex, where the
padding separates an id from its value) each read 0/40 on **every** row
including the uncapped control. The control reading 40/40 in both payload
shapes is what tells those apart from a real finding.

The generated file is `packages/website/public/benchmarks/long-horizon.json`
(`npm run benchmark:generate` writes it, and the Benchmarks page renders it).
A keyless regeneration republishes it with empty `actual` columns and the skip
reason in its own metadata, rather than keeping numbers it did not measure.

## retrieval.js — did the right memory reach the prompt

`@jarenjs/ai`'s `recall()` is tag match and recency by default, and ranks by
meaning only through an injected embedder (`recall({ near })`, refused without
the seam). This is the instrument both stand on — built before the ranker, so
the ranker could be measured rather than assumed. Over a seeded ledger corpus
with gold labels it scores, per policy, whether the right memory reached the
prompt — recall@1/5/10 (a gold memory in the top k), MRR (the reciprocal rank of
the best-ranked gold memory) and the latency of one recall call — against an
oracle ceiling. Five rows, at two corpus sizes:

- **oracle** — the gold ids first. The 1.000 row that proves the scorer, and the
  first thing the run asserts, before it prints anything;
- **random** — a seeded draw, asserted to sit inside its analytic band (k/n,
  adjusted for questions with more than one gold memory);
- **recency** — the newest k, which is what `recall()` answers with no tags;
- **tag+recency** — the default: the question's words that are corpus tags,
  fed to the real `ledger.recall({ tags, limit })` over a real ledger loaded
  through `addMemory`. Nothing is simulated; the row scores the shipped code path;
- **near** — the ranked path: `ledger.recall({ near: question, limit })` over the
  SAME ledger, swept through `embedMissing()` with the deterministic reference
  embedder (`createHashEmbedder`, hashed character trigrams, 64 dims). The
  embedder is **lexical, not semantic** — two texts score high when they share
  letters — so this row is a *mechanism* score: the sweep, the identity check,
  the cosine rank, the tie-break and the limit work end to end over the shipped
  code path, and the same-words distractors are exactly what a lexical signal
  cannot tell apart. It is published whichever way it falls against the default,
  and it says nothing about what an embedding model would do.

Every row runs over the swept ledger — the ledger a host that adopted the seam
has — so the tag rows' latency includes carrying a 64-float vector per record
through the in-memory adapter's JSON copy; the scores are unchanged by it.

The corpus ([`fixtures/retrieval-corpus.json`](./fixtures/retrieval-corpus.json),
written by `scripts/generate-retrieval-corpus.js`, seeded and byte-identical run
to run — a test proves it) is **synthetic**: <!--fact:retrieval.corpus-->240 facts over 20 topic vocabularies, 160 questions<!--/fact-->,
one gold memory per fact, and distractors built to defeat one cheap signal each —
the same tag with a different fact, and the same words with a different fact.
A quarter of the questions never name their topic, which is the honest failure
mode of any policy that starts from a tag; some questions have one gold memory
and some two or three, so recall@k is not trivially recall@1. The memory list is
a prefix design: the first 1 000 records are the small corpus and all 10 000 the
large one, so one question set scores both sizes.

What it measured, for the default, is that over <!--fact:retrieval.incumbent-->10,000 memories today's recall puts a gold memory in the top 10 for 1.3% of questions (recency alone 0.0%, a random draw 0.0%); at 1,000 memories the same policy reaches 17.5%<!--/fact-->.
The ranked path, through the reference embedder, reaches <!--fact:retrieval.ranked-->5.0% of questions at 10,000 memories through the hash-trigram-64 reference embedder (33.8% at 1,000), ahead of tag match and recency's 1.3%<!--/fact-->.
Read the rows as mechanism, not language: they say whether a POLICY can find the
right record among distractors, and nothing about whether any model understands
a question — no deterministic row involves one.

```bash
node benchmark/retrieval.js                         # both sizes, the table
npm run benchmark:retrieval                         # the same
node benchmark/retrieval.js --sizes 1000 --verbose  # one size, plus every question the incumbent missed
node benchmark/retrieval.js --output json --filepath out.json
```

`--live` adds a second ranked row, **near-live**: the corpus is loaded into a
second ledger (one ledger holds one vector identity — a mixture is refused),
swept through `createEmbeddingClient` against the provider
[`lib/env.js`](./lib/env.js) resolves and the `/embeddings` model in
`JAREN_AI_EMBED_MODEL`, and every question is embedded once. The model id prints
beside the row and lands in `meta.live`; the deterministic rows are exactly what
they are without the flag. The spend guard `JAREN_AI_MAX_CALLS` is honoured up
front — a size whose sweep plus questions would exceed it is skipped with that
reason, never half-spent — and a missing key or model is a stated skip, never a
failure. It is never a test dependency, and the tracked file is always generated
without it: this suite publishes no model-quality number as its own.

```bash
JAREN_AI_PROVIDER=ollama JAREN_AI_EMBED_MODEL=nomic-embed-text \
  node --env-file-if-exists=.env benchmark/retrieval.js --live --sizes 1000
```

The corpus and the scorer have their own tests in
`test/ai/retrieval-corpus.test.js`: the generator's two-run byte-identity and
its agreement with the committed fixture, the corpus invariants (every gold id
exists inside the smallest prefix; every fact is asked exactly once), the oracle
and random gates, and a kill-check that the gate refuses a broken oracle.

The generated file is `packages/website/public/benchmarks/retrieval.json`
(`npm run benchmark:generate` writes it, and the Benchmarks page renders it).

`--store=db` adds four **durable** rows beside the in-memory ones: the same
corpus written through a `@jarenjs/db` storage adapter
([`lib/ledger-db.js`](./lib/ledger-db.js), the recipe `packages/ai`'s README
publishes), scored by the same policies, with the ranked path measured twice —
once answered by the store's k-nearest plan over a packed vector column
(`via: 'adapter'`) and once by the ledger reading every record back
(`via: 'sweep'`). Their quality columns are **asserted equal** to the in-memory
rows' before anything prints: three executors of one ordering, and only the
latency column is allowed to move. The flag is a hand-run mode; the tracked file
is always generated without it.

```bash
node benchmark/retrieval.js --store=db              # both sizes, nine rows
```

## vector.js — k-nearest over a stored column, every way it runs

The `@jarenjs/db` store can hold each document's embedding as a packed,
l2-normalized Float32 `BLOB` column (`derive: 'vector'`), and plans "the k most
similar" as a **cut the engine finishes**: the column narrows the candidates,
the engine orders them, the winners' documents are fetched. This suite measures
that decision against every alternative, over seeded unit vectors loaded through
the real write path at two corpus sizes and two widths:

1. **engine resident sweep** — the kernels over a contiguous `Float32Array` in
   RAM. No database at all, and the row the store has to be *worth* rather than
   beat: it starts from decoded floats and pays nothing for durability;
2. **the k-nearest plan** — `collection.execute` end to end, the flagship row;
3. **raw fetch + engine sweep** — the plan's own statement (read out of
   `explain()`, never typed) run by hand, which isolates what the plan costs;
4. **`ORDER BY` over a registered function** — the shape the store deliberately
   does *not* emit, re-measured against the real column so the decision is a
   number rather than a memory;
5. **JSON-doc sweep** — the same query document over a twin collection with no
   vector column: the row the column exists to beat;
6. **sqlite-vec** — the extension built for this, over the same bytes in a
   `vec0` table, same k, same probes.

**Equivalence before timing, and refusal on disagreement.** The stored column is
compared byte for byte against what `@jarenjs/core/vector` packs, then paths 1–5
must return the identical top-k — ids and order — for every probe of every leg
before a single number prints. The rival is compared the same way and every
disagreement is counted into a **named class with a pinned size**: a rival that
answers differently is a finding, not a reason to drop the row.

**Both halves of the price.** The read is the query table; the write is the load
row (the same documents inserted in one transaction with and without the index —
the column costs a JSON round trip of the member plus a normalize and a pack on
every write), and the storage table carries what the column holds against what a
vector costs as JSON inside the document it is derived from.

**The ceiling is published as arithmetic.** Exact brute force is linear in
`n · d`; the suite fits the measured slope and states the corpus size at which
one query crosses 100 ms and one second, for both engines. Past that, this
design is the wrong tool and no margin changes it.

```bash
node benchmark/vector.js                            # the full grid
npm run benchmark:vector                            # the same
node benchmark/vector.js --quick                    # one small leg
node benchmark/vector.js --check-only               # equivalence only, no timings
node benchmark/vector.js --sizes 10000 --dims 768
node benchmark/vector.js --output json --filepath out.json
```

The rival is a devDependency of this workspace (`sqlite-vec`), loaded into
`node:sqlite` with `allowExtension`. A host where it does not load still
publishes every other row, with the exact loader error recorded beside the one
it cannot: a dropped rival row would be the one kind of missing number a reader
could not see.

The generated file is `packages/website/public/benchmarks/vector.json`.

## qt3-runner.js — the W3C QT3 scorecard

Runs the complete W3C QT3 suite (31,821 XQuery/XPath 3.1 test cases) against
the query engine through the XQuery text front-end, classifying every case
into a tier and attributing every failure to a documented deviation — a
committed baseline (`qt3-baseline.json`) makes any behavioral change visible
and fails CI on regressions.

```bash
git submodule update --init benchmark/qt3tests   # once
npm run qt3:convert                              # XML -> benchmark/qt3-json/
npm run benchmark:qt3                            # the scorecard (~0.7 s)
```

The tier definitions, deviation-id registry and baseline workflow are
documented in [qt3-README.md](./qt3-README.md).

## Workspace notes

- Competitor engines (`ajv`, `json-p3`, `fontoxpath`, `jsonata`,
  `jsonpointer`, `fast-xml-parser`, `marked`, `markdown-it`, `micromark`,
  `@mermaid-js/parser`, `mermaid`, `jsdom`, `pouchdb`, `rxdb`, `lowdb`,
  `prisma`/`@prisma/client`, `drizzle-orm`, `better-sqlite3`, `kysely`,
  `sqlite-vec`)
  are devDependencies of this benchmark workspace only — the `packages/*` and `components/*`
  workspaces stay zero-dependency. (`mermaid` + `jsdom` power the
  flowchart/sequence Jison head-to-head; `@mermaid-js/parser` the pie
  head-to-head.)
- Adaptor files under [`adaptors/`](./adaptors/) express each scenario
  idiomatically per engine and document the fairness decisions (e.g.
  fontoxpath's one-time XDM pre-conversion, jsonata's awaited async
  `evaluate()`).
- All profile numbers in package READMEs state the date and Node version they
  were measured with; run-to-run spread on micro-timings is real, so treat
  pass/fail counts as the invariant and ratios as indicative.

## orm.js — the phase-B ORM head-to-head

`node benchmark/orm.js` (and `bun benchmark/orm.js` for the Bun table)
measures `@jarenjs/db`'s entities against Prisma, Drizzle and Kysely
over SQLite: inserts (single/batched/validated), point reads, indexed
predicates at three selectivities, the two-level graph load WITH
STATEMENT COUNTS beside the timings (the structural claim — one
statement versus round trips), aggregate+group over a join, offset
versus keyset pagination at depth, updates (the unit of work versus
prepared statements), cold start (fresh process, median of three), and
a nested-JSON member filter both indexed and unindexed.

Fairness: every engine gets WAL and a fresh file database; every
engine must answer the SAME normalized result before it is timed
(`lib/equals.js`); each rival runs its own documented fast route
(Prisma's generated client with a warmed engine and `$on('query')`
statement counting; Drizzle's prepared statements and relational query
builder; Kysely as the hand-written-SQL contrast). Prisma's SQLite
connector has no Json field type, so its JSONB rows run its only
available route — fetch and filter in JS — stated beside the number.
On Bun, Kysely and Prisma have no first-party `bun:sqlite` route and
are Node-only rows; the capability cliff (no UDF hatch, no session
capture) is stated beside the Bun tables. The losses stay in the
tables with their reasons.

**Run-to-run spread, measured rather than assumed.** Three unchanged
runs of this suite on one host (Node v24.19.0, Linux x86_64) at the
campaign's close-out put 9 of 78 Node figures beyond the ±10 % this
repository's README quotes for micro-timings, the widest at 16.7 %, and
moved the graph-load headline across 9.0× / 6.7× / 7.1×. **Treat this
suite as noisier than ±10 %**: the numbers are file-database work at a
500-user corpus, where a page-cache miss is a visible fraction of a row.
What does NOT move between runs is what the suite is for — the statement
counts, and the equality every engine must produce before it is timed.
Read a ratio here as a band, and read a statement count as a fact.

The `@jarenjs/linq/db` client is one more route in every table: the
same store reached through its typed front door — a chain per read
(`where`/`orderBy`/`skip`/`take` pushed down, the keyset page spelled
as the rivals spell it), the include builder for the graph and the
count rows, the unit of work for the update — verified equal before it
is timed and counted by a counting driver, so the price of the door
itself is a published row beside the hand-written documents. Its reads
run unvalidated like the store rows; the one validated client row is
the DEFAULT door (`open()` without a `validator`, formats asserting),
stated as such.

## db.js — the store, the chain, and what a pen costs to write

`node benchmark/db.js` measures `@jarenjs/db` against the JavaScript
document stores a reader would shortlist (PouchDB over pouchdb-find,
RxDB over its memory storage, lowdb as the object-with-a-veneer floor),
with `--docs N` for the corpus size. Its headline is jaren-only and
structural: the same query document through the pushdown planner versus
forced to the residual (`pushdown: false`) — what translating a query to
SQL is worth, measured rather than argued. Every engine must answer the
same normalized result before a timer starts, and each engine's storage
adapter is printed beside its rows; the async engines are timed through
their async APIs, and jaren's async row pays that toll beside its
`store.sync` row.

Two tables in it are about `@jarenjs/linq` rather than the store:

- **the chain in memory** — a hand-written loop, the chain, and the
  chain's pre-compiled document, over the same rows. The chain
  re-captures and re-emits on every call by design, so the third row is
  what holding the `Sequence` (or the document) buys.
- **what one DEFINITION costs to build** — the schema, model, JSLT and
  migration pens against the hand-written literal each must emit byte
  for byte, in ns per build. This is a **build-time** price, paid once
  per definition at module load, never per request: the row exists so
  that "types for free" is not published without its cost. Each pen row
  is asserted `deepEquals` its literal before it is timed, and the
  migration row's literal computes the same two shape hashes the pen
  does, because a hand-written `$migration` document has to carry them
  too.

The suite needs `rxdb`'s `rxjs` peer installed; it is declared in
`benchmark/package.json` so that a checkout of the repository's own lock
can run it.
