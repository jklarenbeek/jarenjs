//@ts-check
/**
 * @file A reference is typed by the target the validator reaches: it
 * resolves against the base URI of the resource holding it (an embedded
 * `$id` starts one, relative or absolute), to a pointer or a plain name of
 * the resource its URI names.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileEmitModel } from '@jarenjs/emit';
import { emitTypeScript } from '@jarenjs/emit/typescript';
import { embeddedResourceSchemas, placeType } from '../lib/embedded-resources.js';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

/** The emitted type of the root's members. @param {any} schema */
const rootType = (schema) => /export type Root = (.*);/.exec(emitTypeScript(schema))?.[1];

describe('emit — a reference inside an embedded resource', () => {
  it('types `#/definitions/x` by the embedded resource\'s own `x`', () => {
    const schema = {
      $id: 'http://example.com/root.json',
      definitions: { x: { type: 'integer' } },
      properties: {
        r: { $ref: '#/definitions/x' },
        y: { $id: 'thing', type: 'object', definitions: { x: { type: 'string' } }, properties: { z: { $ref: '#/definitions/x' }, w: { $ref: 'root.json#/definitions/x' } } },
      },
    };
    assert.equal(rootType(schema), '{ r?: X; y?: { z?: X2; w?: X; [key: string]: unknown; }; [key: string]: unknown; } | Array<unknown> | string | number | boolean | null');
    assert.match(emitTypeScript(schema), /export type X = number;[\s\S]*export type X2 = string;/);
  });

  it('types a plain name and a URI naming an embedded resource', () => {
    const schema = {
      $schema: D20,
      $id: 'http://e.test/root.json',
      $defs: { x: { $anchor: 'nm', type: 'integer' } },
      properties: {
        r: { $ref: 'thing.json#nm' },
        t: { $ref: 'thing.json' },
        y: { $id: 'thing.json', type: 'object', $defs: { x: { $anchor: 'nm', type: 'string' } }, properties: { z: { $ref: '#nm' } } },
      },
    };
    const ts = emitTypeScript(schema);
    assert.match(ts, /export type Nm = string;/);
    assert.match(ts, /export interface Thing \{\n {2}z\?: Nm;/);
    assert.equal(rootType(schema), '{ r?: Nm; t?: Thing; y?: Thing; [key: string]: unknown; } | Array<unknown> | string | number | boolean | null');
  });

  it('types a draft-07 `$ref` beside an `$id` by the enclosing resource', () => {
    const schema = {
      $schema: D07,
      $id: 'http://e.test/root.json',
      definitions: { a: { type: 'integer' } },
      properties: { y: { $id: 'thing', $ref: '#/definitions/a', definitions: { a: { type: 'string' } } } },
    };
    assert.equal(rootType(schema), '{ y?: A; [key: string]: unknown; } | Array<unknown> | string | number | boolean | null');
    assert.match(emitTypeScript(schema), /export type A = number;/);
  });
});

describe('emit — the type of every generated reference is the place the validator reads', () => {
  it('agrees with the validator at every leaf', () => {
    /** @type {Record<string, string>} */
    const expected = { integer: 'number', number: 'number', string: 'string', boolean: 'boolean', none: 'object', any: 'unknown' };
    let checked = 0;
    /** @type {string[]} */
    const wrong = [];
    for (const { schema, leaves, label } of embeddedResourceSchemas()) {
      let v;
      try { v = new JarenValidator().compile(schema); }
      catch { continue; }
      const model = compileEmitModel(schema);
      const declarations = new Map(model.declarations.map((d) => [d.name, d.type]));
      /** @param {any} type @returns {any} */
      const deref = (type) => {
        const seen = new Set();
        while (type?.kind === 'ref' && !seen.has(type.ref)) { seen.add(type.ref); type = declarations.get(type.ref); }
        return type;
      };
      /** @param {any} type @returns {string[]} */
      const kinds = (type) => {
        const t = deref(type);
        if (t === undefined) return ['?'];
        if (t.kind === 'union') return t.options.flatMap(kinds);
        return [t.kind === 'primitive' ? t.primitive : t.kind];
      };
      for (const path of leaves) {
        let type = deref({ kind: 'ref', ref: model.root });
        for (const key of path) {
          const object = type?.kind === 'union' ? type.options.map(deref).find((/** @type {any} */ o) => o.kind === 'object') : type;
          type = deref(object?.members?.find((/** @type {any} */ m) => m.name === key)?.type);
        }
        checked++;
        const got = [...new Set(kinds(type))].join('|');
        const want = expected[placeType(v, path)];
        if (got !== want) wrong.push(`${label}: ${path.join('.')} emit ${got}, validator ${want}`);
      }
    }
    assert.deepEqual(wrong.slice(0, 5), []);
    assert.equal(checked, 2448);
  });
});
