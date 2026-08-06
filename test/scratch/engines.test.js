//@ts-check
/**
 * @file The scratchpad engines run — each descriptor wraps a real shipped
 * compiler into the `ScratchResult` shape, never throwing, and the
 * registered operators thread through `options` to query/jslt.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { runExample } from '@jarenjs/scratch';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';

const ops = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);

describe('@jarenjs/scratch — the engines run', () => {
  it('path selects nodes from a document', () => {
    const r = runExample('path', { selector: '$.book[*].title' }, { data: '{"book":[{"title":"A"},{"title":"B"}]}' });
    assert.strictEqual(r.ok, true);
    assert.match(r.output, /"A"[\s\S]*"B"/);
    assert.ok(r.timing.compileMs >= 0 && r.timing.runMs >= 0);
  });

  it('pointer addresses a value, and reports NOTHING on a miss', () => {
    assert.match(runExample('pointer', { pointer: '/a/0' }, { data: '{"a":[7]}' }).output, /7/);
    assert.match(runExample('pointer', { pointer: '/nope' }, { data: '{}' }).output, /nothing/i);
  });

  it('patch applies to a target document, copy-on-write', () => {
    const r = runExample('patch', { patch: '[{"op":"add","path":"/b","value":2}]' }, { data: '{"a":1}' });
    assert.strictEqual(r.ok, true);
    assert.match(r.output, /"b": 2/);
  });

  it('query runs, and registered operators thread through options', () => {
    const source = { query: '{"m":{"$mean":"$.v[*]"}}', externals: '' };
    const data = { data: '{"v":[2,4,6]}' };
    assert.strictEqual(runExample('query', source, data).ok, false, 'no packs → $mean is unknown');
    const r = runExample('query', source, data, { operators: ops });
    assert.strictEqual(r.ok, true);
    assert.match(r.output, /"m": 4/);
  });

  it('jslt transforms its data', () => {
    const r = runExample('jslt',
      { stylesheet: '{"$jslt":"0.1","rules":[{"match":"$","body":{"hi":"$.name"}}]}' },
      { data: '{"name":"Ada"}' });
    assert.strictEqual(r.ok, true);
    assert.match(r.output, /"hi": "Ada"/);
  });

  it('jtlt renders its data as TEXT (shown verbatim, not JSON-quoted)', () => {
    const r = runExample('jtlt',
      { template: '[{"match":"$","body":["# ","$.title","\\n"]}]' },
      { data: '{"title":"Hello"}' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.output, '# Hello\n', 'the markdown string is the output, unquoted');
  });

  it('xquery parses the text subset and runs it over $doc', () => {
    const r = runExample('xquery',
      { text: 'for $b in $doc?book?* where $b?price < 10 return $b?title' },
      { data: '{"book":[{"title":"A","price":5},{"title":"B","price":20}]}' });
    assert.strictEqual(r.ok, true);
    assert.match(r.output, /"A"/);
    assert.doesNotMatch(r.output, /"B"/, 'the where clause filtered the expensive book out');
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

  it('csv reads RFC 4180 strict, and repair mode reads damaged input as a Result', () => {
    const damaged = { text: 'a,b\n1,"never closed\n' };
    const strict = runExample('csv', damaged, {}, { config: { repair: 'strict', headers: 'true', delimiter: 'auto', typed: 'off' } });
    assert.strictEqual(strict.ok, false, 'strict rejects the unclosed quote');
    const repaired = runExample('csv', damaged, {}, { config: { repair: 'repair', headers: 'true', delimiter: 'auto', typed: 'off' } });
    assert.strictEqual(repaired.ok, true, 'repair reads it anyway');
    assert.match(repaired.output, /repairs/, 'and reports the fixes it made');
  });

  it('a visual engine delegates to a host renderer and returns its vnode', () => {
    const render = (s) => ['div', { class: 'md' }, String(s)];
    const r = runExample('markdown', { source: '# Hi' }, {}, { renderers: { markdown: render } });
    assert.strictEqual(r.ok, true);
    assert.ok(Array.isArray(r.view), 'the rendered vnode is carried on .view');
    assert.strictEqual(r.output, '', 'a visual engine has no text output');
  });

  it('a visual engine without a renderer is an honest Result, not a throw', () => {
    const bare = runExample('mermaid', { source: 'flowchart TD\n A-->B' }, {});
    assert.strictEqual(bare.ok, false);
    assert.strictEqual(bare.error.code, 'SCRATCH_NO_RENDERER');
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
