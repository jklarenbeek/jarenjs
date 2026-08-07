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

/** Concat every text-bearing panel (code/note) — the old scalar `output`. */
const out = (r) => r.panels.filter((p) => p.text != null).map((p) => p.text).join('\n');
/** The vnode of the first `view` panel, or undefined. */
const view = (r) => r.panels.find((p) => p.kind === 'view')?.vnode;

describe('@jarenjs/play — the engines run', () => {
  it('path selects nodes from a document', () => {
    const r = runExample('path', { selector: '$.book[*].title' }, { data: '{"book":[{"title":"A"},{"title":"B"}]}' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.panels.map((p) => p.kind), ['code'], 'a single code panel');
    assert.match(out(r), /"A"[\s\S]*"B"/);
    assert.ok(r.timing.compileMs >= 0 && r.timing.runMs >= 0);
  });

  it('pointer addresses a value, and reports NOTHING on a miss', () => {
    assert.match(out(runExample('pointer', { pointer: '/a/0' }, { data: '{"a":[7]}' })), /7/);
    assert.match(out(runExample('pointer', { pointer: '/nope' }, { data: '{}' })), /nothing/i);
  });

  it('patch applies to a target document, copy-on-write', () => {
    const r = runExample('patch', { patch: '[{"op":"add","path":"/b","value":2}]' }, { data: '{"a":1}' });
    assert.strictEqual(r.ok, true);
    assert.match(out(r), /"b": 2/);
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

  it('jtlt renders its data as TEXT (shown verbatim, not JSON-quoted)', () => {
    const r = runExample('jtlt',
      { template: '[{"match":"$","body":["# ","$.title","\\n"]}]' },
      { data: '{"title":"Hello"}' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(out(r), '# Hello\n', 'the markdown string is the output, unquoted');
  });

  it('xquery parses the text subset and runs it over $doc', () => {
    const r = runExample('xquery',
      { text: 'for $b in $doc?book?* where $b?price < 10 return $b?title' },
      { data: '{"book":[{"title":"A","price":5},{"title":"B","price":20}]}' });
    assert.strictEqual(r.ok, true);
    assert.match(out(r), /"A"/);
    assert.doesNotMatch(out(r), /"B"/, 'the where clause filtered the expensive book out');
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

  it('csv strict rejects, and repair mode yields a THREE-panel Result (note · table · code)', () => {
    const damaged = { text: 'a,b\n1,"never closed\n' };
    const cfg = (repair) => ({ config: { repair, headers: 'true', delimiter: 'auto', typed: 'off' } });
    const strict = runExample('csv', damaged, {}, cfg('strict'));
    assert.strictEqual(strict.ok, false, 'strict rejects the unclosed quote');
    const repaired = runExample('csv', damaged, {}, cfg('repair'));
    assert.strictEqual(repaired.ok, true, 'repair reads it anyway');
    // the multi-panel proof: a summary note, the parsed table, the round-trip
    assert.deepStrictEqual(repaired.panels.map((p) => p.kind), ['note', 'table', 'code']);
    const [summary, table, roundtrip] = repaired.panels;
    assert.strictEqual(summary.tone, 'warn', 'repairs make the summary a warning');
    assert.match(summary.text, /repair/, 'and the note reports the fixes it made');
    assert.deepStrictEqual(table.columns, ['a', 'b'], 'the header row became the table columns');
    assert.ok(table.rows.length >= 1 && table.depth === 'deep', 'a deep table with rows');
    assert.strictEqual(roundtrip.kind, 'code', 'the CSV round-trip is a code panel');
  });

  it('a clean csv is a clean summary (tone ok) — a single record, no repairs', () => {
    const r = runExample('csv', { text: 'a,b\n1,2\n' }, {}, { config: { repair: 'strict', headers: 'true', delimiter: 'auto', typed: 'off' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.panels[0].tone, 'ok', 'no repairs → an ok summary');
    assert.match(r.panels[0].text, /clean/);
  });

  it('a visual engine delegates to a host renderer and returns a single view panel', () => {
    const render = (s) => ['div', { class: 'md' }, String(s)];
    const r = runExample('markdown', { source: '# Hi' }, {}, { renderers: { markdown: render } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.panels.map((p) => p.kind), ['view'], 'one view panel, no text');
    assert.ok(Array.isArray(view(r)), 'the rendered vnode is carried on the view panel');
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
