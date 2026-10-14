# Vendored CommonMark specification

`spec.txt` is copied verbatim from the
[CommonMark specification](https://github.com/commonmark/commonmark-spec)
(`spec.txt`, version 0.31.2) at revision
`3da939428d80f146f270cd1765e4ba462e96bb1b`. The specification is released
under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) by John
MacFarlane and is redistributed here unchanged under that licence.

It is vendored rather than read from the `benchmark/commonmark-spec` submodule
so the round-trip corpus tests run in a fresh clone and on CI with no
submodule checkout. `test/md/roundtrip.test.js`, `test/md/to-html.test.js` and
`test/md/printer-runs.test.js` read the examples embedded in it with
`extractExamples` (`benchmark/lib/commonmark.js`).

To refresh: re-copy from the submodule and update the revision above.
