//@ts-check
/**
 * @file `createJSONPatch` and `createMergePatch` diff any nesting a default
 * host stack could, without that stack: past 10000 levels, and on a cycle,
 * they refuse with `JO2001`, the bound `equalsJson` and `stableStringify`
 * hold, instead of overflowing it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createJSONPatch, createMergePatch, applyJSONPatch } from '@jarenjs/json';
import { equalsJson } from '@jarenjs/core/object';

/** `n` nested `{ a }` objects around `leaf`. @param {number} n @param {unknown} leaf */
const nestObjects = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
};
/** `n` nested arrays around `leaf`. @param {number} n @param {unknown} leaf */
const nestArrays = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
const refused = {
  name: 'JsonDepthError',
  code: 'JO2001',
  message: 'JO2001: a value nested deeper than 10000 levels cannot be diffed',
};

describe('createJSONPatch diffs deep values without the host stack', () => {
  it('diffs 10000 levels of objects into one replace', () => {
    assert.deepEqual(createJSONPatch(nestObjects(10000, 1), nestObjects(10000, 2)),
      [{ op: 'replace', path: '/a'.repeat(10000), value: 2 }]);
  });

  it('diffs 3000 levels of arrays in both modes', () => {
    for (const arrayDiff of /** @type {const} */ (['index', 'minimal'])) {
      const source = nestArrays(3000, 1);
      const target = nestArrays(3000, 2);
      const patch = createJSONPatch(source, target, { arrayDiff });
      assert.deepEqual(patch, [{ op: 'replace', path: '/0'.repeat(3000), value: 2 }], arrayDiff);
      assert.equal(equalsJson(applyJSONPatch(source, patch), target), true);
    }
  });

  it('refuses the 10001st level and a pair of cycles with JO2001', () => {
    assert.throws(() => createJSONPatch(nestObjects(10001, 1), nestObjects(10001, 2)), refused);
    /** @type {any} */
    const a = { x: 1 };
    a.self = a;
    /** @type {any} */
    const b = { x: 2 };
    b.self = b;
    assert.throws(() => createJSONPatch(a, b), refused);
  });

  it('answers an empty patch for one reference at any depth', () => {
    const deep = nestObjects(100000, 1);
    assert.deepEqual(createJSONPatch(deep, deep), []);
    assert.deepEqual(createJSONPatch({ k: deep }, { k: deep }), []);
  });
});

describe('the diffs keep a recursive walk\'s order', () => {
  it('emits the ops of each member pair where the pair stands', () => {
    assert.deepEqual(createJSONPatch(
      { a: { x: 1, y: [1, { z: 1 }] }, b: { y: 1 }, c: 1, e: [{ q: 1 }, 2] },
      { a: { x: 2, y: [1, { z: 2 }], n: 1 }, b: { y: 2 }, d: 1, e: [{ q: 2 }, 3] }), [
      { op: 'replace', path: '/a/x', value: 2 },
      { op: 'replace', path: '/a/y/1/z', value: 2 },
      { op: 'add', path: '/a/n', value: 1 },
      { op: 'replace', path: '/b/y', value: 2 },
      { op: 'remove', path: '/c' },
      { op: 'replace', path: '/e/0/q', value: 2 },
      { op: 'replace', path: '/e/1', value: 3 },
      { op: 'add', path: '/d', value: 1 },
    ]);
  });

  it('writes the merge patch members in a recursive walk\'s order', () => {
    const patch = createMergePatch(
      { r: 1, a: { x: 1, y: { z: 1 } }, b: { y: 1 }, c: 1, s: { same: 1 } },
      { a: { y: { z: 2 }, x: 2 }, b: { y: 2 }, c: 2, s: { same: 1 }, n: 1 });
    assert.equal(JSON.stringify(patch), '{"r":null,"a":{"y":{"z":2},"x":2},"b":{"y":2},"c":2,"n":1}');
  });
});

describe('createMergePatch diffs deep values without the host stack', () => {
  it('diffs 10000 levels', () => {
    const source = nestObjects(10000, 1);
    const target = nestObjects(10000, 2);
    // the patch of a changed leaf is the target's own shape
    assert.equal(equalsJson(createMergePatch(source, target), target), true);
    assert.equal(equalsJson(createMergePatch(source, nestObjects(10000, null)), nestObjects(10000, null)), true);
  });

  it('refuses the 10001st level and a pair of cycles with JO2001', () => {
    assert.throws(() => createMergePatch(nestObjects(10001, 1), nestObjects(10001, 2)), refused);
    /** @type {any} */
    const a = { x: 1 };
    a.self = a;
    /** @type {any} */
    const b = { x: 2 };
    b.self = b;
    assert.throws(() => createMergePatch(a, b), refused);
  });

  it('answers an empty patch for one reference at any depth', () => {
    const deep = nestObjects(100000, 1);
    assert.deepEqual(createMergePatch({ k: deep }, { k: deep }), {});
  });
});

describe('the bound holds on a small host stack', () => {
  it('passes 10000 levels and refuses 10001 under --stack-size=900', () => {
    const script = `
      import { createJSONPatch, createMergePatch } from '@jarenjs/json';
      const nest = (n, leaf) => { let v = leaf; for (let i = 0; i < n; i++) v = { a: v }; return v; };
      const codeOf = (f) => { try { f(); return 'answered'; } catch (e) { return e.code ?? e.name; } };
      process.stdout.write(JSON.stringify([
        createJSONPatch(nest(10000, 1), nest(10000, 2)).length,
        codeOf(() => createMergePatch(nest(10000, 1), nest(10000, 2))),
        codeOf(() => createJSONPatch(nest(10001, 1), nest(10001, 2))),
        codeOf(() => createMergePatch(nest(10001, 1), nest(10001, 2))),
      ]));
    `;
    const child = spawnSync(process.execPath, ['--stack-size=900', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: new URL('../..', import.meta.url) });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, JSON.stringify([1, 'answered', 'JO2001', 'JO2001']));
  });
});
