//@ts-check
/**
 * @file The accepted variant under `coerceJsonText`: an object or array node
 * whose JSON text the normalizer decodes takes a string on input, exactly
 * where `compileNormalizer` decodes one and nowhere else.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileEmitModel } from '@jarenjs/emit/model';
import { emitTypeScript } from '@jarenjs/emit/typescript';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';

const STRING = { kind: 'primitive', primitive: 'string' };

/** @param {any} model @param {string} name */
const decl = (model, name) => model.declarations.find((/** @type {any} */ d) => d.name === name);
/** @param {any} model */
const names = (model) => model.declarations.map((/** @type {any} */ d) => d.name);
/** @param {any} schema @param {any} instance */
const valid = (schema, instance) => new JarenValidator().compile(schema)(instance);

describe('emit — accepted types for coerceJsonText', () => {
  it('admits the JSON text of each object and array the normalizer decodes, at any depth', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        filter: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } },
      },
    };
    const call = { query: 'q', filter: '{"tags":"[\\"a\\"]"}' };
    const normalized = compileNormalizer(schema, { coerceJsonText: true })(call);
    assert.deepEqual(normalized, { query: 'q', filter: { tags: ['a'] } });
    assert.equal(valid(schema, normalized), true);
    assert.equal(emitTypeScript(schema, { name: 'Call', banner: false, normalize: { coerceJsonText: true } }),
      'export interface Call {\n  query?: string;\n  filter?: { tags?: Array<string>; [key: string]: unknown; };\n  [key: string]: unknown;\n}\n\n\n'
      + '/**\n * Accepted input for Call: the shape before normalization, where defaulted members may be absent and coercible values may still be in their transport form.\n */\n'
      + 'export type CallInput = { query?: string; filter?: { tags?: Array<string> | string; [key: string]: unknown; } | string; [key: string]: unknown; } | string;\n');
  });

  it('never widens where the normalizer never decodes: a string admitted, no type, a union branch, the switch off', () => {
    const schema = {
      type: 'object',
      properties: {
        either: { type: ['object', 'string'] },
        untyped: { properties: { a: { type: 'number' } } },
        branch: { anyOf: [{ type: 'object' }, { type: 'array' }] },
        off: { type: 'object', 'x-raw': true },
      },
      additionalProperties: false,
    };
    const normalize = { coerceJsonText: (/** @type {any} */ node) => node['x-raw'] !== true };
    const text = '{"a":1}';
    assert.deepEqual(compileNormalizer(schema, normalize)({ either: text, untyped: text, branch: text, off: text }),
      { either: text, untyped: text, branch: text, off: text });
    const model = compileEmitModel(schema, { name: 'N', normalize });
    const accepted = decl(model, 'NInput').type;
    assert.deepEqual(accepted.kind, 'union');
    assert.deepEqual(accepted.options[1], STRING);
    const members = Object.fromEntries(accepted.options[0].members.map((/** @type {any} */ m) => [m.name, m.type]));
    const plain = Object.fromEntries(decl(model, 'N').type.members.map((/** @type {any} */ m) => [m.name, m.type]));
    assert.deepEqual(members, plain);
    // a document whose only container admits a string, or declares no type, gains no twin
    for (const only of [{ type: ['object', 'string'], properties: { a: { type: 'number' } } }, { properties: { a: { type: 'number' } } }])
      assert.deepEqual(names(compileEmitModel(only, { name: 'E', normalize: { coerceJsonText: true } })), ['E']);
  });

  it('widens a nullable container, a const container and a decoded array of coerced items', () => {
    const schema = {
      type: 'object',
      properties: {
        maybe: { type: ['object', 'null'], properties: { a: { type: 'number' } } },
        fixed: { type: 'object', const: { a: 1 } },
        ports: { type: 'array', items: { type: 'number' } },
      },
    };
    const normalize = { coerceJsonText: true, coerceTypes: true };
    assert.deepEqual(compileNormalizer(schema, normalize)({ maybe: '{"a":1}', fixed: '{"a":1}', ports: '["80", 443]' }),
      { maybe: { a: 1 }, fixed: { a: 1 }, ports: [80, 443] });
    const accepted = decl(compileEmitModel(schema, { name: 'P', normalize }), 'PInput').type.options[0];
    const members = Object.fromEntries(accepted.members.map((/** @type {any} */ m) => [m.name, m.type]));
    assert.deepEqual(members.maybe.options.at(-1), STRING);
    assert.deepEqual(members.maybe.options.slice(1, 2), [{ kind: 'primitive', primitive: 'null' }]);
    assert.deepEqual(members.fixed.parts[0], { kind: 'union', options: [{ kind: 'literal', value: { a: 1 } }, STRING] });
    assert.deepEqual(members.fixed.parts[1].options.at(-1), STRING);
    assert.deepEqual(members.ports, { kind: 'union', options: [{ kind: 'array', items: { kind: 'union', options: [{ kind: 'primitive', primitive: 'number' }, STRING] } }, STRING] });
  });

  it('decodes nothing beside a $ref the draft reads alone, and the type follows', () => {
    const schema = { $defs: { S: { type: 'string' } }, $ref: '#/$defs/S', type: 'object' };
    assert.equal(valid(schema, '{"a":1}'), true);
    assert.equal(compileNormalizer(schema, { coerceJsonText: true })('{"a":1}'), '{"a":1}');
    assert.deepEqual(names(compileEmitModel(schema, { name: 'R', normalize: { coerceJsonText: true } })), ['S', 'R']);
  });

  it('decodes beside a $ref where the draft applies the sibling type', () => {
    const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: { O: { properties: { a: { type: 'number' } } } }, $ref: '#/$defs/O', type: 'object' };
    assert.deepEqual(compileNormalizer(schema, { coerceJsonText: true })('{"a":1}'), { a: 1 });
    const model = compileEmitModel(schema, { name: 'R', normalize: { coerceJsonText: true } });
    assert.deepEqual(names(model), ['O', 'R', 'RInput']);
    const accepted = decl(model, 'RInput').type;
    assert.deepEqual(accepted.parts[0], { kind: 'ref', ref: 'O' });
    assert.deepEqual(accepted.parts[1].options.at(-1), STRING);
  });
});
