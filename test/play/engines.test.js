//@ts-check
/**
 * @file The playground engines run — each descriptor wraps a real shipped
 * compiler into the `PlayResult` shape, never throwing, and the
 * registered operators thread through `options` to query/jslt.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { runExample, EXAMPLES } from '@jarenjs/play';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';

const ops = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);

/** Concat every SIMPLE text-bearing panel (code/note) — the calm default
 * screens; the deep drill-down panels are asserted separately. */
const out = (r) => r.panels.filter((p) => p.depth !== 'deep' && p.text != null).map((p) => p.text).join('\n');
/** The deep (drill-down) panels of a result. */
const deep = (r) => r.panels.filter((p) => p.depth === 'deep');
/** The vnode of the first `view` panel, or undefined. */
const view = (r) => r.panels.find((p) => p.kind === 'view')?.vnode;

describe('@jarenjs/play — the engines run', () => {
  it('threads explicit externals through JSLT, JTLT and XQuery', () => {
    for (const [engine, source, expected] of [
      ['jslt', { stylesheet: '[{"match":"$","body":"$who"}]' }, '"Ada"'],
      ['jtlt', { template: '[{"match":"$","body":["Hello ","$who"]}]' }, 'Hello Ada'],
      ['xquery', { text: 'declare variable $doc external; declare variable $factor external; $doc * $factor' }, '6'],
    ]) {
      const value = runExample(engine, { ...source, externals: '{"who":"Ada","factor":3,"doc":100}' }, { data: '2' });
      assert.strictEqual(value.ok, true, value.error?.message);
      assert.strictEqual(out(value), expected);
      const invalid = runExample(engine, { ...source, externals: '{broken' }, { data: '2' });
      assert.strictEqual(invalid.ok, false);
      assert.strictEqual(invalid.error.pane, 'externals');
    }
  });
  it('path selects nodes from a document, with a deep drill-down (cards + normalized paths)', () => {
    const r = runExample('path', { selector: '$.book[*].title' }, { data: '{"book":[{"title":"A"},{"title":"B"}]}' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.panels.map((p) => p.kind), ['code', 'cards', 'code']);
    assert.match(out(r), /"A"[\s\S]*"B"/);
    assert.ok(r.timing.compileMs >= 0 && r.timing.runMs >= 0);
    // the drill-down: a "How it matched" stat row + the normalized paths
    const [cards, paths] = deep(r);
    assert.strictEqual(cards.kind, 'cards');
    assert.strictEqual(cards.items[0].title, 'Matches');
    assert.strictEqual(cards.items[0].value, '2');
    assert.match(paths.text, /\$\['book'\]\[0\]\['title'\]/, 'each match names its canonical location');
  });

  it('pointer addresses a value, and reports NOTHING on a miss', () => {
    assert.match(out(runExample('pointer', { pointer: '/a/0' }, { data: '{"a":[7]}' })), /7/);
    assert.match(out(runExample('pointer', { pointer: '/nope' }, { data: '{}' })), /nothing/i);
  });

  it('a pointer starting with a digit is RELATIVE — it walks from the location pane', () => {
    const data = { data: '{"book":[{"title":"A","price":5},{"title":"B","price":9}]}' };
    const sibling = runExample('pointer', { pointer: '1/price', location: '/book/0/title' }, data);
    assert.strictEqual(sibling.ok, true);
    assert.match(out(sibling), /5/, 'up one from the title, down into price');
    const keyName = runExample('pointer', { pointer: '0#', location: '/book/0/title' }, data);
    assert.match(out(keyName), /title/, '0# names the key at the location');
  });

  it('patch applies to a target document, copy-on-write, with the change feed as a drill-down', () => {
    const r = runExample('patch', { patch: '[{"op":"add","path":"/b","value":2}]' }, { data: '{"a":1}' });
    assert.strictEqual(r.ok, true);
    assert.match(out(r), /"b": 2/);
    assert.match(deep(r)[0].text, /\/b/, 'the changed paths are the deep panel');
  });

  it('patch mode "merge" applies RFC 7396 (null deletes); mode "diff" derives both patch flavours', () => {
    const merged = runExample('patch',
      { patch: '{"age":31,"temp":null}' }, { data: '{"name":"Alice","age":30,"temp":"x"}' },
      { config: { mode: 'merge' } });
    assert.strictEqual(merged.ok, true);
    assert.match(out(merged), /"age": 31/);
    assert.doesNotMatch(out(merged), /"temp"/, 'a null merge member deletes');

    const diffed = runExample('patch',
      { patch: '{"a":2,"b":1}' }, { data: '{"a":1}' },
      { config: { mode: 'diff' } });
    assert.strictEqual(diffed.ok, true);
    assert.match(out(diffed), /"replace"[\s\S]*\/a/, 'the RFC 6902 diff is the answer');
    assert.match(deep(diffed)[0].text, /"b": 1/, 'the merge-patch flavour rides deep');
  });

  it('query runs, and registered operators thread through options', () => {
    const source = { query: '{"m":{"$mean":"$.v[*]"}}', externals: '' };
    const data = { data: '{"v":[2,4,6]}' };
    assert.strictEqual(runExample('query', source, data).ok, false, 'no packs → $mean is unknown');
    const r = runExample('query', source, data, { operators: ops });
    assert.strictEqual(r.ok, true);
    assert.match(out(r), /"m": 4/);
  });

  it('jslt transforms its data', () => {
    const r = runExample('jslt',
      { stylesheet: '{"$jslt":"0.1","rules":[{"match":"$","body":{"hi":"$.name"}}]}' },
      { data: '{"name":"Ada"}' });
    assert.strictEqual(r.ok, true);
    assert.match(out(r), /"hi": "Ada"/);
  });

  it('jtlt renders its data as TEXT (shown verbatim, not JSON-quoted), the compiled program deep', () => {
    const r = runExample('jtlt',
      { template: '[{"match":"$","body":["# ","$.title","\\n"]}]' },
      { data: '{"title":"Hello"}' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(out(r), '# Hello\n', 'the markdown string is the output, unquoted');
    // the drill-down: the JSLT stylesheet the template desugared into
    assert.strictEqual(deep(r)[0].label, 'The compiled program');
    assert.match(deep(r)[0].text, /"\$jslt"|rules/, 'a JSLT stylesheet document');
  });

  it('xquery parses the text subset and runs it over $doc, the query document deep', () => {
    const r = runExample('xquery',
      { text: 'for $b in $doc?book?* where $b?price < 10 return $b?title' },
      { data: '{"book":[{"title":"A","price":5},{"title":"B","price":20}]}' });
    assert.strictEqual(r.ok, true);
    assert.match(out(r), /"A"/);
    assert.doesNotMatch(out(r), /"B"/, 'the where clause filtered the expensive book out');
    assert.match(deep(r)[0].text, /\$for|\$where|for/, 'the generated query document is the deep panel');
  });

  it('josl parses to a JS value; the mode option gates the extensions', () => {
    const src = { text: 'x = null\n' };
    // JOSL admits null; strict TOML rejects it — the option-pane config decides
    assert.strictEqual(runExample('josl', src, {}, { config: { mode: 'josl' } }).ok, true);
    const strict = runExample('josl', src, {}, { config: { mode: 'toml' } });
    assert.strictEqual(strict.ok, false, 'TOML mode rejects the null extension');
    // the default (no config) is JOSL — withConfig fills the pane default
    assert.strictEqual(runExample('josl', src, {}).ok, true, 'defaults to JOSL when config is absent');
  });

  it('josl drills down into the streaming events and the canonical round-trip', () => {
    const r = runExample('josl', { text: 'x = 1\ny = "two"\n' }, {});
    assert.strictEqual(r.ok, true);
    const [events, roundtrip] = deep(r);
    assert.strictEqual(events.kind, 'table');
    assert.ok(events.rows.some((row) => row[1] === '/x'), 'each document-order event names its path');
    assert.strictEqual(roundtrip.kind, 'code');
    assert.match(roundtrip.text, /x = 1/, 'stringifyJosl round-trips the document');
  });

  it('csv strict rejects; repair mode is a calm note plus a deep drill-down (rows · dialect · repairs · round-trip)', () => {
    const damaged = { text: 'a,b\n1,"never closed\n' };
    const cfg = (repair) => ({ config: { repair, headers: 'true', delimiter: 'auto', typed: 'off' } });
    const strict = runExample('csv', damaged, {}, cfg('strict'));
    assert.strictEqual(strict.ok, false, 'strict rejects the unclosed quote');
    const repaired = runExample('csv', damaged, {}, cfg('repair'));
    assert.strictEqual(repaired.ok, true, 'repair reads it anyway');
    // the calm half is ONE note; everything else waits behind the depth toggle
    const summary = repaired.panels[0];
    assert.strictEqual(summary.kind, 'note');
    assert.strictEqual(summary.tone, 'warn', 'repairs make the summary a warning');
    assert.match(summary.text, /repair/, 'and the note reports the fixes it made');
    const drill = deep(repaired);
    assert.deepStrictEqual(drill.map((p) => p.id), ['rows', 'dialect', 'repairs', 'roundtrip']);
    const [table, dialect, repairs, roundtrip] = drill;
    assert.deepStrictEqual(table.columns, ['a', 'b'], 'the header row became the table columns');
    assert.ok(table.rows.length >= 1, 'the parsed records are the deep table');
    assert.ok(dialect.rows.some((row) => row[0] === 'sniffed'), 'the dialect table shows the sniff');
    assert.ok(repairs.rows.length >= 1, 'each repair is a row with code/line/column');
    assert.strictEqual(roundtrip.kind, 'code', 'the CSV round-trip is a code panel');
  });

  it('a clean csv is a clean summary (tone ok) — a single record, no repairs', () => {
    const r = runExample('csv', { text: 'a,b\n1,2\n' }, {}, { config: { repair: 'strict', headers: 'true', delimiter: 'auto', typed: 'off' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.panels[0].tone, 'ok', 'no repairs → an ok summary');
    assert.match(r.panels[0].text, /clean/);
  });

  it('validate delegates to the host validator: a verdict note, plus an errors table when invalid', () => {
    const schema = { schema: '{"type":"object","required":["name"]}' };
    const good = runExample('validate', schema, { data: '{"name":"Ada"}' }, {
      validate: () => ({ schemaError: null, draft: 'draft-07', compileMs: 0.2, validateMs: 0.1, valid: true, errors: [] }),
    });
    assert.strictEqual(good.ok, true);
    assert.deepStrictEqual(good.panels.map((p) => p.kind), ['note'], 'valid → just the verdict note');
    assert.strictEqual(good.panels[0].tone, 'ok');
    assert.match(good.panels[0].text, /valid/);

    const bad = runExample('validate', schema, { data: '{}' }, {
      validate: () => ({ schemaError: null, draft: 'draft-07', compileMs: 0.2, validateMs: 0.1, valid: false,
        errors: [{ instancePath: '', keyword: 'required', message: 'must have property name' }] }),
    });
    assert.strictEqual(bad.ok, true, 'invalid DATA is still a successful RUN, with error panels');
    assert.deepStrictEqual(bad.panels.map((p) => p.kind), ['note', 'table']);
    assert.strictEqual(bad.panels[0].tone, 'warn');
    assert.deepStrictEqual(bad.panels[1].columns, ['path', 'message']);
    assert.match(bad.panels[1].rows[0][0], /root/, 'an empty instancePath renders as (root)');
  });

  it('validate without a host runner is an honest Result; a schema error fails with a code', () => {
    const bare = runExample('validate', { schema: '{}' }, { data: '{}' });
    assert.strictEqual(bare.ok, false);
    assert.strictEqual(bare.error.code, 'PLAY_NO_VALIDATOR');
    const badSchema = runExample('validate', { schema: '{' }, { data: '{}' }, {
      validate: () => ({ schemaError: 'bad schema', draft: null, compileMs: null, validateMs: null, valid: null, errors: [] }),
    });
    assert.strictEqual(badSchema.ok, false);
    assert.strictEqual(badSchema.error.code, 'SCHEMA');
  });

  it('a visual engine delegates to a host renderer and returns a single view panel', () => {
    const render = (s) => ['div', { class: 'md' }, String(s)];
    const r = runExample('markdown', { source: '# Hi' }, {}, { renderers: { markdown: render } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.panels.map((p) => p.kind), ['view'], 'one view panel, no text');
    assert.ok(Array.isArray(view(r)), 'the rendered vnode is carried on the view panel');
  });

  it('a host renderer may hand back { vnode, deep } — the deep panels ride behind the toggle', () => {
    const render = (s) => ({
      vnode: ['div', { class: 'md' }, String(s)],
      deep: [{ id: 'ast', label: 'The document, as JSON', kind: 'code', text: '[]' }],
    });
    const r = runExample('markdown', { source: '# Hi' }, {}, { renderers: { markdown: render } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.panels.map((p) => p.kind), ['view', 'code']);
    assert.ok(Array.isArray(view(r)), 'the preview vnode still renders');
    assert.strictEqual(deep(r)[0].id, 'ast', 'the host deep panel is stamped deep');
  });

  it('a visual engine without a renderer is an honest Result, not a throw', () => {
    const bare = runExample('mermaid', { source: 'flowchart TD\n A-->B' }, {});
    assert.strictEqual(bare.ok, false);
    assert.strictEqual(bare.error.code, 'PLAY_NO_RENDERER');
  });

  it('mdx delegates to a host renderer with the PARSED data document', () => {
    /** @type {any[]} */
    const calls = [];
    const render = (source, data) => { calls.push([source, data]); return ['div', {}, 'ok']; };
    const r = runExample('mdx', { source: '# {$.title}' }, { data: '{"title":"T"}' }, { renderers: { mdx: render } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(calls[0], ['# {$.title}', { title: 'T' }], 'the data pane parsed before the seam');
    assert.deepStrictEqual(r.panels.map((p) => p.kind), ['view']);
    // bad JSON in the data pane fails honestly before the renderer runs
    const bad = runExample('mdx', { source: '#' }, { data: '{ nope' }, { renderers: { mdx: render } });
    assert.strictEqual(bad.ok, false);
    // and no renderer at all is the honest seam error
    assert.strictEqual(runExample('mdx', { source: '#' }, { data: '{}' }).error.code, 'PLAY_NO_RENDERER');
  });

  it('a visual engine surfaces a renderer throw as an error Result', () => {
    const boom = () => { throw new Error('bad definition'); };
    const r = runExample('charts', { source: '{}' }, {}, { renderers: { charts: boom } });
    assert.strictEqual(r.ok, false);
    assert.match(r.error.message, /bad definition/);
  });

  it('a compile error is a Result, never a throw', () => {
    const r = runExample('path', { selector: '$[' }, { data: '{}' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.message.length > 0);
    assert.strictEqual(r.timing, null);
  });
});

/** The location fields of an error, without the message (asserted apart). */
const where = (r) => { const { message: _message, ...rest } = r.error; return rest; };

describe('@jarenjs/play — an error says WHERE (PLAY-FORMAT §2)', () => {
  it('the syntax family locates a 0-based position in the source pane (JSONPath, JSON Pointer, XQuery)', () => {
    assert.deepStrictEqual(where(runExample('path', { selector: '$[?@.a =]' }, { data: '{}' })),
      { pane: 'selector', position: 7 });
    assert.deepStrictEqual(where(runExample('pointer', { pointer: 'a/b' }, { data: '{}' })),
      { pane: 'pointer', position: 0 });
    assert.deepStrictEqual(where(runExample('xquery', { text: 'for $x in' }, { data: '{}' })),
      { pane: 'text', position: 9 });
  });

  it('the coded family locates a JSON Pointer into the source pane\'s document (patch, query, JSLT, JTLT)', () => {
    assert.deepStrictEqual(where(runExample('patch', { patch: '[{"op":"add"}]' }, { data: '{}' })),
      { code: 'JP0003', pane: 'patch', path: '/0/path' });
    assert.deepStrictEqual(where(runExample('query', { query: '{"$bogus":1}' }, { data: '{}' })),
      { code: 'JQ0002', pane: 'query', path: '' }, 'a root pointer is a real location, kept as the empty string');
    const jslt = runExample('jslt', { stylesheet: '{"$jslt":"0.1","rules":[{"match":"$[","body":1}]}' }, { data: '{}' });
    assert.deepStrictEqual(where(jslt), { code: 'JT0003', pane: 'stylesheet', path: '/rules/0/match' });
    const jtlt = runExample('jtlt', { template: '{"$jtlt":"0.1","rules":[{"match":"$","body":[{"$bogus":1}]}]}' }, { data: '{}' });
    assert.deepStrictEqual(where(jtlt), { code: 'TL0005', pane: 'template', path: '/rules/0/body/0' },
      'JTLT re-maps a desugared-JSLT failure onto the TEMPLATE document');
  });

  it('a runtime error locates the construct that failed — and a patch op names its target too', () => {
    const q = runExample('query', { query: '{"$idiv":[1,0]}' }, { data: '{}' });
    assert.deepStrictEqual(where(q), { code: 'JQ2002', pane: 'query', path: '/$idiv' });
    const p = runExample('patch', { patch: '[{"op":"remove","path":"/missing"}]' }, { data: '{"a":1}' });
    assert.deepStrictEqual(where(p), { code: 'JP2001', pane: 'patch', path: '/0', dataPath: '/missing' },
      'the op in the patch AND the location in the target — two facts, both kept');
  });

  it('the line/column family locates 1-based line and column (JOSL, CSV)', () => {
    assert.deepStrictEqual(where(runExample('josl', { text: 'a = \n' }, {})), { pane: 'text', line: 1, column: 5 });
    const csv = runExample('csv', { text: 'a,b\n1,"2\n' }, {});
    assert.deepStrictEqual(where(csv), { code: 'CSV1001', pane: 'text', line: 2, column: 1 });
  });

  it('a pane whose JSON does not parse locates the PANE and nothing finer', () => {
    // the host's JSON.parse states its offset only inside engine-specific
    // message text — never claimed as a field
    assert.deepStrictEqual(where(runExample('path', { selector: '$' }, { data: '{oops' })), { pane: 'data' });
    assert.deepStrictEqual(where(runExample('patch', { patch: '[' }, { data: '{}' })), { pane: 'patch' });
    const target = runExample('patch', { patch: '[]' }, { data: '{oops' });
    assert.deepStrictEqual(where(target), { pane: 'data' }, 'the patch target is the `data` pane, whatever the message calls it');
    assert.match(target.error.message, /^target: /);
    assert.deepStrictEqual(where(runExample('query', { query: '{}', externals: '{oops' }, { data: '{}' })), { pane: 'externals' });
  });

  it('a location into a document the learner never typed has no pane (XQuery compiles a GENERATED query)', () => {
    // a runtime failure inside the generated query document: the pointer is
    // into that document, so it is stated, and no pane is claimed
    const r = runExample('xquery', { text: '1 idiv 0' }, { data: '{}' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.pane, undefined);
    assert.strictEqual(typeof r.error.path, 'string');
  });

  it('a missing host seam is nobody\'s pane; a host schema error is the schema pane', () => {
    assert.deepStrictEqual(where(runExample('validate', { schema: '{}' }, { data: '{}' })), { code: 'PLAY_NO_VALIDATOR' });
    assert.deepStrictEqual(where(runExample('markdown', { source: '#' }, {})), { code: 'PLAY_NO_RENDERER' });
    const bad = runExample('validate', { schema: '{' }, { data: '{}' }, {
      validate: () => ({ schemaError: 'bad schema', draft: null, compileMs: null, validateMs: null, valid: null, errors: [] }),
    });
    assert.deepStrictEqual(where(bad), { code: 'SCHEMA', pane: 'schema' });
    // a renderer that throws a located error is copied field-for-field
    const boom = () => { const e = new Error('no'); /** @type {any} */ (e).line = 3; /** @type {any} */ (e).column = 4; throw e; };
    assert.deepStrictEqual(where(runExample('mermaid', { source: 'x' }, {}, { renderers: { mermaid: boom } })),
      { pane: 'source', line: 3, column: 4 });
  });

  it('every location field is present exactly when the compiler stated it — never fabricated', () => {
    for (const r of [
      runExample('path', { selector: '$[' }, { data: '{}' }),
      runExample('query', { query: '{"$bogus":1}' }, { data: '{}' }),
      runExample('josl', { text: '=' }, {}),
      runExample('path', { selector: '$' }, { data: '{' }),
    ]) {
      assert.strictEqual(r.ok, false);
      for (const [k, v] of Object.entries(r.error)) assert.notStrictEqual(v, undefined, `${k} is stated, not undefined`);
    }
  });
});

describe('@jarenjs/play — the contract engine (the one async run)', () => {
  const shop = EXAMPLES.find((/** @type {any} */ e) => e.id === 'contract-shop');

  it('renders its four panels for the shop example: describe / OpenAPI / TypeScript / dispatch', async () => {
    const r = await Promise.resolve(runExample('contract', shop.source, shop.datasets[0].data));
    assert.strictEqual(r.ok, true, r.error?.message);
    assert.deepStrictEqual(r.panels.map((p) => p.id), ['describe', 'openapi', 'types', 'dispatch']);
    assert.match(r.panels[0].text, /"catalog\.load"/);
    assert.match(r.panels[1].text, /"openapi": "3\.1/);
    assert.match(r.panels[2].text, /Outcome/);
    // the dispatch panel resolves a real local-client outcome for the echo
    const outcome = JSON.parse(r.panels[3].text);
    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(outcome.value.product, { id: 7, name: 'Duck', price: 9.99 });
  });

  it('an invalid dispatch input is the pre-send refusal outcome, not an engine failure', async () => {
    const r = await Promise.resolve(runExample('contract', shop.source, shop.datasets[1].data));
    assert.strictEqual(r.ok, true);
    const outcome = JSON.parse(r.panels.find((p) => p.id === 'dispatch').text);
    assert.deepStrictEqual([outcome.ok, outcome.kind, outcome.error.code], [false, 'contract', 'JC2050']);
  });

  it('an empty dispatch pane answers the hint note; an unknown op answers the host error as a note', async () => {
    const empty = await Promise.resolve(runExample('contract', shop.source, { call: '' }));
    assert.strictEqual(empty.panels.find((p) => p.id === 'dispatch').kind, 'note');
    const unknown = await Promise.resolve(runExample('contract', shop.source, { call: '{"op":"nope.op","input":{}}' }));
    assert.strictEqual(unknown.ok, true, 'a host mistake never fails the run');
    const panel = unknown.panels.find((p) => p.id === 'dispatch');
    assert.deepStrictEqual([panel.kind, panel.tone], ['note', 'warn']);
  });

  it('a rejecting async run settles into an error Result — the never-throw contract holds for thenables', async () => {
    // a hostile source object whose pane accessor throws: the async run
    // body rejects before its own guards, and runExample maps the
    // rejection into the same error Result a sync throw yields
    const hostile = { get document() { throw new Error('hostile accessor'); } };
    const r = await Promise.resolve(runExample('contract', /** @type {any} */ (hostile), { call: '' }));
    assert.strictEqual(r.ok, false);
    assert.match(r.error.message, /hostile accessor/);
  });

  it('a broken document refuses with its JC00xx code and docPath into the document pane', async () => {
    const broken = EXAMPLES.find((/** @type {any} */ e) => e.id === 'contract-broken');
    const r = await Promise.resolve(runExample('contract', broken.source, { call: '' }));
    assert.strictEqual(r.ok, false);
    assert.match(String(r.error.code), /^JC00\d\d$/);
    assert.deepStrictEqual([r.error.pane, r.error.path], ['document', '/operations/catalog.load/output']);
  });
});
