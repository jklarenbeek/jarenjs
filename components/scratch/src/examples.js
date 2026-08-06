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

  // ——— JOSL (source-only: no data pane; the mode select is the toggle) ———
  { id: 'josl-citizens', label: 'First-class citizens', engine: 'josl', config: { mode: 'josl' }, datasets: [],
    source: { text: `# JOSL: TOML 1.0 + JavaScript's obvious types
title = "kitchen sink"
middle-name = null            # TOML has no null; JOSL does (flip to TOML → error)
big = 9007199254740993        # promotes to bigint, losslessly
mask = 0xffn                  # bigint literal, any radix
match = /^ok[!.]?$/i          # a real RegExp, validated at parse time
when = 2026-07-18T12:00:00Z   # offset date-time -> Date
day = 2026-07-18              # local date -> LocalDate

[server]
host = "localhost"
ports = [ 8080, 8443 ]
` } },
  { id: 'josl-records', label: 'Record stream [[]]', engine: 'josl', config: { mode: 'josl' }, datasets: [],
    source: { text: `# The most common LLM output shape: a list of records.
# Each [[]] completes the previous record -- streamable.
[[]]
name = "first"
score = 0.92
[meta]
source = "model-a"

[[]]
name = "second"
score = 0.87
tags = [ "draft" ]
` } },
  { id: 'josl-toml', label: 'Strict TOML 1.0', engine: 'josl', config: { mode: 'toml' }, datasets: [],
    source: { text: `# mode: toml -- the same engine, extensions rejected.
# This dialect passes the complete official toml-test 1.0.0 suite.
title = "TOML Example"

[owner]
name = "Tom Preston-Werner"
dob = 1979-05-27T07:32:00-08:00

[[products]]
name = "Hammer"
sku = 738594937
` } },

  // ——— CSV (source-only: strict vs repair is the lesson, live) ———
  { id: 'csv-rfc', label: 'RFC 4180', engine: 'csv', config: { repair: 'strict', headers: 'true', delimiter: 'auto', typed: 'off' }, datasets: [],
    source: { text: `id,name,note
1,Ada,"quoted, with a comma"
2,Grace,"a doubled "" quote"
3,Alan,"a field that spans
two lines"
` } },
  { id: 'csv-repair', label: 'Damaged → self-healing', engine: 'csv', config: { repair: 'repair', headers: 'true', delimiter: 'auto', typed: 'off' }, datasets: [],
    source: { text: `id,name,note
1,Ada,"never closed
2,Grace,"ok"trailing text
3,Alan,"he said "hi" today"
4,Edsger
5,Barbara,extra,column
` } },
  { id: 'csv-dialect', label: 'European dialect (sniffed)', engine: 'csv', config: { repair: 'strict', headers: 'auto', delimiter: 'auto', typed: 'on' }, datasets: [],
    source: { text: `stad;inwoners;opgericht
Amsterdam;921402;1275-10-27
Rotterdam;651446;1340-06-07
Den Haag;548320;1248-01-01
` } },
  { id: 'csv-typed', label: 'Typed values', engine: 'csv', config: { repair: 'strict', headers: 'true', delimiter: ',', typed: 'on' }, datasets: [],
    source: { text: `sku,price,postcode,huge,active,when
A-1,19.95,01234,123456789012345678901234567890,true,2026-07-27
A-2,4.5,00042,7,false,2026-07-27T08:30:00Z
` } },
];
