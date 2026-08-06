//@ts-check
/**
 * @file The project envelope: parseProject normalizes and gates a
 * jaren-project document — layout defaulting, `active` resolution, the
 * closed kind vocabulary, and the two envelope errors (JS0001 malformed,
 * JS0002 duplicate name).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { parseProject, fileOf, KINDS, LAYOUT_DEFAULT } from '@jarenjs/studio';

const sample = () => ({
  project: '0.1',
  files: [
    { name: 'app.json', kind: 'app', text: '{"view":[]}' },
    { name: 'seed.data', kind: 'data', text: '{"a":1}' },
  ],
});

describe('the closed vocabulary + defaults', () => {
  it('exports the nine kinds and the frozen layout default', () => {
    assert.deepStrictEqual([...KINDS].sort(),
      ['app', 'data', 'dag', 'fsm', 'jslt', 'model', 'query', 'schema', 'state'].sort());
    assert.deepStrictEqual(LAYOUT_DEFAULT, { mode: 'classic', ratio: 0.5, autorun: true });
    assert.throws(() => { /** @type {any} */ (LAYOUT_DEFAULT).mode = 'x'; }, TypeError);
  });
});

describe('parseProject', () => {
  it('normalizes: defaults the layout, resolves active to a real file, freezes the result', () => {
    const p = parseProject(sample());
    assert.deepStrictEqual(p.layout, { mode: 'classic', ratio: 0.5, autorun: true });
    assert.strictEqual(p.active, 'app.json');
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.files) && Object.isFrozen(p.files[0]));
  });

  it('merges a partial layout over the default and keeps a valid active', () => {
    const p = parseProject({ ...sample(), active: 'seed.data', layout: { mode: 'right', ratio: 0.3 } });
    assert.deepStrictEqual(p.layout, { mode: 'right', ratio: 0.3, autorun: true });
    assert.strictEqual(p.active, 'seed.data');
  });

  it('falls back active to the first file when it names nothing real', () => {
    assert.strictEqual(parseProject({ ...sample(), active: 'ghost.json' }).active, 'app.json');
  });

  it('accepts a JSON string as well as an object', () => {
    assert.strictEqual(parseProject(JSON.stringify(sample())).files.length, 2);
  });

  it('fileOf finds a file by name, or null', () => {
    const p = parseProject(sample());
    assert.strictEqual(fileOf(p, 'seed.data').kind, 'data');
    assert.strictEqual(fileOf(p, 'nope'), null);
  });

  it('rejects invalid JSON as JS0001', () => {
    assert.throws(() => parseProject('{ not json'), (e) => {
      assert.strictEqual(/** @type {any} */ (e).code, 'JS0001'); return true;
    });
  });

  it('rejects an out-of-vocabulary kind / missing project marker as JS0001', () => {
    assert.throws(() => parseProject({ project: '0.1', files: [{ name: 'x', kind: 'wat', text: '{}' }] }),
      (e) => { assert.strictEqual(/** @type {any} */ (e).code, 'JS0001'); return true; });
    assert.throws(() => parseProject({ files: [] }),
      (e) => { assert.strictEqual(/** @type {any} */ (e).code, 'JS0001'); return true; });
  });

  it('rejects a duplicate file name as JS0002', () => {
    assert.throws(() => parseProject({ project: '0.1', files: [
      { name: 'a', kind: 'data', text: '1' }, { name: 'a', kind: 'data', text: '2' }] }),
    (e) => { assert.strictEqual(/** @type {any} */ (e).code, 'JS0002'); return true; });
  });
});
