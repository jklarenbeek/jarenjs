//@ts-check
/**
 * `switchOption` answers the session one option switch leaves: the pane's
 * `convert` re-expresses the source, `follow: 'example'` loads the
 * engine's example for the choice, and anything else keeps the source.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { switchOption, EXAMPLES } from '@jarenjs/play';

const session = (/** @type {string} */ id) => {
  const example = /** @type {any} */ (EXAMPLES.find((e) => e.id === id));
  return { source: example.source, data: example.datasets[0]?.data ?? {}, config: example.config ?? {} };
};

describe('switchOption', () => {
  it('keeps the source of a pane that declares nothing, and of a choice that does not change', () => {
    const josl = session('josl-citizens');
    assert.deepStrictEqual(switchOption('josl', 'mode', 'toml', josl),
      { config: { ...josl.config, mode: 'toml' }, source: josl.source, data: josl.data });
    const chart = session('charts-heatmap');
    assert.strictEqual(switchOption('charts', 'format', 'json', chart).source, chart.source);
  });

  it('keeps the source of an unknown engine or pane, setting only the config', () => {
    assert.deepStrictEqual(switchOption('nope', 'mode', 'x', { source: { a: '1' }, data: {} }),
      { config: { mode: 'x' }, source: { a: '1' }, data: {} });
    assert.deepStrictEqual(switchOption('patch', 'nope', 'x', { source: { patch: '[]' }, data: {} }).source, { patch: '[]' });
  });

  it('keeps a source the conversion cannot read, so the run says why', () => {
    const broken = { source: { source: '{ "type": ' }, data: {}, config: { format: 'json' } };
    assert.strictEqual(switchOption('charts', 'format', 'josl', broken).source, broken.source);
    const patch = { source: { patch: '{ "a": 1 }' }, data: { data: 'not json' }, config: { mode: 'merge' } };
    assert.strictEqual(switchOption('patch', 'mode', 'patch', patch).source, patch.source);
  });

  it('writes one change three ways', () => {
    const merge = { source: { patch: '{ "b": null, "c": 3 }' }, data: { data: '{ "a": 1, "b": 2 }' }, config: { mode: 'merge' } };
    const asPatch = switchOption('patch', 'mode', 'patch', merge);
    assert.deepStrictEqual(JSON.parse(asPatch.source.patch).map((/** @type {any} */ op) => op.op).sort(), ['add', 'remove']);
    assert.deepStrictEqual(JSON.parse(switchOption('patch', 'mode', 'diff', merge).source.patch), { a: 1, c: 3 });
    assert.deepStrictEqual(JSON.parse(switchOption('patch', 'mode', 'merge', asPatch).source.patch), { b: null, c: 3 });
  });

  it("loads the engine's example for a choice that names what the source holds", () => {
    const next = switchOption('kernels', 'kernel', 'roundExact', session('kernel-distance'));
    assert.strictEqual(next.example, 'kernel-round');
    assert.deepStrictEqual(next.source, session('kernel-round').source);
    assert.strictEqual(next.config.kernel, 'roundExact');
  });
});
