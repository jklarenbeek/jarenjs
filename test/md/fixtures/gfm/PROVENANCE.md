# Vendored GitHub Flavored Markdown specification

`spec.txt` is copied verbatim from the
[cmark-gfm](https://github.com/github/cmark-gfm) repository (`test/spec.txt`,
GitHub Flavored Markdown spec 0.29) at revision
`499789b49373bfa045d0e7547e5ee63444c77bca`. The specification is released
under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) by John
MacFarlane and the cmark-gfm contributors and is
redistributed here unchanged under that licence.

It is vendored rather than read from the `benchmark/gfm-spec` submodule so the
round-trip corpus tests run in a fresh clone and on CI with no submodule
checkout. `test/md/roundtrip.test.js`, `test/md/gfm.test.js` and
`test/md/printer-runs.test.js` read
the examples embedded in it with `extractExamples`
(`benchmark/lib/commonmark.js`).

To refresh: re-copy from the submodule and update the revision above.
