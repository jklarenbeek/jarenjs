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
| [`jslt.js`](./jslt.js) | JSLT performance vs native JS/JSONata | Benchmarking identity sharing, recursive dispatch, modes |
| [`csv.js`](./csv.js) | CSV conformance, self-healing and performance vs the sync npm parsers | Benchmarking the josl CSV reader/writer |
| [`markdown.js`](./markdown.js) | CommonMark scorecard + performance vs marked/markdown-it/micromark | Benchmarking the Markdown engine |
| [`mermaid.js`](./mermaid.js) | Mermaid coverage scorecard + parse speed | Benchmarking the headless Mermaid engine |
| [`flow-fsm.js`](./flow-fsm.js) | FSM compile/transition vs XState v5 + the serializability wedge | Benchmarking `@jarenjs/flow` machines |
| [`flow-dag.js`](./flow-dag.js) | Dag abstraction price vs a hand-written baseline | Benchmarking `@jarenjs/flow` dataflow |
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

Analyzes which functions are touched — and which are not — when running the
official test suite and/or the repository unit tests. Coverage from every run
is merged into a single report, so you get one complete picture to decide
where tests are missing and what might be dead code:

```bash
# The full picture: every draft of the official suite PLUS the unit tests
node benchmark/coverage.js --all --unit-tests

# Complete official suite (draft7, 2019-09, 2020-12) with per-function detail
node benchmark/coverage.js --all --functions

# Machine readable output for diffing between runs
node benchmark/coverage.js --all --unit-tests --json coverage/analysis.json

# What does a single suite file touch?
node benchmark/coverage.js '/required.json' --threshold 25

# Show TOUCHED and NOT touched functions with hit counts
node benchmark/coverage.js '/required.json' --functions

# Full options
What to run (combine freely; at least one is required):
  <testfile.json>    Cover a single official-suite file (e.g. '/ref.json')
  --all              Cover the COMPLETE official suite (all drafts)
  --unit-tests       Cover the repository unit tests (node --test test/)

Options:
  --draft <list>     Draft(s) to run, comma separated
                     (default for --all: draft7,draft2019-09,draft2020-12)
  --iterations <n>   Profiling iterations (default: 1 with --all, 1000 single file)
  --threshold <n>    Only show files with function coverage > n% (default: 0)
  --functions        Show TOUCHED and NOT touched functions
  --touched-only     Show only TOUCHED functions
  --json <path>      Write the full analysis as JSON
  --temp-dir <dir>   Temporary directory for V8 coverage data
```

The report ends with three actionable sections: **untouched functions**
(add tests or consider removal), **files with 0% function coverage**, and
**files never loaded at all** — the strongest dead-code candidates.

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
  `prisma`/`@prisma/client`, `drizzle-orm`, `better-sqlite3`, `kysely`)
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
