//@ts-check
/**
 * @file The ANSWER every play example shows, pinned through the site's real
 * runner (`runPlay`: the registered operators, the localized validator, the
 * markdown, mermaid and chart renderers). The other example tests prove that
 * each example runs and renders; a run can do both and still show a wrong
 * number, a swallowed record or an empty bullet. Every example and every
 * dataset is pinned here, and an example added without a pin fails.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { EXAMPLES, ENGINES } from '@jarenjs/play';
import { parseMarkdown } from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';
import { runPlay } from '../../packages/website/src/boundaries/play.js';
import { md, mdArticle, TRUSTED, UNTRUSTED } from '../../packages/website/src/boundaries/markdown.js';

/** @param {any} ex @param {any} dataset */
function runOver(ex, dataset) {
  const slice = { engine: ex.engine, source: { ...ex.source }, data: { ...(dataset?.data ?? {}) }, config: { ...(ex.config ?? {}) } };
  return Promise.resolve(runPlay(slice));
}
/** @param {any} r @param {string} id */
const panel = (r, id) => r.panels.find((/** @type {any} */ p) => p.id === id);
/** @param {any} r @param {string} [id] */
const out = (r, id = 'out') => panel(r, id).text;
/** @param {any} r @param {string} [id] */
const json = (r, id = 'out') => JSON.parse(out(r, id));
/** The vnode of a view panel. @param {any} r */
const vnode = (r) => panel(r, 'preview').vnode;
/** The visible text of a view panel, tags stripped and entities read. @param {any} r */
const seen = (r) => renderToString(vnode(r)).replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
/** Every node of a vnode tree with the given tag. @param {any} node @param {string} tag @returns {any[]} */
function nodes(node, tag) {
  if (!Array.isArray(node)) return [];
  const found = node[0] === tag ? [node] : [];
  return found.concat(node.flatMap((/** @type {any} */ child) => nodes(child, tag)));
}
/** A vnode's own text: its string children, depth first. @param {any} node @returns {string} */
function textOf(node) {
  if (typeof node === 'string') return node;
  if (!Array.isArray(node)) return '';
  const props = node[1] !== null && typeof node[1] === 'object' && !Array.isArray(node[1]);
  return node.slice(typeof node[0] !== 'string' ? 0 : props ? 2 : 1).map(textOf).join('');
}
/** Every `id` prop in a vnode tree. @param {any} node @returns {string[]} */
const idsOf = (node) => (!Array.isArray(node) ? [] : [
  ...(node[1] && typeof node[1] === 'object' && !Array.isArray(node[1]) && typeof node[1].id === 'string' ? [node[1].id] : []),
  ...node.flatMap(idsOf)]);
/** A declaration text without its doc comments and blank lines. @param {string} t */
const declarations = (t) => t.replace(/[ \t]*\/\*\*[\s\S]*?\*\/\n/g, '').split('\n').filter((l) => l.trim() !== '').join('\n');
/** @param {any} r */
const verdict = (r) => out(r, 'verdict').split(' · ')[0];
/** The errors table, sorted (the order is not the answer). @param {any} r */
const errors = (r) => (panel(r, 'errors')?.rows ?? []).map((/** @type {string[]} */ row) => row.join(' ')).sort();
/** A contract dispatch outcome without its random trace. @param {any} r */
const dispatched = (r) => { const o = json(r, 'dispatch'); delete o.meta.trace; return o; };
/** @param {any} r */
const rows = (r) => ({ columns: panel(r, 'rows').columns, rows: panel(r, 'rows').rows });

const BOOKS = ['Sayings of the Century', 'Sword of Honour', 'Moby Dick', 'The Lord of the Rings'];

/**
 * One pin per example: the answer it must show, computed by hand from its
 * source and data (and, where one exists, agreed by a reference: Ajv,
 * Mermaid, markdown-it, papaparse, SQLite, PostgreSQL). `runs` maps each
 * dataset label to its result (a source-only example has one, `source`).
 * @type {Record<string, (runs: Record<string, any>) => void>}
 */
const PINS = {
  // ——— JSONPath (RFC 9535) ———
  'path-authors': ({ bookstore: r }) => assert.deepStrictEqual(json(r), ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']),
  'path-cheap': ({ bookstore: r }) => assert.deepStrictEqual(json(r), ['Sayings of the Century', 'Moby Dick']),
  'path-prices': ({ bookstore: r }) => assert.deepStrictEqual(json(r), [8.95, 12.99, 8.99, 22.99, 399]),
  'path-shapes': ({ flat, array, deep }) => {
    assert.deepStrictEqual(json(flat), ['root', 'inner']);
    assert.deepStrictEqual(json(array), ['Ada', 'Alan']);
    assert.deepStrictEqual(json(deep), ['buried']);
  },
  'path-slice': ({ bookstore: r }) => assert.deepStrictEqual(json(r), BOOKS.slice(0, 2)),
  'path-regex': ({ bookstore: r }) => assert.deepStrictEqual(json(r, 'paths'), ["$['store']['book'][3]"]),
  'path-last': ({ bookstore: r }) => assert.deepStrictEqual(json(r), ['The Lord of the Rings']),
  // ——— JSON Pointer (RFC 6901 + relative) ———
  'pointer-nested': ({ bookstore: r }) => assert.strictEqual(out(r), '"Sword of Honour"'),
  'pointer-escaped': ({ 'tricky keys': r }) => assert.strictEqual(out(r), '"you found me"'),
  'pointer-miss': ({ bookstore: r }) => assert.strictEqual(out(r), '(nothing — the pointer addresses no value)'),
  'pointer-relative': ({ bookstore: r }) => assert.strictEqual(out(r), '8.95'),
  'pointer-relative-key': ({ bookstore: r }) => assert.strictEqual(out(r), '"title"'),
  // ——— JSON Patch (RFC 6902 / 7396) ———
  'patch-basics': ({ doc: r }) => {
    assert.deepStrictEqual(json(r), { baz: 'boo', numbers: [1, 2, 3], hello: ['world'] });
    assert.deepStrictEqual(json(r, 'changes'), ['/baz', '/hello', '/foo']);
  },
  'patch-append': ({ doc: r }) => assert.deepStrictEqual(json(r), { numbers: [1, 2, 3, 4] }),
  'patch-move': ({ doc: r }) => assert.deepStrictEqual(json(r), { keep: true, b: 1 }),
  'patch-test': ({ doc: r }) => assert.deepStrictEqual(json(r), { version: 6, user: { name: 'Bob', tags: ['reader', 'admin'] } }),
  'patch-merge': ({ doc: r }) => assert.deepStrictEqual(json(r), { name: 'Alice', age: 31, address: { city: 'Berlin', zip: '10999' }, newField: 'hello' }),
  'patch-diff': ({ original: r }) => assert.deepStrictEqual(json(r), [
    { op: 'replace', path: '/user/name', value: 'Bob' },
    { op: 'add', path: '/user/tags/1', value: 'admin' },
    { op: 'replace', path: '/version', value: 6 },
  ]),
  // ——— $query (numbers are IEEE 754 doubles) ———
  'query-filter': ({ bookstore: r }) => assert.deepStrictEqual(json(r), [{ title: 'Sayings of the Century', price: 8.95 }, { title: 'Moby Dick', price: 8.99 }]),
  'query-join': ({ bookstore: r }) => assert.deepStrictEqual(json(r), [{ title: 'Moby Dick', stars: 4 }, { title: 'The Lord of the Rings', stars: 5 }]),
  'query-group': ({ bookstore: r }) => assert.deepStrictEqual(json(r), [{ genre: 'reference', count: 1, avg: 8.95 }, { genre: 'fiction', count: 3, avg: 14.99 }]),
  'query-fold': ({ bookstore: r }) => assert.strictEqual(json(r), 8.95 + 8.99),
  'query-external': ({ bookstore: r }) => assert.deepStrictEqual(json(r), ['Sword of Honour', 'The Lord of the Rings']),
  'query-valid': ({ bookstore: r }) => assert.deepStrictEqual(json(r), ['Moby Dick', 'The Lord of the Rings']),
  'query-mean': ({ readings: r }) => assert.deepStrictEqual(json(r), { average: 100 / 7 }),
  // ——— JSLT ———
  'jslt-identity': ({ bookstore: r }) => assert.ok(panel(r, 'how').items.some((/** @type {any} */ i) => i.value === '=== input')),
  'jslt-vat': ({ bookstore: r }) => {
    const doc = json(r);
    assert.deepStrictEqual(doc.store.book.map((/** @type {any} */ b) => b.price), [8.95 * 1.21, 12.99 * 1.21, 8.99 * 1.21, 22.99 * 1.21]);
    assert.strictEqual(doc.store.bicycle.price, 399 * 1.21);
    assert.deepStrictEqual(doc.ratings, [{ isbn: '0-553-21311-3', stars: 4 }, { isbn: '0-395-19395-8', stars: 5 }]);
  },
  'jslt-reshape': ({ bookstore: r }) => assert.deepStrictEqual(json(r), { shopColour: 'red', firstTitle: 'Sayings of the Century' }),
  'jslt-schema-match': ({ bookstore: r }) => {
    const doc = json(r);
    assert.deepStrictEqual(doc.store.book.map((/** @type {any} */ b) => b.label), [
      'Sayings of the Century by Nigel Rees', 'Sword of Honour by Evelyn Waugh', 'Moby Dick by Herman Melville', 'The Lord of the Rings by J. R. R. Tolkien']);
    assert.deepStrictEqual(Object.keys(doc.store.book[0]), ['title', 'price', 'label']);
    assert.deepStrictEqual(doc.store.bicycle, { color: 'red', price: 399 });
  },
  'jslt-inputs': ({ Ada, Alan }) => {
    assert.deepStrictEqual(json(Ada), { greeting: 'Hello, Ada Lovelace' });
    assert.deepStrictEqual(json(Alan), { greeting: 'Hello, Alan Turing' });
  },
  // ——— JTLT ———
  'jtlt-md': ({ bookstore: r }) => assert.strictEqual(out(r), '# Books\n\n- **Sayings of the Century** — 8.95\n- **Sword of Honour** — 12.99\n- **Moby Dick** — 8.99\n- **The Lord of the Rings** — 22.99\n'),
  'jtlt-modes': ({ doc: r }) => assert.strictEqual(out(r), 'TOC\n- Introduction\n- Usage\n\n== Introduction ==\nStart here.\n\n== Usage ==\nThen this.\n\n'),
  'jtlt-xml': ({ notes: r }) => assert.strictEqual(out(r), '<notes>\n  <note title="Q&amp;A"><b>escaped attribute, raw body</b></note>\n  <note title="Rock &#39;n&#39; roll"><i>quotes too</i></note>\n</notes>'),
  'jtlt-codegen': ({ config: r }) => assert.strictEqual(out(r), 'export const config = {"threshold":10,"labels":["alpha","beta"]};\n'),
  'jtlt-sql': ({ shop: r }) => assert.strictEqual(out(r), '-- SQLite schema: shop\n\nCREATE TABLE customers (\n  id INTEGER,\n  email TEXT NOT NULL UNIQUE,\n  joined_on TEXT NOT NULL,\n  notes TEXT,\n  PRIMARY KEY (id)\n);\n\n'
    + 'CREATE TABLE orders (\n  id INTEGER,\n  customer_id INTEGER NOT NULL REFERENCES customers (id),\n  total NUMERIC NOT NULL,\n  placed_at TEXT NOT NULL,\n  PRIMARY KEY (id)\n);\n\n'),
  'jtlt-sql-pg': ({ shop: r }) => assert.strictEqual(out(r), '-- PostgreSQL schema: shop\n\nCREATE TABLE customers (\n  id integer GENERATED ALWAYS AS IDENTITY,\n  email varchar(254) NOT NULL UNIQUE,\n  joined_on date NOT NULL,\n  notes text,\n  PRIMARY KEY (id)\n);\n\n'
    + 'CREATE TABLE orders (\n  id integer GENERATED ALWAYS AS IDENTITY,\n  customer_id integer NOT NULL REFERENCES customers (id),\n  total numeric(12,2) NOT NULL,\n  placed_at timestamptz NOT NULL,\n  PRIMARY KEY (id)\n);\n\n'),
  // ——— XQuery ———
  'xquery-flwor': ({ bookstore: r }) => assert.deepStrictEqual(json(r), [{ title: 'Sayings of the Century', price: 8.95 }, { title: 'Moby Dick', price: 8.99 }]),
  'xquery-join': ({ bookstore: r }) => assert.deepStrictEqual(json(r), [{ title: 'Moby Dick', stars: 4 }, { title: 'The Lord of the Rings', stars: 5 }]),
  'xquery-group': ({ bookstore: r }) => assert.deepStrictEqual(json(r), [{ genre: 'reference', count: 1, avg: 8.95 }, { genre: 'fiction', count: 3, avg: 14.99 }]),
  'xquery-quantifier': ({ bookstore: r }) => assert.strictEqual(json(r), true),
  // ——— LINQ ———
  'linq-chain': ({ people, books }) => {
    assert.deepStrictEqual(json(people), [{ id: 3, name: 'Bo' }, { id: 1, name: 'Cleo' }, { id: 4, name: 'Dee' }]);
    assert.deepStrictEqual(json(books), [{ id: 4, name: 'The Lord of the Rings' }]);
  },
  'linq-group': ({ people: r }) => assert.deepStrictEqual(json(r), [{ team: 'core', people: 2, oldest: 34 }, { team: 'web', people: 2, oldest: 41 }]),
  'linq-params': ({ people: r }) => assert.deepStrictEqual(json(r), ['Cleo', 'Bo']),
  'linq-join': ({ people: r }) => assert.deepStrictEqual(json(r), [
    { manager: 'Cleo', report: 'Ada' }, { manager: 'Cleo', report: 'Bo' }, { manager: 'Bo', report: 'Dee' }]),
  'linq-operator': ({ people: r }) => {
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual({ code: r.error.code, pane: r.error.pane }, { code: 'PLAY_CHAIN', pane: 'chain' });
    const chain = EXAMPLES.find((e) => e.id === 'linq-operator')?.source.chain ?? '';
    assert.strictEqual(chain.slice(r.error.position - 6, r.error.position + 4), 'u.age > 21', 'the position is the refused >');
    assert.match(r.error.message, /\.gt\(\)/);
  },
  // ——— JOSL ———
  'josl-citizens': ({ source: r }) => assert.strictEqual(out(r), '{\n  "title": "kitchen sink",\n  "middle-name": null,\n  "big": 9007199254740993n,\n  "mask": 255n,\n  "match": /^ok[!.]?$/i,\n'
    + '  "when": 2026-07-18T12:00:00.000Z,\n  "day": 2026-07-18,\n  "server": {\n    "host": "localhost",\n    "ports": [\n      8080,\n      8443\n    ]\n  }\n}'),
  'josl-records': ({ source: r }) => assert.strictEqual(out(r), '[\n  {\n    "name": "first",\n    "score": 0.92,\n    "meta": {\n      "source": "model-a"\n    }\n  },\n  {\n    "name": "second",\n    "score": 0.87,\n    "tags": [\n      "draft"\n    ]\n  }\n]'),
  // an offset date-time reads as a Date: the same instant, written in UTC
  'josl-toml': ({ source: r }) => assert.strictEqual(out(r), '{\n  "title": "TOML Example",\n  "owner": {\n    "name": "Tom Preston-Werner",\n    "dob": 1979-05-27T15:32:00.000Z\n  },\n  "products": [\n    {\n      "name": "Hammer",\n      "sku": 738594937\n    }\n  ]\n}'),
  // ——— JSONX ———
  'jsonx-citizens': ({ source: r }) => {
    assert.deepStrictEqual(json(r), { title: 'kitchen sink', count: 1000000, match: {}, at: '2026-07-18T12:00:00.000Z', day: '2026-07-18', ratio: null, tags: ['a', 'b'] });
    assert.match(out(r, 'kept'), /^4 values JSON writes differently:/);
  },
  'jsonx-bigint': ({ source: r }) => {
    assert.strictEqual(panel(r, 'out'), undefined, 'a bigint document has no JSON spelling');
    assert.match(out(r, 'kept'), /\/id: a bigint — JSON has no spelling for it/);
  },
  'jsonx-strict': ({ source: r }) => assert.deepStrictEqual(json(r), { name: 'Ada', langs: ['en', 'nl'], active: true }),
  // ——— CSV ———
  'csv-rfc': ({ source: r }) => assert.deepStrictEqual(rows(r), { columns: ['id', 'name', 'note'], rows: [
    ['1', 'Ada', 'quoted, with a comma'], ['2', 'Grace', 'a doubled " quote'], ['3', 'Alan', 'a field that spans\ntwo lines']] }),
  // every damage is healed in place and logged: no record swallows the next
  'csv-repair': ({ source: r }) => {
    assert.deepStrictEqual(rows(r), { columns: ['id', 'name', 'note', 'column_4'], rows: [
      ['1', 'Ada', 'oktrailing text', ''], ['2', 'Grace', 'he said "hi" today', ''], ['3', 'Alan', '', ''],
      ['4', 'Edsger', 'extra', 'column'], ['5', 'Barbara', 'never closed', '']] });
    // line 5 widens the header to four columns, so line 6's three fall short of it
    assert.deepStrictEqual(panel(r, 'repairs').rows.map((/** @type {string[]} */ x) => `${x[0]}@${x[1]}`),
      ['CSV1002@2', 'CSV1003@3', 'CSV1003@3', 'CSV1004@4', 'CSV1005@5', 'CSV1001@6', 'CSV1004@6']);
    assert.match(out(r, 'summary'), /^,-delimited · header row · 5 records · 7 repairs\n/);
  },
  // typed cells show their own text: a date is not shown as a quoted JSON string
  'csv-dialect': ({ source: r }) => {
    assert.match(out(r, 'summary'), /^;-delimited · header row · 3 records · clean$/);
    assert.deepStrictEqual(rows(r).rows, [['Amsterdam', '921402', '1275-10-27'], ['Rotterdam', '651446', '1340-06-07'], ['Den Haag', '548320', '1248-01-01']]);
  },
  'csv-typed': ({ source: r }) => assert.deepStrictEqual(rows(r).rows, [
    ['A-1', '19.95', '01234', '123456789012345678901234567890', 'true', '2026-07-27'],
    ['A-2', '4.5', '00042', '7', 'false', '2026-07-27T08:30:00.000Z']]),
  // ——— Kernels ———
  'kernel-distance': ({ source: r }) => assert.strictEqual(json(r), 429861.983446582),
  'kernel-geohash': ({ source: r }) => assert.strictEqual(json(r), 'u173zt5'),
  'kernel-add-duration': ({ source: r }) => assert.strictEqual(json(r), '2026-02-28T10:00:00Z'),
  'kernel-date-format': ({ source: r }) => assert.strictEqual(json(r), '2026-07-27 at 14:30'),
  'kernel-round': ({ source: r }) => assert.strictEqual(json(r), 1),
  'kernel-iregexp': ({ source: r }) => assert.strictEqual(json(r), true),
  // ——— MDX ———
  'mdx-invoice': ({ paid, unpaid }) => {
    assert.strictEqual(seen(paid), 'Invoice INV-7 # Billed to Ada (ada@example.com). Rubber duck — 9.99 Duck house — 40.01 Total: 50 Paid — thank you!');
    assert.strictEqual(seen(unpaid), 'Invoice INV-8 # Billed to Alan (alan@example.com). Enigma manual — 120 Total: 120');
  },
  'mdx-digest': ({ stories: r }) => assert.deepStrictEqual(['h1', 'h2'].flatMap((t) => nodes(vnode(r), t).map((n) => textOf(n).replace(/#$/, ''))),
    ['The weekly digest', 'Play retires the playground', 'Markdown meets data']),
  // a marker that does not begin its line resolves; the note stays text
  'mdx-comment': ({ release: r }) => {
    assert.deepStrictEqual(nodes(vnode(r), 'li').map(textOf), ['shipped 2026-08-11', 'one version across 21 packages']);
    assert.strictEqual(textOf(nodes(vnode(r), 'h1')[0]).replace(/#$/, ''), 'Release 0.31.3');
    assert.match(seen(r), /data you did not write: \*\*not bold\*\*, <script>not script<\/script>$/);
  },
  // ——— Markdown ———
  'md-tour': ({ source: r }) => {
    assert.deepStrictEqual(json(r, 'frontmatter'), { title: 'The inverse of JTLT', tags: ['markdown', 'jaren'] });
    const boxes = nodes(vnode(r), 'input').map((n) => n[1].checked === true);
    assert.deepStrictEqual(boxes, [true, true, false]);
    assert.ok(nodes(vnode(r), 'a').some((n) => n[1].href === 'http://www.commonmark.org'), 'the bare www link');
    assert.deepStrictEqual(nodes(vnode(r), 'th').map((n) => n[1].style), ['text-align:left', 'text-align:right']);
  },
  'md-frontmatter': ({ source: r }) => assert.deepStrictEqual(json(r, 'frontmatter'), { title: 'TOML up top', weight: 3 }),
  // the in-page link lands on the heading the page minted (prefixed on this page)
  'md-anchors': ({ source: r }) => {
    const link = nodes(vnode(r), 'a').find((n) => textOf(n) === 'jump to the notes');
    const target = link[1].on.click.with.id;
    assert.ok(idsOf(vnode(r)).includes(target), `the link scrolls to "${target}", an id the article holds`);
    assert.strictEqual(target, 'user-content-the-notes');
    assert.ok(nodes(vnode(r), 'a').some((n) => n[1].href === 'mailto:spec@commonmark.test'), 'the bare email link');
  },
  // the baked figure is derived from the library, so the static line is true
  'md-directives': ({ source: r }) => {
    assert.strictEqual(textOf(nodes(vnode(r), 'p')[0]), `This playground runs ${Object.keys(ENGINES).length} engines.`);
  },
  'md-roundtrip': ({ source: r }) => {
    const source = String(EXAMPLES.find((e) => e.id === 'md-roundtrip')?.source.source);
    assert.deepStrictEqual(parseMarkdown(out(r, 'roundtrip')).ast, parseMarkdown(source).ast);
  },
  // ——— Mermaid ———
  'mermaid-flow': ({ source: r }) => assert.strictEqual(seen(r), 'Yes No Start Is it working? Ship it Debug Done'),
  'mermaid-seq': ({ source: r }) => {
    assert.strictEqual(seen(r), 'Alice Alice Bob Bob handshake complete Authenticate Token');
    const html = renderToString(vnode(r));
    const bar = /<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[^>]*class="mm-activation"/.exec(html);
    const lifelines = [...html.matchAll(/<line x1="([\d.]+)"[^>]*class="mm-lifeline"/g)].map((m) => Number(m[1]));
    assert.strictEqual(Number(bar?.[1]) + Number(bar?.[2]) / 2, lifelines[1], 'the activation sits on Bob');
  },
  'mermaid-state': ({ source: r }) => assert.strictEqual(seen(r), 'start stop Idle Running'),
  'mermaid-pie': ({ source: r }) => assert.strictEqual(seen(r), 'Time spent Parsing (20.0%) Layout (35.0%) Rendering (45.0%)'),
  'mermaid-gantt': ({ source: r }) => {
    const day = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10);
    const tasks = json(r, 'ast').sections.flatMap((/** @type {any} */ s) => s.tasks).map((/** @type {any} */ t) => [t.name, day(t.start), day(t.end)]);
    assert.deepStrictEqual(tasks, [['Design', '2024-01-04', '2024-01-09'], ['Implement', '2024-01-09', '2024-01-16'],
      ['Review', '2024-01-16', '2024-01-18'], ['Launch', '2024-01-18', '2024-01-18']]);
  },
  'mermaid-class': ({ source: r }) => assert.strictEqual(seen(r), 'Class diagram Shape +String name +area() Number Circle +Number radius Square +Number side relations Shape <|-- Circle Shape <|-- Square'),
  'mermaid-er': ({ source: r }) => assert.strictEqual(seen(r), 'Entity–relationship CUSTOMER int id PK string email ORDER int id PK int customer_id FK LINE_ITEM relationships CUSTOMER ||--o{ ORDER : places ORDER ||--|{ LINE_ITEM : contains'),
  // ——— Charts ———
  'charts-pie': ({ source: r }) => assert.match(seen(r), /validate \(42\.0%\) json \(25\.0%\) view \(18\.0%\) md \(15\.0%\)$/),
  'charts-bar': ({ source: r }) => assert.match(seen(r), /jaren — ~2 kB: 0\.11 jaren — ~40 kB: 2\.3 jaren — ~90 kB: 10\.7 rival — ~2 kB: 0\.43 rival — ~40 kB: 6\.1 rival — ~90 kB: 38\.4$/),
  'charts-heatmap': ({ source: r }) => assert.match(seen(r), /4 books × singular: 220 100 books × singular: 80 1000 books × singular: 12 4 books × filter: 90 100 books × filter: 30 1000 books × filter: 6 4 books × join: 15 100 books × join: 4 1000 books × join: 1\.2$/),
  'charts-sankey': ({ source: r }) => assert.match(seen(r), /search → home: 40 social → home: 15 home → docs: 30 home → play: 20 docs → github: 8/),
  'charts-line': ({ source: r }) => assert.match(seen(r), /120 140 160 180 200 220 240 2026-07-27 2026-07-28 2026-07-29 2026-07-30 api$/),
  'charts-scatter': ({ source: r }) => assert.match(seen(r), /budget \(1, 1\.2\) \(4, 2\.9\) \(9, 4\.1\) \(16, 6\.8\) \(25, 9\.5\)$/),
  'charts-candlestick': ({ source: r }) => {
    assert.match(seen(r), /2026-07-28 O 105 H 110 L 101 C 102/);
    assert.deepStrictEqual([...renderToString(vnode(r)).matchAll(/<rect[^>]*class="chart-candle-(up|down)"/g)].map((m) => m[1]), ['up', 'down', 'up', 'up']);
  },
  'charts-radar': ({ source: r }) => assert.match(seen(r), /parse compile run memory size jaren rival/),
  'charts-gauge': ({ source: r }) => assert.match(seen(r), /0 20 40 60 80 100 87 %$/),
  'charts-boxplot': ({ source: r }) => assert.match(seen(r), /\/home — min 12, q1 14\.75, median 16, q3 18\.75, max 60 \/search — min 30, q1 39\.5, median 48, q3 60, max 71$/),
  'charts-treemap': ({ source: r }) => assert.match(seen(r), /engines \(69\.8%\) views \(30\.2%\) engines \/ json: 55 \(39\.6%\) json engines \/ validate: 42 \(30\.2%\) validate views \/ view: 24 \(17\.3%\) view views \/ md: 18 \(12\.9%\) md$/),
  'charts-streamgraph': ({ source: r }) => assert.match(seen(r), /search social direct$/),
  'charts-map': ({ source: r }) => assert.match(seen(r), /West: 1200 East: 9800$/),
  // ——— JSON Schema (verdicts and error sets agreed by Ajv 8, allErrors) ———
  'validate-user': ({ valid: r }) => assert.strictEqual(verdict(r), '✓ valid'),
  'validate-conditional': ({ 'a card payment': r }) => assert.strictEqual(verdict(r), '✓ valid'),
  'validate-query': ({ balanced: r }) => assert.strictEqual(verdict(r), '✓ valid'),
  'validate-invalid': ({ invalid: r }) => {
    assert.strictEqual(verdict(r), '✗ 3 errors');
    assert.deepStrictEqual(errors(r), ['/age must be >= 13', '/email must match format "email"', '/name must NOT have fewer than 2 characters']);
  },
  'validate-ref-by-id': ({ valid, 'missing city': missing }) => {
    assert.strictEqual(verdict(valid), '✓ valid');
    assert.deepStrictEqual(errors(missing), ["/billing must have required property 'city'"]);
  },
  // ——— Contract ———
  'contract-shop': ({ 'a valid save': save, 'an invalid input': invalid, 'no dispatch': none }) => {
    assert.deepStrictEqual(dispatched(save), { ok: true, value: { id: 7, product: { id: 7, name: 'Duck', price: 9.99 } },
      meta: { op: 'product.save', attempt: null, revision: null, etag: null, notModified: false } });
    const refused = dispatched(invalid);
    assert.deepStrictEqual([refused.ok, refused.error.code, refused.error.details.map((/** @type {any} */ d) => `${d.path}|${d.keyword}`).sort()],
      [false, 'JC2050', ['/id|type', '|required']]);
    assert.strictEqual(panel(none, 'dispatch').tone, 'info');
    const put = json(none, 'openapi').paths['/api/products/{id}'].put;
    assert.deepStrictEqual([put.parameters[0].name, put.parameters[0].in, Object.keys(put.responses).includes('409')], ['id', 'path', true]);
  },
  'contract-minimal': ({ 'say something': r }) => {
    assert.deepStrictEqual([json(r, 'describe').operations[0].method, json(r, 'describe').operations[0].path], ['POST', '/echo.say']);
    assert.deepStrictEqual(dispatched(r).value, { text: 'hello' });
  },
  'contract-broken': ({ 'nothing to dispatch': r }) => {
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual({ code: r.error.code, pane: r.error.pane, path: r.error.path }, { code: 'JC0006', pane: 'document', path: '/operations/catalog.load/output' });
  },
  // ——— Emit ———
  'emit-user': ({ source: r }) => assert.strictEqual(declarations(out(r)), 'export type Id = string;\nexport interface Root {\n  id: Id;\n  name: string;\n  role?: "admin" | "user";\n  tags?: Array<string>;\n  [key: string]: unknown;\n}'),
  'emit-markdown': ({ source: r }) => assert.match(out(r), /\| `id` \| `Id` \| yes \|\n\| `name` \| `string` \| yes \|\n\| `role` \| `"admin" or "user"` \| no \|\n\| `tags` \| `array of string` \| no \|/),
  'emit-closed': ({ source: r }) => assert.strictEqual(declarations(out(r)), 'export type Id = string;\nexport interface Root {\n  id: Id;\n  name: string;\n  role?: "admin" | "user";\n  tags?: Array<string>;\n}'),
  'emit-defaults': ({ source: r }) => assert.strictEqual(declarations(out(r)), 'export interface Root {\n  name: string;\n  port: number;\n  verbose: boolean;\n}\nexport interface RootInput {\n  name: string;\n  port?: number;\n  verbose?: boolean;\n}'),
  'emit-coerce': ({ source: r }) => assert.strictEqual(declarations(out(r)), 'export interface Root {\n  name: string;\n  port?: number;\n  verbose?: boolean;\n}\nexport interface RootInput {\n  name: string | number | boolean;\n  port?: number | string;\n  verbose?: boolean | string;\n}'),
  'emit-twins': ({ source: r }) => assert.strictEqual(declarations(out(r)), 'export interface Root {\n  name: string;\n  port: number;\n  verbose: boolean;\n}\nexport interface RootInput {\n  name: string | number | boolean;\n  port?: number | string;\n  verbose?: boolean | string;\n}'),
  'emit-recursive': ({ source: r }) => assert.strictEqual(out(r), 'export interface Node {\n  label: string;\n  children?: Array<Node>;\n}\n\n\nexport type Root = Node;\n'),
};

// the localized examples share one schema and one document: the same three
// errors at the same places, in each language (Ajv agrees on the pairs)
for (const ex of EXAMPLES.filter((e) => e.id.startsWith('validate-locale-'))) {
  PINS[ex.id] = ({ invalid: r }) => {
    assert.strictEqual(panel(r, 'errors').rows.length, 3);
    assert.deepStrictEqual(panel(r, 'errors').rows.map((/** @type {string[]} */ row) => row[0]).sort(), ['(root)', '/age', '/name']);
    assert.match(panel(r, 'errors').rows.find((/** @type {string[]} */ row) => row[0] === '(root)')[1], /email/);
  };
}

describe('play examples show the right answer through the site runner', () => {
  it('every example carries a pin', () => {
    assert.deepStrictEqual(EXAMPLES.map((e) => e.id).filter((id) => !Object.hasOwn(PINS, id)), []);
  });

  for (const ex of EXAMPLES) {
    it(ex.id, async () => {
      /** @type {Record<string, any>} */
      const runs = {};
      for (const ds of ex.datasets.length > 0 ? ex.datasets : [{ label: 'source', data: {} }]) runs[ds.label] = await runOver(ex, ds);
      for (const [label, r] of Object.entries(runs)) {
        const refusal = ex.id === 'linq-operator' || ex.id === 'contract-broken';
        assert.strictEqual(r.ok, !refusal, `${ex.id} / ${label}: ${r.error?.message ?? 'answered'}`);
      }
      PINS[ex.id]?.(runs);
    });
  }
});

describe('an in-page link in rendered markdown lands on an id the article holds', () => {
  /** The id a link's click scrolls to. @param {any} article @param {string} text */
  const target = (article, text) => nodes(article, 'a').find((n) => textOf(n) === text)[1].on.click.with.id;
  const source = '# The notes\n\n[bare](#the-notes) [prefixed](#user-content-the-notes) [nowhere](#nowhere)\n';

  it('a bare slug lands on the prefixed id an untrusted render mints', () => {
    const article = mdArticle(md.view(source, UNTRUSTED));
    assert.deepStrictEqual(['bare', 'prefixed', 'nowhere'].map((t) => target(article, t)),
      ['user-content-the-notes', 'user-content-the-notes', 'nowhere']);
  });

  it('a trusted render keeps every fragment as written, and a bare id that exists wins over a prefixed one', () => {
    const article = mdArticle(md.view(source, TRUSTED));
    assert.deepStrictEqual(['bare', 'prefixed', 'nowhere'].map((t) => target(article, t)), ['the-notes', 'user-content-the-notes', 'nowhere']);
    // both `the-notes` and `user-content-the-notes` are headings here
    const both = mdArticle(md.view('# The notes\n\n# User content the notes\n\n[go](#the-notes)\n', TRUSTED));
    assert.deepStrictEqual([idsOf(both).includes('the-notes'), idsOf(both).includes('user-content-the-notes'), target(both, 'go')], [true, true, 'the-notes']);
  });
});
