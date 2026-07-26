# Vendored host format suites

`iri.json`, `iri-reference.json` and `idn-hostname.json` are copied verbatim
from the official [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite),
`tests/draft2020-12/optional/format/`, at revision
`8ef15501fa68155dcae3ec2431492dae5039a02a`.

They are vendored rather than read from the `benchmark/suite` submodule so the
conformance test runs in a fresh clone with no submodule checkout, matching how
`test/json/fixtures/pointer-format/` vendors the pointer suites.

`test/core/text/host-format.test.js` runs every case directly against the
testers in `@jarenjs/core/text` (`isValidIRI`, `isValidIRIRef`,
`isValidIdnHostname`). Running the testers rather than compiling a 2020-12
schema is deliberate: under 2020-12 `format` is annotation-only by default, so
a schema-level run would pass every case vacuously and assert nothing.

These three carry the grammars with the most room to drift — the RFC 3987
character classes and the IDNA label rules — so they are the suites worth
pinning next to the hand-written unit tests in `host.test.js`.

To refresh: re-copy from the submodule and update the revision above.
