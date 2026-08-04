//@ts-check
/**
 * @file The one-call caches must key on EVERY option that changes what
 * compiles. Before the health pass, `renderText`'s per-template cache
 * compared only `compileTypeTest` and `maxDepth` while
 * `compileJtltStylesheet` forwards its whole options object to the JSLT
 * compiler (which also honours `memo` and `pathFunctions`) — so a
 * one-call render with `pathFunctions` silently compiled WITHOUT them
 * (the "default" bucket dropped the options), and a template whose
 * match paths use a custom function threw where the direct compile
 * succeeded. This suite demonstrates that bug's shape and pins the fix.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { renderText, compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { transformJson } from '@jarenjs/json/jslt';

const REGISTRY = {
  shout: {
    params: ['value'],
    returns: 'value',
    evaluate: (v) => (typeof v === 'string' ? v.toUpperCase() : undefined),
  },
};

// A template whose match path only compiles under REGISTRY.
const TEMPLATE = [
  { match: "$.items[?shout(@.s) == 'B']", body: ['hit:', '$.s'] },
  { match: '$', body: [{ $apply: '$.items[*]' }] },
];
const DATA = { items: [{ s: 'a' }, { s: 'b' }] };

describe('jtlt one-call cache honours every compile option', () => {
  it('the direct compile accepts pathFunctions (the reference behaviour)', () => {
    const render = compileJtltStylesheet(TEMPLATE, { pathFunctions: REGISTRY });
    // 'a' falls through to the default text rule; 'b' hits the custom rule.
    assert.strictEqual(render(DATA), 'ahit:b');
  });

  it('renderText with pathFunctions behaves exactly like the direct compile', () => {
    // Pre-fix: the options were dropped into the default bucket and the
    // unknown function threw at compile time.
    assert.strictEqual(renderText(TEMPLATE, DATA, undefined, { pathFunctions: REGISTRY }),
      'ahit:b');
  });

  it('two registries do not poison each other through the one-call cache', () => {
    const template = [{ match: '$', body: [{ $let: { v: "$.items[?shout(@.s) == 'B'].s" }, $return: '$v' }] }];
    const upper = REGISTRY;
    const lower = {
      shout: {
        params: ['value'],
        returns: 'value',
        evaluate: (v) => (typeof v === 'string' ? v.toLowerCase() : undefined),
      },
    };
    // Under `upper`, shout('b') === 'B' matches; under `lower` it never
    // does — the same template must compile per registry, not share.
    assert.strictEqual(renderText(template, DATA, undefined, { pathFunctions: upper }), 'b');
    assert.strictEqual(renderText(template, DATA, undefined, { pathFunctions: lower }), '');
    assert.strictEqual(renderText(template, DATA, undefined, { pathFunctions: upper }), 'b');
  });

  it('jslt one-call already keyed on all four options (regression pin)', () => {
    const stylesheet = [{ match: '$', body: { v: "$.items[?shout(@.s) == 'B'].s" } }];
    assert.deepStrictEqual(
      transformJson(stylesheet, DATA, undefined, { pathFunctions: REGISTRY }),
      { v: 'b' });
    // Without the registry the same stylesheet must NOT reuse the cached
    // compilation — it compiles fresh and fails on the unknown function.
    assert.throws(() => transformJson(stylesheet, DATA), /shout/);
  });
});
