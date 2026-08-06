//@ts-check
/**
 * @file The scratchpad's curated example library — the canonical home for
 * the suite's engine examples (folded from the website + more). Each
 * example presets its engine's source pane(s) and a LIST of datasets: one
 * dataset shows a single run; several turn on a switcher, so the same
 * source runs over each shape (see the `-shapes` / `-inputs` examples).
 */

const j = (v) => JSON.stringify(v, null, 2);

/** A small bookstore, shared by several path/pointer/query examples. */
const BOOKSTORE = {
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
  ],
};
const bookstore = { label: 'bookstore', data: { data: j(BOOKSTORE) } };

/** @type {import('./index.js').ScratchExample[]} */
export const EXAMPLE_LIST = [
  // ——— JSONPath ———
  { id: 'path-authors', label: 'All authors', engine: 'path',
    source: { selector: '$.store.book[*].author' }, datasets: [bookstore] },
  { id: 'path-cheap', label: 'Filter: books under 10', engine: 'path',
    source: { selector: '$.store.book[?@.price < 10].title' }, datasets: [bookstore] },
  { id: 'path-prices', label: 'Every price, anywhere', engine: 'path',
    source: { selector: '$..price' }, datasets: [bookstore] },
  { id: 'path-shapes', label: 'One selector, three shapes', engine: 'path',
    source: { selector: '$..name' },
    datasets: [
      { label: 'flat', data: { data: j({ name: 'root', child: { name: 'inner' } }) } },
      { label: 'array', data: { data: j({ people: [{ name: 'Ada' }, { name: 'Alan' }] }) } },
      { label: 'deep', data: { data: j({ a: { b: { c: { name: 'buried' } } } }) } },
    ] },

  // ——— JSON Pointer ———
  { id: 'pointer-nested', label: 'A nested member', engine: 'pointer',
    source: { pointer: '/store/book/1/title' }, datasets: [bookstore] },
  { id: 'pointer-escaped', label: 'Escaped keys (~0 ~1)', engine: 'pointer',
    source: { pointer: '/a~1b/m~0n' },
    datasets: [{ label: 'tricky keys', data: { data: j({ 'a/b': { 'm~n': 'you found me' }, plain: 1 }) } }] },
  { id: 'pointer-miss', label: 'A miss is NOTHING, not an error', engine: 'pointer',
    source: { pointer: '/store/book/9/title' }, datasets: [bookstore] },

  // ——— JSON Patch ———
  { id: 'patch-basics', label: 'RFC 6902 basics', engine: 'patch',
    source: { patch: j([{ op: 'replace', path: '/baz', value: 'boo' }, { op: 'add', path: '/hello', value: ['world'] }, { op: 'remove', path: '/foo' }]) },
    datasets: [{ label: 'doc', data: { data: j({ baz: 'qux', foo: 'bar', numbers: [1, 2, 3] }) } }] },
  { id: 'patch-append', label: 'Append to an array (the - token)', engine: 'patch',
    source: { patch: j([{ op: 'add', path: '/numbers/-', value: 4 }]) },
    datasets: [{ label: 'doc', data: { data: j({ numbers: [1, 2, 3] }) } }] },
  { id: 'patch-move', label: 'Move a member', engine: 'patch',
    source: { patch: j([{ op: 'move', from: '/a', path: '/b' }]) },
    datasets: [{ label: 'doc', data: { data: j({ a: 1, keep: true }) } }] },

  // ——— $query ———
  { id: 'query-filter', label: 'Filter + order', engine: 'query',
    source: { query: j({ $for: { b: '$.store.book[*]' }, $where: { $lt: ['$b.price', 10] }, $orderby: '$b.price', $return: { title: '$b.title', price: '$b.price' } }), externals: '' },
    datasets: [bookstore] },
  { id: 'query-join', label: 'Join books and ratings on isbn', engine: 'query',
    source: { query: j({ $for: { b: '$.store.book[*]', r: '$.ratings[*]' }, $where: { $eq: ['$b.isbn', '$r.isbn'] }, $orderby: '$b.price', $return: { title: '$b.title', stars: '$r.stars' } }), externals: '' },
    datasets: [bookstore] },
  { id: 'query-mean', label: 'Aggregate with the registered $mean', engine: 'query',
    source: { query: j({ average: { $mean: '$.readings[*]' } }), externals: '' },
    datasets: [{ label: 'readings', data: { data: j({ readings: [10, 12, 14, 20, 8, 6, 30] }) } }] },

  // ——— JSLT ———
  { id: 'jslt-vat', label: 'Surgical: VAT on every price', engine: 'jslt',
    source: { stylesheet: j([{ match: '$..price', body: { $mul: ['$', 1.21] } }]) },
    datasets: [bookstore] },
  { id: 'jslt-reshape', label: 'Reshape a document', engine: 'jslt',
    source: { stylesheet: j({ $jslt: '0.1', rules: [{ match: '$', body: { shopColour: '$.store.bicycle.color', firstTitle: '$.store.book[0].title' } }] }) },
    datasets: [bookstore] },
  { id: 'jslt-inputs', label: 'One stylesheet, two inputs', engine: 'jslt',
    source: { stylesheet: j({ $jslt: '0.1', rules: [{ match: '$', body: { greeting: { $concat: ['Hello, ', '$.name'] } } }] }) },
    datasets: [
      { label: 'Ada', data: { data: j({ name: 'Ada Lovelace' }) } },
      { label: 'Alan', data: { data: j({ name: 'Alan Turing' }) } },
    ] },

  // ——— JTLT (JSLT's text front-end) ———
  { id: 'jtlt-md', label: 'Render a Markdown book list', engine: 'jtlt',
    source: { template: j([
      { match: '$', body: ['# Books\n\n', { $apply: '$.store.book[*]' }] },
      { match: '$.store.book[*]', body: ['- **', '$.title', '** — ', '$.price', '\n'] },
    ]) },
    datasets: [bookstore] },
  { id: 'jtlt-modes', label: 'Two modes: a TOC and the body', engine: 'jtlt',
    source: { template: j({ $jtlt: '0.1', rules: [
      { match: '$', body: ['TOC\n', { $apply: ['$.sections[*]', 'toc'] }, '\n', { $apply: '$.sections[*]' }] },
      { mode: 'toc', match: '$.sections[*]', body: ['- ', '$.heading', '\n'] },
      { match: '$.sections[*]', body: ['== ', '$.heading', ' ==\n', '$.text', '\n\n'] },
    ] }) },
    datasets: [{ label: 'doc', data: { data: j({ sections: [
      { heading: 'Introduction', text: 'Start here.' },
      { heading: 'Usage', text: 'Then this.' },
    ] }) } }] },
  { id: 'jtlt-xml', label: 'XML: escaping vs $raw', engine: 'jtlt',
    source: { template: j({ $jtlt: '0.1', output: 'xml', rules: [
      { match: '$', body: ['<notes>\n', { $apply: '$.notes[*]' }, '</notes>'] },
      { match: '$.notes[*]', body: ['  <note title="', '$.title', '">', { $raw: '$.markup' }, '</note>\n'] },
    ] }) },
    datasets: [{ label: 'notes', data: { data: j({ notes: [
      { title: 'Q&A', markup: '<b>escaped attribute, raw body</b>' },
      { title: "Rock 'n' roll", markup: '<i>quotes too</i>' },
    ] }) } }] },
  { id: 'jtlt-codegen', label: 'Codegen with $json', engine: 'jtlt',
    source: { template: j([{ match: '$', body: ['export const config = ', { $json: '$' }, ';\n'] }]) },
    datasets: [{ label: 'config', data: { data: j({ threshold: 10, labels: ['alpha', 'beta'] }) } }] },

  // ——— XQuery (the text subset → a query document, run over $doc) ———
  { id: 'xquery-flwor', label: 'FLWOR: cheap books', engine: 'xquery',
    source: { text: 'for $b in $doc?store?book?*\nwhere $b?price < 10\norder by $b?price\nreturn map { "title": $b?title, "price": $b?price }' },
    datasets: [bookstore] },
  { id: 'xquery-join', label: 'Join books and ratings on isbn', engine: 'xquery',
    source: { text: 'for $b in $doc?store?book?*, $r in $doc?ratings?*\nwhere $b?isbn = $r?isbn\norder by $b?price\nreturn map { "title": $b?title, "stars": $r?stars }' },
    datasets: [bookstore] },
  { id: 'xquery-group', label: 'Group by category', engine: 'xquery',
    source: { text: 'for $b in $doc?store?book?*\ngroup by $genre := $b?category\nreturn map { "genre": $genre, "count": count($b), "avg": avg($b?price) }' },
    datasets: [bookstore] },
];
