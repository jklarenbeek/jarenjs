// fontoxpath adaptor for benchmark/jsonquery.js
//
// fontoxpath is a real XQuery 3.1 engine for JavaScript — the closest
// honest comparison for the Jaren JSON Query engine's semantics. Caveats
// that keep the comparison fair, all applied here:
//
// - fontoxpath is XML-first: JSON travels as XDM maps/arrays bound to an
//   external variable ($doc), navigated with `?` lookups. Passing a plain
//   JS object converts it to XDM on *every* evaluateXPath call (~12 ms for
//   a 10k-book store), so `prepare` converts the document ONCE through
//   createTypedValueFactory — the same one-time cost jaren pays implicitly
//   by operating on plain JS values.
// - `group by` is not implemented by fontoxpath (it throws "Not
//   implemented: groupByClause"); the group scenario is n/a.
// - There is no public compile-only API, but compiled expressions are
//   cached by source string: the compile benchmark times evaluation of
//   fresh unique-comment sources against a tiny document, then subtracts a
//   second (fully cached) pass over the same sources.
// - XDM maps are unordered; result objects may serialize keys in a
//   different order than jaren's. Equivalence comparison is key-order
//   insensitive, so this does not matter.

import { createRequire } from 'module';
import fx from 'fontoxpath';

const require = createRequire(import.meta.url);
const VERSION = require('fontoxpath/package.json').version;

const OPTIONS = { language: fx.evaluateXPath.XQUERY_3_1_LANGUAGE };

const SINGULAR_SRC = '$doc?store?book?3?title'; // XQuery lookups are 1-based

const FILTER_SRC = `
  for $b in $doc?store?book?*
  where $b?price lt 10
  order by $b?price
  return map { "title": $b?title, "price": $b?price }`;

const JOIN_SRC = `
  for $b in $doc?store?book?*, $r in $doc?ratings?*
  where $b?isbn = $r?isbn
  order by $b?price
  return map { "title": $b?title, "stars": $r?stars }`;

const RESHAPE_SRC = `
  map { "catalog": array { for $b in $doc?store?book?*
          return map { "id": ($b?isbn, $b?title)[1],
                       "label": concat($b?title, " by ", $b?author),
                       "pricing": map { "list": $b?price,
                                        "discounted": $b?price * 0.9 } } },
        "bike": map { "color": $doc?store?bicycle?color } }`;

const SOURCES = {
  singular: SINGULAR_SRC,
  filter: FILTER_SRC,
  join: JOIN_SRC,
  reshape: RESHAPE_SRC,
};

function scenario(source) {
  return {
    source: source.trim(),
    compile: () => source, // fontoxpath compiles internally, keyed by source
    run: (compiled, ctx) =>
      fx.evaluateXPath(compiled, null, null, { doc: ctx }, fx.evaluateXPath.ALL_RESULTS_TYPE, OPTIONS),
  };
}

export async function load() {
  const toXdm = fx.createTypedValueFactory('map(*)');

  return {
    key: 'fontoxpath',
    name: `fontoxpath@${VERSION}`,
    isAsync: false,
    prepare: (document) => toXdm(document, fx.domFacade),
    scenarios: {
      singular: scenario(SINGULAR_SRC),
      filter: scenario(FILTER_SRC),
      join: scenario(JOIN_SRC),
      group: null, // fontoxpath: "Not implemented: groupByClause is not implemented yet."
      reshape: scenario(RESHAPE_SRC),
    },
    notes: {
      group: 'fontoxpath does not implement the XQuery group by clause',
    },
    compileBench: (sources) => {
      const texts = sources.map((key) => SOURCES[key]).filter((s) => s !== undefined);
      // the sources evaluate too (compile is not separable), so the tiny
      // document must satisfy them: ?3 needs at least three books
      const tiny = toXdm({
        store: {
          book: [
            { title: 'a', author: 'x', price: 1 },
            { title: 'b', author: 'y', price: 2 },
            { title: 'c', author: 'z', price: 3 },
          ],
          bicycle: { color: 'red' },
        },
        ratings: [],
      }, fx.domFacade);
      const evalAll = (i) => {
        for (const text of texts)
          fx.evaluateXPath(`${text}\n(: compile-bench ${i} :)`, null, null, { doc: tiny }, fx.evaluateXPath.ALL_RESULTS_TYPE, OPTIONS);
      };
      // fn sees each unique source for the first time (compile + tiny eval);
      // baseline re-evaluates the now-cached sources (tiny eval only).
      return { fn: evalAll, baseline: evalAll, perCall: texts.length };
    },
  };
}
