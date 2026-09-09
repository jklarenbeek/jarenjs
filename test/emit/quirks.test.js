import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compileEmitModel, emitTypeScript, emitMarkdown } from '@jarenjs/emit';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';

const rootType = (schema, options) => {
  const model = compileEmitModel(schema, options);
  return model.declarations.find((declaration) => declaration.name === model.root).type;
};

describe('emitted schema agreement', () => {
  it('includes nullable values admitted by the validator', () => {
    const schema = { type: 'string', nullable: true };
    assert.equal(new JarenValidator().compile(schema)(null), true);
    assert.deepEqual(rootType(schema), {
      kind: 'union', options: [{ kind: 'primitive', primitive: 'string' }, { kind: 'primitive', primitive: 'null' }],
    });
    assert.equal(emitTypeScript(schema, { banner: false }), 'export type Root = string | null;\n\n');
  });

  it('carries required members even without a properties declaration', () => {
    const schema = { type: 'object', required: ['id'] };
    assert.equal(new JarenValidator().compile(schema)({}), false);
    assert.deepEqual(rootType(schema).members, [{
      kind: 'member', name: 'id', type: { kind: 'unknown' }, required: true, constraints: [], doc: [],
    }]);
  });

  it('filters enum literals by their declared scalar type', () => {
    assert.deepEqual(rootType({ type: 'number', enum: ['yes'] }), { kind: 'never' });
    assert.deepEqual(rootType({ type: 'string', enum: [1, 'yes'] }), { kind: 'literal', value: 'yes' });
    assert.deepEqual(rootType({ type: 'integer', enum: [1, 1.5] }), { kind: 'literal', value: 1 });
    assert.deepEqual(rootType({ type: 'string', nullable: true, enum: [null, 'yes'] }), {
      kind: 'union', options: [{ kind: 'literal', value: null }, { kind: 'literal', value: 'yes' }],
    });
  });

  it('composes literal constraints with sibling applicators', () => {
    assert.deepEqual(rootType({ const: 'no', allOf: [{ const: 'yes' }] }), {
      kind: 'intersection', parts: [{ kind: 'literal', value: 'no' }, { kind: 'literal', value: 'yes' }],
    });
  });

  it('retains the documented draft-neutral ref sibling intersection', () => {
    assert.deepEqual(rootType({ $defs: { S: { type: 'string' } }, $ref: '#/$defs/S', type: 'number' }), {
      kind: 'intersection', parts: [{ kind: 'ref', ref: 'S' }, { kind: 'primitive', primitive: 'number' }],
    });
  });

  it('carries anonymous constraints into both generated artifacts', () => {
    const schema = { type: 'array', items: { type: 'string', minLength: 2 } };
    const model = compileEmitModel(schema);
    const item = model.declarations.find((declaration) => declaration.name === 'RootItem');
    assert.deepEqual(item?.constraints, [{ keyword: 'minLength', value: 2 }]);
    assert.match(emitTypeScript(schema), /minLength=2/);
    assert.match(emitMarkdown(schema), /minLength=2/);
  });

  it('keeps nested member constraints visible in TypeScript and Markdown', () => {
    const schema = { type: 'object', properties: { outer: { type: 'object', properties: { n: { type: 'string', minLength: 2 } } } } };
    assert.match(emitTypeScript(schema), /minLength=2/);
    assert.match(emitMarkdown(schema), /minLength=2/);
  });

  it('derives every recursive accepted twin independently of definition order', () => {
    const defs = {
      A: { type: 'object', properties: { b: { $ref: '#/$defs/B' }, n: { type: 'number' } } },
      B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
    };
    for (const order of ['AB', 'BA']) {
      const schema = { $defs: Object.fromEntries([...order].map((name) => [name, defs[name]])), $ref: '#/$defs/A' };
      const normalize = { coerceTypes: true };
      assert.deepEqual(compileNormalizer(schema, normalize)({ b: { a: { n: '2' } } }), { b: { a: { n: 2 } } });
      const model = compileEmitModel(schema, { normalize });
      const a = model.declarations.find((declaration) => declaration.name === 'AInput');
      const b = model.declarations.find((declaration) => declaration.name === 'BInput');
      assert.deepEqual(a?.type.members[0].type, { kind: 'ref', ref: 'BInput' });
      assert.deepEqual(b?.type.members[0].type, { kind: 'ref', ref: 'AInput' });
    }
  });

  it('validates models carrying declared member extensions against their published schema', () => {
    const schema = JSON.parse(fs.readFileSync(new URL('../../packages/emit/schemas/jaren-emit-model.schema.json', import.meta.url), 'utf8'));
    const model = compileEmitModel({ type: 'object', properties: { x: { type: 'string', 'x-kind': 'id' } } }, { extensions: ['x-kind'] });
    assert.equal(new JarenValidator().compile(schema)(model), true);
    assert.deepEqual(model.declarations.at(-1).type.members[0].extensions, { 'x-kind': 'id' });
  });

  it('preserves an own __proto__ extension as data', () => {
    const schema = JSON.parse('{"type":"object","properties":{"x":{"type":"string","__proto__":{"preserve":true}}}}');
    const model = compileEmitModel(schema, { extensions: ['__proto__'] });
    const extensions = model.declarations.at(-1).type.members[0].extensions;
    assert.equal(Object.hasOwn(extensions, '__proto__'), true);
    assert.deepEqual(extensions, JSON.parse('{"__proto__":{"preserve":true}}'));
    assert.equal(Object.getPrototypeOf(extensions), Object.prototype);
  });
});
