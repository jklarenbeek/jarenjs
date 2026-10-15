//@ts-check
/**
 * @file `createJSONPatch` and `createMergePatch` diff, and
 * `compileMergePatch`/`applyMergePatch` apply, any nesting a default host
 * stack could, without that stack: past 10000 levels they refuse with
 * `JO2001`, the bound `equalsJson` and `stableStringify` hold, instead of
 * overflowing it, and on a cycle with `JO2002` at the member that closes
 * it, located from the documents' roots.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createJSONPatch, createMergePatch, applyJSONPatch, applyMergePatch, compileMergePatch, canonicalizeJson } from '@jarenjs/json';
import { equalsJson, locateCycle, stableStringify } from '@jarenjs/core/object';

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
/** An object whose `self` member is itself. @param {number} x */
const cycle = (x) => {
  /** @type {any} */
  const value = { x };
  value.self = value;
  return value;
};
/** An array whose one item is itself. */
const cycleArray = () => {
  /** @type {any[]} */
  const value = [];
  value.push(value);
  return value;
};
/** @param {string} tail @param {string} at */
const circular = (tail, at) => ({
  name: 'JsonCycleError',
  code: 'JO2002',
  docPath: at,
  message: `JO2002: a circular reference ${tail} at ${at}`,
});
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

  it('refuses the 10001st level with JO2001', () => {
    assert.throws(() => createJSONPatch(nestObjects(10001, 1), nestObjects(10001, 2)), refused);
  });

  it('refuses a pair of cycles as a circular reference located in the documents', () => {
    assert.throws(() => createJSONPatch(cycle(1), cycle(2)), circular('in the source cannot be diffed', '/self'));
    // equalsJson and stableStringify meet these cycles on a subtree: the pointer is the document's
    for (const arrayDiff of /** @type {const} */ (['index', 'minimal'])) {
      assert.throws(() => createJSONPatch({ a: [cycle(1)] }, { a: [cycle(1)] }, { arrayDiff }),
        circular('in the source cannot be diffed', '/a/0/self'), arrayDiff);
    }
    // the minimal diff keys each item by its stable serialization; the index diff never walks them
    assert.throws(() => createJSONPatch({ a: [1, cycle(1)] }, { a: [cycle(1), 2] }, { arrayDiff: 'minimal' }),
      circular('in the source cannot be diffed', '/a/1/self'));
    const added = cycle(1);
    assert.deepEqual(createJSONPatch({ a: [1, cycle(1)] }, { a: [added, 2] }),
      [{ op: 'replace', path: '/a/0', value: added }, { op: 'replace', path: '/a/1', value: 2 }]);
    // a cycle closed past the bound from the documents' roots is a value as deep as the bound,
    // though equalsJson meets it within its own bound on the subtree it compares
    assert.throws(() => createJSONPatch(nestObjects(9998, { k: [cycle(1)] }), nestObjects(9998, { k: [cycle(1)] })), refused);
    // a cycle only the target holds is named in the target
    assert.throws(() => createJSONPatch({ k: [nestArrays(10005, 1)] }, { k: [cycleArray()] }),
      circular('in the target cannot be diffed', '/k/0/0'));
  });

  it('still answers a diff that adds a cycle the walk never enters', () => {
    const target = cycle(1);
    assert.deepEqual(createJSONPatch({}, target), [{ op: 'add', path: '/x', value: 1 }, { op: 'add', path: '/self', value: target }]);
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

  it('refuses the 10001st level with JO2001', () => {
    assert.throws(() => createMergePatch(nestObjects(10001, 1), nestObjects(10001, 2)), refused);
  });

  it('refuses a pair of cycles as a circular reference located in the documents', () => {
    assert.throws(() => createMergePatch(cycle(1), cycle(2)), circular('in the source cannot be diffed', '/self'));
    // equalsJson compares the arrays: the pointer is the document's
    assert.throws(() => createMergePatch({ a: [cycle(1)] }, { a: [cycle(1)] }), circular('in the source cannot be diffed', '/a/0/self'));
    const target = cycle(1);
    assert.deepEqual(createMergePatch({}, target), target);
  });

  it('answers an empty patch for one reference at any depth', () => {
    const deep = nestObjects(100000, 1);
    assert.deepEqual(createMergePatch({ k: deep }, { k: deep }), {});
  });
});

describe('compileMergePatch and applyMergePatch apply deep patches without the host stack', () => {
  const unapplied = { ...refused, message: 'JO2001: a value nested deeper than 10000 levels cannot be applied' };

  it('applies the 10000-level patch createMergePatch writes', () => {
    const source = nestObjects(10000, 1);
    const target = nestObjects(10000, 2);
    assert.equal(equalsJson(applyMergePatch(source, createMergePatch(source, target)), target), true);
    // onto a non-object, the patch builds the objects it merges into
    assert.equal(equalsJson(applyMergePatch(1, nestObjects(10000, 2)), target), true);
  });

  it('returns a document 10000 levels deep that the patch does not change by reference', () => {
    const doc = nestObjects(10000, 1);
    assert.equal(compileMergePatch(nestObjects(10000, 1))(doc), doc);
    const changed = compileMergePatch({ b: 1, a: nestObjects(9999, 1) })(doc);
    assert.notEqual(changed, doc);
    assert.equal(changed.a, doc.a);
    assert.equal(JSON.stringify(Object.keys(changed)), '["a","b"]');
  });

  it('refuses a patch of 10001 levels with JO2001', () => {
    assert.throws(() => compileMergePatch(nestObjects(10001, 1)), unapplied);
    assert.throws(() => applyMergePatch({}, nestObjects(10001, null)), unapplied);
  });

  it('refuses a cyclic patch as a circular reference at the member that closes it', () => {
    assert.throws(() => compileMergePatch(cycle(1)), circular('cannot be applied', '/self'));
    assert.throws(() => applyMergePatch({}, { a: { b: cycle(1) } }), circular('cannot be applied', '/a/b/self'));
  });
});

describe('every walker names the member canonicalizeJson names', () => {
  it('agrees on the pointer of each cycle', () => {
    /** @type {any[]} */
    const shapes = [];
    for (const build of [
      (/** @type {any} */ v) => { v.self = v; },
      (/** @type {any} */ v) => { v.list = [1, { back: v }]; },
      (/** @type {any} */ v) => { v['a/b'] = { 'm~n': v }; },
      (/** @type {any} */ v) => { v.z = { y: null }; v.z.y = v.z; v.a = 1; },
      (/** @type {any} */ v) => { v.deep = nestObjects(500, null); let at = v.deep; while (at.a !== null) at = at.a; at.a = v; },
    ]) {
      const value = {};
      build(value);
      shapes.push(value);
    }
    for (const value of shapes) {
      /** @type {any} */
      let oracle;
      try { canonicalizeJson(value); }
      catch (error) { oracle = error; }
      assert.equal(oracle?.message.startsWith('a circular reference'), true, oracle?.message);
      const at = oracle.dataPath;
      assert.equal(locateCycle(value), at);
      assert.throws(() => stableStringify(value), { code: 'JO2002', docPath: at });
      // a merge patch sets an array whole, so only a cycle through objects is walked
      if (Array.isArray(value.list))
        assert.equal(typeof compileMergePatch(value), 'function');
      else
        assert.throws(() => compileMergePatch(value), { code: 'JO2002', docPath: at });
      assert.throws(() => createJSONPatch(value, structuredClone(value)), { code: 'JO2002', docPath: at });
      assert.throws(() => createMergePatch(value, structuredClone(value)), { code: 'JO2002', docPath: at });
    }
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

  it('applies a 10000-level merge patch and refuses 10001 under --stack-size=900', () => {
    const script = `
      import { applyMergePatch, compileMergePatch } from '@jarenjs/json';
      const nest = (n, leaf) => { let v = leaf; for (let i = 0; i < n; i++) v = { a: v }; return v; };
      const codeOf = (f) => { try { f(); return 'answered'; } catch (e) { return e.code ?? e.name; } };
      process.stdout.write(JSON.stringify([
        codeOf(() => applyMergePatch(nest(10000, 1), nest(10000, 2))),
        codeOf(() => compileMergePatch(nest(10001, 2))),
      ]));
    `;
    const child = spawnSync(process.execPath, ['--stack-size=900', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: new URL('../..', import.meta.url) });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, JSON.stringify(['answered', 'JO2001']));
  });
});
