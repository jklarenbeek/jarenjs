//@ts-check
/**
 * @file A normalizer's compile builds a chain of references one link inside
 * the next, so a chain longer than the host's call stack holds threw the
 * host's uncoded `RangeError` from `compileNormalizer` and
 * `unfilledDefaults`. It is refused `SchemaCompileError` `JK0017`, at the
 * schema object being built when the stack gave out, the host's error its
 * `cause` — recognised as the host's stack refusal, never by a bound on the
 * chain's length, so every chain that compiled still compiles. A call
 * nesting references past the stack under a raised `maxReferenceDepth` is
 * refused `JK2001`, as validation is, and the next call answers. Each case
 * runs in a child process with a fixed small stack, and asks nothing of
 * where that stack gives out.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compileNormalizer } from '@jarenjs/validate/normalize';

/** Run a module script in a child with a 500 kB stack, and read the JSON it prints. @param {string} body @returns {any} */
const inChild = (body) => {
  const script = `
    import { compileNormalizer, unfilledDefaults } from '@jarenjs/validate/normalize';
    const chainOf = (n, leaf) => {
      const $defs = {};
      for (let i = 0; i < n; i++) $defs['d' + i] = { properties: { x: i + 1 < n ? { $ref: '#/$defs/d' + (i + 1) } : leaf } };
      return { $ref: '#/$defs/d0', $defs };
    };
    const nested = (n) => { let s = { type: 'integer' }; for (let i = 0; i < n; i++) s = { properties: { a: s } }; return s; };
    const deep = (n) => { let v = '1'; for (let i = 0; i < n; i++) v = { a: v }; return v; };
    const outcome = (f) => {
      try { const answer = f(); return typeof answer === 'function' ? 'function' : answer; }
      catch (e) {
        return { name: e.name, code: e.code ?? null, cause: e.cause?.constructor?.name ?? null, docPath: e.docPath ?? null,
          stack: /call stack/.test(e.message), repair: /larger stack/.test(e.message) };
      }
    };
    ${body}`;
  const run = spawnSync(process.execPath, ['--stack-size=500', '--input-type=module', '-e', script],
    { cwd: new URL('../..', import.meta.url), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

describe('a compile past the host\'s call stack is refused JK0017', () => {
  it('a chain of 20000 references, for every option set, and unfilledDefaults alike (they threw an uncoded RangeError)', () => {
    const out = inChild(`
      const chain = chainOf(20000, { type: 'integer', default: 1 });
      console.log(JSON.stringify([outcome(() => compileNormalizer(chain)), outcome(() => compileNormalizer(chain, { coerceTypes: true })),
        outcome(() => compileNormalizer(chain, { useDefaults: true, coerceTypes: true, removeAdditional: 'all', trimStrings: true, coerceJsonText: true })),
        outcome(() => unfilledDefaults(chain, { useDefaults: true }))]));`);
    for (const answer of out) {
      assert.equal(answer.name, 'SchemaCompileError');
      assert.equal(answer.code, 'JK0017');
      assert.equal(answer.cause, 'RangeError');
      assert.equal(answer.stack, true);
      assert.equal(answer.repair, true);
      assert.match(answer.docPath, /^#\/%24defs\/d[0-9]+/);
    }
  });

  it('a schema nested past the stack under a raised maxSchemaDepth', () => {
    const [answer] = inChild(`console.log(JSON.stringify([outcome(() => compileNormalizer(nested(20000), { coerceTypes: true, maxSchemaDepth: 1e9 }))]));`);
    assert.deepEqual([answer.name, answer.code, answer.cause], ['SchemaCompileError', 'JK0017', 'RangeError']);
    assert.match(answer.docPath, /#\/properties\/a\/properties\/a/);
  });

  it('refuses nothing the stack holds: a chain of 100 compiles and normalizes, with and without defaults', () => {
    const out = inChild(`
      const n = compileNormalizer(chainOf(100, { type: 'integer', default: 1 }), { coerceTypes: true, useDefaults: true });
      let v = n(deep(99)); let level = 0; while (typeof v === 'object') { v = v.a ?? v.x; level++; }
      console.log(JSON.stringify([typeof n, outcome(() => compileNormalizer(chainOf(100, { type: 'integer' }))), outcome(() => unfilledDefaults(chainOf(100, { default: 1 }), { useDefaults: true }).size)]));`);
    assert.deepEqual(out, ['function', 'function', 0]);
  });

  it('a refused compile leaves the next compile as it would have been', () => {
    const out = inChild(`
      const first = outcome(() => compileNormalizer(chainOf(20000, { type: 'integer' }), { coerceTypes: true }));
      const n = compileNormalizer({ properties: { a: { type: 'integer', default: '7' }, b: { type: 'integer' } } }, { coerceTypes: true, useDefaults: true });
      console.log(JSON.stringify([first.code, n({ b: '2' })]));`);
    assert.deepEqual(out, ['JK0017', { b: 2, a: 7 }]);
  });
});

describe('a call nesting references past the host\'s call stack is refused JK2001', () => {
  it('under a raised maxReferenceDepth, with and without defaults, and the next call answers', () => {
    const out = inChild(`
      const plain = compileNormalizer({ properties: { a: { $ref: '#' } } }, { coerceTypes: true, maxReferenceDepth: 1e9 });
      const filling = compileNormalizer({ properties: { a: { $ref: '#', default: {} }, b: { type: 'integer', default: 1 } } }, { useDefaults: true, maxReferenceDepth: 1e9 });
      console.log(JSON.stringify([outcome(() => plain(deep(100000))), outcome(() => plain({ a: { a: 'x' } })),
        outcome(() => filling(deep(100000))), outcome(() => filling({ a: {} }))]));`);
    assert.deepEqual([out[0].name, out[0].code, out[0].cause], ['SchemaRuntimeError', 'JK2001', 'RangeError']);
    assert.deepEqual(out[1], { a: { a: 'x' } });
    assert.deepEqual([out[2].name, out[2].code, out[2].cause], ['SchemaRuntimeError', 'JK2001', 'RangeError']);
    assert.deepEqual(out[3], { a: { b: 1 }, b: 1 });
  });
});

describe('within the stack, nothing changes', () => {
  it('compiles and normalizes a chain of 200 references on this process\'s stack', () => {
    const $defs = /** @type {Record<string, any>} */ ({});
    for (let i = 0; i < 200; i++) $defs[`d${i}`] = { properties: { x: i + 1 < 200 ? { $ref: `#/$defs/d${i + 1}` } : { type: 'integer' } } };
    let data = /** @type {any} */ ('5');
    for (let i = 0; i < 200; i++) data = { x: data };
    let out = compileNormalizer({ $ref: '#/$defs/d0', $defs }, { coerceTypes: true })(data);
    for (let i = 0; i < 200; i++) out = out.x;
    assert.equal(out, 5);
  });
});
