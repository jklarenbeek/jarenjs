# Vendored W3C QT3 cases

`cases.json` holds test cases of the W3C QT3 test suite
([w3c/qt3tests](https://github.com/w3c/qt3tests)) at revision
`201a6e466940cdfc727f4babfedcde5332b9f578`, in the JSON form
`benchmark/tools/qt3-convert.js` writes (`npm run qt3:convert`), each with its
environment resolved inline. They come from these upstream catalogs:

- `fn/format-number.xml` and `app/spec-examples.xml` (`fn:format-number`,
  with and without an environment's `decimal-format` declarations);
- `fn/tokenize.xml`, `fn/translate.xml`, `fn/substring-before.xml` and
  `fn/substring-after.xml`;
- `op/dateTime-less-than.xml`, `op/time-equal.xml`, `op/date-greater-than.xml`,
  `op/dateTime-equal.xml`, `prod/CastExpr.xml`, `prod/CastableExpr.xml`,
  `prod/WhereClause.xml` and `misc/CombinedErrorCodes.xml`.

They are vendored rather than read from the `benchmark/qt3tests` submodule (or
its gitignored conversion) so the test runs in a fresh clone with no submodule
checkout. `test/json/xquery/qt3-cases.test.js` runs each one through the QT3
harness (`benchmark/qt3-runner.js`): the XQuery front-end, the engine and the
harness's own reading of the case's environment and assertions.

To refresh: re-run the conversion, copy the cases by name from
`benchmark/qt3-json/`, and update the revision above.
