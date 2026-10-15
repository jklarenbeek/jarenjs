# Vendored output-format examples and suites

Three sources, each pinned to a revision:

| File | Upstream |
|---|---|
| `spec-2020-12.json` | The examples of JSON Schema 2020-12 Core ([draft-bhutton-json-schema-01](https://www.ietf.org/archive/id/draft-bhutton-json-schema-01.txt)) section 12.4: the polygon schema and instance, its `flag`, `basic` and `detailed` results (12.4.1–12.4.3), and the schema, instance and result of the `verbose` example (12.4.4) |
| `spec-output.json` | The examples of [json-schema-spec](https://github.com/json-schema-org/json-schema-spec) `specs/output/jsonschema-validation-output-machines.md` at revision `4f56a9900674b27804f0ec32e3b7fdfa4efad695`: the example schema, the failing and passing instances, and the `flag`, `list` and `hierarchical` results, in the order the document gives them |
| `suite-draft2020-12-*.json`, `suite-draft-next-*.json` | Copied verbatim from the [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) at revision `8ef15501fa68155dcae3ec2431492dae5039a02a`: `output-tests/draft2020-12/content/<name>.json` and `output-tests/draft-next/content/<name>.json`, and each folder's `output-schema.json` as `suite-<draft>-output-schema.json` |

The two `spec-*.json` files are transcriptions: each example is the JSON value
of one code block, parsed as it is printed, with two repairs. The 2020-12 text
breaks long strings across lines and pages (the page headers and footers are
dropped, the line breaks fall between JSON tokens), and its `verbose` example
schema has a trailing comma after `"validProp": true`, removed here.

They are vendored rather than read from the `benchmark/suite` submodule or the
network so the test runs in a fresh clone. `test/validate/output-format.test.js`
compares every example with what a validator compiled with the matching
`outputFormat` returns, and validates every suite case's output against the
suite's own output schema.

To refresh: re-copy the suite files from the submodule, re-transcribe the
examples from the revisions above, and update the revisions.
