// JSONata adaptor for benchmark/jsonquery.js
//
// JSONata is the popular practical JSON query/transformation alternative.
// Caveats that keep the comparison fair, all applied here:
//
// - `evaluate()` is async since jsonata 2.x (the interpreter is
//   generator-based); the timed loop awaits every call, so JSONata's
//   numbers include the unavoidable promise overhead of its own API.
// - JSONata unwraps singleton results (a one-element result is the item,
//   not an array) and returns undefined for "no match"; results are
//   normalized to an array of items to compare with the other engines.
// - The join scenario: JSONata has no order-by-on-the-joined-stream
//   clause, so the books are sorted by price *before* the `@` context-
//   binding join. Equivalent to jaren's `$orderby` because the sort key is
//   per-book and the benchmark documents have unique prices.
// - The group scenario: JSONata's native grouping is the object
//   constructor `{key: expr}`; `$each` reshapes the grouped object into
//   the same array-of-rows the other engines produce. Group order is
//   first appearance, same as jaren.

import { createRequire } from 'module';
import jsonata from 'jsonata';

const require = createRequire(import.meta.url);
const VERSION = require('jsonata/package.json').version;

function toItems(v) {
  if (v === undefined)
    return [];
  return Array.isArray(v) ? v : [v];
}

const SINGULAR_SRC = 'store.book[2].title';

const FILTER_SRC = 'store.book[price < 10]^(price).{ "title": title, "price": price }';

const JOIN_SRC =
  '(store.book^(price))@$b.$$.ratings@$r[$b.isbn = $r.isbn].{ "title": $b.title, "stars": $r.stars }';

const GROUP_SRC = `(
  store.book{ category: { "count": $count($), "avg": $average($.price) } }
  ~> $each(function($v, $k) { { "genre": $k, "count": $v.count, "avg": $v.avg } })
)`;

const RESHAPE_SRC = `{
  "catalog": [store.book.{ "id": [isbn, title][0],
                           "label": title & " by " & author,
                           "pricing": { "list": price, "discounted": price * 0.9 } }],
  "bike": { "color": store.bicycle.color } }`;

const SOURCES = {
  singular: SINGULAR_SRC,
  filter: FILTER_SRC,
  join: JOIN_SRC,
  group: GROUP_SRC,
  reshape: RESHAPE_SRC,
};

function scenario(source) {
  return {
    source: source.trim(),
    compile: () => jsonata(source),
    run: (compiled, ctx) => compiled.evaluate(ctx).then(toItems),
  };
}

export async function load() {
  return {
    key: 'jsonata',
    name: `jsonata@${VERSION}`,
    isAsync: true,
    prepare: (document) => document,
    scenarios: {
      singular: scenario(SINGULAR_SRC),
      filter: scenario(FILTER_SRC),
      join: scenario(JOIN_SRC),
      group: scenario(GROUP_SRC),
      reshape: scenario(RESHAPE_SRC),
    },
    compileBench: (sources) => {
      const texts = sources.map((key) => SOURCES[key]);
      return {
        fn: () => {
          for (const text of texts)
            jsonata(text);
        },
        perCall: texts.length,
      };
    },
  };
}
