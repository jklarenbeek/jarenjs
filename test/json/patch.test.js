import { describe, it } from 'node:test';
import { strictEqual, notStrictEqual, deepStrictEqual } from 'node:assert';
import * as assert from '../assert.node.js';
import { readFileSync } from 'node:fs';

import {
  compileJSONPatch,
  applyJSONPatch,
  createJSONPatch,
  isValidJSONPatch,
  compileMergePatch,
  applyMergePatch,
  createMergePatch,
  JsonPatchCompileError,
  JsonPatchRuntimeError,
  encodeJSONPointerSegment,
  formatJSONPointer,
} from '@jarenjs/json';

function fixture(name) {
  return JSON.parse(readFileSync(
    new URL(`./fixtures/json-patch/${name}`, import.meta.url), 'utf8'));
}

//#region official json-patch-tests vectors

// https://github.com/json-patch/json-patch-tests - tests.json holds the
// community vectors, spec_tests.json the RFC 6902 appendix A examples.
for (const file of ['spec_tests.json', 'tests.json']) {
  describe(`json-patch-tests ${file}`, () => {
    const cases = fixture(file);
    cases.forEach((test, i) => {
      if (test.disabled)
        return;
      const label = test.comment ?? `case ${i}`;
      if (test.error !== undefined) {
        it(`${label} (error)`, () => {
          assert.throws(
            () => applyJSONPatch(test.doc, test.patch),
            (e) => e instanceof JsonPatchCompileError || e instanceof JsonPatchRuntimeError);
        });
      }
      else {
        it(label, () => {
          const input = structuredClone(test.doc);
          const result = applyJSONPatch(input, test.patch);
          if (test.expected !== undefined)
            deepStrictEqual(result, test.expected);
          // the input document is never mutated
          deepStrictEqual(input, test.doc);
        });
      }
    });
  });
}

//#endregion

//#region compile-time validation

describe('compileJSONPatch validation', () => {
  it('rejects a non-array patch document (JP0001)', () => {
    assert.throws(() => compileJSONPatch({ op: 'add', path: '/a', value: 1 }), (e) => {
      return e instanceof JsonPatchCompileError && e.code === 'JP0001' && e.docPath === '';
    });
  });

  it('rejects a non-object operation (JP0001)', () => {
    assert.throws(() => compileJSONPatch([null]), (e) => {
      return e.code === 'JP0001' && e.docPath === '/0';
    });
    assert.throws(() => compileJSONPatch([['add']]), (e) => e.code === 'JP0001');
  });

  it('rejects a missing or unknown op member (JP0002)', () => {
    assert.throws(() => compileJSONPatch([{ path: '/a' }]), (e) => {
      return e.code === 'JP0002' && e.docPath === '/0/op';
    });
    assert.throws(() => compileJSONPatch([{ op: 'spawn', path: '/a' }]), (e) => {
      return e.code === 'JP0002' && e.docPath === '/0/op';
    });
  });

  it('rejects a missing or invalid pointer (JP0003)', () => {
    assert.throws(() => compileJSONPatch([{ op: 'remove' }]), (e) => {
      return e.code === 'JP0003' && e.docPath === '/0/path';
    });
    assert.throws(() => compileJSONPatch([{ op: 'add', path: 'a', value: 1 }]), (e) => {
      return e.code === 'JP0003' && e.cause !== undefined;
    });
    assert.throws(() => compileJSONPatch([{ op: 'move', path: '/a' }]), (e) => {
      return e.code === 'JP0003' && e.docPath === '/0/from';
    });
  });

  it('rejects a missing value member (JP0004)', () => {
    for (const op of ['add', 'replace', 'test']) {
      assert.throws(() => compileJSONPatch([{ op, path: '/a' }]), (e) => {
        return e.code === 'JP0004' && e.docPath === '/0';
      });
    }
  });

  it('accepts an explicit null value', () => {
    deepStrictEqual(applyJSONPatch({}, [{ op: 'add', path: '/a', value: null }]), { a: null });
  });

  it('rejects a move whose from is a proper prefix of path (JP0005)', () => {
    assert.throws(
      () => compileJSONPatch([{ op: 'move', from: '/a/b', path: '/a/b/c' }]),
      (e) => e.code === 'JP0005' && e.docPath === '/0/from');
    assert.throws(
      () => compileJSONPatch([{ op: 'move', from: '', path: '/a' }]),
      (e) => e.code === 'JP0005');
    // equal pointers and sibling moves are fine
    assert.doesNotThrow(() => compileJSONPatch([{ op: 'move', from: '/a', path: '/a' }]));
    assert.doesNotThrow(() => compileJSONPatch([{ op: 'move', from: '/ab', path: '/ab2' }]));
  });

  it('rejects an unknown values option', () => {
    assert.throws(() => compileJSONPatch([], { values: 'copy' }), TypeError);
  });

  it('isValidJSONPatch mirrors compile validation', () => {
    assert.isTrue(isValidJSONPatch([]));
    assert.isTrue(isValidJSONPatch([{ op: 'test', path: '', value: null }]));
    assert.isFalse(isValidJSONPatch({}));
    assert.isFalse(isValidJSONPatch([{ op: 'add', path: 'bad', value: 1 }]));
    assert.isFalse(isValidJSONPatch([{ op: 'frobnicate', path: '/a' }]));
  });
});

//#endregion

//#region runtime errors

describe('JsonPatchRuntimeError', () => {
  it('carries docPath into the patch and dataPath into the document', () => {
    assert.throws(
      () => applyJSONPatch({ a: 1 }, [
        { op: 'test', path: '/a', value: 1 },
        { op: 'replace', path: '/b/c', value: 2 },
      ]),
      (e) => {
        return e instanceof JsonPatchRuntimeError
          && e.code === 'JP2001' && e.docPath === '/1' && e.dataPath === '/b/c';
      });
  });

  it('reports failed tests as JP2004', () => {
    assert.throws(
      () => applyJSONPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }]),
      (e) => e.code === 'JP2004' && e.dataPath === '/a');
    assert.throws(
      () => applyJSONPatch({ a: 1 }, [{ op: 'test', path: '/b', value: 1 }]),
      (e) => e.code === 'JP2004');
  });

  it('rejects removing the root (JP2003)', () => {
    assert.throws(
      () => applyJSONPatch({ a: 1 }, [{ op: 'remove', path: '' }]),
      (e) => e.code === 'JP2003');
  });

  it('rejects invalid array positions (JP2002)', () => {
    assert.throws(
      () => applyJSONPatch([1, 2], [{ op: 'add', path: '/01', value: 3 }]),
      (e) => e.code === 'JP2002');
    assert.throws(
      () => applyJSONPatch([1, 2], [{ op: 'add', path: '/3', value: 3 }]),
      (e) => e.code === 'JP2002');
    assert.throws(
      () => applyJSONPatch([1, 2], [{ op: 'remove', path: '/-' }]),
      (e) => e.code === 'JP2002');
    assert.throws(
      () => applyJSONPatch([1, 2], [{ op: 'replace', path: '/-', value: 3 }]),
      (e) => e.code === 'JP2002');
  });

  it('leaves the input untouched when a later operation fails (atomicity)', () => {
    const doc = { a: { b: 1 }, list: [1, 2, 3] };
    const snapshot = structuredClone(doc);
    assert.throws(() => applyJSONPatch(doc, [
      { op: 'replace', path: '/a/b', value: 99 },
      { op: 'add', path: '/list/9', value: 0 },
    ]));
    deepStrictEqual(doc, snapshot);
  });
});

//#endregion

//#region RFC 6902 semantics details

describe('JSON Patch semantics', () => {
  it('applies the proposal example', () => {
    const original = { baz: 'qux', foo: 'bar', numbers: [1, 2, 3] };
    const result = applyJSONPatch(original, [
      { op: 'replace', path: '/baz', value: 'boo' },
      { op: 'add', path: '/hello', value: ['world'] },
      { op: 'remove', path: '/foo' },
      { op: 'add', path: '/numbers/-', value: 4 },
    ]);
    deepStrictEqual(result, { baz: 'boo', hello: ['world'], numbers: [1, 2, 3, 4] });
    deepStrictEqual(original, { baz: 'qux', foo: 'bar', numbers: [1, 2, 3] });
  });

  it('add and replace at the root replace the whole document', () => {
    deepStrictEqual(applyJSONPatch({ a: 1 }, [{ op: 'add', path: '', value: [1] }]), [1]);
    deepStrictEqual(applyJSONPatch({ a: 1 }, [{ op: 'replace', path: '', value: 5 }]), 5);
  });

  it('moves a value to the root', () => {
    deepStrictEqual(
      applyJSONPatch({ a: { b: 2 }, c: 1 }, [{ op: 'move', from: '/a', path: '' }]),
      { b: 2 });
  });

  it('moving the root onto itself is a no-op', () => {
    const doc = { a: 1 };
    deepStrictEqual(applyJSONPatch(doc, [{ op: 'move', from: '', path: '' }]), { a: 1 });
  });

  it("treats '-' as a member name on objects", () => {
    deepStrictEqual(
      applyJSONPatch({ '-': 1 }, [{ op: 'replace', path: '/-', value: 2 }]),
      { '-': 2 });
    deepStrictEqual(
      applyJSONPatch({}, [{ op: 'add', path: '/-', value: 1 }]),
      { '-': 1 });
  });

  it('addresses the empty-string member', () => {
    deepStrictEqual(
      applyJSONPatch({ '': 0 }, [{ op: 'replace', path: '/', value: 9 }]),
      { '': 9 });
  });

  it('copies into a descendant of the source', () => {
    deepStrictEqual(
      applyJSONPatch({ a: { x: 1 } }, [{ op: 'copy', from: '/a', path: '/a/self' }]),
      { a: { x: 1, self: { x: 1 } } });
  });

  it('a compiled patch is reusable across documents', () => {
    const apply = compileJSONPatch([{ op: 'add', path: '/n/-', value: 0 }]);
    deepStrictEqual(apply({ n: [1] }), { n: [1, 0] });
    deepStrictEqual(apply({ n: [] }), { n: [0] });
  });

  it('does not pollute prototypes through __proto__ members', () => {
    const result = applyJSONPatch({}, [
      { op: 'add', path: '/__proto__', value: { polluted: true } },
    ]);
    strictEqual({}.polluted, undefined);
    strictEqual(Object.getPrototypeOf(result), Object.prototype);
    deepStrictEqual(Object.getOwnPropertyDescriptor(result, '__proto__').value,
      { polluted: true });
    // and survives the copy-on-write clone of such an object
    const result2 = applyJSONPatch(result, [{ op: 'add', path: '/x', value: 1 }]);
    strictEqual(Object.getPrototypeOf(result2), Object.prototype);
    deepStrictEqual(Object.getOwnPropertyDescriptor(result2, '__proto__').value,
      { polluted: true });
  });
});

//#endregion

//#region copy-on-write and sharing

describe('copy-on-write application', () => {
  it('shares untouched subtrees with the input', () => {
    const doc = { a: { deep: { x: 1 } }, b: { y: 2 } };
    const result = applyJSONPatch(doc, [{ op: 'replace', path: '/b/y', value: 3 }]);
    strictEqual(result.a, doc.a);
    notStrictEqual(result.b, doc.b);
    strictEqual(doc.b.y, 2);
  });

  it('clones a spine only once across operations', () => {
    const doc = { a: { b: { c: 1, d: 2 } } };
    const result = applyJSONPatch(doc, [
      { op: 'replace', path: '/a/b/c', value: 10 },
      { op: 'replace', path: '/a/b/d', value: 20 },
    ]);
    deepStrictEqual(result, { a: { b: { c: 10, d: 20 } } });
    deepStrictEqual(doc, { a: { b: { c: 1, d: 2 } } });
  });

  it('does not alias when copying an already-modified subtree', () => {
    const doc = { a: { x: 1 } };
    const result = applyJSONPatch(doc, [
      { op: 'replace', path: '/a/x', value: 2 },
      { op: 'copy', from: '/a', path: '/b' },
      { op: 'replace', path: '/b/x', value: 3 },
    ]);
    deepStrictEqual(result, { a: { x: 2 }, b: { x: 3 } });
  });

  it('does not alias when modifying through a copied location', () => {
    const doc = { a: { x: 1 } };
    const result = applyJSONPatch(doc, [
      { op: 'copy', from: '/a', path: '/b' },
      { op: 'replace', path: '/b/x', value: 3 },
    ]);
    deepStrictEqual(result, { a: { x: 1 }, b: { x: 3 } });
    strictEqual(doc.a.x, 1);
  });

  it("values: 'share' shares inserted values, 'fresh' copies them per application", () => {
    const value = { tag: 'v' };
    const shared = compileJSONPatch([{ op: 'add', path: '/v', value }]);
    strictEqual(shared({}).v, value);
    const fresh = compileJSONPatch([{ op: 'add', path: '/v', value }], { values: 'fresh' });
    const out1 = fresh({});
    const out2 = fresh({});
    deepStrictEqual(out1.v, value);
    notStrictEqual(out1.v, value);
    notStrictEqual(out1.v, out2.v);
  });

  it('mutate: true patches in place', () => {
    const doc = { a: { b: 1 }, list: [1, 2] };
    const inner = doc.a;
    const result = applyJSONPatch(doc, [
      { op: 'replace', path: '/a/b', value: 2 },
      { op: 'add', path: '/list/-', value: 3 },
    ], { mutate: true });
    strictEqual(result, doc);
    strictEqual(doc.a, inner);
    deepStrictEqual(doc, { a: { b: 2 }, list: [1, 2, 3] });
  });

  it('mutate: true never shares inserted or copied values', () => {
    const value = { tag: 'v' };
    const apply = compileJSONPatch([{ op: 'add', path: '/v', value }], { mutate: true });
    const out1 = apply({});
    const out2 = apply({});
    notStrictEqual(out1.v, out2.v);
    out1.v.tag = 'changed';
    strictEqual(value.tag, 'v');
    strictEqual(out2.v.tag, 'v');

    const doc = { a: { x: 1 } };
    applyJSONPatch(doc, [
      { op: 'copy', from: '/a', path: '/b' },
      { op: 'replace', path: '/b/x', value: 3 },
    ], { mutate: true });
    deepStrictEqual(doc, { a: { x: 1 }, b: { x: 3 } });
  });
});

//#endregion

//#region structural diff (RFC 6902)

describe('createJSONPatch', () => {
  function roundtrip(source, target) {
    const patch = createJSONPatch(source, target);
    const input = structuredClone(source);
    deepStrictEqual(applyJSONPatch(input, patch), target);
    deepStrictEqual(input, source);
    return patch;
  }

  it('returns an empty patch for equal documents', () => {
    deepStrictEqual(createJSONPatch({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), []);
    deepStrictEqual(createJSONPatch(null, null), []);
  });

  it('diffs object member changes', () => {
    const patch = roundtrip({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, d: 4 });
    deepStrictEqual(patch, [
      { op: 'replace', path: '/b', value: 9 },
      { op: 'remove', path: '/c' },
      { op: 'add', path: '/d', value: 4 },
    ]);
  });

  it('recurses into nested objects', () => {
    const patch = roundtrip({ a: { b: { c: 1 }, d: 2 } }, { a: { b: { c: 5 }, d: 2 } });
    deepStrictEqual(patch, [{ op: 'replace', path: '/a/b/c', value: 5 }]);
  });

  it('replaces on kind changes, including at the root', () => {
    deepStrictEqual(roundtrip({ a: 1 }, [1]), [{ op: 'replace', path: '', value: [1] }]);
    roundtrip([1], { a: 1 });
    roundtrip({ a: { b: 1 } }, { a: [1] });
    roundtrip(1, 'one');
    roundtrip(null, { a: 1 });
  });

  it('diffs array tail appends and truncations', () => {
    deepStrictEqual(roundtrip([1, 2], [1, 2, 3, 4]), [
      { op: 'add', path: '/2', value: 3 },
      { op: 'add', path: '/3', value: 4 },
    ]);
    deepStrictEqual(roundtrip([1, 2, 3], [1]), [
      { op: 'remove', path: '/1' },
      { op: 'remove', path: '/1' },
    ]);
  });

  it('diffs head insertions and removals through the common suffix', () => {
    deepStrictEqual(roundtrip([2, 3], [1, 2, 3]), [
      { op: 'add', path: '/0', value: 1 },
    ]);
    deepStrictEqual(roundtrip([1, 2, 3], [2, 3]), [
      { op: 'remove', path: '/0' },
    ]);
  });

  it('diffs in-place element edits index-wise', () => {
    deepStrictEqual(roundtrip([{ a: 1 }, { b: 2 }], [{ a: 1 }, { b: 3 }]),
      [{ op: 'replace', path: '/1/b', value: 3 }]);
  });

  it('handles mid-array changes with length shifts', () => {
    roundtrip([1, 2, 3, 4, 5], [1, 9, 8, 5]);
    roundtrip([1, 5], [1, 2, 3, 4, 5]);
    roundtrip(['a', 'b', 'c'], ['c', 'b', 'a']);
  });

  it('escapes special characters in emitted paths', () => {
    const patch = roundtrip({ 'a/b': 1, 'm~n': 2 }, { 'a/b': 9, 'm~n': 2, '': 3 });
    deepStrictEqual(patch, [
      { op: 'replace', path: '/a~1b', value: 9 },
      { op: 'add', path: '/', value: 3 },
    ]);
  });

  it('round-trips a larger mixed document', () => {
    roundtrip(
      {
        name: 'store', open: true,
        books: [
          { title: 'A', price: 10, tags: ['x'] },
          { title: 'B', price: 20 },
          { title: 'C', price: 30 },
        ],
        meta: { version: 1, region: 'eu' },
      },
      {
        name: 'store', open: false,
        books: [
          { title: 'A', price: 12, tags: ['x', 'y'] },
          { title: 'C', price: 30 },
          { title: 'D', price: 40 },
        ],
        meta: { version: 2 },
        extra: [1, 2, 3],
      });
  });
});

//#endregion

//#region JSON Merge Patch (RFC 7396)

describe('applyMergePatch', () => {
  // The test cases of RFC 7396, appendix A
  const rfc7396 = [
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
    [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}],
    [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
    [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    [['a', 'b'], ['c', 'd'], ['c', 'd']],
    [{ a: 'b' }, ['c'], ['c']],
    [{ a: 'foo' }, null, null],
    [{ a: 'foo' }, 'bar', 'bar'],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ];

  rfc7396.forEach(([target, patch, expected], i) => {
    it(`applies RFC 7396 appendix case ${i + 1}`, () => {
      const input = structuredClone(target);
      deepStrictEqual(applyMergePatch(input, patch), expected);
      deepStrictEqual(input, target);
    });
  });

  it('applies the RFC 7396 section 3 example', () => {
    const doc = {
      title: 'Goodbye!',
      author: { givenName: 'John', familyName: 'Doe' },
      tags: ['example', 'sample'],
      content: 'This will be unchanged',
    };
    const patch = {
      title: 'Hello!',
      phoneNumber: '+01-123-456-7890',
      author: { familyName: null },
      tags: ['example'],
    };
    deepStrictEqual(applyMergePatch(doc, patch), {
      title: 'Hello!',
      author: { givenName: 'John' },
      tags: ['example'],
      content: 'This will be unchanged',
      phoneNumber: '+01-123-456-7890',
    });
  });

  it('is identity-preserving and shares unchanged subtrees', () => {
    const doc = { a: { x: 1 }, b: { y: 2 } };
    strictEqual(applyMergePatch(doc, {}), doc);
    strictEqual(applyMergePatch(doc, { a: { x: 1 } }), doc);
    strictEqual(applyMergePatch(doc, { c: null }), doc);
    const changed = applyMergePatch(doc, { b: { y: 3 } });
    notStrictEqual(changed, doc);
    strictEqual(changed.a, doc.a);
    deepStrictEqual(doc, { a: { x: 1 }, b: { y: 2 } });
  });

  it('a compiled merge patch is reusable', () => {
    const apply = compileMergePatch({ on: true, tmp: null });
    deepStrictEqual(apply({ tmp: 1 }), { on: true });
    deepStrictEqual(apply({ on: true }), { on: true });
    deepStrictEqual(apply('scalar'), { on: true });
  });

  it('does not pollute prototypes through __proto__ members', () => {
    const result = applyMergePatch({}, JSON.parse('{"__proto__": {"polluted": true}}'));
    strictEqual({}.polluted, undefined);
    strictEqual(Object.getPrototypeOf(result), Object.prototype);
  });
});

describe('createMergePatch', () => {
  function roundtrip(source, target) {
    const patch = createMergePatch(source, target);
    deepStrictEqual(applyMergePatch(source, patch), target);
    return patch;
  }

  it('diffs member changes, removals and additions', () => {
    deepStrictEqual(roundtrip({ a: 'b', c: 1 }, { a: 'x' }), { a: 'x', c: null });
    deepStrictEqual(roundtrip({}, { a: 1 }), { a: 1 });
    deepStrictEqual(roundtrip({ a: 1 }, { a: 1 }), {});
  });

  it('recurses into nested objects and replaces arrays wholesale', () => {
    deepStrictEqual(
      roundtrip({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { b: 9, c: 2 }, l: [1, 2, 3] }),
      { a: { b: 9 }, l: [1, 2, 3] });
  });

  it('replaces wholesale on kind changes', () => {
    strictEqual(roundtrip({ a: 1 }, 'doc'), 'doc');
    deepStrictEqual(roundtrip([1], { a: 1 }), { a: 1 });
    strictEqual(roundtrip({ a: 1 }, null), null);
  });

  it('emits a removal for the unrepresentable null member (documented loss)', () => {
    const patch = createMergePatch({ a: 1 }, { a: null });
    deepStrictEqual(patch, { a: null });
    // applying deletes the member instead of setting it to null
    deepStrictEqual(applyMergePatch({ a: 1 }, patch), {});
  });
});

//#endregion

//#region change tracking

describe('compileJSONPatch changes option', () => {
  it('reports precise pointers for object writes and array replaces', () => {
    const apply = compileJSONPatch([
      { op: 'replace', path: '/user/name', value: 'Bob' },
      { op: 'add', path: '/user/role', value: 'admin' },
      { op: 'replace', path: '/tags/1', value: 'y' },
      { op: 'remove', path: '/user/tmp' },
    ], { changes: true });
    const { doc, changes } = apply({
      user: { name: 'Al', tmp: 1 }, tags: ['a', 'b'],
    });
    deepStrictEqual(changes, ['/user/name', '/user/role', '/tags/1', '/user/tmp']);
    deepStrictEqual(doc, { user: { name: 'Bob', role: 'admin' }, tags: ['a', 'y'] });
  });

  it('reports the array append location precisely, - resolved', () => {
    const { changes } = applyJSONPatch({ tags: ['a'] }, [
      { op: 'add', path: '/tags/-', value: 'b' },
      { op: 'add', path: '/tags/2', value: 'c' },
    ], { changes: true });
    deepStrictEqual(changes, ['/tags/1', '/tags/2']);
  });

  it('reports the parent array for shifting inserts and removes', () => {
    const { changes } = applyJSONPatch({ tags: ['a', 'b', 'c'] }, [
      { op: 'add', path: '/tags/0', value: 'x' },
      { op: 'remove', path: '/tags/2' },
    ], { changes: true });
    deepStrictEqual(changes, ['/tags', '/tags']);
  });

  it('reports both sides of a move', () => {
    const { changes } = applyJSONPatch({ a: { v: 1 }, b: {} }, [
      { op: 'move', from: '/a/v', path: '/b/v' },
    ], { changes: true });
    deepStrictEqual(changes, ['/a/v', '/b/v']);
  });

  it('reports the empty pointer for root writes', () => {
    const { changes } = applyJSONPatch({ a: 1 }, [
      { op: 'replace', path: '', value: { b: 2 } },
    ], { changes: true });
    deepStrictEqual(changes, ['']);
  });

  it('reports nothing for test operations', () => {
    const { doc, changes } = applyJSONPatch({ a: 1 }, [
      { op: 'test', path: '/a', value: 1 },
    ], { changes: true });
    deepStrictEqual(changes, []);
    deepStrictEqual(doc, { a: 1 });
  });

  it('keeps copy-on-write semantics: input untouched, siblings shared', () => {
    const doc = { a: { deep: [1] }, b: { v: 1 } };
    const apply = compileJSONPatch(
      [{ op: 'replace', path: '/b/v', value: 2 }], { changes: true });
    const result = apply(doc);
    strictEqual(doc.b.v, 1);
    strictEqual(result.doc.a, doc.a, 'untouched sibling shared');
    notStrictEqual(result.doc.b, doc.b);
    deepStrictEqual(result.changes, ['/b/v']);
  });

  it('composes with mutate mode', () => {
    const doc = { a: 1 };
    const { doc: out, changes } = applyJSONPatch(doc,
      [{ op: 'replace', path: '/a', value: 2 }],
      { changes: true, mutate: true });
    strictEqual(out, doc, 'mutated in place');
    strictEqual(doc.a, 2);
    deepStrictEqual(changes, ['/a']);
  });

  it('returns the plain document when the option is off', () => {
    const result = applyJSONPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 2 }]);
    deepStrictEqual(result, { a: 2 });
  });

  it('escaped member names stay encoded in reported pointers', () => {
    const { changes } = applyJSONPatch({ 'a/b': { 'm~n': 1 } }, [
      { op: 'replace', path: '/a~1b/m~0n', value: 2 },
    ], { changes: true });
    deepStrictEqual(changes, ['/a~1b/m~0n']);
  });
});

//#endregion

//#region pointer encode helpers

describe('encodeJSONPointerSegment / formatJSONPointer', () => {
  it('encodes RFC 6901 escapes', () => {
    strictEqual(encodeJSONPointerSegment('plain'), 'plain');
    strictEqual(encodeJSONPointerSegment('a/b'), 'a~1b');
    strictEqual(encodeJSONPointerSegment('m~n'), 'm~0n');
    strictEqual(encodeJSONPointerSegment('~/'), '~0~1');
    strictEqual(encodeJSONPointerSegment(0), '0');
  });

  it('formats segments as a pointer, inverse of the parser', () => {
    strictEqual(formatJSONPointer([]), '');
    strictEqual(formatJSONPointer(['a/b', 0, '']), '/a~1b/0/');
    strictEqual(formatJSONPointer(['m~n']), '/m~0n');
  });
});

//#endregion
