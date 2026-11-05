import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';

import { JarenValidator } from '@jarenjs/validate';
import { basicOutput } from '@jarenjs/validate/output';

// The default (first-failure) validator compiles a one-keyword item schema
// to a bare predicate. That shortcut must give the verdict the full
// compilation gives, so the same schema answers the same in both modes.

const MODES = [
  ['first-failure', {}],
  ['collecting', { collectErrors: true, skipErrors: false }],
];

function verdict(options, schema, data) {
  const result = new JarenValidator(options).compile(schema)(data);
  return typeof result === 'object' ? result.valid : result;
}

describe('one-keyword item schemas', function () {
  for (const [label, options] of MODES) {
    it(`type given as an array is enforced (${label})`, function () {
      assert.strictEqual(verdict(options, { items: { type: ['string'] } }, [true]), false);
      assert.strictEqual(verdict(options, { items: { type: ['string'] } }, ['a']), true);
      assert.strictEqual(verdict(options, { items: { type: ['string', 'number'] } }, [true]), false);
      assert.strictEqual(verdict(options, { items: { type: ['string', 'number'] } }, ['a', 1]), true);
      assert.strictEqual(verdict(options, { prefixItems: [{ type: ['integer'] }] }, [1.5]), false);
      assert.strictEqual(verdict(options, { items: { type: ['null'] } }, [0]), false);
    });

    it(`required counts own members only (${label})`, function () {
      assert.strictEqual(verdict(options, { items: { required: ['toString'] } }, [{}]), false);
      assert.strictEqual(verdict(options, { items: { required: ['constructor'] } }, [{}]), false);
      assert.strictEqual(verdict(options, { prefixItems: [{ required: ['valueOf'] }] }, [{}]), false);
      assert.strictEqual(verdict(options, { items: { required: ['toString'] } }, [JSON.parse('{"toString":1}')]), true);
      assert.strictEqual(verdict(options, { items: { required: ['a'] } }, [{ a: 1 }, 1, []]), true);
      assert.strictEqual(verdict(options, { items: { required: ['a'] } }, [{ b: 1 }]), false);
      // a member the item inherits from a prototype of its own is not the
      // item's, as `{ required: ['a'] }` reads it at the root
      const inherits = Object.create({ a: 1 });
      assert.strictEqual(verdict(options, { required: ['a'] }, inherits), false);
      assert.strictEqual(verdict(options, { items: { required: ['a'] } }, [inherits]), false);
      assert.strictEqual(verdict(options, { prefixItems: [{ required: ['a', 'b'] }] }, [Object.assign(Object.create({ a: 1 }), { b: 2 })]), false);
      assert.strictEqual(verdict(options, { items: { required: ['a'] } }, [Object.assign(Object.create(null), { a: 1 })]), true);
    });

    it(`required given as a $data reference is honored (${label})`, function () {
      const schema = { properties: { list: { items: { required: { $data: '2/names' } } } } };
      assert.strictEqual(verdict(options, schema, { names: ['a'], list: [{}] }), false);
      assert.strictEqual(verdict(options, schema, { names: ['a'], list: [{ a: 1 }] }), true);
    });
  }
});

// A document with an `$id` is held under its URI with and without the empty
// fragment, and built once, under the `#` spelling: a `$ref`-only item that
// names it either way reaches that object. The shortcut compiles such an
// item without building a refusal it would only discard, and locates an
// error below the document below `…#`, as the full compilation does.
describe('a $ref-only item schema in a document with an $id', function () {
  const bundle = {
    $id: 'https://example.test/bundle',
    type: 'object',
    properties: {
      tags: { type: 'array', items: { $ref: '#/$defs/tag' } },
      owners: { type: 'array', items: { $ref: '#/$defs/owner' } },
    },
    $defs: {
      tag: { type: 'string', pattern: '^[a-z]+$' },
      owner: { type: 'object', required: ['name'], properties: { name: { $ref: '#/$defs/tag' } } },
    },
  };

  it('compiles without constructing an error', function () {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      let constructed = 0;
      const Base = globalThis.Error;
      globalThis.Error = class extends Base { constructor(...args) { super(...args); constructed++; } };
      const { JarenValidator } = await import('@jarenjs/validate');
      new JarenValidator({ skipErrors: false, collectErrors: true }).compile(${JSON.stringify(bundle)});
      console.log(constructed);
    `], { encoding: 'utf8', timeout: 10000, env: { ...process.env, FORCE_COLOR: '0' } });
    assert.strictEqual(result.status, 0, result.error?.message ?? result.stderr);
    assert.strictEqual(result.stdout, '0\n');
  });

  it('answers as the full compilation of the same item schemas', function () {
    // a second member keeps an item schema off the shortcut; draft-07 reads
    // nothing beside a `$ref`
    const full = structuredClone(bundle);
    full.properties.tags.items.$comment = 'compiled in full';
    full.properties.owners.items.$comment = 'compiled in full';
    const instances = [
      { tags: ['a', 'B', 1], owners: [{ name: 'x' }, {}, { name: 'Y' }] },
      { tags: ['a'], owners: [{ name: 'b' }] },
      { tags: 'x' },
    ];
    for (const [, options] of MODES) {
      const viaShortcut = new JarenValidator(options).compile(bundle);
      const viaFull = new JarenValidator(options).compile(full);
      for (const data of instances)
        assert.deepStrictEqual(viaShortcut(data), viaFull(data));
    }
    const collected = new JarenValidator({ collectErrors: true, skipErrors: false }).compile(bundle)(instances[0]);
    assert.deepStrictEqual(collected.errors.map((e) => [e.instancePath, e.keyword, e.schemaPath]), [
      ['/tags/1', 'pattern', 'https://example.test/bundle#/$defs/tag'],
      ['/tags/2', 'type', 'https://example.test/bundle#/$defs/tag'],
      ['/tags', 'items', 'https://example.test/bundle#/properties/tags'],
      ['/owners/1', 'required', 'https://example.test/bundle#/$defs/owner'],
      ['/owners/2/name', 'pattern', 'https://example.test/bundle#/$defs/tag'],
      ['/owners', 'items', 'https://example.test/bundle#/properties/owners'],
    ]);
  });

  it('locates an error below an item naming a held document without the fragment as the full compilation does', function () {
    // from a `$defs` member: the document's own `$id`, and another document
    // the validator holds
    const own = {
      $id: 'https://example.test/a', type: 'object',
      properties: { n: { type: 'number' }, list: { $ref: '#/$defs/list' } },
      $defs: { list: { type: 'array', items: { $ref: 'https://example.test/a' } } },
    };
    const held = { $id: 'https://example.test/r', type: 'object', properties: { n: { type: 'number' } } };
    const user = {
      $id: 'https://example.test/user', type: 'object',
      properties: { list: { $ref: '#/$defs/list' } },
      $defs: { list: { type: 'array', items: { $ref: 'https://example.test/r' } } },
    };
    const data = { list: [{ n: 'x' }, 1] };
    const collecting = () => new JarenValidator({ collectErrors: true, skipErrors: false });
    const located = (result) => result.errors.map((e) => [e.instancePath, e.keyword, e.schemaPath]);
    assert.deepStrictEqual(located(collecting().compile(own)(data)), [
      ['/list/0/n', 'type', 'https://example.test/a#/properties/n'],
      ['/list/1', 'type', 'https://example.test/a#'],
      ['/list', 'items', 'https://example.test/a#/$defs/list'],
    ]);
    assert.deepStrictEqual(located(collecting().addSchema(held).compile(user)(data)), [
      ['/list/0/n', 'type', 'https://example.test/r#/properties/n'],
      ['/list/1', 'type', 'https://example.test/r#'],
      ['/list', 'items', 'https://example.test/user#/$defs/list'],
    ]);
    const full = structuredClone(own);
    full.$defs.list.items.$comment = 'compiled in full';
    assert.deepStrictEqual(collecting().compile(own)(data), collecting().compile(full)(data));
    // recording output units, an item's subschema is a unit of its own: no shortcut
    const units = (result) => result.errors.map((e) => [e.instanceLocation, e.absoluteKeywordLocation]);
    assert.deepStrictEqual(units(new JarenValidator({ outputFormat: basicOutput }).compile(own)(data)), [
      ['/list', 'https://example.test/a#/$defs/list/items'],
      ['/list/0/n', 'https://example.test/a#/properties/n/type'],
      ['/list/1', 'https://example.test/a#/type'],
    ]);
  });
});
