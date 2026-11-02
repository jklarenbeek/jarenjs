//@ts-check
/**
 * @file A schema with an `$id` is held under its URI with and without the
 * empty fragment (`…/s.json#` and `…/s.json`). A compile builds it once,
 * under the `#` spelling, and that object answers for both spellings:
 * `getSchema` answers by either, and a `$ref` spelled either way validates
 * and locates its errors alike.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { JarenValidator } from '@jarenjs/validate';

const SPELLINGS = ['https://x.test/s.json', 'https://x.test/s.json#'];

describe('a schema with an $id', function () {
  it('is built once per compile, under its URI with the empty fragment', function () {
    // A format compiler is called once per schema object built at a place:
    // the places it is handed are the places built.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { JarenValidator } = await import('@jarenjs/validate');
      const counted = { type: 'string', format: 'counted' };
      const cases = [
        [[], { $id: 'https://x.test/s.json', type: 'object', properties: { a: counted } }],
        [[], { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://x.test/s.json', properties: { a: counted } }],
        [[], { $id: 'sub/s.json', properties: { a: counted } }],
        [[], { $id: 'https://x.test/root.json', properties: { b: { $id: 'b.json', properties: { a: counted } } } }],
        [[{ $id: 'https://x.test/r.json', properties: { a: counted } }], { $ref: 'https://x.test/r.json' }],
        [[], { $id: 'https://x.test/n.json#root', properties: { a: counted } }],
      ];
      console.log(JSON.stringify(cases.map(([held, schema]) => {
        const places = [];
        const validator = new JarenValidator({ formatAssertion: true })
          .addFormat('counted', (place) => { places.push(place.path); return () => true; });
        for (const document of held) validator.addSchema(document);
        validator.compile(schema);
        return places;
      })));
    `], { encoding: 'utf8', timeout: 10000, env: { ...process.env, FORCE_COLOR: '0' } });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    const [absolute, draft2020, relative, nested, held, named] = JSON.parse(result.stdout);
    assert.deepEqual(absolute, ['https://x.test/s.json#/properties/a']);
    assert.deepEqual(draft2020, ['https://x.test/s.json#/properties/a']);
    assert.deepEqual(relative, ['https://github.com/jklarenbeek/sub/s.json#/properties/a']);
    assert.deepEqual(nested, ['https://x.test/b.json#/properties/a']);
    assert.deepEqual(held, ['https://x.test/r.json#/properties/a']);
    // a root `$id` with a plain-name fragment names the document too: no
    // place of it is built under the URI without the fragment
    assert.deepEqual(named.filter((/** @type {string} */ place) => !place.includes('#')), []);
    assert.ok(named.includes('https://x.test/n.json#/properties/a'));
  });

  it('is answered by getSchema under either spelling, before and after a compile reads it', function () {
    const document = { $id: 'https://x.test/s.json', type: 'object', properties: { n: { type: 'number' } } };
    const validator = new JarenValidator().addSchema(document);
    assert.deepEqual(SPELLINGS.map((key) => validator.getSchema(key) === document), [true, true]);
    for (const ref of SPELLINGS) validator.compile({ items: { $ref: ref } });
    assert.deepEqual(SPELLINGS.map((key) => validator.getSchema(key) === document), [true, true]);
    // a compiled document is not held
    const compiling = new JarenValidator();
    compiling.compile(document);
    assert.deepEqual(SPELLINGS.map((key) => compiling.getSchema(key)), [null, null]);
  });

  it('keeps the location of a plain-name identifier, whose URI holds a fragment', function () {
    // `$id: '#foo'` below a base change is held as `…/nested.json#foo`, not
    // one of the two spellings of a document
    const schema = {
      $id: 'https://x.test/root.json',
      properties: { p: { $ref: 'https://x.test/nested.json#foo' }, q: { type: 'array', items: { $ref: 'https://x.test/nested.json#foo' } } },
      definitions: { A: { $id: 'nested.json', definitions: { B: { $id: '#foo', type: 'integer' } } } },
    };
    const result = new JarenValidator({ collectErrors: true, skipErrors: false }).compile(schema)({ p: 'x', q: ['y'] });
    assert.deepEqual(result.errors.map((e) => [e.instancePath, e.keyword, e.schemaPath]), [
      ['/p', 'type', 'https://x.test/nested.json#foo'],
      ['/q/0', 'type', 'https://x.test/nested.json#foo'],
      ['/q', 'items', 'https://x.test/root.json#/properties/q'],
    ]);
  });

  it('validates through a $ref spelled either way alike', function () {
    const document = { $id: 'https://x.test/s.json', type: 'object', properties: { n: { type: 'number' } } };
    const instances = [{ one: { n: 'x' } }, { many: [{ n: 'y' }] }, { one: { n: 1 }, many: [{ n: 2 }] }];
    for (const ref of SPELLINGS) {
      const schema = { properties: { one: { $ref: ref }, many: { type: 'array', items: { $ref: ref } } } };
      const verdicts = new JarenValidator().addSchema(document).compile(schema);
      assert.deepEqual(instances.map((data) => verdicts(data)), [false, false, true], ref);
      const collected = new JarenValidator({ collectErrors: true, skipErrors: false }).addSchema(document).compile(schema)({ one: { n: 'x' }, many: [{ n: 'y' }] });
      assert.deepEqual(collected.errors.map((e) => [e.instancePath, e.keyword, e.schemaPath]), [
        ['/one/n', 'type', 'https://x.test/s.json#/properties/n'],
        ['/many/0/n', 'type', 'https://x.test/s.json#/properties/n'],
        ['/many', 'items', 'https://github.com/jklarenbeek/jarenjs#/properties/many'],
      ], ref);
    }
  });
});
