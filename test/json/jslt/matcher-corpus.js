//@ts-check
// A stylesheet corpus over every match-path selector kind, for comparing
// the single-walk matcher with the per-path enumeration it replaces. Each
// case is transformed with every input under each option set.

/** A minimal type-test hook: `{ type }` against `typeof`/`Array.isArray`. */
export function compileTypeTest(schema) {
  const type = schema.type;
  return (value) => type === 'array'
    ? Array.isArray(value)
    : type === 'null'
      ? value === null
      : type === 'object'
        ? typeof value === 'object' && value !== null && !Array.isArray(value)
        : typeof value === type;
}

const STORE = {
  store: {
    book: [
      { category: 'reference', author: 'Rees', title: 'Sayings', price: 8.95 },
      { category: 'fiction', author: 'Waugh', title: 'Honour', price: 12.99, isbn: '0-553' },
      { category: 'fiction', author: 'Melville', title: 'Moby', price: 8.99, isbn: '0-395' },
    ],
    bicycle: { color: 'red', price: 399 },
  },
  limit: 9,
};

// member names that need escapes in a normalized path, an own
// `__proto__`, an object key '0' beside array index 0, nested arrays
const ODD = JSON.parse(JSON.stringify({
  "it's": [1, { price: 2 }],
  'back\\slash': { price: 3, '0': 'zero' },
  '\u0001ctl': { 'new\nline': { price: 4 } },
  a: [[1, 2, 3], [4, { b: 5, price: 6 }], [], {}],
  '0': [{ '0': 7 }, 8],
  constructor: { price: 9 },
}).replace('"constructor"', '"__proto__"'));

const DEEP = { x: { y: { z: { w: { x: { price: 1 } } } } }, x2: [[[[{ price: 2 }]]]] };

export const INPUTS = [STORE, ODD, DEEP, [], {}, 7, null, [STORE, ODD], { list: [1, 2, 3, 4, 5] }];

const double = (path) => ({ match: path, body: { $mul: ['$', 2] } });
const tag = (path, label) => ({ match: path, body: [label, '$path'] });

/** @type {{ name: string, stylesheet: any, options?: object[], externals?: object }[]} */
export const CASES = [
  { name: 'descendant name', stylesheet: [double('$..price')] },
  {
    name: 'names, indexes, negatives, wildcards, unions',
    stylesheet: [
      tag('$.a', 'a'), tag('$.a[0]', 'a0'), tag('$.a[-1]', 'a-1'), tag('$.a[*][1]', 'a*1'),
      tag("$['a','a'][-4]", 'dup'), tag("$[\"it's\"][1]", 'quote'), tag("$['back\\\\slash']['0']", 'bs'),
      tag("$['\\u0001ctl']['new\\nline']", 'ctl'), tag("$..['0']", 'key0'), tag('$..[0]', 'idx0'),
      tag('$.store.book[-1].title', 'last'), tag('$.store.book[0,-1,0].author', 'firstlast'),
      tag("$['__proto__'].price", 'proto'), tag('$[*]', 'top'),
    ],
  },
  {
    name: 'walkable, slice and filter paths in one mode',
    stylesheet: [
      tag('$.store.book[1:3].price', 'slice'), tag('$.a[::-1]', 'rev'), double('$..price'),
      tag('$.store.book[?@.price > 9]', 'filter'), tag('$..[?@ == $.limit]', 'rootfilter'),
      tag('$.list[*]', 'item'), tag('$.list[-2:]', 'tail'),
    ],
  },
  { name: 'descendant wildcard', stylesheet: [{ match: '$..*', body: { at: '$path', v: '$' } }] },
  {
    name: 'descendant chains',
    stylesheet: [tag('$..book..price', 'bp'), tag('$..x..price', 'xp'), tag('$..[*][*]', 'ww'), double('$..a..b')],
  },
  {
    name: 'more than 32 path rules in one mode',
    stylesheet: [
      ...Array.from({ length: 34 }, (_, i) => tag(`$..k${i}`, `k${i}`)),
      tag('$.store.book[*].price', 'bp'), tag('$..price', 'p'), tag('$.a[-1]', 'a-1'), tag('$.list[1:]', 'ls'),
    ],
  },
  {
    name: 'modes sharing match paths, explicit and location-less $apply, $path',
    stylesheet: {
      $jslt: '0.1',
      rules: [
        {
          match: '$', body: {
            toc: [{ $apply: ['$.store.book[*]', 'toc'] }],
            body: [{ $apply: ['$.store.book[*]', 'render'] }],
            odd: [{ $apply: ["$[\"it's\"][*]", 'render'] }],
            ctl: [{ $apply: ["$['\\u0001ctl'][*][*]", 'render'] }],
            spine: [{ $apply: ['$.store.bicycle.*', 'render'] }],
            loose: [{ $apply: [{ $seq: [{ price: 1 }, 2] }, 'render'] }],
            here: [{ $apply: ['$', 'toc'] }],
          },
        },
        { mode: 'toc', match: '$.store.book[*]', body: { at: '$path', label: '$.title' } },
        { mode: 'render', match: '$.store.book[*]', body: { at: '$path', price: '$.price' } },
        { mode: 'render', match: '$..price', body: { $concat: ['p@', '$path'] } },
        { mode: 'render', match: { schema: { type: 'number' } }, body: { $mul: ['$', 10] } },
      ],
    },
  },
  {
    name: 'fresh mode with path and schema rules',
    stylesheet: {
      $jslt: '0.1', unmatched: 'fresh',
      rules: [
        { match: '$..price', body: { $mul: ['$', 3] } },
        { match: { path: '$.store.book[*]', schema: { type: 'object' } }, body: { t: '$.title', a: { $apply: '$.author' } } },
        { match: { schema: { type: 'string' } }, body: { $concat: ['s:', '$'] } },
      ],
    },
  },
  {
    name: 'share mode: a matched location whose schema test fails',
    stylesheet: [
      { match: { path: '$.store.book[*]', schema: { type: 'string' } }, body: 'never' },
      double('$.store.book[*].price'),
      { match: { path: '$..b', schema: { type: 'string' } }, body: 'never' },
    ],
  },
  { name: 'root match beside deeper ones', stylesheet: [{ match: '$', body: { $apply: '$.*' } }, double('$..price'), tag('$[*]', 'top')] },
  {
    name: 'error mode names the unmatched location',
    stylesheet: { $jslt: '0.1', unmatched: 'error', rules: [{ match: '$', body: { $apply: '$.store' } }, double('$.store.book')] },
  },
  { name: 'a body error names its location', stylesheet: [{ match: '$..title', body: { $mul: ['$', 2] } }] },
  { name: 'a member producing many items', stylesheet: [{ match: '$..price', body: { $seq: [1, 2] } }] },
  {
    name: 'array elements producing many or no items',
    stylesheet: [{ match: '$.a[*]', body: { $seq: [1, 2] } }, { match: '$.list[1:3]', body: { $seq: [] } }],
  },
  {
    name: 'a descent bound the input reaches',
    stylesheet: [double('$..price'), tag('$.x.y.z..price', 'deep')],
    options: [{ maxDescentDepth: 2 }, { maxDescentDepth: 4 }, { maxDescentDepth: 5 }],
  },
  {
    name: 'a descent bound only the absolute depth reaches',
    stylesheet: [tag('$.x.y.z..price', 'deep'), tag('$.x2[0][0]..price', 'deep2')],
    options: [{ maxDescentDepth: 3 }],
  },
  {
    name: 'externals and memo',
    stylesheet: [{ match: '$..price', body: { $add: ['$', '$bump'] } }, tag('$.store.book[*].title', 't')],
    externals: { bump: 1 },
  },
];

/** The option sets every case runs under (beside its own). */
export const OPTION_SETS = [{}, { memo: true }];
