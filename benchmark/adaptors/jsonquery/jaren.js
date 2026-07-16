// Jaren JSON Query adaptor for benchmark/jsonquery.js
//
// The reference engine: every scenario is the query document from the
// QUERY-FORMAT.md spec (appendix A where one exists). Results are
// canonicalized to an array of items: the engine returns `undefined` for
// the empty sequence, the item itself for a singleton and an array for
// longer sequences. No scenario below yields a single item that is itself
// an array, so the wrap is unambiguous.

import { compileJsonQuery } from '@jarenjs/json/query';

function toItems(v) {
  if (v === undefined)
    return [];
  return Array.isArray(v) ? v : [v];
}

const SINGULAR_DOC = {
  $let: { b: '$.store.book[2]' },
  $return: '$b.title',
};

// spec appendix A.2
const FILTER_DOC = {
  $for: { b: '$.store.book[*]' },
  $where: { $lt: ['$b.price', 10] },
  $orderby: '$b.price',
  $return: { title: '$b.title', price: '$b.price' },
};

// spec appendix A.3
const JOIN_DOC = {
  $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
  $where: { $eq: ['$b.isbn', '$r.isbn'] },
  $orderby: '$b.price',
  $return: { title: '$b.title', stars: '$r.stars' },
};

// spec appendix A.4
const GROUP_DOC = {
  $for: { b: '$.store.book[*]' },
  $groupby: { genre: '$b.category' },
  $return: { genre: '$genre', count: { $count: '$b' }, avg: { $avg: '$b.price' } },
};

const RESHAPE_DOC = {
  catalog: [{
    $for: { b: '$.store.book[*]' },
    $return: {
      id: { $default: ['$b.isbn', '$b.title'] },
      label: { $concat: ['$b.title', ' by ', '$b.author'] },
      pricing: { list: '$b.price', discounted: { $mul: ['$b.price', 0.9] } },
    },
  }],
  bike: { color: '$.store.bicycle.color' },
};

function scenario(doc) {
  return {
    source: JSON.stringify(doc),
    compile: () => compileJsonQuery(doc),
    run: (compiled, data) => toItems(compiled(data)),
  };
}

export async function load() {
  return {
    key: 'jaren',
    name: 'Jaren',
    isAsync: false,
    prepare: (document) => document,
    scenarios: {
      singular: scenario(SINGULAR_DOC),
      filter: scenario(FILTER_DOC),
      join: scenario(JOIN_DOC),
      group: scenario(GROUP_DOC),
      reshape: scenario(RESHAPE_DOC),
    },
    // Compile-time probe: the competitors compile from query *text*, so the
    // fair jaren equivalent starts from JSON text too (JSON.parse included).
    compileBench: (sources) => {
      const texts = sources.map((key) => JSON.stringify({
        singular: SINGULAR_DOC, filter: FILTER_DOC, join: JOIN_DOC,
        group: GROUP_DOC, reshape: RESHAPE_DOC,
      }[key]));
      return {
        fn: () => {
          for (const text of texts)
            compileJsonQuery(JSON.parse(text));
        },
        perCall: texts.length,
      };
    },
  };
}
