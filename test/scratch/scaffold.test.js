//@ts-check
/**
 * @file @jarenjs/scratch scaffold — the headless engine surface exists and
 * the package is wired. The engines, the example library and the component
 * view land in the following orders; this pins the exports + the
 * never-throw contract of `runExample`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { ENGINES, EXAMPLES, engineIds, runExample } from '@jarenjs/scratch';
import { createScratchComponent } from '@jarenjs/scratch/component';

describe('@jarenjs/scratch — scaffold', () => {
  it('exports the engine surface (empty until the engines land)', () => {
    assert.deepStrictEqual(engineIds(), []);
    assert.deepStrictEqual([...EXAMPLES], []);
    assert.deepStrictEqual(ENGINES, {});
  });

  it('runExample returns an error Result for an unknown engine — never throws', () => {
    const r = runExample('nope', { selector: '$' }, { data: '{}' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.output, '');
    assert.strictEqual(r.timing, null);
    assert.match(r.error.message, /unknown engine/);
  });

  it('the component factory hands back the engine surface', () => {
    const c = createScratchComponent();
    assert.deepStrictEqual(c.engineIds(), []);
    assert.strictEqual(typeof c.runExample, 'function');
  });
});
