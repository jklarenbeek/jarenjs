# Vendored remote-reference suites

Copied verbatim from the official
[JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite)
at revision `8ef15501fa68155dcae3ec2431492dae5039a02a`, at their upstream
paths:

| Path here | Upstream path |
|---|---|
| `remotes/**` | `remotes/**`, every file except those under `remotes/draft-next/` |
| `tests/draft7/refRemote.json` | `tests/draft7/refRemote.json` |
| `tests/draft2019-09/ref.json` | `tests/draft2019-09/ref.json` |
| `tests/draft2019-09/refRemote.json` | `tests/draft2019-09/refRemote.json` |
| `tests/draft2019-09/vocabulary.json` | `tests/draft2019-09/vocabulary.json` |
| `tests/draft2020-12/refRemote.json` | `tests/draft2020-12/refRemote.json` |
| `tests/draft2020-12/vocabulary.json` | `tests/draft2020-12/vocabulary.json` |
| `tests/draft2020-12/optional/format-assertion.json` | `tests/draft2020-12/optional/format-assertion.json` |

The suite's harness serves `remotes/` at `http://localhost:1234/`;
`test/validate/compile-async-suite.test.js` serves them from memory at the same
URIs through a `loadSchema` function. It also runs `tests/draft7/ref.json`,
`tests/draft2020-12/ref.json` and `tests/draft2020-12/dynamicRef.json` from
`../recursive-refs/`, vendored at the same revision.

They are vendored rather than read from the `benchmark/suite` submodule so the
test runs in a fresh clone with no submodule checkout.

To refresh: re-copy from the submodule and update the revision above.
