//@ts-check
/**
 * @file Every play example, run through the site's REAL renderers: the
 * charts schema + compiler, the mermaid component and the localized
 * validator. The package's own example test stubs these hosts, so a chart
 * definition the schema refuses, a diagram the parser rejects or a locale
 * that never reaches the messages would pass there; here they cannot.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { EXAMPLES } from '@jarenjs/play';
import { runPlay } from '../../packages/website/src/boundaries/play.js';
import { mermaid } from '../../packages/website/src/boundaries/mermaid.js';

/** Run one example over one dataset with the host's runner. */
function runOver(ex, dataset) {
  const slice = { engine: ex.engine, source: { ...ex.source }, data: { ...(dataset?.data ?? {}) }, config: { ...(ex.config ?? {}) } };
  return Promise.resolve(runPlay(slice));
}

/** The errors table of a validate run: its message cells in order. */
const messages = (result) => result.panels.find((p) => p.kind === 'table').rows.map((row) => JSON.stringify(row));

describe('play examples through the site renderers', () => {
  it('every chart and diagram example renders an SVG', async () => {
    for (const ex of EXAMPLES.filter((e) => e.engine === 'charts' || e.engine === 'mermaid')) {
      const result = await runOver(ex, undefined);
      assert.strictEqual(result.ok, true, `${ex.id}: ${result.error?.message}`);
      const view = result.panels.find((p) => p.kind === 'view');
      assert.ok(Array.isArray(view?.vnode), `${ex.id}: a rendered vnode`);
      assert.match(JSON.stringify(view.vnode), /"svg"/, `${ex.id}: an SVG`);
    }
  });

  it('the map example draws one shape per region', async () => {
    const ex = EXAMPLES.find((e) => e.id === 'charts-map');
    const result = await runOver(ex, undefined);
    const paths = JSON.stringify(result.panels.find((p) => p.kind === 'view').vnode).match(/"path"/g) ?? [];
    assert.strictEqual(paths.length, 2, 'the west and east regions');
  });

  it('the mermaid examples parse to the seven laid-out diagram kinds', () => {
    const kinds = new Set();
    for (const ex of EXAMPLES.filter((e) => e.engine === 'mermaid')) {
      const compiled = mermaid.compile(String(ex.source.source));
      assert.strictEqual(compiled.parseError ?? null, null, `${ex.id}: ${compiled.parseError?.message}`);
      kinds.add(compiled.doc.diagram);
    }
    assert.deepStrictEqual([...kinds].sort(), ['class', 'er', 'flowchart', 'gantt', 'pie', 'sequence', 'state']);
  });

  it('each locale example localizes the errors the English run reports', async () => {
    const locales = EXAMPLES.filter((e) => e.id.startsWith('validate-locale-'));
    assert.ok(locales.length >= 11, `only ${locales.length} locale examples`);
    for (const ex of locales) {
      const localized = await runOver(ex, ex.datasets[0]);
      assert.strictEqual(localized.ok, true, `${ex.id}: ${localized.error?.message}`);
      const english = await runOver({ ...ex, config: { locale: 'en' } }, ex.datasets[0]);
      assert.notDeepStrictEqual(messages(localized), messages(english), `${ex.id}: the messages are not English`);
    }
  });

  it('the $ref-by-$id example resolves its referenced schema, and editing that schema recompiles', async () => {
    const ex = EXAMPLES.find((e) => e.id === 'validate-ref-by-id');
    const [valid, invalid] = ex.datasets;
    const good = await runOver(ex, valid);
    assert.strictEqual(good.ok, true, good.error?.message);
    assert.match(good.panels[0].text, /^✓ valid/);

    const bad = await runOver(ex, invalid);
    assert.strictEqual(bad.ok, true);
    assert.deepStrictEqual(messages(bad), ['["/billing","must have required property \'city\'"]']);

    // same main schema text, referenced schema edited: the compile cache must not answer for the old one
    const address = JSON.parse(ex.source.schemas)[0];
    const strict = { ...ex, source: { ...ex.source, schemas: JSON.stringify([{ ...address, properties: { ...address.properties, city: { type: 'string', minLength: 20 } } }]) } };
    const stricter = await runOver(strict, valid);
    assert.deepStrictEqual(messages(stricter), [
      '["/billing/city","must NOT have fewer than 20 characters"]',
      '["/shipping/city","must NOT have fewer than 20 characters"]',
    ]);
    const back = await runOver(ex, valid);
    assert.match(back.panels[0].text, /^✓ valid/);

    // without the pane the reference cannot resolve: the schema is refused, with the validator's message
    const without = await runOver({ ...ex, source: { ...ex.source, schemas: '' } }, valid);
    assert.strictEqual(without.ok, false);
    assert.strictEqual(without.error.code, 'SCHEMA');
    assert.match(without.error.message, /Can not resolve schema/);
  });
});
