//@ts-check
/**
 * @file The playground's curated example library — the canonical home for
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

/** @type {import('./index.js').PlayExample[]} */
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
  { id: 'path-slice', label: 'Slice: first two', engine: 'path',
    source: { selector: '$.store.book[0:2].title' }, datasets: [bookstore] },
  { id: 'path-regex', label: 'Regex filter (I-Regexp)', engine: 'path',
    source: { selector: "$.store.book[?match(@.author, '.*Tolkien')]" }, datasets: [bookstore] },
  { id: 'path-last', label: 'Last element', engine: 'path',
    source: { selector: '$.store.book[-1].title' }, datasets: [bookstore] },

  // ——— JSON Pointer ———
  { id: 'pointer-nested', label: 'A nested member', engine: 'pointer',
    source: { pointer: '/store/book/1/title', location: '' }, datasets: [bookstore] },
  { id: 'pointer-escaped', label: 'Escaped keys (~0 ~1)', engine: 'pointer',
    source: { pointer: '/a~1b/m~0n', location: '' },
    datasets: [{ label: 'tricky keys', data: { data: j({ 'a/b': { 'm~n': 'you found me' }, plain: 1 }) } }] },
  { id: 'pointer-miss', label: 'A miss is NOTHING, not an error', engine: 'pointer',
    source: { pointer: '/store/book/9/title', location: '' }, datasets: [bookstore] },
  { id: 'pointer-relative', label: 'Relative: sibling', engine: 'pointer',
    source: { pointer: '1/price', location: '/store/book/0/title' }, datasets: [bookstore] },
  { id: 'pointer-relative-key', label: 'Relative: key name (0#)', engine: 'pointer',
    source: { pointer: '0#', location: '/store/book/0/title' }, datasets: [bookstore] },

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
  { id: 'patch-test', label: 'Guarded update (test op)', engine: 'patch',
    source: { patch: j([
      { op: 'test', path: '/version', value: 5 },
      { op: 'replace', path: '/user/name', value: 'Bob' },
      { op: 'add', path: '/user/tags/-', value: 'admin' },
      { op: 'replace', path: '/version', value: 6 },
    ]) },
    datasets: [{ label: 'doc', data: { data: j({ version: 5, user: { name: 'Alice', tags: ['reader'] } }) } }] },
  { id: 'patch-merge', label: 'Merge (RFC 7396)', engine: 'patch', config: { mode: 'merge' },
    source: { patch: j({ age: 31, address: { zip: '10999' }, temp: null, newField: 'hello' }) },
    datasets: [{ label: 'doc', data: { data: j({ name: 'Alice', age: 30, address: { city: 'Berlin', zip: '10115' }, temp: 'delete-me' }) } }] },
  { id: 'patch-diff', label: 'Diff two documents', engine: 'patch', config: { mode: 'diff' },
    source: { patch: j({ user: { name: 'Bob', tags: ['reader', 'admin'] }, version: 6 }) },
    datasets: [{ label: 'original', data: { data: j({ user: { name: 'Alice', tags: ['reader'] }, version: 5 }) } }] },

  // ——— $query ———
  { id: 'query-filter', label: 'Filter + order', engine: 'query',
    source: { query: j({ $for: { b: '$.store.book[*]' }, $where: { $lt: ['$b.price', 10] }, $orderby: '$b.price', $return: { title: '$b.title', price: '$b.price' } }), externals: '' },
    datasets: [bookstore] },
  { id: 'query-join', label: 'Join books and ratings on isbn', engine: 'query',
    source: { query: j({ $for: { b: '$.store.book[*]', r: '$.ratings[*]' }, $where: { $eq: ['$b.isbn', '$r.isbn'] }, $orderby: '$b.price', $return: { title: '$b.title', stars: '$r.stars' } }), externals: '' },
    datasets: [bookstore] },
  { id: 'query-group', label: 'Group + aggregate', engine: 'query',
    source: { query: j({ $for: { b: '$.store.book[*]' }, $groupby: { genre: '$b.category' }, $return: { genre: '$genre', count: { $count: '$b' }, avg: { $avg: '$b.price' } } }), externals: '' },
    datasets: [bookstore] },
  { id: 'query-fold', label: '$fold: a running total', engine: 'query',
    source: { query: j({ $fold: { total: 0 }, $for: { b: '$.store.book[*]' }, $where: { $lt: ['$b.price', 10] }, $return: { $add: ['$total', '$b.price'] } }), externals: '' },
    datasets: [bookstore] },
  { id: 'query-external', label: 'External parameter', engine: 'query',
    source: { query: j({ $for: { b: '$.store.book[*]' }, $where: { $ge: ['$b.price', '$minPrice'] }, $return: '$b.title' }), externals: j({ minPrice: 10 }) },
    datasets: [bookstore] },
  { id: 'query-valid', label: '$valid: schema as type test', engine: 'query',
    source: { query: j({ $for: { b: '$.store.book[*]' }, $where: { $valid: ['$b', { type: 'object', required: ['isbn'], properties: { price: { maximum: 25 } } }] }, $return: '$b.title' }), externals: '' },
    datasets: [bookstore] },
  { id: 'query-mean', label: 'Aggregate with the registered $mean', engine: 'query',
    source: { query: j({ average: { $mean: '$.readings[*]' } }), externals: '' },
    datasets: [{ label: 'readings', data: { data: j({ readings: [10, 12, 14, 20, 8, 6, 30] }) } }] },

  // ——— JSLT ———
  { id: 'jslt-identity', label: 'Identity (proof of no change)', engine: 'jslt',
    source: { stylesheet: j([]) }, datasets: [bookstore] },
  { id: 'jslt-vat', label: 'Surgical: VAT on every price', engine: 'jslt',
    source: { stylesheet: j([{ match: '$..price', body: { $mul: ['$', 1.21] } }]) },
    datasets: [bookstore] },
  { id: 'jslt-reshape', label: 'Reshape a document', engine: 'jslt',
    source: { stylesheet: j({ $jslt: '0.1', rules: [{ match: '$', body: { shopColour: '$.store.bicycle.color', firstTitle: '$.store.book[0].title' } }] }) },
    datasets: [bookstore] },
  { id: 'jslt-schema-match', label: 'Schema match: annotate books', engine: 'jslt',
    source: { stylesheet: j({ $jslt: '0.1', unmatched: 'fresh', rules: [
      { match: { schema: { type: 'object', required: ['title', 'author', 'price'] } },
        body: { title: '$.title', price: '$.price', label: { $concat: ['$.title', ' by ', '$.author'] } } },
    ] }) },
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
  { id: 'jtlt-sql', label: 'SQL DDL — SQLite', engine: 'jtlt',
    source: { template: j({ $jtlt: '0.1', rules: [
      { match: '$', body: ['-- SQLite schema: ', '$.database', '\n\n', { $apply: '$.tables[*]' }] },
      { match: '$.tables[*]', body: ['CREATE TABLE ', '$.name', ' (\n', { $apply: '$.columns[*]' }, '  PRIMARY KEY (', '$.columns[?@.pk].name', ')\n);\n\n'] },
      { match: '$.tables[*].columns[*]', body: ['  ', '$.name', ' ', { $apply: ['$', 'type'] },
        { $if: [{ $eq: ['$.nullable', false] }, ' NOT NULL', ''] },
        { $if: [{ $eq: ['$.unique', true] }, ' UNIQUE', ''] },
        { $if: ['$.references', { $concat: [' REFERENCES ', '$.references'] }, ''] },
        ',\n'] },
      { mode: 'type', match: { schema: { required: ['type'], properties: { type: { const: 'int' } } } }, body: ['INTEGER'] },
      { mode: 'type', match: { schema: { required: ['type'], properties: { type: { const: 'decimal' } } } }, body: ['NUMERIC'] },
      { mode: 'type', body: ['TEXT'] },
    ] }) },
    datasets: [{ label: 'shop', data: { data: j({ database: 'shop', tables: [
      { name: 'customers', columns: [
        { name: 'id', type: 'int', pk: true },
        { name: 'email', type: 'string', maxLength: 254, nullable: false, unique: true },
        { name: 'joined_on', type: 'date', nullable: false },
        { name: 'notes', type: 'text' },
      ] },
      { name: 'orders', columns: [
        { name: 'id', type: 'int', pk: true },
        { name: 'customer_id', type: 'int', nullable: false, references: 'customers (id)' },
        { name: 'total', type: 'decimal', nullable: false },
        { name: 'placed_at', type: 'datetime', nullable: false },
      ] },
    ] }) } }] },

  { id: 'jtlt-sql-pg', label: 'SQL DDL — PostgreSQL', engine: 'jtlt',
    source: { template: j({ $jtlt: '0.1', rules: [
      { match: '$', body: ['-- PostgreSQL schema: ', '$.database', '\n\n', { $apply: '$.tables[*]' }] },
      { match: '$.tables[*]', body: ['CREATE TABLE ', '$.name', ' (\n', { $apply: '$.columns[*]' }, '  PRIMARY KEY (', '$.columns[?@.pk].name', ')\n);\n\n'] },
      { match: '$.tables[*].columns[*]', body: ['  ', '$.name', ' ', { $apply: ['$', 'type'] },
        { $if: [{ $eq: ['$.nullable', false] }, ' NOT NULL', ''] },
        { $if: [{ $eq: ['$.unique', true] }, ' UNIQUE', ''] },
        { $if: ['$.references', { $concat: [' REFERENCES ', '$.references'] }, ''] },
        ',\n'] },
      // priority rules: the pk / maxLength overrides beat the plain types
      { mode: 'type', priority: 1, match: { schema: { required: ['pk'], properties: { pk: { const: true } } } }, body: ['integer GENERATED ALWAYS AS IDENTITY'] },
      { mode: 'type', priority: 1, match: { schema: { required: ['maxLength'] } }, body: [{ $concat: ['varchar(', '$.maxLength', ')'] }] },
      { mode: 'type', match: { schema: { required: ['type'], properties: { type: { const: 'int' } } } }, body: ['integer'] },
      { mode: 'type', match: { schema: { required: ['type'], properties: { type: { const: 'decimal' } } } }, body: ['numeric(12,2)'] },
      { mode: 'type', match: { schema: { required: ['type'], properties: { type: { const: 'date' } } } }, body: ['date'] },
      { mode: 'type', match: { schema: { required: ['type'], properties: { type: { const: 'datetime' } } } }, body: ['timestamptz'] },
      { mode: 'type', body: ['text'] },
    ] }) },
    datasets: [{ label: 'shop', data: { data: j({ database: 'shop', tables: [
      { name: 'customers', columns: [
        { name: 'id', type: 'int', pk: true },
        { name: 'email', type: 'string', maxLength: 254, nullable: false, unique: true },
        { name: 'joined_on', type: 'date', nullable: false },
        { name: 'notes', type: 'text' },
      ] },
      { name: 'orders', columns: [
        { name: 'id', type: 'int', pk: true },
        { name: 'customer_id', type: 'int', nullable: false, references: 'customers (id)' },
        { name: 'total', type: 'decimal', nullable: false },
        { name: 'placed_at', type: 'datetime', nullable: false },
      ] },
    ] }) } }] },

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
  { id: 'xquery-quantifier', label: 'Quantifier: any 5-star?', engine: 'xquery',
    source: { text: 'some $r in $doc?ratings?* satisfies $r?stars >= 5' },
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

  // ——— MDX (markdown × data: interpolation + sections over the data pane) ———
  { id: 'mdx-invoice', label: 'An invoice from data', engine: 'mdx',
    source: { source: `# Invoice {$.number}

Billed to **{$.customer.name}** ({$.customer.email}).

{#each $.lines as line}

**{$line.description}** — {$line.amount}

{/each}

Total: **{$.total}**

{#if $.paid}

Paid — thank you!

{/if}
` },
    datasets: [
      { label: 'paid', data: { data: j({ number: 'INV-7', customer: { name: 'Ada', email: 'ada@example.com' },
        lines: [{ description: 'Rubber duck', amount: 9.99 }, { description: 'Duck house', amount: 40.01 }],
        total: 50, paid: true }) } },
      { label: 'unpaid', data: { data: j({ number: 'INV-8', customer: { name: 'Alan', email: 'alan@example.com' },
        lines: [{ description: 'Enigma manual', amount: 120 }],
        total: 120, paid: false }) } },
    ] },
  { id: 'mdx-digest', label: 'Frontmatter binds as externals', engine: 'mdx',
    source: { source: `---
title: The weekly digest
---
# {$title}

{#each $.stories as story}
## {$story.headline}

{$story.summary}

{/each}
` },
    datasets: [{ label: 'stories', data: { data: j({ stories: [
      { headline: 'Play retires the playground', summary: 'One curated surface, calm by default.' },
      { headline: 'Markdown meets data', summary: 'The same document, rendered per reader.' },
    ] }) } }] },

  { id: 'mdx-comment', label: 'The comment spelling', engine: 'mdx',
    source: { source: `# Release <!--mdx:$.version-->0.0.0<!--/mdx-->

\`{$.path}\` is terser, and it is the right read in a document that is
always rendered against data. But it shows as literal gibberish anywhere
the transform has not run — so a document that is ALSO read raw uses the
comment spelling instead:

- shipped <!--mdx:$.date-->a while ago<!--/mdx-->
- <!--mdx:$.packages-->some<!--/mdx--> packages, one version

Same expression, same compiler, same cache. The markers survive the pass,
so the value can be re-derived; every other renderer drops them and shows
the baked text. An interpolated value lands in a TEXT node either way —
it is never re-read as markdown, which is what makes the pass safe over
data you did not write: <!--mdx:$.note-->none<!--/mdx-->
` },
    datasets: [{ label: 'release', data: { data: j({
      version: '0.31.3', date: '2026-08-11', packages: 21,
      note: '**not bold**, <script>not script</script>',
    }) } }] },

  // ——— Markdown (visual: rendered by a host renderer, source-only) ———
  { id: 'md-tour', label: 'GFM tour', engine: 'markdown', datasets: [],
    source: { source: `---
title: The inverse of JTLT
tags: [markdown, jaren]
---
# Markdown, as JSON

Parse **CommonMark** with *GFM* extensions into a plain JSON AST —
then query it, transform it with JSLT, and render it as vnodes.

- [x] tables, strikethrough, task lists
- [x] footnotes[^1] and bare links like www.commonmark.org
- [ ] your ~~regex~~ hand-rolled parser

[^1]: Collected out of the flow and rendered at the end, GitHub-style.

| engine | output |
| :----- | -----: |
| JTLT | Markdown |
| @jarenjs/md | JSON |

\`\`\`js
const doc = parseMarkdown(source);
doc.ast[0].type; // 'heading'
\`\`\`

> One suite, one philosophy: parse once, run a specialized closure.
` } },
  { id: 'md-frontmatter', label: 'Frontmatter flavours', engine: 'markdown', datasets: [],
    source: { source: `+++
title = "TOML up top"
weight = 3
+++
The same document works with \`---\` YAML, \`---json\`, a leading
\`{\` JSON object, or \`+++\` TOML — all normalize to plain JSON on
\`doc.frontmatter\`, and bind as JSLT externals.
` } },
  { id: 'md-anchors', label: 'Anchors, footnotes and bare links', engine: 'markdown', datasets: [],
    source: { source: `# Everything linkable

Every heading gets a GitHub-compatible \`id\`, so [jump to the notes](#the-notes)
lands where you expect — the same slug GitHub mints, so one committed README
anchors identically here, on GitHub and in an editor preview.

Bare addresses become links without \`<>\`: visit www.commonmark.org/help,
read https://spec.commonmark.org/ or mail spec@commonmark.test. Trailing
punctuation stays out of the link — see www.commonmark.org/a.b. — and a
citation[^why] carries its own return path.

## The notes

Footnotes are collected out of the flow and rendered once, at the end, in
first-reference order. An uncited definition renders nothing at all.

[^why]: Cite it twice[^why] and it grows a second back-reference.
` } },
  { id: 'md-directives', label: 'Directives: a number a machine derives', engine: 'markdown', datasets: [],
    source: { source: `# Comment-carried data

Jaren is <!--fact:jsonpath.ctsRatio-->23.1<!--/fact-->x faster on the CTS mean.

Every markdown renderer on earth drops HTML comments, so that line reads as
plain, correct, static text — here, on GitHub and on npm. A directive-aware
consumer reads the marker instead and re-derives the value; \`bake()\` writes
the fresh one back into the source, so a re-derivation is a reviewable diff
rather than a number that quietly stopped being true.

This repository's own published figures work exactly this way.

<!--fact:example-->
A block directive wraps whole blocks — a table, a list, anything the
resolver produces.
<!--/fact-->

One rule: an inline marker must not begin a line. A comment at the start of
a line opens an HTML block and swallows the rest of that line.
` } },
  { id: 'md-roundtrip', label: 'Round trip is a fixed point', engine: 'markdown', datasets: [],
    source: { source: `# Canonical form

Re-parsing \`toMarkdown(doc)\` yields a **deep-equal** AST: printing
is a fixed point.

1. parse
2. print
3. parse again
` } },

  // ——— Mermaid (visual: geometry-free AST → pure-vnode SVG) ———
  { id: 'mermaid-flow', label: 'Flowchart', engine: 'mermaid', datasets: [],
    source: { source: `flowchart TD
  A[Start] --> B{Is it working?}
  B -->|Yes| C[Ship it]
  B -->|No| D[Debug]
  D --> B
  C --> E((Done))` } },
  { id: 'mermaid-seq', label: 'Sequence', engine: 'mermaid', datasets: [],
    source: { source: `sequenceDiagram
  participant A as Alice
  participant B as Bob
  A->>+B: Authenticate
  B-->>-A: Token
  note over A,B: handshake complete` } },
  { id: 'mermaid-state', label: 'State diagram', engine: 'mermaid', datasets: [],
    source: { source: `stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  Running --> Idle : stop
  Running --> [*]` } },
  { id: 'mermaid-pie', label: 'Pie', engine: 'mermaid', datasets: [],
    source: { source: `pie showData
  title Time spent
  "Parsing" : 20
  "Layout" : 35
  "Rendering" : 45` } },

  // ——— Charts (visual: JSON/JSONX/JOSL definition → SVG; static only) ———
  { id: 'charts-pie', label: 'Pie', engine: 'charts', config: { format: 'json' }, datasets: [],
    source: { source: j({ type: 'pie', title: 'Suite time by package', slices: [
      { label: 'validate', value: 42 }, { label: 'json', value: 25 }, { label: 'view', value: 18 }, { label: 'md', value: 15 },
    ] }) } },
  { id: 'charts-bar', label: 'Grouped bars', engine: 'charts', config: { format: 'json' }, datasets: [],
    source: { source: j({ type: 'bar', title: 'Parse profile — ms per document', valLabel: 'ms/op',
      categories: ['~2 kB', '~40 kB', '~90 kB'],
      series: [{ name: 'jaren', values: [0.11, 2.3, 10.7] }, { name: 'rival', values: [0.43, 6.1, 38.4] }],
    }) } },
  { id: 'charts-heatmap', label: 'Heatmap (log)', engine: 'charts', config: { format: 'json' }, datasets: [],
    source: { source: j({ type: 'heatmap', title: 'Speed ratio by scenario × scale (log)', log: true,
      xLabels: ['4 books', '100 books', '1000 books'], yLabels: ['singular', 'filter', 'join'],
      values: [[220, 80, 12], [90, 30, 6], [15, 4, 1.2]],
    }) } },
  { id: 'charts-sankey', label: 'Sankey', engine: 'charts', config: { format: 'json' }, datasets: [],
    source: { source: j({ type: 'sankey', title: 'Where visits go', links: [
      { source: 'search', target: 'home', value: 40 }, { source: 'social', target: 'home', value: 15 },
      { source: 'home', target: 'docs', value: 30 }, { source: 'home', target: 'play', value: 20 },
      { source: 'docs', target: 'github', value: 8 },
    ] }) } },

  // ——— JSON Schema validation (the validate engine, host-delegated) ———
  { id: 'validate-user', label: 'User', engine: 'validate', config: { locale: 'en' },
    source: { schema: j({ type: 'object', title: 'User', properties: {
      name: { type: 'string', minLength: 2 }, email: { type: 'string', format: 'email' },
      age: { type: 'integer', minimum: 13 }, newsletter: { type: 'boolean' }, plan: { enum: ['free', 'pro'] },
      tags: { type: 'array', default: [], items: { type: 'string' } },
    }, required: ['name', 'email'] }) },
    datasets: [{ label: 'valid', data: { data: j({ name: 'Ada', email: 'ada@example.com', age: 36, newsletter: true, plan: 'pro', tags: ['compiler'] }) } }] },
  { id: 'validate-conditional', label: 'Conditional (if/then/else)', engine: 'validate', config: { locale: 'en' },
    source: { schema: j({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', title: 'Payment',
      properties: { method: { type: 'string', enum: ['card', 'iban'] }, cardNumber: { type: 'string', pattern: '^\\d{16}$' }, iban: { type: 'string', format: 'iban' } },
      required: ['method'], if: { properties: { method: { const: 'card' } }, required: ['method'] }, then: { required: ['cardNumber'] }, else: { required: ['iban'] } }) },
    datasets: [{ label: 'a card payment', data: { data: j({ method: 'card', cardNumber: '4111111111111111' }) } }] },
  { id: 'validate-query', label: 'Cross-field ($query)', engine: 'validate', config: { locale: 'en' },
    source: { schema: j({ type: 'object', title: 'Invoice',
      description: 'The $query keyword embeds a Jaren JSON Query as a cross-field assertion — the class of constraint (sums, ordering) JSON Schema is notoriously bad at.',
      properties: {
        lines: { type: 'array', minItems: 1, items: { type: 'object',
          properties: { description: { type: 'string', minLength: 1 }, amount: { type: 'number' } }, required: ['description', 'amount'] } },
        total: { type: 'number', description: 'Must equal the sum of the line amounts' },
      }, required: ['lines', 'total'], $query: { $eq: ['$.total', { $sum: '$.lines[*].amount' }] } }) },
    datasets: [{ label: 'balanced', data: { data: j({ lines: [
      { description: 'Rubber duck', amount: 9.99 }, { description: 'Duck house', amount: 40.01 }], total: 50 }) } }] },
  { id: 'validate-invalid', label: 'Invalid data (see the errors)', engine: 'validate', config: { locale: 'en' },
    source: { schema: j({ type: 'object', title: 'User', properties: {
      name: { type: 'string', minLength: 2 }, email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 13 },
    }, required: ['name', 'email'] }) },
    datasets: [{ label: 'invalid', data: { data: j({ name: 'A', email: 'not-an-email', age: 7 }) } }] },

  // ——— Contract ($contract document → describe / OpenAPI / TypeScript / dispatch) ———
  { id: 'contract-shop', label: 'A shop contract', engine: 'contract',
    source: { document: j({ $contract: '0.1', id: 'shop', version: '1',
      $defs: { Product: { type: 'object', required: ['id', 'name', 'price'], properties: {
        id: { type: 'integer' }, name: { type: 'string', minLength: 1 }, price: { type: 'number', minimum: 0 } } } },
      operations: {
        'catalog.load': { kind: 'read',
          input: { type: 'object', properties: { since: { type: 'string', format: 'date-time' } } },
          output: { type: 'array', items: { $ref: '#/$defs/Product' } },
          http: { method: 'GET', path: '/api/catalog' },
          doc: 'The whole catalog.' },
        'product.save': { kind: 'command',
          input: { type: 'object', required: ['id', 'product'], properties: {
            id: { type: 'integer' }, product: { $ref: '#/$defs/Product' } } },
          output: { $ref: '#/$defs/Product' },
          errors: { conflict: { status: 409 } },
          policy: { idempotency: 'optional' },
          http: { method: 'PUT', path: '/api/products/{id}' } },
      } }) },
    datasets: [
      { label: 'a valid save', data: { call: j({ op: 'product.save', input: { id: 7, product: { id: 7, name: 'Duck', price: 9.99 } } }) } },
      { label: 'an invalid input', data: { call: j({ op: 'product.save', input: { id: 'seven' } }) } },
      { label: 'no dispatch', data: { call: '' } },
    ] },
  { id: 'contract-minimal', label: 'One operation, no http', engine: 'contract',
    source: { document: j({ $contract: '0.1', id: 'echo', operations: {
      'echo.say': { kind: 'command',
        input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        output: true,
        doc: 'No http member: the binding defaults to POST /echo.say.' },
    } }) },
    datasets: [{ label: 'say something', data: { call: j({ op: 'echo.say', input: { text: 'hello' } }) } }] },
  { id: 'contract-broken', label: 'A refusal, with its docPath', engine: 'contract',
    source: { document: j({ $contract: '0.1', id: 'broken', operations: {
      'catalog.load': { kind: 'read',
        input: { type: 'object', properties: { since: { type: 'string' } } },
        // no output member: JC00xx at compile, never at request time —
        // the error names /operations/catalog.load with its code
        http: { method: 'GET', path: '/api/catalog' } },
    } }) },
    datasets: [{ label: 'nothing to dispatch', data: { call: '' } }] },
];
