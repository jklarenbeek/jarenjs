// A document registered without `$schema` holds an `$id` beside a `$ref`. Each
// compile reads it under the draft that compile names, whichever URI reaches
// the object: draft-07 resolves the `$ref` against the enclosing base (the
// `$id` sets no base beside a `$ref`), 2019-09 on against the `$id`. A
// declared draft-07 document is the oracle for the draft-07 reading.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';

const D7 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const IGNORED_ID = 'a draft-07 $ref ignores the $id beside it; register that URI, or declare $schema 2019-09 or later';
const UNHELD = 'no schema the validator holds has that URI; register it with addSchema, load it with compileAsync, or fix the reference';

const ROOT = 'https://held.test/root.json';
const NAME = 'https://held.test/name.json';
const SUB_NAME = 'https://held.test/sub/name.json';
/** @param {string} [draft] */
const holder = (draft) => ({ ...(draft ? { $schema: draft } : {}), $id: ROOT, $defs: { a: { $id: 'sub/a.json', $ref: 'name.json' } } });
const strings = () => ({ $id: NAME, type: 'string' });
const numbers = () => ({ $id: SUB_NAME, type: 'number' });
/** @param {string} [draft] - p reaches the object by its `$id`, q by a pointer */
const schema = (draft) => ({ ...(draft ? { $schema: draft } : {}), properties: { p: { $ref: 'https://held.test/sub/a.json' }, q: { $ref: `${ROOT}#/$defs/a` } } });
const INSTANCES = [{ p: 'x' }, { p: 5 }, { q: 'x' }, { q: 5 }, {}];

/** Each instance's answer, or the code its call is refused with. */
const answers = (validate) => INSTANCES.map((instance) => {
  try { return validate(instance); }
  catch (error) { return error instanceof SchemaCompileError ? error.code : 'uncoded'; }
});

/** A validator holding the documents, in order. */
const holding = (...documents) => {
  const validator = new JarenValidator();
  for (const document of documents) validator.addSchema(document);
  return validator;
};

const thrown = (fn) => {
  try { fn(); }
  catch (error) { return error.message; }
  return 'no throw';
};

describe('a draft-07 compile reads an undeclared document one way', () => {
  for (const [label, draft] of [['an undeclared compile', undefined], ['a draft-07 compile', D7]]) {
    it(`${label}: both URIs held, a pointer reads what the $id reference reads`, () => {
      assert.deepEqual(answers(holding(holder(), strings(), numbers()).compile(schema(draft))), [true, false, true, false, true]);
    });

    it(`${label}: only the URI draft-07 reads held, it answers`, () => {
      assert.deepEqual(answers(holding(holder(), strings()).compile(schema(draft))), [true, false, true, false, true]);
    });

    it(`${label}: only the URI the $id names held, each call that reaches the object is refused`, () => {
      const validate = holding(holder(), numbers()).compile(schema(draft));
      assert.deepEqual(answers(validate), ['JK0008', 'JK0008', 'JK0008', 'JK0008', true]);
      assert.equal(thrown(() => validate({ q: 5 })), `JK0008: Can not resolve schema for '${NAME}#': ${IGNORED_ID} at ${ROOT}#/$defs/a/%24ref`);
    });
  }

  it('reads as the same document declared draft-07 does', () => {
    assert.deepEqual(answers(holding(holder(D7), strings(), numbers()).compile(schema())), [true, false, true, false, true]);
    assert.deepEqual(answers(holding(holder(D7), strings()).compile(schema())), [true, false, true, false, true]);
  });

  it('a target both readings name is still needed when the schema compiles', () => {
    const validator = holding({ $id: ROOT, $defs: { a: { $id: 'a.json', $ref: 'name.json' } } });
    assert.equal(thrown(() => validator.compile({ properties: { p: { $ref: 'https://held.test/a.json' } } })),
      `JK0009: Can not resolve schema for '${NAME}#': ${UNHELD}`);
  });

  it('a loop only the 2019-09 reading makes is no loop for it', () => {
    // sub/name.json leads back to the object: a loop when the $id sets the base
    const loopsBack = { $id: SUB_NAME, $ref: `${ROOT}#/$defs/a` };
    for (const via of [`${ROOT}#/$defs/a`, 'https://held.test/sub/a.json']) {
      const validate = holding(loopsBack, holder(), strings()).compile({ properties: { p: { $ref: via } } });
      assert.deepEqual([{ p: 'x' }, { p: 5 }, {}].map((instance) => validate(instance)), [true, false, true]);
    }
  });

  it('a $dynamicRef pointer to the object reads what the $id reference reads', () => {
    const validate = holding(holder(), strings(), numbers()).compile({ properties: { p: { $dynamicRef: `${ROOT}#/$defs/a` } } });
    assert.deepEqual([{ p: 'x' }, { p: 5 }, {}].map((instance) => validate(instance)), [true, false, true]);
  });

  it('a relative $data behind the object is read where the draft-07 target puts it', () => {
    const minimumOfSibling = { $id: NAME, properties: { y: { minimum: { $data: '1/min' } } } };
    const validate = holding(holder(), minimumOfSibling, { $id: SUB_NAME, type: 'object' })
      .compile({ properties: { p: { $ref: `${ROOT}#/$defs/a` } } });
    assert.deepEqual([{ p: { min: 3, y: 2 } }, { p: { min: 3, y: 5 } }, {}].map((instance) => validate(instance)), [false, true, true]);
  });

  it('the documents registered in another order', () => {
    assert.deepEqual(answers(holding(numbers(), strings(), holder()).compile(schema())), [true, false, true, false, true]);
  });
});

describe('a 2019-09 compile reads the $id as the base, as before', () => {
  it('both URIs held', () => {
    assert.deepEqual(answers(holding(holder(), strings(), numbers()).compile(schema(D19))), [false, true, false, true, true]);
  });

  it('only the URI the $id names held', () => {
    assert.deepEqual(answers(holding(holder(), numbers()).compile(schema(D19))), [false, true, false, true, true]);
  });

  it('only the URI draft-07 reads held: refused when it compiles', () => {
    assert.equal(thrown(() => holding(holder(), strings()).compile(schema(D19))),
      `JK0009: Can not resolve schema for '${SUB_NAME}#': ${UNHELD}`);
  });
});

describe('one validator, compiles of both drafts in turn', () => {
  it('draft-07, 2019-09, draft-07', () => {
    const validator = holding(holder(), strings(), numbers());
    assert.deepEqual(
      [answers(validator.compile(schema())), answers(validator.compile(schema(D19))), answers(validator.compile(schema()))],
      [[true, false, true, false, true], [false, true, false, true, true], [true, false, true, false, true]]);
  });

  it('2019-09, draft-07, 2019-09', () => {
    const validator = holding(holder(), strings(), numbers());
    assert.deepEqual(
      [answers(validator.compile(schema(D19))), answers(validator.compile(schema())), answers(validator.compile(schema(D19)))],
      [[false, true, false, true, true], [true, false, true, false, true], [false, true, false, true, true]]);
  });
});

describe('compileAsync loads the URI the compile reads', () => {
  /** @param {string[]} available */
  const loading = (available) => {
    const documents = { [ROOT]: holder, [NAME]: strings, [SUB_NAME]: numbers };
    const asked = [];
    const loadSchema = async (uri) => {
      asked.push(uri);
      if (!available.includes(uri)) throw new Error(`no ${uri}`);
      return documents[uri]();
    };
    return { asked, loadSchema };
  };

  it('a draft-07 compile asks for the URI draft-07 reads', async () => {
    const { asked, loadSchema } = loading([ROOT, NAME]);
    const validate = await compileAsync(new JarenValidator(), schema(), { loadSchema });
    assert.deepEqual(asked, ['https://held.test/sub/a.json', ROOT, NAME]);
    assert.deepEqual(answers(validate), [true, false, true, false, true]);
  });

  it('a draft-07 target the loader cannot serve is refused by the call that reaches it, as compile refuses it', async () => {
    const { asked, loadSchema } = loading([ROOT, SUB_NAME]);
    const validate = await compileAsync(new JarenValidator(), schema(), { loadSchema });
    assert.deepEqual(asked, ['https://held.test/sub/a.json', ROOT, NAME]);
    assert.deepEqual(answers(validate), answers(holding(holder(), numbers()).compile(schema())));
    assert.deepEqual(answers(validate), ['JK0008', 'JK0008', 'JK0008', 'JK0008', true]);
  });

  it('in the schema compiled, a draft-07 target the loader cannot serve is refused when it loads, as before', async () => {
    const asked = [];
    const loadSchema = async (uri) => {
      asked.push(uri);
      throw new Error(`no ${uri}`);
    };
    await assert.rejects(
      () => compileAsync(new JarenValidator(), { $id: 'https://own.test/root.json', $defs: { a: { $id: 'sub/a.json', $ref: 'name.json' } }, $ref: 'sub/a.json' }, { loadSchema }),
      { code: 'JK0004', message: "JK0004: loadSchema('https://own.test/name.json') failed: no https://own.test/name.json at #/%24defs/a/%24ref" });
    assert.deepEqual(asked, ['https://own.test/name.json']);
  });

  it('a 2019-09 compile asks for the URI the $id names, as before', async () => {
    const { asked, loadSchema } = loading([ROOT, SUB_NAME]);
    const validate = await compileAsync(new JarenValidator(), schema(D19), { loadSchema });
    assert.deepEqual(asked, ['https://held.test/sub/a.json', ROOT, SUB_NAME]);
    assert.deepEqual(answers(validate), [false, true, false, true, true]);
  });
});
