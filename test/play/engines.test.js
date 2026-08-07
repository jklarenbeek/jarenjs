//@ts-check
/**
 * @file The playground engines run — each descriptor wraps a real shipped
 * compiler into the `PlayResult` shape, never throwing, and the
 * registered operators thread through `options` to query/jslt.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { runExample } from '@jarenjs/play';
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

  it('patch applies to a target document, copy-on-write, with the change feed as a drill-down', () => {
    const r = runExample('patch', { patch: '[{"op":"add","path":"/b","value":2}]' }, { data: '{"a":1}' });
    assert.strictEqual(r.ok, true);
    assert.match(out(r), /"b": 2/);
    assert.match(deep(r)[0].text, /\/b/, 'the changed paths are the deep panel');
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
