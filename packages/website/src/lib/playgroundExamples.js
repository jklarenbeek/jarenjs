/**
 * Example documents and programs for the multi-engine playground.
 * The bookstore is the RFC 9535 store, extended with the ratings array
 * the query/JSLT specs join against.
 */

export const BOOKSTORE = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 399 },
  },
  ratings: [
    { isbn: '0-553-21311-3', stars: 4 },
    { isbn: '0-395-19395-8', stars: 5 },
    { isbn: '0-000-00000-0', stars: 1 },
  ],
};

export const pathExamples = [
  {
    name: 'All authors',
    selector: '$.store.book[*].author',
    document: BOOKSTORE,
  },
  {
    name: 'Every price, anywhere',
    selector: '$..price',
    document: BOOKSTORE,
  },
  {
    name: 'Filter: cheap books',
    selector: '$.store.book[?@.price < 10].title',
    document: BOOKSTORE,
  },
  {
    name: 'Slice: first two',
    selector: '$.store.book[0:2].title',
    document: BOOKSTORE,
  },
  {
    name: 'Regex filter (I-Regexp)',
    selector: "$.store.book[?match(@.author, '.*Tolkien')]",
    document: BOOKSTORE,
  },
  {
    name: 'Last element',
    selector: '$.store.book[-1].title',
    document: BOOKSTORE,
  },
];

export const pointerExamples = [
  {
    name: 'Nested member',
    mode: 'absolute',
    pointer: '/store/book/1/title',
    document: BOOKSTORE,
  },
  {
    name: 'Escaped keys (~0 ~1)',
    mode: 'absolute',
    pointer: '/a~1b/m~0n',
    document: { 'a/b': { 'm~n': 'you found me' }, plain: 1 },
  },
  {
    name: 'Relative: sibling',
    mode: 'relative',
    pointer: '1/price',
    location: '/store/book/0/title',
    document: BOOKSTORE,
  },
  {
    name: 'Relative: key name (0#)',
    mode: 'relative',
    pointer: '0#',
    location: '/store/bicycle/color',
    document: BOOKSTORE,
  },
  {
    name: 'Not found',
    mode: 'absolute',
    pointer: '/store/book/9/title',
    document: BOOKSTORE,
  },
];

export const patchExamples = [
  {
    name: 'RFC 6902 basics',
    mode: 'patch',
    document: { baz: 'qux', foo: 'bar', numbers: [1, 2, 3] },
    patch: [
      { op: 'replace', path: '/baz', value: 'boo' },
      { op: 'add', path: '/hello', value: ['world'] },
      { op: 'remove', path: '/foo' },
      { op: 'add', path: '/numbers/-', value: 4 },
    ],
  },
  {
    name: 'Guarded update (test op)',
    mode: 'patch',
    document: {
      version: 5,
      user: { name: 'Alice', tags: ['reader'] },
    },
    patch: [
      { op: 'test', path: '/version', value: 5 },
      { op: 'replace', path: '/user/name', value: 'Bob' },
      { op: 'add', path: '/user/tags/-', value: 'admin' },
      { op: 'replace', path: '/version', value: 6 },
    ],
  },
  {
    name: 'Move & copy',
    mode: 'patch',
    document: {
      draft: { title: 'Sayings of the Century', price: 8.95 },
      published: [],
      template: { reviewed: false },
    },
    patch: [
      { op: 'copy', from: '/template/reviewed', path: '/draft/reviewed' },
      { op: 'move', from: '/draft', path: '/published/-' },
    ],
  },
  {
    name: 'Atomic abort (failing test)',
    mode: 'patch',
    document: { version: 5, user: { name: 'Alice' } },
    patch: [
      { op: 'replace', path: '/user/name', value: 'Mallory' },
      { op: 'test', path: '/version', value: 99 },
    ],
  },
  {
    name: 'Merge: RFC 7396 example',
    mode: 'merge',
    document: {
      name: 'Alice',
      age: 30,
      address: { city: 'Berlin', zip: '10115' },
      temp: 'delete-me',
    },
    patch: {
      age: 31,
      address: { zip: '10999' },
      temp: null,
      newField: 'hello',
    },
  },
  {
    name: 'Merge: no-op (shared)',
    mode: 'merge',
    document: BOOKSTORE,
    patch: { store: { bicycle: { color: 'red' } } },
  },
  {
    name: 'Diff two documents',
    mode: 'diff',
    document: BOOKSTORE,
    target: {
      store: {
        book: [
          { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 9.95 },
          { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
          { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
        ],
        bicycle: { color: 'black', price: 399, onSale: true },
      },
      ratings: BOOKSTORE.ratings,
    },
  },
];

export const queryExamples = [
  {
    name: 'Filter + order (spec A.2)',
    query: {
      $for: { b: '$.store.book[*]' },
      $where: { $lt: ['$b.price', 10] },
      $orderby: '$b.price',
      $return: { title: '$b.title', price: '$b.price' },
    },
    document: BOOKSTORE,
  },
  {
    name: 'Join on isbn (spec A.3)',
    query: {
      $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
      $where: { $eq: ['$b.isbn', '$r.isbn'] },
      $orderby: '$b.price',
      $return: { title: '$b.title', stars: '$r.stars' },
    },
    document: BOOKSTORE,
  },
  {
    name: 'Group + aggregate (spec A.4)',
    query: {
      $for: { b: '$.store.book[*]' },
      $groupby: { genre: '$b.category' },
      $return: { genre: '$genre', count: { $count: '$b' }, avg: { $avg: '$b.price' } },
    },
    document: BOOKSTORE,
  },
  {
    name: 'Quantifier: any 5-star?',
    query: {
      $some: { r: '$.ratings[*]' },
      $satisfies: { $ge: ['$r.stars', 5] },
    },
    document: BOOKSTORE,
  },
  {
    name: 'External parameter',
    query: {
      $for: { b: '$.store.book[*]' },
      $where: { $ge: ['$b.price', '$minPrice'] },
      $return: '$b.title',
    },
    document: BOOKSTORE,
    externals: { minPrice: 10 },
  },
  {
    name: '$valid: schema as type test',
    query: {
      $for: { b: '$.store.book[*]' },
      $where: {
        $valid: ['$b', {
          type: 'object',
          required: ['isbn'],
          properties: { price: { maximum: 25 } },
        }],
      },
      $return: '$b.title',
    },
    document: BOOKSTORE,
  },
];

export const jsltExamples = [
  {
    name: 'Identity (proof of no change)',
    stylesheet: [],
    document: BOOKSTORE,
  },
  {
    name: 'Surgical: VAT on every price',
    stylesheet: [
      {
        match: '$..price',
        body: { $mul: ['$', 1.21] },
      },
    ],
    document: BOOKSTORE,
  },
  {
    name: 'Reshape with two modes',
    stylesheet: {
      $jslt: '0.1',
      rules: [
        {
          match: '$',
          body: {
            toc: [{ $apply: ['$.store.book[*]', 'toc'] }],
            body: [{ $apply: ['$.store.book[*]', 'render'] }],
          },
        },
        {
          mode: 'toc',
          match: '$.store.book[*]',
          body: { id: { $default: ['$.isbn', '$.title'] }, label: '$.title' },
        },
        {
          mode: 'render',
          match: '$.store.book[*]',
          body: { title: '$.title', author: '$.author', price: '$.price' },
        },
      ],
    },
    document: BOOKSTORE,
  },
  {
    name: 'Schema match: annotate books',
    stylesheet: {
      $jslt: '0.1',
      unmatched: 'fresh',
      rules: [
        {
          match: {
            schema: {
              type: 'object',
              required: ['title', 'author', 'price'],
            },
          },
          body: {
            title: '$.title',
            price: '$.price',
            label: { $concat: ['$.title', ' by ', '$.author'] },
          },
        },
      ],
    },
    document: BOOKSTORE,
  },
];

export const jtltExamples = [
  {
    name: 'Markdown book list',
    template: [
      { match: '$', body: ['# Books\n\n', { $apply: '$.store.book[*]' }] },
      { match: '$.store.book[*]', body: ['- **', '$.title', '** — ', '$.price', '\n'] },
    ],
    document: BOOKSTORE,
  },
  {
    name: 'XML: escaping + $raw',
    template: {
      $jtlt: '0.1',
      output: 'xml',
      rules: [
        { match: '$', body: ['<notes>\n', { $apply: '$.notes[*]' }, '</notes>'] },
        {
          match: '$.notes[*]',
          body: ['  <note title="', '$.title', '">', { $raw: '$.markup' }, '</note>\n'],
        },
      ],
    },
    document: {
      notes: [
        { title: 'Q&A', markup: '<b>escaped attribute, raw body</b>' },
        { title: "Rock 'n' roll", markup: '<i>quotes too</i>' },
      ],
    },
  },
  {
    name: 'Two modes: TOC + body',
    template: {
      $jtlt: '0.1',
      rules: [
        {
          match: '$',
          body: ['TOC\n', { $apply: ['$.sections[*]', 'toc'] }, '\n', { $apply: '$.sections[*]' }],
        },
        { mode: 'toc', match: '$.sections[*]', body: ['- ', '$.heading', '\n'] },
        { match: '$.sections[*]', body: ['== ', '$.heading', ' ==\n', '$.text', '\n\n'] },
      ],
    },
    document: {
      sections: [
        { heading: 'Introduction', text: 'Start here.' },
        { heading: 'Usage', text: 'Then this.' },
      ],
    },
  },
  {
    name: 'Codegen with $json',
    template: [
      { match: '$', body: ['export const config = ', { $json: '$' }, ';\n'] },
    ],
    document: { threshold: 10, labels: ['alpha', 'beta'] },
  },
];

export const xqueryExamples = [
  {
    name: 'FLWOR: cheap books',
    text: `for $b in $doc?store?book?*
where $b?price < 10
order by $b?price
return map { "title": $b?title, "price": $b?price }`,
    document: BOOKSTORE,
  },
  {
    name: 'Join on isbn',
    text: `for $b in $doc?store?book?*, $r in $doc?ratings?*
where $b?isbn = $r?isbn
order by $b?price
return map { "title": $b?title, "stars": $r?stars }`,
    document: BOOKSTORE,
  },
  {
    name: 'Group by category',
    text: `for $b in $doc?store?book?*
group by $genre := $b?category
return map { "genre": $genre, "count": count($b), "avg": avg($b?price) }`,
    document: BOOKSTORE,
  },
  {
    name: 'Quantifier',
    text: `some $r in $doc?ratings?* satisfies $r?stars >= 5`,
    document: BOOKSTORE,
  },
];

/** Cross-field validation with the $query keyword (validator playground). */
export const querySchemaExample = {
  name: '$query keyword',
  schema: {
    type: 'object',
    title: 'Invoice',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            amount: { type: 'number' },
          },
          required: ['description', 'amount'],
        },
      },
      total: { type: 'number' },
    },
    required: ['lines', 'total'],
    $query: {
      $eq: ['$.total', { $sum: '$.lines[*].amount' }],
    },
  },
  data: {
    lines: [
      { description: 'Rubber duck', amount: 9.99 },
      { description: 'Duck house', amount: 40.01 },
    ],
    total: 50,
  },
};
