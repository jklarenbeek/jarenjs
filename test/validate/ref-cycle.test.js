//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { resolveRefSchemaDeep, TraverseOptions } from '../../packages/validate/src/traverse.js';

describe('a schema that references itself', () => {
  /** @param {any} schema @param {any} [options] */
  const compile = (schema, options) => new JarenValidator(options).compile(schema);
  const message = /^JK0001: \$ref cycle: \S+# refers to itself and never reads the instance$/;

  it('is refused when the schema is compiled, not when it validates', () => {
    for (const options of [undefined, { collectErrors: true }, { draftVersion: 2020 }, { draftVersion: 7 }]) {
      assert.throws(() => compile({ $ref: '#' }, options), { name: 'SchemaCompileError', code: 'JK0001', message });
    }
  });

  it('is refused with siblings and where it is nested', () => {
    assert.throws(() => compile({ $ref: '#', type: 'object' }, { draftVersion: 2020 }), { message });
    assert.throws(() => compile({ properties: { a: { $ref: '#/properties/a' } } }), {
      message: /^JK0001: \$ref cycle: \S+#\/properties\/a refers to itself and never reads the instance$/,
    });
  });

  it('is refused when the loop reaches its target through other references', () => {
    const loop = /^JK0001: \$ref cycle: \S+#\/\$defs\/a refers to itself and never reads the instance$/;
    for (const options of [undefined, { collectErrors: true }, { draftVersion: 2020 }, { draftVersion: 7 }]) {
      assert.throws(() => compile({ $defs: { a: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' }, options), { name: 'SchemaCompileError', code: 'JK0001', message: loop });
    }
  });

  it('names every hop of a ring', () => {
    const ring = { $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' };
    assert.throws(() => compile(ring), {
      message: /^JK0001: \$ref cycle: \S+#\/\$defs\/a -> \S+#\/\$defs\/b -> \S+#\/\$defs\/a never reads the instance$/,
    });
    const three = { $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/c' }, c: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' };
    assert.throws(() => compile(three), { message: /\/\$defs\/a -> \S+\/\$defs\/b -> \S+\/\$defs\/c -> \S+\/\$defs\/a never/ });
  });

  it('is refused from the root and with siblings that would otherwise assert', () => {
    assert.throws(() => compile({ $ref: '#/$defs/a', $defs: { a: { $ref: '#' } } }), { message: /^JK0001: \$ref cycle: / });
    assert.throws(() => compile({ type: 'string', $ref: '#/$defs/a', $defs: { a: { $ref: '#' } } }, { draftVersion: 2020 }), {
      message: /^JK0001: \$ref cycle: /,
    });
  });

  it('is refused in a definition no reference reaches, as a self-reference there is', () => {
    const message = /^JK0001: \$ref cycle: \S+#\/\$defs\/a -> \S+#\/\$defs\/b -> \S+#\/\$defs\/a never reads the instance$/;
    assert.throws(() => compile({ type: 'string', $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } } }), { message });
    assert.throws(() => compile({ type: 'string', $defs: { a: { $ref: '#/$defs/a' } } }), {
      message: /^JK0001: \$ref cycle: \S+#\/\$defs\/a refers to itself and never reads the instance$/,
    });
  });

  it('keeps every reference that consumes the instance', () => {
    const tree = compile({ type: 'object', properties: { next: { $ref: '#' } } });
    assert.equal(tree({ next: { next: {} } }), true);
    assert.equal(tree({ next: { next: 1 } }), false);
    const chain = compile({ $defs: { a: { $ref: '#/$defs/b' }, b: { type: 'string' } }, $ref: '#/$defs/a' });
    assert.equal(chain('x'), true);
    assert.equal(chain(1), false);
    assert.equal(compile({ anyOf: [{ type: 'null' }, { $ref: '#' }] })(null), true);
    const hop = compile({ $defs: { a: { $ref: '#/$defs/b' }, b: { type: 'object', properties: { n: { $ref: '#/$defs/a' } } } }, $ref: '#/$defs/a' });
    assert.equal(hop({ n: { n: {} } }), true);
    assert.equal(hop({ n: { n: 1 } }), false);
  });
});

describe('the loop check over a long chain of references', () => {
  /** @param {number} n */
  const lookups = (n) => {
    let count = 0;
    const doc = /** @type {Record<string, any>} */ ({});
    const id = (/** @type {number} */ i) => `urn:chain#/a${i}`;
    for (let i = 0; i < n; i++) doc[`a${i}`] = i < n - 1 ? { $ref: id(i + 1) } : { type: 'string' };
    const schemas = new Map([['urn:chain#', doc], ['urn:chain', doc]]);
    const counted = new Proxy(schemas, {
      get(target, key) {
        if (key === 'get' || key === 'has') {
          return (/** @type {any} */ k) => { count++; return /** @type {any} */ (target)[key](k); };
        }
        const member = Reflect.get(target, key, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const clean = new Set();
    for (let i = 0; i < n; i++) resolveRefSchemaDeep(counted, 'urn:chain#', doc[`a${i}`], new TraverseOptions(), clean);
    return count;
  };

  it('does work in proportion to the chain, not its square', () => {
    const small = lookups(200);
    const large = lookups(1600);
    assert.ok(small >= 200);
    assert.ok(large < small * 8 * 2, `${small} lookups for 200, ${large} for 1600`);
  });
});

describe('a ring of references handed to addSchema', () => {
  const ring = /^JK0001: \$ref cycle: \S+ -> \S+ -> \S+ never reads the instance$/;

  it('is refused where it is added, and leaves the validator usable', () => {
    const v = new JarenValidator();
    v.addSchema({ $id: 'http://ring.test/ok', type: 'number' });
    v.addSchema({ $id: 'http://ring.test/a', $ref: 'http://ring.test/ok' });
    assert.throws(() => v.addSchema({ $id: 'http://ring.test/s', $ref: 'http://ring.test/s' }), {
      message: /^JK0001: \$ref cycle: \S+ refers to itself and never reads the instance$/,
    });
    const through = v.compile({ $ref: 'http://ring.test/a' });
    assert.equal(through(1), true);
    assert.equal(through('x'), false);
  });

  it('is refused as the second member of a ring', () => {
    const v = new JarenValidator();
    v.addSchema({ $id: 'http://ring.test/c', $ref: 'http://ring.test/d' });
    assert.throws(() => v.addSchema({ $id: 'http://ring.test/d', $ref: 'http://ring.test/c' }), { message: ring });
  });

  it('does not poison unrelated compiles when the ring sits inside a registered document', () => {
    const v = new JarenValidator();
    v.addSchema({ $id: 'http://ring.test/doc', $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } } });
    const plain = v.compile({ type: 'string' });
    assert.equal(plain('x'), true);
    assert.equal(plain(1), false);
    assert.throws(() => v.compile({ $ref: 'http://ring.test/doc#/$defs/a' }), { message: /^JK0001: \$ref cycle: / });
  });
});
