//@ts-check
/**
 * @file The normalizer holds the validator's bounds, with the validator's
 * codes, so a schema or an instance nested past the host's call stack is
 * refused coded rather than with an uncoded `RangeError`: a subschema
 * nested past 128 levels is refused when the normalizer compiles
 * (`JK0017`); a call that nests schema references past 256 levels is
 * refused where it crosses them (`JK2001`), each reference weighing the
 * levels it nests per turn, as the validator weighs them; a loop every
 * call runs into without reading anything below the value is refused when
 * it compiles (`JK0001`). A `default` nested past the host stack is copied
 * at any depth. Every schema and call within the bounds answers as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer, unfilledDefaults } from '@jarenjs/validate/normalize';
import { indexSchemaResources } from '@jarenjs/validate/references';

const ORIGIN = 'https://github.com/jklarenbeek/jarenjs';
const CAUSE = ' (an instance nested this deep, or a loop of references that never reads it)';
/** @param {number} n @returns {any} `n` arrays nested around `0` */
const nestedArrays = (n) => { let v = /** @type {any} */ (0); for (let i = 0; i < n; i++) v = [v]; return v; };
/** @param {number} n @returns {any} `n` objects nested around `0` under `a` */
const nestedObjects = (n) => { let v = /** @type {any} */ (0); for (let i = 0; i < n; i++) v = { a: v }; return v; };
/** `n` levels of `keyword` around `leaf`. @param {string} keyword @param {number} n @param {any} [leaf] @returns {any} */
const chain = (keyword, n, leaf = {}) => {
  let s = leaf;
  for (let i = 0; i < n; i++) s = keyword === 'allOf' ? { allOf: [s] } : keyword === 'items' ? { items: s } : { properties: { a: s } };
  return s;
};
/** The step a chain adds to the pointer of its next level. @param {string} keyword */
const STEP = (keyword) => ({ allOf: '/allOf/0', items: '/items', properties: '/properties/a' })[keyword];
const ALL = { useDefaults: true, coerceTypes: true, removeAdditional: /** @type {'all'} */ ('all'), trimStrings: true, coerceJsonText: true };
/** @param {() => any} f @returns {any} the answer, or the code thrown */
const outcome = (f) => {
  try { return f(); }
  catch (e) { return e instanceof RangeError ? 'RangeError' : /** @type {any} */ (e).code; }
};

describe('the normalizer refuses a schema nested past the validator\'s depth bound', () => {
  it('compiles 128 nested subschemas and refuses the next one with JK0017 where the validator does', () => {
    for (const keyword of ['properties', 'items', 'allOf']) {
      for (const options of [{}, ALL]) assert.equal(typeof compileNormalizer(chain(keyword, 127), options), 'function');
      const docPath = `${ORIGIN}#${STEP(keyword).repeat(128)}`;
      assert.throws(() => compileNormalizer(chain(keyword, 128)), {
        name: 'SchemaCompileError', code: 'JK0017', docPath,
        message: 'JK0017: the schema nests subschemas more than 128 levels deep, deeper than a small host call stack compiles '
          + `and normalizes; raise maxSchemaDepth to compile it at ${docPath}`,
      });
      assert.throws(() => new JarenValidator().compile(chain(keyword, 128)), { code: 'JK0017', docPath });
    }
  });

  it('refuses a schema nested 20000 levels under every option, dialects included, and unfilledDefaults alike', () => {
    const dialects = new JarenValidator();
    for (const keyword of ['properties', 'items', 'allOf']) {
      for (const options of [{}, { useDefaults: true }, { dialects }, { ...ALL, dialects }])
        assert.throws(() => compileNormalizer(chain(keyword, 20000, { type: 'string', default: 'x' }), options), { code: 'JK0017' });
      assert.throws(() => unfilledDefaults(chain(keyword, 20000, { default: 'x' }), { useDefaults: true }), { code: 'JK0017' });
    }
  });

  it('counts a reference\'s target from the top, as the validator does', () => {
    const path = (/** @type {number} */ n, /** @type {any} */ leaf) => { let v = leaf; for (let i = 0; i < n; i++) v = { p: v }; return v; };
    const levels = (/** @type {number} */ n, /** @type {any} */ leaf) => { let v = leaf; for (let i = 0; i < n; i++) v = { properties: { p: v } }; return v; };
    const schema = () => ({ properties: { p: levels(100, { $ref: '#/$defs/d' }) }, $defs: { d: levels(100, { type: 'integer' }) } });
    assert.deepEqual(compileNormalizer(schema(), { coerceTypes: true })(path(201, '5')), path(201, 5));
    assert.deepEqual([path(201, 5), path(201, '5')].map((d) => new JarenValidator().compile(schema())(d)), [true, false]);
  });

  it('counts nesting, not the subschemas beside it', () => {
    const wide = { type: 'object', properties: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`m${i}`, { type: 'integer' }])) };
    const normalize = compileNormalizer(wide, { coerceTypes: true });
    assert.deepEqual(normalize({ m0: '1', m299: '2' }), { m0: 1, m299: 2 });
    const loop = compileNormalizer({ properties: { ...wide.properties, next: { $ref: '#' } } });
    const next = (/** @type {number} */ n) => { let v = /** @type {any} */ ({}); for (let i = 0; i < n; i++) v = { next: v }; return v; };
    assert.deepEqual(loop(next(256)), next(256));
    assert.equal(outcome(() => loop(next(257))), 'JK2001');
  });

  it('indexes a document nested 20000 levels in document order, the first of a repeated name winning', () => {
    const document = { $defs: { a: chain('properties', 20000, { $anchor: 'x' }), b: { $anchor: 'x' } } };
    const index = indexSchemaResources(document);
    let leaf = /** @type {any} */ (document.$defs.a);
    for (let i = 0; i < 20000; i++) leaf = leaf.properties.a;
    assert.equal(index.resources.get(ORIGIN)?.names.get('x'), leaf);
    assert.equal(index.places.get(leaf)?.pointer, `#/%24defs/a${'/properties/a'.repeat(20000)}`);
    assert.equal(index.places.size, 20003);
    assert.deepEqual([...index.places.keys()].slice(0, 3), [document, document.$defs.a, document.$defs.a.properties.a]);
  });

  it('compiles a deep subschema it never compiles, as the validator does', () => {
    const schema = () => ({ type: 'object', properties: { n: { type: 'integer' } }, $defs: { deep: chain('properties', 20000) } });
    const dialects = new JarenValidator();
    for (const options of [{ coerceTypes: true }, { coerceTypes: true, dialects }])
      assert.deepEqual(compileNormalizer(schema(), options)({ n: '5' }), { n: 5 });
    assert.equal(new JarenValidator().compile(schema())({ n: 5 }), true);
  });
});

describe('the normalizer bounds the references a call nests as the validator does', () => {
  it('answers 256 levels and refuses 257, at each step of 8 from 32 to 16384, under any option', () => {
    for (const options of [{}, ALL]) {
      const members = compileNormalizer({ properties: { a: { $ref: '#' } } }, options);
      const items = compileNormalizer({ items: { $ref: '#' } }, options);
      for (const n of [32, 256]) {
        assert.deepEqual(members(nestedObjects(n)), nestedObjects(n));
        assert.deepEqual(items(nestedArrays(n)), nestedArrays(n));
      }
      for (const n of [257, 2048, 16384]) {
        assert.equal(outcome(() => members(nestedObjects(n))), 'JK2001');
        assert.equal(outcome(() => items(nestedArrays(n))), 'JK2001');
      }
    }
    const validate = new JarenValidator().compile({ properties: { a: { $ref: '#' } } });
    assert.deepEqual([256, 257].map((n) => outcome(() => validate(nestedObjects(n)))), [true, 'JK2001']);
  });

  it('names the normalization and the reference, and is restored after a refusal', () => {
    const members = compileNormalizer({ properties: { a: { $ref: '#' } } });
    for (let call = 0; call < 3; call++) {
      assert.throws(() => members(nestedObjects(100000)), {
        name: 'SchemaRuntimeError', code: 'JK2001',
        message: `JK2001: normalization nests more than 256 schema references at ${ORIGIN}#/properties/a${CAUSE}`,
      });
      assert.deepEqual(members(nestedObjects(256)), nestedObjects(256));
    }
  });

  it('weighs a reference K levels below its target by K, where the validator refuses', () => {
    const spaced = (/** @type {number} */ k) => chain('items', k, { $ref: '#' });
    for (const [k, last] of [[2, 257], [10, 259], [100, 299]]) {
      const normalize = compileNormalizer(spaced(k));
      const validate = new JarenValidator().compile(spaced(k));
      assert.deepEqual(normalize(nestedArrays(last)), nestedArrays(last));
      assert.equal(outcome(() => normalize(nestedArrays(last + 1))), 'JK2001');
      assert.deepEqual([last, last + 1].map((n) => outcome(() => validate(nestedArrays(n)))), [true, 'JK2001']);
    }
    assert.throws(() => compileNormalizer(spaced(2))(nestedArrays(100000)), {
      message: `JK2001: normalization nests schema references more than 256 levels deep at ${ORIGIN}#/items/items${CAUSE}`,
    });
  });

  it('weighs a loop through two definitions by the levels it nests per turn', () => {
    const ring = compileNormalizer({ $ref: '#/$defs/a', $defs: { a: { items: { $ref: '#/$defs/b' } }, b: { items: { $ref: '#/$defs/a' } } } });
    assert.deepEqual(ring(nestedArrays(257)), nestedArrays(257));
    assert.equal(outcome(() => ring(nestedArrays(258))), 'JK2001');
    const members = compileNormalizer({ $ref: '#/$defs/a', $defs: { a: chain('properties', 10, { $ref: '#/$defs/b' }), b: chain('properties', 10, { $ref: '#/$defs/a' }) } });
    assert.equal(outcome(() => members(nestedObjects(100000))), 'JK2001');
  });

  it('bounds a loop through a member a schema object holds itself', () => {
    const node = /** @type {any} */ ({ type: 'object', properties: {} });
    node.properties.next = node;
    const normalize = compileNormalizer(node);
    const next = (/** @type {number} */ n) => { let v = /** @type {any} */ ({}); for (let i = 0; i < n; i++) v = { next: v }; return v; };
    assert.deepEqual(normalize(next(256)), next(256));
    assert.equal(outcome(() => normalize(next(257))), 'JK2001');
  });

  it('copies a default nested past the host stack, and refuses one it nests past the bound only where a call fills it', () => {
    const deep = nestedArrays(100000);
    const filled = compileNormalizer({ properties: { d: { default: deep } } }, { useDefaults: true })({});
    assert.notEqual(filled.d, deep);
    let level = filled.d;
    for (let i = 0; i < 100000; i++) level = level[0];
    assert.equal(level, 0);
    const tree = (/** @type {number} */ n) => { let t = /** @type {any} */ ({}); for (let i = 0; i < n; i++) t = { c: t }; return t; };
    const holding = (/** @type {any} */ value) => compileNormalizer({ $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { t: { $ref: '#/$defs/tree', default: value } },
      $defs: { tree: { type: 'object', properties: { c: { $ref: '#/$defs/tree' } } } } }, { useDefaults: true });
    assert.deepEqual(holding(tree(200))({}), { t: tree(200) });
    const beyond = holding(tree(300));
    assert.equal(outcome(() => beyond({})), 'JK2001');
    assert.deepEqual(beyond({ t: { c: {} } }), { t: { c: {} } });
  });

  // The bounds exist so the refusal comes before the stack runs out: under a
  // stack half the default size, every call is refused, never overflowed.
  it('refuses before a half-size stack overflows', () => {
    const script = `
      import { compileNormalizer } from '@jarenjs/validate/normalize';
      let arrays = 0; for (let i = 0; i < 100000; i++) arrays = [arrays];
      let objects = 0; for (let i = 0; i < 100000; i++) objects = { a: objects };
      let tree = { children: [] }; for (let i = 0; i < 100000; i++) tree = { children: [tree] };
      let spaced = { $ref: '#' }; for (let i = 0; i < 100; i++) spaced = { items: spaced };
      let deep = { type: 'string' }; for (let i = 0; i < 127; i++) deep = { properties: { a: deep } };
      const out = [];
      for (const options of [{}, { useDefaults: true, coerceTypes: true, removeAdditional: 'all', trimStrings: true, coerceJsonText: true }]) {
        for (const [schema, data] of [[{ properties: { a: { $ref: '#', default: 1 } } }, objects], [{ items: { $ref: '#' } }, arrays],
          [spaced, arrays], [{ type: 'object', properties: { children: { type: 'array', items: { $ref: '#' } } } }, tree]]) {
          try { out.push(JSON.stringify(compileNormalizer(schema, options)(data)).length); }
          catch (e) { out.push(e instanceof RangeError ? 'RangeError' : e.code); }
        }
        out.push(typeof compileNormalizer(deep, options));
      }
      console.log(JSON.stringify(out));`;
    const run = spawnSync(process.execPath, ['--stack-size=500', '--input-type=module', '-e', script],
      { cwd: new URL('../..', import.meta.url), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), ['JK2001', 'JK2001', 'JK2001', 'JK2001', 'function', 'JK2001', 'JK2001', 'JK2001', 'JK2001', 'function']);
  });
});

describe('the normalizer refuses a loop every call runs into', () => {
  it('refuses it when it compiles, as the validator refuses it', () => {
    for (const schema of [{ allOf: [{ $ref: '#' }] }, { $id: 'http://loop.test/a', allOf: [{ $ref: '#' }] }]) {
      let message = '';
      try { new JarenValidator().compile(structuredClone(schema)); }
      catch (e) { message = /** @type {any} */ (e).message; }
      assert.throws(() => compileNormalizer(structuredClone(schema)), { name: 'SchemaCompileError', code: 'JK0001', message });
      assert.throws(() => unfilledDefaults(structuredClone(schema), { useDefaults: true }), { code: 'JK0001' });
    }
    assert.throws(() => compileNormalizer({ $id: 'http://loop.test/a', allOf: [{ $ref: '#' }] }), {
      message: 'JK0001: $ref cycle: http://loop.test/a# -> http://loop.test/a#/allOf/0 -> http://loop.test/a# never reads the instance',
    });
    for (const schema of [
      { type: 'string', $ref: '#/$defs/x', $defs: { x: { allOf: [{ $ref: '#' }] } } },
      { $schema: 'https://json-schema.org/draft/2020-12/schema', $ref: '#/$defs/x', type: 'object', $defs: { x: { $ref: '#' } } },
    ]) {
      assert.throws(() => new JarenValidator().compile(structuredClone(schema)), { code: 'JK0001' });
      for (const options of [{}, ALL]) assert.throws(() => compileNormalizer(structuredClone(schema), options), { code: 'JK0001' });
    }
    assert.throws(() => compileNormalizer({ $id: 'http://loop.test/r', $defs: { a: { allOf: [{ $ref: '#/$defs/b' }] }, b: { allOf: [{ $ref: '#/$defs/a' }] } }, $ref: '#/$defs/a' }), {
      message: 'JK0001: $ref cycle: http://loop.test/r#/%24defs/a -> http://loop.test/r#/%24defs/a/allOf/0 -> http://loop.test/r#/%24defs/b'
        + ' -> http://loop.test/r#/%24defs/b/allOf/0 -> http://loop.test/r#/%24defs/a never reads the instance',
    });
  });

  it('refuses one the validator leaves to the reference bound, every normalizer call of which ran out of stack', () => {
    // The validator reads `type` first and answers `false` for a number;
    // the normalizer applies every `allOf` branch to every value.
    for (const schema of [{ type: 'string', allOf: [{ $ref: '#' }] }, { allOf: [{ type: 'string' }, { $ref: '#' }] }]) {
      assert.throws(() => compileNormalizer(structuredClone(schema)), { code: 'JK0001' });
      assert.deepEqual(['s', 1].map((d) => outcome(() => new JarenValidator().compile(structuredClone(schema))(d))), ['JK2001', false]);
    }
  });

  it('normalizes as before a loop it never runs: through anyOf, oneOf, not or if', () => {
    for (const schema of [{ anyOf: [{ $ref: '#' }, { type: 'string' }] }, { oneOf: [{ $ref: '#' }, { type: 'string' }] },
      { not: { $ref: '#' } }, { if: { $ref: '#' }, then: {} }]) {
      assert.throws(() => new JarenValidator().compile(structuredClone(schema)), { code: 'JK0001' });
      assert.deepEqual(compileNormalizer(structuredClone(schema), ALL)({ a: ' 1 ' }), { a: ' 1 ' });
    }
  });

  it('reads an object reached twice, with no loop, as before', () => {
    const twice = { allOf: [{ $ref: '#/$defs/n' }, { $ref: '#/$defs/n' }], properties: { a: { $ref: '#/$defs/n' }, b: { $ref: '#/$defs/n' } },
      $defs: { n: { type: 'integer' } } };
    assert.equal(compileNormalizer(twice, { coerceTypes: true })('5'), 5);
    assert.deepEqual(compileNormalizer(twice, { coerceTypes: true })({ a: '1', b: '2' }), { a: 1, b: 2 });
  });

  it('refuses a loop reached through a member only where a call reaches it, as the validator does', () => {
    const schema = { properties: { p: { allOf: [{ $ref: '#/properties/p' }] } } };
    const normalize = compileNormalizer(schema);
    const validate = new JarenValidator().compile(schema);
    assert.deepEqual([normalize({}), normalize({ q: 1 })], [{}, { q: 1 }]);
    assert.equal(outcome(() => normalize({ p: 1 })), 'JK2001');
    assert.deepEqual([outcome(() => validate({})), outcome(() => validate({ p: 1 }))], [true, 'JK2001']);
  });
});

describe('the normalizer takes the validator\'s bounds as options', () => {
  /** A list `n` links long, each link's `n` a numeral. @param {number} n @param {(i: number) => unknown} at @returns {any} */
  const list = (n, at) => { let v = /** @type {any} */ ({ n: at(0) }); for (let i = 1; i <= n; i++) v = { n: at(i), next: v }; return v; };
  const listSchema = { properties: { next: { $ref: '#' }, n: { type: 'integer' } } };
  /** @param {number} n @param {any} leaf @returns {any} */
  const nest = (n, leaf) => { let v = leaf; for (let i = 0; i < n; i++) v = { a: v }; return v; };
  const holding = () => chain('properties', 200, { properties: { d: { type: 'integer', default: 2 }, c: { const: 1, default: 2 } } });

  it('normalizes a list 300 links long with maxReferenceDepth 512, which the default refuses', () => {
    assert.equal(outcome(() => compileNormalizer(listSchema, { coerceTypes: true })(list(300, String))), 'JK2001');
    const raised = compileNormalizer(listSchema, { coerceTypes: true, maxReferenceDepth: 512 });
    assert.deepEqual(raised(list(300, String)), list(300, (i) => i));
    assert.deepEqual(raised(list(512, String)), list(512, (i) => i));
    assert.equal(outcome(() => raised(list(513, String))), 'JK2001');
  });

  it('compiles a schema nested 200 levels with maxSchemaDepth 256, which the default refuses', () => {
    assert.throws(() => compileNormalizer(holding(), { useDefaults: true }), {
      code: 'JK0017', message: /^JK0017: the schema nests subschemas more than 128 levels deep, deeper than a small host call stack compiles and normalizes; raise maxSchemaDepth to compile it at /,
    });
    const raised = compileNormalizer(holding(), { useDefaults: true, coerceTypes: true, maxSchemaDepth: 256 });
    assert.deepEqual(raised(nest(200, { d: '5' })), nest(200, { d: 5 }));
    assert.deepEqual(raised(nest(200, {})), nest(200, { d: 2 }));
    assert.throws(() => compileNormalizer(chain('properties', 256), { maxSchemaDepth: 256 }), { message: /more than 256 levels deep/ });
  });

  it('gives unfilledDefaults the same bounds', () => {
    assert.throws(() => unfilledDefaults(holding(), { useDefaults: true }), { code: 'JK0017' });
    const unfilled = unfilledDefaults(holding(), { useDefaults: true, maxSchemaDepth: 256 });
    assert.deepEqual([...unfilled].map(([object, keys]) => [Object.keys(object.properties), [...keys]]), [[['d', 'c'], ['c']]]);
  });

  it('fills a default copied through 300 references with maxReferenceDepth 512, read by its checks at that bound', () => {
    const tree = (/** @type {number} */ n, /** @type {unknown} */ leaf) => { let t = /** @type {any} */ ({ n: leaf }); for (let i = 0; i < n; i++) t = { n: 1, next: t }; return t; };
    const defaulted = (/** @type {any} */ value, /** @type {object} */ options) => compileNormalizer({ $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { t: { $ref: '#/$defs/node', default: value } },
      $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' }, n: { type: 'integer' } } } } }, { useDefaults: true, ...options });
    assert.equal(outcome(() => defaulted(tree(300, 1), {})({})), 'JK2001');
    assert.deepEqual(defaulted(tree(300, 1), { maxReferenceDepth: 512 })({}), { t: tree(300, 1) });
    // the validator refuses the copy at its place, and with the bound its check reads that far
    assert.deepEqual(defaulted(tree(300, 'x'), { maxReferenceDepth: 512 })({}), {});
    assert.equal(new JarenValidator({ maxReferenceDepth: 512 }).compile({ $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object', properties: { next: { $ref: '#' }, n: { type: 'integer' } } })(tree(300, 'x')), false);
  });

  it('refuses a bound that is not a positive safe integer as the validator refuses it, and reads null as the default', () => {
    for (const name of ['maxReferenceDepth', 'maxSchemaDepth']) {
      for (const bad of [0, -1, 1.5, '5', NaN, Infinity, 2 ** 53, true]) {
        let message = '';
        try { new JarenValidator({ [name]: bad }).compile({}); }
        catch (e) { message = /** @type {any} */ (e).message; }
        assert.equal(message, `JK0002: ${name} must be a positive safe integer, got ${typeof bad === 'string' ? '"5"' : String(bad)}`);
        assert.throws(() => compileNormalizer({}, { [name]: bad }), { name: 'SchemaCompileError', code: 'JK0002', message });
        assert.throws(() => unfilledDefaults({}, { useDefaults: true, [name]: bad }), { code: 'JK0002', message });
      }
    }
    for (const unset of [null, undefined]) {
      const members = compileNormalizer({ properties: { a: { $ref: '#' } } }, { maxReferenceDepth: unset, maxSchemaDepth: unset });
      assert.deepEqual(members(nestedObjects(256)), nestedObjects(256));
      assert.equal(outcome(() => members(nestedObjects(257))), 'JK2001');
    }
  });

  // Past the default the host's stack decides again, so this half runs in a
  // child process with a known, large stack.
  it('restores the answer past the default on a large enough stack', () => {
    const script = `
      import { compileNormalizer } from '@jarenjs/validate/normalize';
      let schema = { type: 'integer' }; for (let i = 0; i < 1000; i++) schema = { properties: { a: schema } };
      let data = '5'; for (let i = 0; i < 1000; i++) data = { a: data };
      let list = { n: '0' }; for (let i = 1; i <= 1500; i++) list = { n: String(i), next: list };
      const out = [];
      const attempt = (f) => { try { out.push(f()); } catch (e) { out.push(e.code); } };
      attempt(() => { let v = compileNormalizer(schema, { coerceTypes: true, maxSchemaDepth: 2000 })(data); while (typeof v === 'object') v = v.a; return v; });
      attempt(() => compileNormalizer(schema, { coerceTypes: true })(data));
      attempt(() => compileNormalizer({ properties: { next: { $ref: '#' }, n: { type: 'integer' } } }, { coerceTypes: true, maxReferenceDepth: 2000 })(list).n);
      attempt(() => compileNormalizer({ properties: { next: { $ref: '#' }, n: { type: 'integer' } } }, { coerceTypes: true })(list).n);
      console.log(JSON.stringify(out));`;
    const run = spawnSync(process.execPath, ['--stack-size=4000', '--input-type=module', '-e', script],
      { cwd: new URL('../..', import.meta.url), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [5, 'JK0017', 1500, 'JK2001']);
  });
});
