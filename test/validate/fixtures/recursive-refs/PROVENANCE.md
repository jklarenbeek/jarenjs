# Vendored recursive-reference suites

The four suite files are copied verbatim from the official
[JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite)
at revision `8ef15501fa68155dcae3ec2431492dae5039a02a`, renamed by draft:

| File | Upstream path |
|---|---|
| `draft7-ref.json` | `tests/draft7/ref.json` |
| `draft2019-09-recursiveRef.json` | `tests/draft2019-09/recursiveRef.json` |
| `draft2020-12-ref.json` | `tests/draft2020-12/ref.json` |
| `draft2020-12-dynamicRef.json` | `tests/draft2020-12/dynamicRef.json` |

`remotes/draft2020-12/` holds the three remote documents those cases load,
copied verbatim from `remotes/draft2020-12/` at the same revision; the test
registers them under `http://localhost:1234/draft2020-12/`, as the suite's
harness serves them.

They are vendored rather than read from the `benchmark/suite` submodule so the
test runs in a fresh clone with no submodule checkout.
`test/validate/reference-depth.test.js` runs every case, so recursion that
descends into the instance keeps validating under the reference depth bound,
and no case is refused as a loop that never reads the instance.

To refresh: re-copy from the submodule and update the revision above.
