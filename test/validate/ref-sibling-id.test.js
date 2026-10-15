// Before 2019-09 a `$ref` replaces the schema object it sits in, so an `$id`
// beside it does not set the base the reference resolves against. The walk
// that registers a document (and finds what `compileAsync` loads) and the
// compiler read that `$id` the same way; the `$id` still names the object.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError, VALIDATE_CODES } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';

const BASE = 'https://github.com/jklarenbeek/';
const D7 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
// `name.json` holds strings, `sub/name.json` numbers: an answer names the base read.
const STRING_AT_BASE = { type: 'string' };
const NUMBER_UNDER_SUB = { type: 'number' };
const doc = ($schema, ref) => {
  const key = $schema === D19 || $schema === D20 ? '$defs' : 'definitions';
  return { ...($schema === undefined ? {} : { $schema }),
    [key]: { a: { $id: 'sub/a.json', $ref: 'name.json' } }, $ref: ref ?? 'sub/a.json' };
};
const pointerOf = ($schema) => ($schema === D19 || $schema === D20 ? '#/$defs/a' : '#/definitions/a');
const load = (asked) => async (uri) => {
  asked.push(uri.slice(BASE.length));
  return uri.endsWith('/sub/name.json') ? NUMBER_UNDER_SUB : STRING_AT_BASE;
};
const registered = (...names) => {
  const validator = new JarenValidator();
  for (const name of names) validator.addSchema(name === 'name.json' ? STRING_AT_BASE : NUMBER_UNDER_SUB, BASE + name);
  return validator;
};

describe('a draft-07 $id beside $ref does not set the base of that $ref', () => {
  for (const $schema of [undefined, D7]) {
    const label = $schema === undefined ? 'no $schema (draft-07)' : 'declared draft-07';

    it(`${label}: compileAsync loads the reference under the enclosing base and answers`, async () => {
      for (const ref of ['sub/a.json', pointerOf($schema)]) {
        const asked = [];
        const validate = await compileAsync(new JarenValidator(), doc($schema, ref), { loadSchema: load(asked) });
        assert.deepEqual(asked, ['name.json'], ref);
        assert.deepEqual([validate('x'), validate(5)], [true, false], ref);
      }
    });

    it(`${label}: addSchema + compile reads the same document`, () => {
      for (const ref of ['sub/a.json', pointerOf($schema)]) {
        for (const names of [['name.json'], ['name.json', 'sub/name.json']]) {
          const validate = registered(...names).compile(doc($schema, ref));
          assert.deepEqual([validate('x'), validate(5)], [true, false], `${ref} ${names}`);
        }
      }
    });

    it(`${label}: a reference that then resolves to nothing is refused when compiled, coded`, () => {
      for (const ref of ['sub/a.json', pointerOf($schema)]) {
        for (const names of [[], ['sub/name.json']]) {
          let refused;
          try { registered(...names).compile(doc($schema, ref)); }
          catch (error) { refused = error; }
          assert.ok(refused instanceof SchemaCompileError, `${ref} ${names}: ${refused}`);
          assert.equal(refused.code, 'JK0008');
          assert.match(refused.message, /^JK0008: Can not resolve schema for 'https:\/\/github\.com\/jklarenbeek\/name\.json#'/);
          assert.match(refused.message, /draft-07 \$ref ignores the \$id beside it/);
          assert.match(refused.message, /register that URI, or declare \$schema 2019-09 or later$/);
        }
      }
      // a target in a document nothing holds is refused the same way
      const pointer = { ...doc($schema), definitions: { a: { $id: 'sub/a.json', $ref: 'other.json#/definitions/x' } } };
      assert.throws(() => new JarenValidator().compile(pointer), (error) => error.code === 'JK0008'
        && error.message.startsWith("JK0008: Can not resolve schema for 'https://github.com/jklarenbeek/other.json#/definitions/x'"));
      assert.equal(typeof VALIDATE_CODES.JK0008, 'string');
    });
  }
});

describe('the refusal says why only for the compile whose walk kept the base', () => {
  it('a later compile of a plain reference to the same URI is refused as before', () => {
    const validator = new JarenValidator();
    assert.throws(() => validator.compile(doc(undefined)), (error) => error.code === 'JK0008');
    assert.throws(() => validator.compile({ $schema: D20, $ref: 'name.json' }), (error) =>
      !(error instanceof SchemaCompileError) && error.message === `Can not resolve schema for '${BASE}name.json#'`);
  });
});

describe('from 2019-09 on an $id beside $ref sets its base, as before', () => {
  for (const $schema of [D19, D20]) {
    it(`${$schema}: both loaders and compile read sub/name.json`, async () => {
      for (const ref of ['sub/a.json', pointerOf($schema)]) {
        const asked = [];
        const loaded = await compileAsync(new JarenValidator(), doc($schema, ref), { loadSchema: load(asked) });
        assert.deepEqual(asked, ['sub/name.json'], ref);
        assert.deepEqual([loaded('x'), loaded(5)], [false, true], ref);
        const compiled = registered('name.json', 'sub/name.json').compile(doc($schema, ref));
        assert.deepEqual([compiled('x'), compiled(5)], [false, true], ref);
        assert.throws(() => registered('name.json').compile(doc($schema, ref)), (error) =>
          !(error instanceof SchemaCompileError) && /^Can not resolve schema for 'https:\/\/github\.com\/jklarenbeek\/sub\/name\.json#'$/.test(error.message));
      }
    });
  }

  it('a document registered without $schema keeps reading the $id beside $ref as a base', () => {
    const held = { $id: 'https://held.test/root.json', $defs: { a: { $id: 'sub/a.json', $ref: 'name.json' } } };
    for (const $schema of [D19, D20]) {
      const validator = new JarenValidator()
        .addSchema(held)
        .addSchema(STRING_AT_BASE, 'https://held.test/name.json')
        .addSchema(NUMBER_UNDER_SUB, 'https://held.test/sub/name.json');
      const validate = validator.compile({ $schema, $ref: 'https://held.test/sub/a.json' });
      assert.deepEqual([validate('x'), validate(5)], [false, true], $schema);
    }
  });
});
