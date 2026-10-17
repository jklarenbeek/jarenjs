//@ts-check
/**
 * @file Under `unknownFormats: 'error'`, an asserting `format` that names no
 * registered format compiler is refused when the schema compiles (`JK0015`),
 * located at the keyword: an unregistered name, and a value that is no name
 * at all (a number, `null`, an object that is not a `$data` reference), which
 * used to compile to a keyword accepting every value. Where `format` does not
 * assert, or under the default `'ignore'`, the same schemas compile and the
 * keyword is an annotation. A name only the object prototype holds
 * (`toString`) is no registered format either: it used to be called as one and
 * throw an uncoded error under either setting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator, SchemaCompileError } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';
import * as formats from '@jarenjs/formats';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * The refusal a compile throws, as code, location and whether the message
 * ends at the location, or null when it compiles.
 * @param {any} schema @param {object} [options]
 */
function refusal(schema, options = { unknownFormats: 'error' }) {
  try {
    new JarenValidator(options).compile(schema);
  }
  catch (e) {
    return { coded: e instanceof SchemaCompileError, code: e.code, docPath: e.docPath, located: e.message.endsWith(` at ${e.docPath}`) };
  }
  return null;
}

/** @param {string} docPath */
const refused = (docPath) => ({ coded: true, code: 'JK0015', docPath, located: true });

/**
 * The boolean answers of a schema for each instance.
 * @param {object} schema @param {unknown[]} instances @param {object} [options]
 */
function answers(schema, instances, options = undefined) {
  const validate = new JarenValidator(options).compile(schema);
  return instances.map((x) => validate(x));
}

/** Format values that name no registered compiler. */
const UNNAMED = /** @type {unknown[]} */ (['foo', 'toString', 'constructor', 5, null, true, [], {}, { $data: 5 }]);

describe("an asserting format with no registered compiler is refused under unknownFormats: 'error' (JK0015)", () => {
  for (const [label, draft, options] of /** @type {[string, string | undefined, object][]} */ ([
    ['no $schema', undefined, {}],
    ['draft-07', D07, {}],
    ['draft 2019-09', D19, {}],
    ['draft 2020-12 with format assertion', D20, { formatAssertion: true }],
  ])) {
    it(`refuses each value at the keyword (${label})`, () => {
      const at = (/** @type {object} */ s) => (draft === undefined ? s : { $schema: draft, ...s });
      assert.deepEqual(UNNAMED.map((format) => refusal(at({ format }), { unknownFormats: 'error', ...options })),
        UNNAMED.map(() => refused('#/format')));
      assert.deepEqual(refusal(at({ properties: { a: { format: 5 } } }), { unknownFormats: 'error', ...options }),
        refused('#/properties/a/format'));
    });
  }

  for (const [root, label] of [[{}, 'without a root $id'], [{ $id: 'https://x.test/order' }, 'under an absolute root $id'], [{ $id: 'sub/order.json' }, 'under a relative root $id']]) {
    it(`locates the refusal by its pointer ${label}`, () => {
      assert.deepEqual(refusal({ ...root, properties: { a: { format: 'foo' } } }), refused('#/properties/a/format'));
    });
  }

  it('names the format, the registration that would serve it and the opt-out', () => {
    assert.throws(() => new JarenValidator({ unknownFormats: 'error' }).compile({ format: 'foo' }),
      /^SchemaCompileError: JK0015: Unknown format 'foo': no compiler is registered for it, .*addFormat.*unknownFormats: 'ignore'.* at #\/format$/s);
    assert.throws(() => new JarenValidator({ unknownFormats: 'error' }).compile({ format: 5 }),
      /JK0015: 'format' holds 5, which names no format, .*unknownFormats: 'ignore'.* at #\/format$/s);
  });

  it('refuses through compileAsync alike', async () => {
    await assert.rejects(compileAsync(new JarenValidator({ unknownFormats: 'error' }), { format: 'foo' }, { loadSchema: async () => ({}) }),
      { name: 'SchemaCompileError', code: 'JK0015', docPath: '#/format' });
  });
});

describe('the same formats where the refusal does not apply', () => {
  it("compile under the default 'ignore' and assert nothing", () => {
    assert.deepEqual(UNNAMED.map((format) => answers({ format }, ['x', 5, null])), UNNAMED.map(() => [true, true, true]));
  });

  it('compile where format is an annotation (draft 2020-12 without format assertion)', () => {
    assert.deepEqual(UNNAMED.map((format) => answers({ $schema: D20, format }, ['x', 5], { unknownFormats: 'error' })),
      UNNAMED.map(() => [true, true]));
  });

  it('compile a format registered under a name the object prototype holds, and assert it', () => {
    for (const unknownFormats of ['ignore', 'error']) {
      const validator = new JarenValidator({ unknownFormats });
      for (const name of ['constructor', '__proto__']) validator.addFormat(name, () => (/** @type {unknown} */ x) => x === 'ok');
      assert.deepEqual(['constructor', '__proto__'].map((format) => {
        const validate = validator.compile({ format });
        return [validate('ok'), validate('no')];
      }), [[true, false], [true, false]]);
    }
  });

  it('compile a registered format and a $data reference', () => {
    const validator = () => new JarenValidator({ unknownFormats: 'error' }).addFormats(formats.stringFormats);
    const email = validator().compile({ format: 'email' });
    assert.deepEqual([email('a@b.co'), email('x')], [true, false]);
    const named = validator().compile({ properties: { f: {}, v: { format: { $data: '1/f' } } } });
    assert.deepEqual([named({ f: 'email', v: 'a@b.co' }), named({ f: 'email', v: 'x' })], [true, false]);
  });
});
