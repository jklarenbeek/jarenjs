//@ts-check
/**
 * @file The playground speaks the reader's language. A pseudo-locale (every
 * playground message id rendered as `⟦id⟧`) runs every example, and a set
 * of forced states (errors at every location family, the session bar in
 * each state, every result tab and every drill-down panel, the refusals the
 * playground writes), through the engines, the view model and the JSLT
 * view: the rendering must show none of the English catalog's text, every
 * word of chrome must carry the pseudo-locale's mark, and every id must be
 * reached. Without a catalog, or with the English one compiled, every
 * result and every view is the English it was.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { compileMessageCatalog, compileMessageTemplate } from '@jarenjs/core/message';
import { LOCALE_NAMES } from '@jarenjs/locales';
import { EXAMPLES, ENGINES, runExample, playMessagesEn, playText } from '@jarenjs/play';
import { createPlayComponent, playViewModel, playRules, playModes } from '@jarenjs/play/component';
import { compileJsltStylesheet, createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';

const IDS = Object.keys(playMessagesEn);
const MARK = '⟦';
/** Every id the pseudo-locale rendered. */
const reached = new Set();
const PSEUDO = compileMessageCatalog(Object.fromEntries(IDS.map((id) => [id, () => { reached.add(id); return `⟦${id}⟧`; }])));

const ops = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);
const stub = (/** @type {string} */ s) => ['pre', {}, String(s)];
const renderers = { markdown: stub, mermaid: stub, charts: stub, mdx: stub };
const report = (/** @type {any[]} */ errors) => ({ schemaError: null, draft: 'draft-07', compileMs: 0.1, validateMs: 0.1, valid: errors.length === 0, errors });
const VALIDATORS = [
  () => report([]),
  () => report([{ instancePath: '', message: 'm1' }]),
  () => report([{ instancePath: '', message: 'm1' }, { instancePath: '/a', message: 'm2' }]),
];

/** Every label a descriptor gives no message id. */
const UNTRANSLATED = Object.values(ENGINES).flatMap((e) => [
  ...(e.msgid ? [] : [e.label]),
  ...[...e.sourcePanes, ...e.dataPanes].filter((p) => !p.msgid).map((p) => p.label),
  ...(e.optionPanes ?? []).flatMap((o) => [...(o.msgid ? [] : [o.label]), ...o.choices.filter((c) => !c.msgid).map((c) => c.label)]),
]);

/** Names no language translates, each for its reason. */
const NAMES = new Set([
  // the engines, by the name of the format or package each runs
  'JSONPath', 'JSON Pointer', 'JSON Patch', '$query', 'JSLT', 'JTLT', 'XQuery', 'LINQ', 'JOSL', 'JSONX', 'CSV',
  'JSON Schema', 'MDX', 'Contract', 'Emit', 'Markdown', 'Mermaid', 'Charts',
  // formats a pane holds, a choice names, a projection is written in, or the data toggle shows
  'TypeScript', 'JSON', 'OpenAPI', 'describe()',
  // delimiters, which are their own spelling
  ',', ';', '|',
  // the kernels, by their @jarenjs/core subpath and export name
  'geo · geoDistance', 'geo · geohashEncode', 'dates · addDuration', 'dates · compileDateFormat', 'math · roundExact', 'text · compileIRegexp',
  // a language is named in its own language
  'English', ...LOCALE_NAMES.map((l) => l.name),
  // the draft the host's validator names in the verdict line
  'draft-07',
  // the session names the forced states save under: the reader's own words
  'saved-one', 'renamed-one',
]);

/** Classes whose text is content, not chrome: host vnodes, code, card
 * values, the error's own message (an engine's words), and table cells.
 * Content may not BE an English message, but need not carry the mark. */
const CONTENT = ['jplay-view', 'code-block', 'jplay-card-value', 'error-line'];
/** Classes whose text the example library writes (English by design): the
 * lead, the example and dataset names. Not checked. */
const FOREIGN = ['jplay-lead', 'jplay-ex', 'jplay-datasets'];

/** Every string a rendering shows: text nodes, and the aria-label / title /
 * placeholder attributes, each marked chrome or content. @returns {{ text: string, chrome: boolean }[]} */
function strings(/** @type {any} */ node, chrome = true, /** @type {{ text: string, chrome: boolean }[]} */ out = []) {
  if (typeof node === 'string') { out.push({ text: node, chrome }); return out; }
  if (!Array.isArray(node)) return out;
  if (typeof node[0] !== 'string') { for (const child of node) strings(child, chrome, out); return out; }
  const [tag, attrs, ...children] = node;
  const classes = typeof attrs?.class === 'string' ? attrs.class.split(' ') : [];
  if (classes.some((c) => FOREIGN.includes(c))) return out;
  for (const name of ['aria-label', 'title', 'placeholder']) if (typeof attrs?.[name] === 'string') out.push({ text: attrs[name], chrome: true });
  const inner = chrome && tag !== 'td' && tag !== 'th' && !classes.some((c) => CONTENT.includes(c));
  for (const child of children) strings(child, inner, out);
  return out;
}

/** The English a rendering must not show: each literal entry rendered, and
 * a pattern per parameterized entry or closure (a closure's pattern is its
 * rendering at counts 1 and 2, the digits generalized). */
const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LITERAL = new Map();
const PATTERNS = [];
for (const id of IDS) {
  const entry = playMessagesEn[id];
  if (typeof entry === 'function') {
    const shapes = [1, 2].map((count) => escape(entry({ count })).replace(/\d+/g, '\\d+'));
    PATTERNS.push([id, new RegExp(`^(?:${shapes.join('|')})$`)]);
    continue;
  }
  const render = compileMessageTemplate(entry);
  if (render.parameters.length === 0) { LITERAL.set(render({}), id); continue; }
  const parts = entry.split(/(\{\{|\{[^{}]*\})/);
  // a template whose words are all parameters (`{pane}: {message}`) is
  // punctuation: nothing of it is English
  if (!parts.some((part) => !part.startsWith('{') && /\p{L}/u.test(part))) continue;
  const source = parts.map((part) => (part === '{{' ? '\\{' : part.startsWith('{') && part.endsWith('}') ? '[\\s\\S]+?' : escape(part))).join('');
  PATTERNS.push([id, new RegExp(`^${source}$`)]);
}

/** Content that is a format's own token, shown verbatim: a JSONX parser
 * event's kind (`open`, the start of a container) in the events table. */
const TOKENS = new Set(['open']);
/** A library's own coded refusal the dispatch panel quotes: the contract
 * client's thrown host-mistake error (`JC1005`, an operation the contract
 * does not declare) has no catalog sentence, and keeps its English. */
const LIBRARY = /^JC1\d{3}: /;

/** What a rendering shows that it must not. @returns {string[]} */
function violations(/** @type {any} */ vnode, /** @type {string} */ where) {
  const found = [];
  for (const { text, chrome } of strings(vnode)) {
    if (NAMES.has(text.trim()) || (!chrome && TOKENS.has(text)) || LIBRARY.test(text)) continue;
    for (const segment of text.split(/\n| · /).map((s) => s.trim()).filter((s) => s !== '')) {
      if (NAMES.has(segment)) continue;
      if (LITERAL.has(segment)) found.push(`${where}: English "${segment}" (${LITERAL.get(segment)})`);
      else if (chrome) {
        const pattern = PATTERNS.find(([, re]) => re.test(segment));
        if (pattern) found.push(`${where}: English "${segment}" (${pattern[0]})`);
        else if (/\p{L}/u.test(segment) && !segment.includes(MARK)) found.push(`${where}: unmarked chrome "${segment}"`);
      }
    }
  }
  return found;
}

const sheet = compileJsltStylesheet({
  $jslt: '0.1', modes: playModes,
  rules: [{ match: '$', body: { $apply: ['$.ui.play', 'play'] } }, ...playRules],
});
/** The view over one play slice, in the pseudo-locale. */
const render = (/** @type {any} */ play) => sheet({ ui: { play: playViewModel({ play }, { messages: PSEUDO }) } });

/** The calm view of a result, then each simple tab and each deep panel. */
function everyView(/** @type {any} */ play) {
  const panels = play.result?.panels ?? [];
  return [{ ...play, deep: false }, ...panels.map((/** @type {any} */ p) => (p.depth === 'deep'
    ? { ...play, deep: true, deepPick: p.id } : { ...play, panel: p.id }))].map(render);
}

/** Run an engine in the pseudo-locale. */
const pseudoRun = (/** @type {string} */ engine, /** @type {any} */ source, /** @type {any} */ data = {}, /** @type {any} */ config = {}, extra = {}) =>
  Promise.resolve(runExample(engine, source, data, { operators: ops, config, renderers, validate: VALIDATORS[0], messages: PSEUDO, ...extra }));

/** The inputs no example reaches: each a refusal or a shape the library
 * keeps clean on purpose. [engine, source, data, config] */
const bad = '{ nope';
const FORCED = [
  // a JSON parse failure names each pane in words
  ['path', { selector: '$' }, { data: bad }], ['patch', { patch: '[]' }, { data: bad }], ['patch', { patch: bad }, { data: '{}' }],
  ['query', { query: bad }, { data: '{}' }], ['query', { query: '"$"', externals: bad }, { data: '{}' }],
  ['jslt', { stylesheet: bad }, { data: '{}' }], ['jtlt', { template: bad }, { data: '{}' }],
  ['emit', { schema: bad }], ['emit', { schema: '[]' }], ['validate', { schema: '{}', schemas: bad }, { data: '{}' }],
  ['kernels', { args: bad }, {}, { kernel: 'geoDistance' }], ['kernels', { args: '{}' }, {}, { kernel: 'geoDistance' }],
  ['contract', { document: bad }], ['contract', { document: EXAMPLES.find((e) => e.id === 'contract-minimal')?.source.document }, { call: bad }],
  // the referenced-schemas pane's own refusals
  ['validate', { schema: '{}', schemas: '{}' }, { data: '{}' }], ['validate', { schema: '{}', schemas: '[1]' }, { data: '{}' }],
  ['validate', { schema: '{}', schemas: '[{"$id":"a"},{"$id":"a#"}]' }, { data: '{}' }],
  // results written in words
  ['pointer', { pointer: '/nope', location: '' }, { data: '{}' }], ['query', { query: '"$.nope"' }, { data: '{}' }],
  ['jtlt', { template: '{"$jtlt":"0.1","rules":[{"match":"$","body":[]}]}' }, { data: '{}' }], ['xquery', { text: '()' }, { data: '{}' }],
  ['patch', { patch: '{"a":1}' }, { data: '{"a":1}' }, { mode: 'merge' }], ['patch', { patch: '{"a":2}' }, { data: '{"a":1}' }, { mode: 'merge' }],
  ['patch', { patch: '{"a":2}' }, { data: '{"a":1}' }, { mode: 'diff' }],
  ['jslt', { stylesheet: '{"$jslt":"0.1","rules":[]}' }, { data: '{"a":1}' }],
  // capped event tables, a document whose every value JSON keeps, losses
  ['josl', { text: Array.from({ length: 250 }, (_, i) => `k${i} = ${i}`).join('\n') }, {}, { mode: 'josl' }],
  ['jsonx', { text: JSON.stringify(Array.from({ length: 250 }, (_, i) => i)) }, {}, { mode: 'jsonx' }],
  ['jsonx', { text: '[1n, /a/g, Infinity, 2024-01-02T03:04:05Z, 2024-01-02T03:04:05, 2024-01-02, 03:04:05]' }, {}, { mode: 'jsonx' }],
  // a CSV that is long, positional, tab-delimited, repaired
  ['csv', { text: Array.from({ length: 60 }, (_, i) => `${i}\tx`).join('\n') }, {}, { repair: 'strict', headers: 'false', delimiter: 'tab', typed: 'off' }],
  ['csv', { text: 'a,b\n"1,2\n' }, {}, { repair: 'repair', headers: 'true', delimiter: 'auto', typed: 'off' }],
  // the kernels' two doors, every way they can disagree
  ['kernels', { args: '[[1, 2], "x"]' }, {}, { kernel: 'geoDistance' }],
  ['kernels', { args: '[4.9, 52.4]' }, {}, { kernel: 'geohashEncode' }],
  ['kernels', { args: '["[", "a"]' }, {}, { kernel: 'compileIRegexp' }],
  ['kernels', { args: '["a", 1]' }, {}, { kernel: 'compileIRegexp' }],
  ['kernels', { args: '["nope", "P1D"]' }, {}, { kernel: 'addDuration' }],
  ['kernels', { args: '[[0, 0], []]' }, {}, { kernel: 'geoDistance' }],
  ['kernels', { args: '[null, null, 3]' }, {}, { kernel: 'geohashEncode' }],
  // the contract dispatch: no call, a call naming no op, an echo, an unknown op
  ...[undefined, '{}', '{"op":"echo.say","input":{"text":"hi"}}', '{"op":"nope"}', '{"op":"echo.say","input":{}}'].map((call) =>
    ['contract', { document: EXAMPLES.find((e) => e.id === 'contract-minimal')?.source.document }, call === undefined ? {} : { call }]),
  // every refusal the chain reader words
  ...[
    'from(data) /* x', 'from(data).where(`x`)', 'from(data)#', "from(data).where('\\q')", "from(data).where('abc",
    'from(data).where((u) => u.a + 1)', 'from(data).where((u) => u.a - 1)', 'from(data).where((u) => u.a ? 1 : 2)',
    'from(data).where((u) => u.a > 1)', 'from(data) x', 'from data', 'from(data', 'from(data).(', 'from(data).take(1 2)',
    'from(data).where((u) => u.a.in([1 2]))', 'from(data).select((u) => ({ a: u.a b: 1 }))', 'from(data).select((u) => ({ 1: u }))',
    'from(data).select((u) => ({ a u }))', 'from(data).take(,)', 'from(data).where((u) => u.)', 'data', 'from(x)',
    'from(data).toArray()', 'from(data).nope()', 'from(data).where((u) => { a: 1 })', 'from(data).take(x)',
    'from(data).where(() => u.a)', 'from(data).where((u) => x.a)', 'from(data).where((u) => u[0])', 'from(data).take(1 .a)',
    'from(data).select((a, b, c, d) => d.x)', 'from(data).where((u) => u.eq)',
    "from(data).select((u) => u.constructor.constructor('return 1'))",
  ].map((chain) => ['linq', { chain }, { data: '[{"a":1}]' }]),
];

/** Results no engine run reaches: a location of every family on a pane, a
 * runtime location in the data, and the session bar's states. */
const FORCED_VIEWS = [
  { engine: 'patch', source: { patch: '[]' }, data: { data: '{}' }, result: { ok: false, timing: null, panels: [], error: { message: 'm', code: 'C1', pane: 'patch', path: '' } } },
  { engine: 'patch', source: { patch: '[]' }, data: { data: '{}' }, result: { ok: false, timing: null, panels: [], error: { message: 'm', pane: 'patch', path: '/0', dataPath: '' } } },
  { engine: 'patch', source: { patch: '[]' }, data: { data: '{}' }, result: { ok: false, timing: null, panels: [], error: { message: 'm', pane: 'patch', path: '/0', dataPath: '/a' } } },
  { engine: 'path', source: { selector: '$[' }, data: { data: '{}' }, result: { ok: false, timing: null, panels: [], error: { message: 'm', pane: 'selector', position: 2 } } },
  { engine: 'josl', source: { text: 'x' }, data: {}, result: { ok: false, timing: null, panels: [], error: { message: 'm', pane: 'text', line: 1 } } },
  { engine: 'josl', source: { text: 'x' }, data: {}, result: { ok: false, timing: null, panels: [], error: { message: 'm', pane: 'text', line: 1, column: 2 } } },
  { engine: 'path', source: {}, data: {}, result: null, name: 'saved-one', names: ['saved-one'], savedName: 'saved-one' },
  { engine: 'path', source: {}, data: {}, result: null, name: 'renamed-one', names: ['saved-one'], savedName: 'saved-one' },
  { engine: 'validate', source: {}, data: {}, result: null, dataView: 'form' },
];

describe('@jarenjs/play — the pseudo-locale renders no English', () => {
  it('a descriptor label with no message id is a name the allowlist gives a reason for', () => {
    assert.deepEqual(UNTRANSLATED.filter((label) => !NAMES.has(label)), []);
  });

  it('every example, every forced state: every word of chrome is the catalog\'s', async () => {
    const found = [];
    const runs = [];
    for (const ex of EXAMPLES) {
      const sets = ex.datasets.length > 0 ? ex.datasets : [{ label: '—', data: {} }];
      for (const ds of sets) {
        for (const validate of ex.engine === 'validate' ? VALIDATORS : [VALIDATORS[0]]) {
          runs.push([`${ex.id} / ${ds.label}`, { engine: ex.engine, exampleId: ex.id, source: ex.source, data: ds.data, config: ex.config ?? {} }, validate]);
        }
      }
    }
    FORCED.forEach(([engine, source, data, config], i) => runs.push([`forced ${i} (${engine})`, { engine, source, data: data ?? {}, config: config ?? {} }, VALIDATORS[0]]));
    for (const [where, play, validate] of runs) {
      const result = await pseudoRun(play.engine, play.source, play.data, play.config, { validate });
      // an error the playground words carries the mark; a compiler's own
      // message (the contract compiler, the linq package) is its English
      if (play.exampleId === 'linq-operator') assert.ok(result.error?.message.includes(MARK), `${where}: ${result.error?.message}`);
      for (const vnode of everyView({ ...play, result })) found.push(...violations(vnode, where));
    }
    FORCED_VIEWS.forEach((play, i) => found.push(...violations(render(play), `forced view ${i}`)));
    found.push(...violations(render({ engine: 'path', result: (/** @type {any} */ (runExample('nope', {}, {}, { messages: PSEUDO }))) }), 'unknown engine'));
    assert.deepEqual([...new Set(found)].slice(0, 40), []);
  });

  it('reaches every id of the catalog', () => {
    // each of these is worded by code no input reaches: the reader only
    // asks for a parameter where a name already stands, a kernel answers
    // null rather than nothing, every $query refusal carries a code, and
    // the two doors agree wherever both answer (`no` would report a
    // disagreement between a kernel and its operator)
    const unreachable = ['play/chain/parameter', 'play/kernel/answers-nothing', 'play/kernel/refuses', 'play/kernel/different'];
    assert.deepEqual(IDS.filter((id) => !reached.has(id) && !unreachable.includes(id)), []);
    assert.deepEqual(unreachable.filter((id) => reached.has(id)), [], 'an id listed as unreachable was reached: drop it from the list');
  });
});

describe('@jarenjs/play — the catalog', () => {
  it('is frozen, and every id is a play/ id the source uses', () => {
    assert.ok(Object.isFrozen(playMessagesEn));
    const files = readdirSync(join(import.meta.dirname, '../../components/play/src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.js') && !f.endsWith('messages.js'));
    const source = files.map((f) => readFileSync(join(import.meta.dirname, '../../components/play/src', f), 'utf8')).join('\n');
    for (const id of IDS) {
      assert.match(id, /^play\/[a-z]+(?:\/[a-z0-9-]+)+$/, id);
      assert.ok(source.includes(`'${id}'`), `${id} is used by no source file`);
    }
  });

  it('renders through a compiled catalog, and falls back to English per id', () => {
    const t = playText(compileMessageCatalog({
      'play/action/save': 'Opslaan', 'play/panel/rows': 'Rijen ({count})',
      'play/action/new': () => { throw new Error('broken'); }, 'play/action/share': () => /** @type {any} */ (7),
    }));
    assert.equal(t('play/action/save'), 'Opslaan');
    assert.equal(t('play/panel/rows', { count: 3 }), 'Rijen (3)');
    assert.equal(t('play/action/download'), 'Download', 'an id the catalog lacks is English');
    assert.equal(t('play/action/new'), 'New', 'a throwing translation is English');
    assert.equal(t('play/action/share'), 'Share', 'a translation that is not text is English');
    assert.equal(t('play/verdict/errors', { count: 1 }), '✗ 1 error');
    assert.equal(t('play/verdict/errors', { count: 2 }), '✗ 2 errors');
    assert.equal(t('play/no-such-id'), 'play/no-such-id');
    assert.equal(playText()('play/pane/call'), 'Dispatch — { "op", "input" }', '{{ is a literal brace');
  });

  it('derives the Messages choices from the locale packs', () => {
    assert.deepEqual(ENGINES.validate.optionPanes?.[0].choices,
      [{ value: 'en', label: 'English' }, ...LOCALE_NAMES.map(({ code, name }) => ({ value: code, label: name }))]);
    assert.deepEqual(EXAMPLES.filter((e) => e.id.startsWith('validate-locale-')).map((e) => e.config?.locale), LOCALE_NAMES.map((l) => l.code));
  });
});

describe('@jarenjs/play — the libraries with a catalog speak it too', () => {
  it('a $query error that names its sentence is worded by the catalog; one that does not keeps its English', () => {
    const english = /** @type {any} */ (runExample('query', { query: '{"$nope":1}' }, { data: '{}' }));
    const catalog = compileMessageCatalog({ ...PSEUDO, 'query/unknown-operator-suggest': 'onbekend {key}' });
    const localized = /** @type {any} */ (runExample('query', { query: '{"$nope":1}' }, { data: '{}' }, { messages: catalog }));
    assert.match(english.error.message, /^JQ0002: unknown operator '\$nope'/);
    assert.equal(localized.error.message, 'JQ0002: onbekend $nope ⟦play/where/root⟧');
    assert.deepEqual({ ...localized.error, message: '' }, { ...english.error, message: '' }, 'only the words change');
    const nested = /** @type {any} */ (runExample('query', { query: '{"a":{"$nope":1}}' }, { data: '{}' }, { messages: catalog }));
    assert.equal(nested.error.message, `JQ0002: onbekend $nope ⟦play/where/path⟧`);
    const lacking = /** @type {any} */ (runExample('query', { query: '{"$nope":1}' }, { data: '{}' }, { messages: PSEUDO }));
    assert.equal(lacking.error.message, english.error.message, 'a catalog without the sentence keeps the English');
  });

  it('a host renderer is handed the run\'s catalog, for the words it renders', () => {
    const seen = [];
    const render = (/** @type {any[]} */ ...args) => { seen.push(args); return ['p', {}, 'x']; };
    runExample('markdown', { source: '# a' }, {}, { renderers: { markdown: render }, messages: PSEUDO });
    runExample('mdx', { source: '# a' }, { data: '{}' }, { renderers: { mdx: render }, messages: PSEUDO });
    runExample('markdown', { source: '# a' }, {}, { renderers: { markdown: render } });
    assert.deepEqual(seen.map((args) => args[2]), [{ messages: PSEUDO }, { messages: PSEUDO }, { messages: undefined }]);
  });

  it('the contract dispatch outcome is worded by the catalog', async () => {
    const document = EXAMPLES.find((e) => e.id === 'contract-minimal')?.source.document;
    const call = { call: '{"op":"echo.say","input":{}}' };
    const catalog = compileMessageCatalog({ 'contract/client-invalid-input': 'ongeldige invoer voor {op}' });
    const english = await Promise.resolve(runExample('contract', { document }, call));
    const localized = await Promise.resolve(runExample('contract', { document }, call, { messages: catalog }));
    const text = (/** @type {any} */ r) => r.panels.find((/** @type {any} */ p) => p.id === 'dispatch').text;
    assert.doesNotMatch(text(english), /ongeldige invoer/);
    assert.match(text(localized), /ongeldige invoer voor echo\.say/);
  });
});

describe('@jarenjs/play — English is unchanged', () => {
  const ENGLISH = compileMessageCatalog(playMessagesEn);
  /** A result with its measured numbers and its trace ids blanked. */
  const steady = (/** @type {any} */ r) => JSON.stringify(r, (k, v) => (k === 'compileMs' || k === 'runMs' ? typeof v : v))
    .replace(/<?\d+\.\d+ ms/g, 'N ms').replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, 'UUID');

  it('every example answers the same with no catalog and with the English one', async () => {
    for (const ex of EXAMPLES) {
      for (const ds of ex.datasets.length > 0 ? ex.datasets : [{ label: '—', data: {} }]) {
        const options = { operators: ops, config: ex.config, renderers, validate: VALIDATORS[2] };
        const bare = await Promise.resolve(runExample(ex.engine, ex.source, ds.data, options));
        const english = await Promise.resolve(runExample(ex.engine, ex.source, ds.data, { ...options, messages: ENGLISH }));
        assert.equal(steady(english), steady(bare), ex.id);
        const play = { engine: ex.engine, exampleId: ex.id, source: ex.source, data: ds.data, config: ex.config, result: bare, deep: true };
        assert.deepEqual(playViewModel({ play }, { messages: ENGLISH }), playViewModel({ play }), ex.id);
      }
    }
  });

  it('the component\'s catalog is a default the view model and the engines share, and a per-call catalog wins', () => {
    const component = createPlayComponent({ messages: PSEUDO });
    const play = { engine: 'path', source: { selector: '$' }, data: { data: '[]' }, result: null };
    assert.equal(component.viewModel({ play }).t.save, '⟦play/action/save⟧');
    assert.equal(component.viewModel({ play }, { messages: compileMessageCatalog({ 'play/action/save': 'Opslaan' }) }).t.save, 'Opslaan');
    assert.equal(createPlayComponent().viewModel({ play }).t.save, 'Save');
    const result = /** @type {any} */ (component.runExample('path', { selector: '$' }, { data: '[]' }));
    assert.equal(result.panels[0].label, '⟦play/panel/output⟧');
  });

  it('an engine id that names an inherited member keeps its id as the title, as before', () => {
    assert.equal(playViewModel({ play: { engine: 'constructor' } }, { messages: PSEUDO }).engine.label, 'constructor');
  });

  it('the save title names the bound session; the lead says it is English', () => {
    const vm = playViewModel({ play: { engine: 'path', savedName: 'alpha', name: 'beta', result: null } });
    assert.equal(vm.t.saveTitle, 'Overwrite “alpha”');
    assert.equal(vm.t.bound, 'Save overwrites “alpha” · Save As keeps both');
    assert.equal(playViewModel({ play: { engine: 'path', result: null } }).t.saveTitle, 'Save this session under the name above');
    assert.match(JSON.stringify(render({ engine: 'path', result: null })), /"class":"muted jplay-lead","lang":"en"/);
  });
});
