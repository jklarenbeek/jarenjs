//@ts-check
/**
 * @file @jarenjs/play scaffold — the headless engine surface exists and
 * the package is wired. The engines, the example library and the component
 * view land in the following orders; this pins the exports + the
 * never-throw contract of `runExample`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { ENGINES, EXAMPLES, engineIds, runExample } from '@jarenjs/play';
import { createPlayComponent } from '@jarenjs/play/component';

describe('@jarenjs/play — scaffold', () => {
  it('registers the first engine set and a non-empty example library', () => {
    const ids = engineIds();
    for (const id of ['path', 'pointer', 'patch', 'query', 'jslt']) assert.ok(ids.includes(id), id);
    assert.strictEqual(typeof ENGINES.path.run, 'function');
    assert.ok(EXAMPLES.length > 0);
  });

  it('runExample returns an error Result for an unknown engine — never throws', () => {
    const r = runExample('nope', { selector: '$' }, { data: '{}' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.output, '');
    assert.strictEqual(r.timing, null);
    assert.match(r.error.message, /unknown engine/);
  });

  it('the component factory hands back the engine surface', () => {
    const c = createPlayComponent();
    assert.ok(c.engineIds().includes('path'));
    assert.strictEqual(typeof c.runExample, 'function');
  });
});
