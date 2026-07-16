# QT3 compliance harness

A tiered scorecard that runs the [W3C QT3 test suite](https://github.com/w3c/qt3tests)
(the official XQuery/XPath 3.1 suite) against the Jaren JSON Query engine through
its XQuery text front-end (`@jarenjs/json/xquery`). The point is **legible partial
compliance**: the engine implements XQuery 3.1 *semantics* over the JSON data
model (QUERY-FORMAT.md), and the front-end implements a defined XQuery *subset*
(XQUERY-FRONTEND.md) — so no pass rate near 100% is possible or intended. Instead,
every test case is classified into a tier, every failure is attributed, and the
committed baseline makes any *change* in behavior visible.

## Running it

```sh
git submodule update --init benchmark/qt3tests   # once, ~60 MB
npm run qt3:convert                              # XML -> benchmark/qt3-json/ (regenerate after suite updates)
npm run benchmark:qt3                            # the scorecard
```

Runner options:

```sh
node benchmark/qt3-runner.js map-size            # only sets/cases whose name contains the string
node benchmark/qt3-runner.js --verbose           # per-set table, top unsupported constructs, all failures
node benchmark/qt3-runner.js --dump out.json     # per-case results as JSON (for triage)
node benchmark/qt3-runner.js --seed-baseline     # write qt3-baseline.seed.json (see below)
```

The exit code is nonzero when there are **regressions** — tier-A failures not in
the baseline, or a pass count below the baseline's recorded count — so the run is
CI-friendly.

## The pieces

| File | Role |
|---|---|
| `benchmark/qt3tests/` | git submodule, the source of truth |
| `benchmark/tools/qt3-convert.js` | XML → JSON converter (deterministic; `fast-xml-parser` is a benchmark-workspace devDependency — packages stay zero-dep) |
| `benchmark/qt3-json/` | generated, gitignored: one JSON per test set + `index.json` |
| `benchmark/qt3-classify.js` | the tier classifier (importable; CLI prints tier counts) |
| `benchmark/qt3-runner.js` | the runner + scorecard |
| `benchmark/qt3-baseline.json` | committed: every attributed tier-A failure + expected pass count |

## Tiers and buckets

Classification happens **before** running, from converted metadata only
(`qt3-classify.js`):

- **C — out of scope, never run**: dependencies on XML/XSD machinery the JSON
  engine cannot have (schema import/validation/awareness, higher-order functions,
  static typing, modules, serialization, XSLT interop, DTDs, collations, ...);
  spec dependencies that exclude XQuery/XPath 3.1; environments with XML source
  documents or collections; XML-shaped result assertions (`assert-xml`,
  `serialization-matches`, ...); tests with library modules.
- **A — applicable**: everything else.

Each tier-A case then lands in one runtime bucket:

| Bucket | Meaning |
|---|---|
| `pass` | assertions satisfied |
| `unsupported-syntax` | the front-end rejected the query (or an assertion expression) with a named `unsupported ...` error — measures **front-end subset coverage**, not engine correctness |
| `reclassified-C` | metadata looked applicable but the case needs non-JSON values (params or `assert-type` types outside the JSON model: dates, durations, QNames, ...) |
| `fail-by-design` | failing, listed in the baseline with a deviation id |
| `known-bug` | failing, listed in the baseline as a bug |
| `fail` | failing, **not** in the baseline — the regression signal |

## Reading assertions in the JSON model

Assertion kinds are evaluated in JS (`assert-true/false`, `assert-empty`,
`assert-count`, `assert-eq`, `assert-deep-eq`, `assert-string-value`,
`assert-permutation`, `assert-type`, `error`, `any-of`/`all-of`/`not`), with two
bootstraps: expected values of `assert-eq`/`assert-deep-eq`/`assert-permutation`
and the arbitrary-XPath `assert` kind are parsed with `parseXQuery` and evaluated
by the engine itself (`$result` is bound via an external). The result sequence is
extracted faithfully by compiling `[query]` — the JSON array constructor flattens
the result sequence into array members, so there is no singleton-vs-sequence
ambiguity.

Divergences from XDM to keep in mind when triaging:

- **Equality is the engine's** (`equalsJson`): deep structural JSON equality,
  numbers mathematically, `NaN` equal to nothing, `-0` equal to `0`. XDM's
  `fn:deep-equal` treats `NaN` as equal to itself, and compares untyped atomics
  after casting; neither applies to the JSON model, where every item already has
  exactly one type. Tests relying on those XDM rules fail and are baselined.
- **String values** use the engine's `$string` cast table: JS number
  serialization (`Infinity`, `1e+21`) rather than XDM canonical form (`INF`,
  `1.0E21`); arrays/objects have no string value (the assertion fails).
- **Error codes** match by family via the spec's mapping column
  (QUERY-FORMAT.md §10): e.g. expected `XPTY0004` accepts `JQ2001`/`JQ2004`/
  `JQ2005`; expected `XPST0003` accepts a front-end syntax error. An expected
  code with no JQ mapping fails and is triaged into the baseline.
- `assert-type` maps coarsely: `xs:integer|decimal|double|float|numeric|string|
  boolean|anyAtomicType`, `map(*)`, `array(*)`, `item()`, occurrence indicators,
  `empty-sequence()`. Anything else reclassifies the case to tier C.

## The baseline

`benchmark/qt3-baseline.json` is the committed contract:

```json
{
  "summary": { "pass": 1234, "unsupported-syntax": 5678 },
  "tests": {
    "some-test-name": { "status": "deviation", "id": "D6", "note": "0-based positions" },
    "other-test-name": { "status": "bug", "issue": "..." },
    "huge-range-test": { "status": "bug", "skip": true, "issue": "OOM before JQ2007 guard" }
  }
}
```

- `status: "deviation"` — fails **by design**; `id` names the documented
  deviation. Three id families:
  - **Spec deviations** (QUERY-FORMAT.md §11): `D1` doubles (includes integer
    precision, IEEE division by zero, JS number-to-string forms like
    `Infinity`/`1e+21`/`-0` → `"0"`), `D2` structural equality (an array item
    compares structurally, never atomized), `D3` EBV of arrays/objects is true,
    `D5` I-Regexp not XSD regex (invalid patterns → `false`, no captures/
    back-refs/anchors/flags, literal replacements), `D6` 0-based positions
    (`index-of` results, `at`/`count` variables).
  - **Engine rules** (QUERY-FORMAT.md §§8.4–8.10): `E1` only numbers order with
    numbers and strings with strings — every other pair (booleans, mixed types)
    compares `false` or is `JQ2001`/`JQ2005`, never XQuery's answer; `E2` no XDM
    atomization or coercion — aggregates treat an array as one item, `$string`
    propagates the empty sequence, string parameters read empty as `""`,
    computed map keys must be strings.
  - **Front-end approximations** (XQUERY-FRONTEND.md §§3–5): `F1` value
    comparisons mapped to general comparisons (`false` instead of empty/
    XPTY0004), `F2` square array constructors flatten their members (unused so
    far), `F3` lookups map to `$get` (empty instead of type/range errors,
    non-variable sequence bases are single items), `F4` the version/encoding
    declaration is parsed and ignored (no `XQST0031`/`XQST0087`), `F5`
    `fn:number` maps to the stricter `$number` cast (`JQ2001` instead of `NaN`),
    `F6` XPath-only grammar restrictions do not apply (the front-end parses
    XQuery 3.1).
- `status: "bug"` — fails and should not; `issue` describes it. Real bugs are
  wins: fix the trivial ones, keep the rest listed here.
- `skip: true` — never run in-process: the query exhausts the heap (e.g.
  `1 to 3000000000` materializes before the 2³² `JQ2007` guard can fire, since
  the engine's sequences are eager arrays). Counted under its `status`.
- `summary.pass` — a full run must pass at least this many cases, so a
  pass → unsupported/reclassified flip cannot slip through unnoticed.

### Updating the baseline

After an engine or front-end change (or a suite submodule bump):

1. `npm run benchmark:qt3` — read the report.
2. **Surprises** (baseline entries that now pass): delete those entries, then
   raise `summary.pass` to the new pass count.
3. **Regressions**: fix them, or — only when attributable — add entries. Use
   `--seed-baseline` to write `qt3-baseline.seed.json` containing every current
   unattributed failure as an untriaged `bug` entry plus the current summary
   counts; triage each entry (deviation vs bug), then merge it into
   `qt3-baseline.json`. Never commit unattributed entries as deviations.
