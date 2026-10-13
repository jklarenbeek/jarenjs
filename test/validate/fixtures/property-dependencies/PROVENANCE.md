# Vendored draft-next suite files

`propertyDependencies.json`, `unevaluatedProperties.json`,
`additionalProperties.json` and `dynamicRef.json` are copied verbatim from
the official [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite),
`tests/draft-next/`, at revision
`8ef15501fa68155dcae3ec2431492dae5039a02a`.

They are vendored rather than read from the `benchmark/suite` submodule so the
conformance test runs in a fresh clone with no submodule checkout, matching how
`test/json/fixtures/pointer-format/` vendors the format suites.

`test/validate/property-dependencies.test.js` runs every case of
`propertyDependencies.json`, and every group of the other three files whose
schema uses the keyword, with the `propertyDependencies` option on.

To refresh: re-copy from the submodule and update the revision above.
