//@ts-check
/**
 * @file The reference depth bound counts the levels of schema between the
 * references a validation enters, not only how many it enters: a
 * reference that sits K levels below the schema it enters (a schema
 * enclosing it) nests K levels on every entry and weighs K, so `JK2001`
 * fires after 256 levels of nesting however far apart the references sit,
 * where it fired after 256 × K levels (past the host's stack for a large
 * K). A reference one level below its target weighs one, so the direct
 * shapes keep their threshold and their message.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JarenValidator } from '@jarenjs/validate';

/** @param {number} n @returns {any} `n` arrays nested around `0` */
const nestedArrays = (n) => { let v = /** @type {any} */ (0); for (let i = 0; i < n; i++) v = [v]; return v; };
/** @param {number} n @returns {any} `n` objects nested around `0` under `a` */
const nestedObjects = (n) => { let v = /** @type {any} */ (0); for (let i = 0; i < n; i++) v = { a: v }; return v; };
/** `inner` under `k` levels of `items`. @param {any} inner @param {number} k @returns {any} */
const spaced = (inner, k) => { let s = inner; for (let i = 0; i < k; i++) s = { items: s }; return s; };
/** @param {any} result */
const answer = (result) => (typeof result === 'object' ? result.valid : result);
const TYPE = { type: ['array', 'integer'] };
const DRAFTS = [undefined, 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema'];
const depthRefusal = { name: 'SchemaRuntimeError', code: 'JK2001' };
const CAUSE = ' (an instance nested this deep, or a loop of references that never reads it)';

/**
 * What a validator answers for each depth: `true`/`false`, or the code it throws.
 * @param {(data: any) => any} validate @param {(n: number) => any} nest @param {number[]} depths
 */
const answers = (validate, nest, depths) => depths.map((n) => {
  try { return answer(validate(nest(n))); }
  catch (e) { return /** @type {any} */ (e).code; }
});

describe('the direct shapes keep their threshold', () => {
  it('answers 256 levels and refuses 257, at each step of 8 from 32 to 16384, in every mode and draft', () => {
    for (const collectErrors of [false, true]) {
      for (const $schema of DRAFTS) {
        const draft = $schema === undefined ? {} : { $schema };
        const items = new JarenValidator({ collectErrors }).compile({ ...draft, ...TYPE, items: { $ref: '#' } });
        assert.deepEqual(answers(items, nestedArrays, [32, 256, 257, 2048, 16384]), [true, true, 'JK2001', 'JK2001', 'JK2001']);
        const members = new JarenValidator({ collectErrors }).compile({ ...draft, type: ['object', 'integer'], properties: { a: { $ref: '#' } } });
        assert.deepEqual(answers(members, nestedObjects, [32, 256, 257, 2048, 16384]), [true, true, 'JK2001', 'JK2001', 'JK2001']);
      }
    }
  });

  it('names the references, as it did', () => {
    const items = new JarenValidator().compile({ $id: 'http://depth.test/items', ...TYPE, items: { $ref: '#' } });
    assert.throws(() => items(nestedArrays(257)), {
      ...depthRefusal, message: `JK2001: validation nests more than 256 schema references at http://depth.test/items#/items${CAUSE}`,
    });
  });
});

describe('a reference K levels below the schema it enters weighs K levels', () => {
  it('refuses after 256 levels however far apart the references sit', () => {
    for (const collectErrors of [false, true]) {
      const validate = (/** @type {number} */ k) => new JarenValidator({ collectErrors }).compile({ ...TYPE, ...spaced({ $ref: '#' }, k) });
      assert.deepEqual(answers(validate(2), nestedArrays, [257, 258]), [true, 'JK2001']);
      assert.deepEqual(answers(validate(10), nestedArrays, [259, 260]), [true, 'JK2001']);
      assert.deepEqual(answers(validate(100), nestedArrays, [299, 300, 100000]), [true, 'JK2001', 'JK2001']);
    }
  });

  it('names the levels rather than the references', () => {
    const validate = new JarenValidator().compile({ $id: 'http://depth.test/k2', ...TYPE, ...spaced({ $ref: '#' }, 2) });
    assert.throws(() => validate(nestedArrays(258)), {
      ...depthRefusal, message: `JK2001: validation nests schema references more than 256 levels deep at http://depth.test/k2#/items/items${CAUSE}`,
    });
  });

  it('weighs a $ref into a definition, a $recursiveRef and a $dynamicRef alike', () => {
    const D19 = 'https://json-schema.org/draft/2019-09/schema';
    const D20 = 'https://json-schema.org/draft/2020-12/schema';
    for (const collectErrors of [false, true]) {
      const compile = (/** @type {any} */ schema) => new JarenValidator({ collectErrors }).compile(schema);
      const definition = (/** @type {number} */ k) => compile({ $ref: '#/$defs/a', $defs: { a: { ...TYPE, ...spaced({ $ref: '#/$defs/a' }, k) } } });
      assert.deepEqual(answers(definition(1), nestedArrays, [255, 256]), [true, 'JK2001']);
      assert.deepEqual(answers(definition(10), nestedArrays, [259, 260]), [true, 'JK2001']);
      const recursive = (/** @type {number} */ k) => compile({ $schema: D19, $recursiveAnchor: true, ...TYPE, ...spaced({ $recursiveRef: '#' }, k) });
      assert.deepEqual(answers(recursive(1), nestedArrays, [256, 257]), [true, 'JK2001']);
      assert.deepEqual(answers(recursive(10), nestedArrays, [259, 260, 100000]), [true, 'JK2001', 'JK2001']);
      const dynamic = (/** @type {number} */ k) => compile({ $schema: D20, $dynamicAnchor: 'n', ...TYPE, ...spaced({ $dynamicRef: '#n' }, k) });
      assert.deepEqual(answers(dynamic(1), nestedArrays, [256, 257]), [true, 'JK2001']);
      assert.deepEqual(answers(dynamic(10), nestedArrays, [259, 260, 100000]), [true, 'JK2001', 'JK2001']);
    }
  });

  it('counts the levels allOf nests and a loop through two definitions nests', () => {
    let nested = /** @type {any} */ ({ ...TYPE, items: { $ref: '#' } });
    for (let i = 0; i < 9; i++) nested = { allOf: [nested] };
    assert.deepEqual(answers(new JarenValidator().compile(nested), nestedArrays, [25, 26]), [true, 'JK2001']);
    const ring = new JarenValidator().compile({ $ref: '#/$defs/a', $defs: { a: { ...TYPE, items: { $ref: '#/$defs/b' } }, b: { ...TYPE, items: { $ref: '#/$defs/a' } } } });
    assert.deepEqual(answers(ring, nestedArrays, [255, 256]), [true, 'JK2001']);
  });

  it('names the levels where a reference of one level crosses the bound after deeper ones', () => {
    const validate = new JarenValidator().compile({ type: ['array', 'object'], items: { items: { $ref: '#' } },
      properties: { p: { $ref: '#/$defs/one' } }, $defs: { one: { properties: { p: { $ref: '#/$defs/one' } } } } });
    let data = /** @type {any} */ (0);
    for (let i = 0; i < 10; i++) data = { p: data };
    for (let i = 0; i < 254; i++) data = [data];
    assert.throws(() => validate(data), {
      ...depthRefusal,
      message: `JK2001: validation nests schema references more than 256 levels deep at https://github.com/jklarenbeek/jarenjs#/$defs/one/properties/p${CAUSE}`,
    });
  });

  it('moves with maxReferenceDepth', () => {
    const at = (/** @type {number} */ maxReferenceDepth) => new JarenValidator({ maxReferenceDepth }).compile({ ...TYPE, ...spaced({ $ref: '#' }, 10) });
    assert.deepEqual(answers(at(50), nestedArrays, [59, 60]), [true, 'JK2001']);
    assert.deepEqual(answers(at(1000), nestedArrays, [1009, 1010]), [true, 'JK2001']);
  });

  // The bound exists so the refusal comes before the stack runs out: under a
  // stack half the default size, every shape is refused, never overflowed.
  it('refuses before a half-size stack overflows', () => {
    const script = `
      import { JarenValidator } from '@jarenjs/validate';
      let deep = 0; for (let i = 0; i < 100000; i++) deep = [deep];
      let tree = { children: [] }; for (let i = 0; i < 100000; i++) tree = { children: [tree] };
      const spaced = (inner, k) => { let s = inner; for (let i = 0; i < k; i++) s = { items: s }; return s; };
      let nested = { items: { $ref: '#' } }; for (let i = 0; i < 99; i++) nested = { allOf: [nested] };
      const out = [];
      for (const collectErrors of [false, true]) {
        const shapes = [...[1, 2, 10, 100, 127].map((k) => [spaced({ $ref: '#' }, k), deep]),
          [{ type: 'object', properties: { children: { type: 'array', items: { $ref: '#' } } } }, tree],
          [{ $schema: 'https://json-schema.org/draft/2020-12/schema', $dynamicAnchor: 'n', ...spaced({ $dynamicRef: '#n' }, 100) }, deep],
          [nested, deep]];
        for (const [schema, data] of shapes) {
          try { out.push(new JarenValidator({ collectErrors }).compile(schema)(data)); }
          catch (e) { out.push(e instanceof RangeError ? 'RangeError' : e.code); }
        }
      }
      console.log(JSON.stringify(out));`;
    const run = spawnSync(process.execPath, ['--stack-size=500', '--input-type=module', '-e', script],
      { cwd: new URL('../..', import.meta.url), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), Array(16).fill('JK2001'));
  });
});
