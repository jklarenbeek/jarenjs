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

  it('a compile error is a Result, never a throw', () => {
    const r = runExample('path', { selector: '$[' }, { data: '{}' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.message.length > 0);
    assert.strictEqual(r.timing, null);
  });
});
