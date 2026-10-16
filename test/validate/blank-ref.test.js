import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { basicOutput } from '@jarenjs/validate/output';
import { compileNormalizer, resolveSameDocumentRef } from '@jarenjs/validate/normalize';

// A blank `$ref` (or `$dynamicRef`) is the empty URI reference: it names the
// current resource, as `#` does, so it answers as `#` answers at the same
// place. Read as no reference, its constraint was dropped.

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

const answers = (validate, instances) => instances.map((instance) => {
  try {
    const answer = validate(instance);
    return typeof answer === 'object' ? answer.valid : answer;
  }
  catch (e) { return /** @type {any} */ (e).code; }
});
/** The answers, or the refusal's code and message, of one compile. */
const outcome = (schema, instances, options = {}) => {
  let validate;
  try { validate = new JarenValidator(options).compile(schema); }
  catch (e) { return `${/** @type {any} */ (e).code}: ${/** @type {any} */ (e).message}`; }
  return answers(validate, instances);
};

describe('a blank $ref names the current resource', () => {
  it('the entry input', () => {
    assert.deepEqual(outcome({ $schema: D20, type: 'object', properties: { p: { $ref: '' } } }, [{ p: 1 }, { p: {} }]), [false, true]);
  });

  /** Each row: a label, the schema with the reference written `REF`, the instances and the answers. */
  const shapes = /** @type {[string, (ref: string) => any, unknown[], unknown][]} */ ([
    ['2020-12 under properties', (ref) => ({ $schema: D20, type: 'object', properties: { p: { $ref: ref } } }), [{ p: 1 }, { p: {} }], [false, true]],
    ['2019-09 under properties', (ref) => ({ $schema: D19, type: 'object', properties: { p: { $ref: ref } } }), [{ p: 1 }, { p: {} }], [false, true]],
    ['draft-07 under properties', (ref) => ({ $schema: D07, type: 'object', properties: { p: { $ref: ref } } }), [{ p: 1 }, { p: {} }], [false, true]],
    ['no declared draft', (ref) => ({ type: 'object', properties: { p: { $ref: ref } } }), [{ p: 1 }, { p: {} }], [false, true]],
    ['under a nested $id: that resource, not the root', (ref) => ({
      $schema: D20, $id: 'https://b.test/s.json', type: 'object',
      properties: { p: { $id: 'sub.json', type: 'array', items: { $ref: ref } } },
    }), [{ p: [[]] }, { p: [{}] }, { p: [1] }], [true, false, false]],
    ['draft-07 beside an $id, which does not set its base', (ref) => ({
      $schema: D07, $id: 'https://b.test/s.json', type: 'object', properties: { p: { $id: 'sub.json', $ref: ref } },
    }), [{ p: 1 }, { p: {} }], [false, true]],
    ['an item reference', (ref) => ({ $schema: D20, type: 'array', maxItems: 3, items: { $ref: ref } }), [[1], [[]], [[[1]]], [[1, 2, 3, 4]]], [false, true, false, false]],
    ['through a pointer chain', (ref) => ({ $schema: D20, type: 'object', $defs: { h: { $ref: ref } }, properties: { p: { $ref: '#/$defs/h' } } }), [{ p: 1 }, { p: {} }], [false, true]],
    ['a root reference to itself: a loop', (ref) => ({ $schema: D20, $ref: ref }), [1],
      'JK0001: JK0001: $ref cycle: https://github.com/jklarenbeek/jarenjs# refers to itself and never reads the instance'],
    ['2020-12 $dynamicRef', (ref) => ({ $schema: D20, type: 'object', properties: { p: { $dynamicRef: ref } } }), [{ p: 1 }, { p: {} }], [false, true]],
  ]);

  for (const [label, schema, instances, expected] of shapes) {
    it(`answers as "#": ${label}`, () => {
      assert.deepEqual(outcome(schema('#'), instances), expected, 'the "#" spelling');
      assert.deepEqual(outcome(schema(''), instances), expected, 'the blank spelling');
      assert.deepEqual(outcome(schema(' '), instances), expected, 'white space alone');
    });
  }

  it('in collect mode and in an output format', () => {
    const schema = { $schema: D20, type: 'object', properties: { p: { $ref: '' } } };
    assert.equal(new JarenValidator({ collectErrors: true }).compile(schema)({ p: 1 }).errors[0].keyword, 'type');
    assert.equal(new JarenValidator({ outputFormat: basicOutput }).compile(schema)({ p: 1 }).valid, false);
  });

  it('a registered document with a blank $ref answers where it is read', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'https://r.test/a.json', type: 'object', properties: { p: { $ref: '' } } });
    assert.deepEqual(answers(validator.compile({ $ref: 'https://r.test/a.json' }), [{ p: 1 }, { p: {} }]), [false, true]);
  });

  it('a ring through a blank $ref is refused by the compile that reaches it, not by addSchema', () => {
    for (const document of [
      { $id: 'https://x.test/a.json', $defs: { s: { type: 'string' } }, $ref: '' },
      { $id: 'https://x.test/a.json', $defs: { s: { type: 'string' }, b: { $ref: '' } }, $ref: '#/$defs/b' },
    ]) {
      const validator = new JarenValidator();
      validator.addSchema(document);
      assert.deepEqual(answers(validator.compile({ $ref: 'https://x.test/a.json#/$defs/s' }), [1, 's']), [false, true]);
      assert.throws(() => validator.compile({ $ref: 'https://x.test/a.json' }), { code: 'JK0001' });
      assert.deepEqual(answers(validator.compile({ type: 'string' }), [1, 's']), [false, true]);
    }
  });

  it('a ring through "#" is still refused by addSchema', () => {
    assert.throws(() => new JarenValidator().addSchema({ $id: 'https://x.test/a.json', $ref: '#' }), {
      code: 'JK0001', message: 'JK0001: $ref cycle: https://x.test/a.json# refers to itself and never reads the instance',
    });
  });
});

describe('the normalizer reads a blank $ref as "#" too', () => {
  it('resolves it to the document and normalizes through it', () => {
    for (const ref of ['#', '', ' ']) {
      const schema = { type: 'object', properties: { n: { type: 'integer' }, p: { $ref: ref } } };
      assert.equal(resolveSameDocumentRef(ref, schema), schema, JSON.stringify(ref));
      assert.deepEqual(compileNormalizer(schema, { coerceTypes: true })({ n: '1', p: { n: '2' } }), { n: 1, p: { n: 2 } }, JSON.stringify(ref));
    }
  });
});

describe('a blank $recursiveRef', () => {
  it('read as 2019-09 is no "#": JK0011 naming $ref', () => {
    const validate = new JarenValidator().compile({ $schema: D19, type: 'object', properties: { p: { $recursiveRef: '' } } });
    assert.deepEqual(answers(validate, [{}, { p: 1 }]), [true, 'JK0011']);
    assert.throws(() => validate({ p: 1 }), {
      message: `JK0011: $recursiveRef '' is defined only as "#"; to apply the schema it names, write $ref '' at https://github.com/jklarenbeek/jarenjs#/properties/p/%24recursiveRef`,
    });
  });
  it('2020-12 ignores it', () => {
    assert.deepEqual(outcome({ $schema: D20, type: 'object', properties: { p: { $recursiveRef: '' } } }, [{ p: 1 }]), [true]);
  });
});

// A `$ref` is read as the URL standard reads a reference, as the validator's
// own parse reads it: the C0 controls and spaces around it are dropped, and
// every tab and line break inside it. The normalizer and `@jarenjs/emit`
// resolve it to the same node the validator applies.
describe('a $ref with white space around it, or a tab or line break inside it', () => {
  const schema = (/** @type {string} */ ref) => ({ $schema: D20, type: 'object', properties: { kid: { $ref: ref } }, $defs: { n: { type: 'integer' } } });
  const target = schema('#/$defs/n').$defs.n;

  for (const ref of ['#/$defs/n ', ' #/$defs/n', '#/$defs/\nn', '\t#/$de\tfs/n\r\n', '\u0001#/$defs/n\u001f']) {
    it(`${JSON.stringify(ref)}: the validator, the normalizer and the resolver read #/$defs/n`, () => {
      const s = schema(ref);
      assert.deepEqual(outcome(s, [{ kid: 1 }, { kid: 'x' }]), [true, false]);
      assert.deepEqual(compileNormalizer(s, { coerceTypes: true })({ kid: '1' }), { kid: 1 });
      assert.equal(resolveSameDocumentRef(ref, s), s.$defs.n);
      assert.notEqual(resolveSameDocumentRef(ref, s), target, 'each schema its own node');
    });
  }

  it('a tab or line break around "#" names the document, as "#" does', () => {
    const s = { $schema: D20, type: 'object' };
    for (const ref of ['#\t', '\n#', '#  ', '\u0000']) assert.equal(resolveSameDocumentRef(ref, s), s, JSON.stringify(ref));
  });

  it('a space inside a pointer token is part of the name, as before', () => {
    const s = { $schema: D20, type: 'object', properties: { kid: { $ref: '#/$defs/a b' } }, $defs: { 'a b': { type: 'integer' } } };
    assert.deepEqual(outcome(s, [{ kid: 1 }, { kid: 'x' }]), [true, false]);
    assert.deepEqual(compileNormalizer(s, { coerceTypes: true })({ kid: '1' }), { kid: 1 });
  });

  it('a non-breaking space before "#" is no URL white space: the reference names another document, which nothing holds', () => {
    const s = schema(' #/$defs/n');
    assert.equal(resolveSameDocumentRef(' #/$defs/n', s), undefined);
    assert.equal(typeof outcome(s, [{ kid: 1 }]), 'string', 'the validator refuses it');
  });
});
