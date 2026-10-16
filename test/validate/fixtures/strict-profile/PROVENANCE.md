# Vendored suite groups for the strict-profile contract

`draft2020-12-accepted.json` holds every test group of the official
[JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite)
`tests/draft2020-12/*.json` files (the top level, not `optional/`) at revision
`8ef15501fa68155dcae3ec2431492dae5039a02a` whose schema `deriveStrictProfile`
accepts. Each group is copied verbatim (`description`, `schema`, `tests`), with
one added member, `file`, naming the upstream file it came from.

They are vendored rather than read from the `benchmark/suite` submodule so the
contract test runs in a fresh clone with no submodule checkout. Where the
submodule is checked out, `test/validate/strict-profile.test.js` also derives
every group of those files and proves that exactly these are accepted and every
other one is refused with a code.

To refresh: re-derive over the submodule's files, copy the accepted groups, and
update the revision above.
