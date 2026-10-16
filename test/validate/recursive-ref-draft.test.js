import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { verboseOutput } from '@jarenjs/validate/output';
import { compileAsync } from '@jarenjs/validate/load';

// A dynamic reference is a keyword only in the drafts that define it:
// `$recursiveRef` in 2019-09, `$dynamicRef` from 2020-12 on. A document that
// declares another draft reads it as an unknown keyword, which applies
// nothing; a document that declares none reads both.

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
const compiled = (schema, options = {}) => new JarenValidator(options).compile(schema);
const outcome = (fn) => {
  try { return fn(); }
  catch (e) { return /** @type {any} */ (e).code; }
};

describe('$recursiveRef in a document that declares a draft other than 2019-09', () => {
  it('the entry input: 2020-12 ignores the keyword', () => {
    const schema = { $schema: D20, type: 'object', properties: { p: { $recursiveRef: '#' } } };
    assert.deepEqual(answers(compiled(schema), [{ p: 1 }, { p: {} }, 1]), [true, true, false]);
  });

  for (const [label, $schema] of [['draft-07', D07], ['2020-12', D20]]) {
    it(`${label}: "#" applies nothing`, () => {
      assert.deepEqual(answers(compiled({ $schema, type: 'object', properties: { p: { $recursiveRef: '#' } } }), [{ p: 1 }]), [true]);
    });
    it(`${label}: a value nothing resolves applies nothing, not JK0009`, () => {
      assert.deepEqual(answers(compiled({ $schema, properties: { p: { $recursiveRef: '#/$defs/nope' } } }), [{ p: 1 }]), [true]);
      assert.deepEqual(answers(compiled({ $schema, properties: { p: { $recursiveRef: 'https://o.test/d.json' } } }), [{ p: 1 }]), [true]);
    });
    it(`${label}: a value that is no URI applies nothing, not JK0010`, () => {
      assert.deepEqual(answers(compiled({ $schema, properties: { p: { $recursiveRef: 'http://[x' } } }), [{ p: 1 }]), [true]);
    });
    it(`${label}: beside $recursiveAnchor: true it applies nothing`, () => {
      const schema = { $schema, $recursiveAnchor: true, type: 'object', properties: { p: { $recursiveRef: '#' } } };
      assert.deepEqual(answers(compiled(schema), [{ p: 1 }, { p: {} }]), [true, true]);
    });
    it(`${label}: a root $recursiveRef "#" is no loop`, () => {
      assert.deepEqual(answers(compiled({ $schema, $recursiveRef: '#' }), [1, 'a', {}]), [true, true, true]);
      assert.deepEqual(answers(compiled({ $schema, allOf: [{ $recursiveRef: '#' }] }), [1]), [true]);
    });
    it(`${label}: in collect mode and in an output format`, () => {
      const schema = { $schema, type: 'object', properties: { p: { $recursiveRef: '#' } } };
      assert.deepEqual(compiled(schema, { collectErrors: true })({ p: 1 }), { valid: true, errors: [] });
      assert.equal(compiled(schema, { outputFormat: verboseOutput })({ p: 1 }).valid, true);
    });
  }

  it('2020-12: the $ref beside it applies alone', () => {
    const schema = { $schema: D20, type: 'object', $defs: { s: { type: 'string' } }, properties: { p: { $ref: '#/$defs/s', $recursiveRef: '#' } } };
    assert.deepEqual(answers(compiled(schema), [{ p: 's' }, { p: 1 }, { p: {} }]), [true, false, false]);
  });

  it('2020-12: unevaluatedProperties beside the $ref sees what the $ref evaluated', () => {
    const schema = { $schema: D20, $defs: { a: { properties: { x: true } } }, $ref: '#/$defs/a', $recursiveRef: '#', unevaluatedProperties: false };
    assert.deepEqual(answers(compiled(schema), [{ x: 1 }, { y: 1 }]), [true, false]);
  });

  it('2020-12: a verbose output lists no $recursiveRef it did not evaluate', () => {
    const schema = { $schema: D20, type: 'object', properties: { p: { $recursiveRef: '#', type: 'number' } } };
    const output = JSON.stringify(compiled(schema, { outputFormat: verboseOutput })({ p: 1 }));
    assert.equal(output.includes('$recursiveRef'), false, output);
    assert.equal(output.includes('/properties/p/type'), true);
  });

  it('a 2020-12 subschema inside a 2019-09 document ignores it, a 2019-09 one inside a 2020-12 document reads it', () => {
    const inner20 = { $schema: D19, type: 'object', properties: { a: { $schema: D20, $id: 'https://n.test/a', type: 'object', properties: { p: { $recursiveRef: '#' } } } } };
    assert.deepEqual(answers(compiled(inner20), [{ a: { p: 1 } }]), [true]);
    const inner19 = { $schema: D20, type: 'object', properties: { a: { $schema: D19, $id: 'https://n.test/b', type: 'object', properties: { p: { $recursiveRef: '#' } } } } };
    assert.deepEqual(answers(compiled(inner19), [{ a: { p: 1 } }, { a: { p: {} } }]), [false, true]);
  });

  it('compileAsync asks for nothing a 2020-12 $recursiveRef names', async () => {
    const asked = [];
    const validate = await compileAsync(new JarenValidator(), { $schema: D20, properties: { p: { $recursiveRef: 'https://o.test/d.json' } } },
      { loadSchema: async (uri) => { asked.push(uri); return { type: 'string' }; } });
    assert.deepEqual(asked, []);
    assert.equal(validate({ p: 1 }), true);
  });
});

describe('$recursiveRef where it is a keyword (unchanged)', () => {
  it('2019-09 reads "#"', () => {
    assert.deepEqual(answers(compiled({ $schema: D19, type: 'object', properties: { p: { $recursiveRef: '#' } } }), [{ p: 1 }, { p: {} }]), [false, true]);
  });
  it('a document that declares no draft reads "#"', () => {
    assert.deepEqual(answers(compiled({ type: 'object', properties: { p: { $recursiveRef: '#' } } }), [{ p: 1 }, { p: {} }]), [false, true]);
  });
  it('a registered document that declares no draft reads it under a 2020-12 compile', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'https://r.test/u.json', type: 'object', properties: { p: { $recursiveRef: '#' } } });
    const validate = validator.compile({ $schema: D20, $ref: 'https://r.test/u.json' });
    assert.deepEqual(answers(validate, [{ p: 1 }, { p: {} }]), [false, true]);
  });
  it('2019-09 refuses a root "#" loop JK0001', () => {
    assert.equal(outcome(() => compiled({ $schema: D19, $recursiveRef: '#' })), 'JK0001');
  });
  it('2019-09 refuses another value JK0011', () => {
    assert.deepEqual(answers(compiled({ $schema: D19, $defs: { x: { type: 'string' } }, properties: { p: { $recursiveRef: '#/$defs/x' } } }), [{}, { p: 1 }]), [true, 'JK0011']);
  });
  it('2019-09: the $ref beside it applies too', () => {
    const schema = { $schema: D19, type: 'object', $defs: { s: { type: 'string' } }, properties: { p: { $ref: '#/$defs/s', $recursiveRef: '#' } } };
    assert.deepEqual(answers(compiled(schema), [{ p: 's' }, { p: {} }]), [false, false]);
  });
});

describe('$dynamicRef in a document that declares a draft before 2020-12', () => {
  for (const [label, $schema] of [['draft-07', D07], ['2019-09', D19]]) {
    it(`${label}: "#" applies nothing`, () => {
      assert.deepEqual(answers(compiled({ $schema, type: 'object', properties: { p: { $dynamicRef: '#' } } }), [{ p: 1 }, { p: {} }]), [true, true]);
    });
    it(`${label}: a value nothing resolves applies nothing, not JK0009`, () => {
      assert.deepEqual(answers(compiled({ $schema, properties: { p: { $dynamicRef: '#/$defs/nope' } } }), [{ p: 1 }]), [true]);
    });
    it(`${label}: a root $dynamicRef to its own anchor is no loop`, () => {
      assert.deepEqual(answers(compiled({ $schema, $dynamicAnchor: 'n', $dynamicRef: '#n' }), [1]), [true]);
    });
  }

  it('2019-09: the $ref beside it applies alone', () => {
    const schema = { $schema: D19, $defs: { yes: true, no: false }, $ref: '#/$defs/yes', $dynamicRef: '#/$defs/no' };
    assert.deepEqual(answers(compiled(schema), [0]), [true]);
  });

  it('compileAsync asks for nothing a 2019-09 $dynamicRef names', async () => {
    const asked = [];
    const validate = await compileAsync(new JarenValidator(), { $schema: D19, properties: { p: { $dynamicRef: 'https://o.test/d.json' } } },
      { loadSchema: async (uri) => { asked.push(uri); return { type: 'string' }; } });
    assert.deepEqual(asked, []);
    assert.equal(validate({ p: 1 }), true);
  });
});

describe('$dynamicRef where it is a keyword (unchanged)', () => {
  it('2020-12 reads it', () => {
    assert.deepEqual(answers(compiled({ $schema: D20, type: 'object', properties: { p: { $dynamicRef: '#' } } }), [{ p: 1 }, { p: {} }]), [false, true]);
  });
  it('a document that declares no draft reads it', () => {
    assert.deepEqual(answers(compiled({ type: 'object', properties: { p: { $dynamicRef: '#' } } }), [{ p: 1 }, { p: {} }]), [false, true]);
  });
  it('2020-12 refuses a root loop to its own anchor JK0001', () => {
    assert.equal(outcome(() => compiled({ $schema: D20, $dynamicAnchor: 'n', $dynamicRef: '#n' })), 'JK0001');
  });
  it('2020-12: compileAsync asks for what it names', async () => {
    const asked = [];
    const validate = await compileAsync(new JarenValidator(), { $schema: D20, properties: { p: { $dynamicRef: 'https://o.test/d.json' } } },
      { loadSchema: async (uri) => { asked.push(uri); return { type: 'string' }; } });
    assert.deepEqual(asked, ['https://o.test/d.json']);
    assert.deepEqual(answers(validate, [{ p: 1 }, { p: 's' }]), [false, true]);
  });
});

describe('a $schema that names no draft this package knows reads both, as where none is declared (unchanged)', () => {
  const OAS = 'https://spec.openapis.org/oas/3.1/dialect/base';
  const CUSTOM = 'https://example.com/my-meta';
  for (const $schema of [OAS, CUSTOM]) {
    it(`${$schema}: $dynamicRef and $recursiveRef apply`, () => {
      for (const keyword of ['$dynamicRef', '$recursiveRef'])
        assert.deepEqual(answers(compiled({ $schema, type: 'object', properties: { p: { [keyword]: '#' } } }), [{ p: 1 }, { p: {} }]), [false, true], keyword);
    });
    it(`${$schema}: a nested subschema inherits the reading`, () => {
      const schema = { $schema, type: 'object', properties: { a: { type: 'object', properties: { p: { $dynamicRef: '#' } } } } };
      assert.deepEqual(answers(compiled(schema), [{ a: { p: 1 } }, { a: { p: {} } }]), [false, true]);
    });
  }
  it('a root loop through one is refused JK0001', () => {
    assert.equal(outcome(() => compiled({ $schema: OAS, $dynamicAnchor: 'n', $dynamicRef: '#n' })), 'JK0001');
  });
  it('a verbose output lists it', () => {
    const schema = { $schema: OAS, type: 'object', properties: { p: { $dynamicRef: '#/$defs/n' } }, $defs: { n: { type: 'number' } } };
    assert.equal(JSON.stringify(compiled(schema, { outputFormat: verboseOutput })({ p: 1 })).includes('/properties/p/$dynamicRef'), true);
  });
  it('compileAsync asks for what it names', async () => {
    const asked = [];
    await compileAsync(new JarenValidator(), { $schema: OAS, properties: { p: { $dynamicRef: 'https://o.test/d.json' } } },
      { loadSchema: async (uri) => { asked.push(uri); return uri === OAS ? {} : { type: 'string' }; } });
    assert.deepEqual(asked.sort(), [OAS, 'https://o.test/d.json'].sort());
  });
  it('a registered document under one, compiled from a 2020-12 schema', () => {
    const validator = new JarenValidator();
    validator.addSchema({ $schema: OAS, $id: 'https://r.test/o.json', type: 'object', properties: { p: { $recursiveRef: '#' } } });
    assert.deepEqual(answers(validator.compile({ $schema: D20, $ref: 'https://r.test/o.json' }), [{ p: 1 }, { p: {} }]), [false, true]);
  });
});
