# Vendored pointer format suites

`json-pointer.json` and `relative-json-pointer.json` are copied verbatim from
the official [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite),
`tests/draft2020-12/optional/format/`, at revision
`8ef15501fa68155dcae3ec2431492dae5039a02a`.

They are vendored rather than read from the `benchmark/suite` submodule so the
conformance test runs in a fresh clone with no submodule checkout, matching how
`test/json/fixtures/json-patch/` vendors the official JSON Patch suite.

`test/json/pointer-format.test.js` runs every case directly against the format
**testers** (`isValidJSONPointer`, `isValidRelativeJSONPointer`). Running the
testers rather than compiling a 2020-12 schema is deliberate: under 2020-12
`format` is annotation-only by default, so a schema-level run would pass every
case vacuously and assert nothing.

To refresh: re-copy from the submodule and update the revision above.
