//@ts-check
/**
 * @file A `$ref`'s sibling keywords, read as the validator and
 * `compileNormalizer` read them: before draft 2019-09, and where a document
 * declares no draft, a schema object holding a `$ref` is its target alone, so
 * the generated type, its documented constraints and its variants read only
 * the target there; from 2019-09 on the siblings apply beside it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileEmitModel } from '@jarenjs/emit/model';
import { emitTypeScript } from '@jarenjs/emit/typescript';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const DRAFT_2019 = 'https://json-schema.org/draft/2019-09/schema';
const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema';

/** @param {any} model @param {string} name */
const decl = (model, name) => model.declarations.find((/** @type {any} */ d) => d.name === name);
/** @param {any} schema @param {any} instance */
const valid = (schema, instance) => new JarenValidator().compile(schema)(instance);

describe('emit — $ref siblings per declared draft', () => {
  const typed = { $defs: { S: { type: 'string' } }, $ref: '#/$defs/S', type: 'integer' };

  it('types a document declaring no draft, or draft-07, as the target alone', () => {
    for (const schema of [typed, { $schema: DRAFT_07, ...typed }]) {
      assert.equal(valid(schema, '12'), true);
      assert.equal(valid(schema, 12), false);
      assert.equal(emitTypeScript(schema, { name: 'T', banner: false }), 'export type S = string;\n\nexport type T = S;\n');
    }
  });

  it('intersects the siblings where the declared draft applies them', () => {
    for (const $schema of [DRAFT_2019, DRAFT_2020]) {
      const schema = { $schema, ...typed };
      assert.equal(valid(schema, '12'), false);
      assert.equal(emitTypeScript(schema, { name: 'T', banner: false }),
        'export type S = string;\n\n/**\n * Schema constraints this type cannot express: type="integer"\n */\nexport type T = S & number;\n');
    }
  });

  it('reads object siblings and constraints beside the $ref as inert, keeping its description', () => {
    const schema = {
      $defs: { O: { type: 'object', properties: { a: { type: 'string' } } }, S: { type: 'string' } },
      type: 'object',
      properties: {
        o: { $ref: '#/$defs/O', properties: { a: { type: 'number' } }, required: ['a'] },
        s: { $ref: '#/$defs/S', minLength: 2, description: 'a name' },
      },
    };
    assert.equal(valid(schema, { o: { b: 1 }, s: 'x' }), true);
    const root = decl(compileEmitModel(schema, { name: 'R' }), 'R').type;
    assert.deepEqual(root.members.map((/** @type {any} */ m) => [m.name, m.type, m.constraints, m.doc]), [
      ['o', { kind: 'ref', ref: 'O' }, [], []],
      ['s', { kind: 'ref', ref: 'S' }, [], ['a name']],
    ]);
  });

  it('does not default a member whose default sits beside a $ref the draft reads alone', () => {
    const schema = { type: 'object', properties: { p: { $ref: '#/$defs/S', default: 5 } }, $defs: { S: { type: 'string' } } };
    assert.deepEqual(compileNormalizer(schema, { useDefaults: true })({}), {});
    const model = compileEmitModel(schema, { name: 'U', normalize: { useDefaults: true } });
    const member = decl(model, 'U').type.members[0];
    assert.deepEqual([member.name, member.type, member.required, 'default' in member], ['p', { kind: 'ref', ref: 'S' }, false, false]);
    assert.equal(decl(model, 'UInput'), undefined);
    // where the draft applies the default, it is materialized and the twin follows
    const declared = { $schema: DRAFT_2020, ...schema };
    assert.deepEqual(compileNormalizer(declared, { useDefaults: true })({}), { p: 5 });
    const twin = compileEmitModel(declared, { name: 'U', normalize: { useDefaults: true } });
    assert.equal(decl(twin, 'U').type.members[0].required, true);
    assert.equal(decl(twin, 'UInput').type.members[0].required, false);
  });

  it('does not widen by a coercion of the sibling type the draft never reads', () => {
    const schema = { type: 'object', properties: { n: { $ref: '#/$defs/O', type: 'integer' } }, $defs: { O: { type: 'object' } } };
    assert.deepEqual(compileNormalizer(schema, { coerceTypes: true })({ n: '2' }), { n: '2' });
    const model = compileEmitModel(schema, { name: 'C', normalize: { coerceTypes: true } });
    assert.deepEqual(model.declarations.map((/** @type {any} */ d) => d.name), ['O', 'C']);
    assert.deepEqual(decl(model, 'C').type.members[0].type, { kind: 'ref', ref: 'O' });
  });

  it('reads a node below a nested $schema by that draft, as the validator does', () => {
    const schema = {
      $defs: { S: { type: 'string' }, A: { $schema: DRAFT_2020, type: 'object', properties: { p: { $ref: '#/$defs/S', type: 'integer' } } } },
      type: 'object',
      properties: { a: { $ref: '#/$defs/A' }, q: { $ref: '#/$defs/S', type: 'integer' } },
    };
    assert.equal(valid(schema, { a: { p: '12' } }), false);
    assert.equal(valid(schema, { q: '12' }), true);
    const model = compileEmitModel(schema, { name: 'N' });
    assert.deepEqual(decl(model, 'A').type.members[0].type,
      { kind: 'intersection', parts: [{ kind: 'ref', ref: 'S' }, { kind: 'primitive', primitive: 'number' }] });
    assert.deepEqual(decl(model, 'N').type.members[1].type, { kind: 'ref', ref: 'S' });
  });
});
