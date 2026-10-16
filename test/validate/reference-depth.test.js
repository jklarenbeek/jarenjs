//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { JarenValidator, SchemaCompileError, SchemaRuntimeError, VALIDATE_CODES } from '@jarenjs/validate';
import { getSchemaDraftByName, getSchemaDraftByVersion } from '@jarenjs/refs';
import { stringFormats } from '@jarenjs/formats';

/** @param {number} n @returns {any} `n` arrays nested around `0` */
const nestedArrays = (n) => { let v = /** @type {any} */ (0); for (let i = 0; i < n; i++) v = [v]; return v; };
/** @param {number} n @returns {any} `n` objects nested around `0` under `a` */
const nestedObjects = (n) => { let v = /** @type {any} */ (0); for (let i = 0; i < n; i++) v = { a: v }; return v; };
/** @param {any} result */
const answer = (result) => (typeof result === 'object' ? result.valid : result);

const DRAFTS = ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema'];
/** Each mode: the collecting flag and the draft the schema declares. */
const MODES = [false, true].flatMap((collectErrors) => DRAFTS.map(($schema) => ({ collectErrors, $schema })));
const INSTANCES = [1, 'a', null, true, [], {}, { a: 1 }];
const loopRefusal = { name: 'SchemaCompileError', code: 'JK0001' };
const depthRefusal = { name: 'SchemaRuntimeError', code: 'JK2001' };

describe('a root that comes back to itself before reading the instance', () => {
  const loops = /** @type {[string, any][]} */ ([
    ['the only allOf member', { allOf: [{ $ref: '#' }] }],
    ['the first anyOf member', { anyOf: [{ $ref: '#' }, { type: 'string' }] }],
    ['the first oneOf member', { oneOf: [{ $ref: '#' }, { type: 'string' }] }],
    ['not', { not: { $ref: '#' } }],
    ['if beside then', { if: { $ref: '#' }, then: {} }],
    ['if beside else', { if: { $ref: '#' }, else: {} }],
    ['a $ref whose siblings assert', { type: 'string', $ref: '#/$defs/x', $defs: { x: { allOf: [{ $ref: '#' }] } } }],
    ['a ring through two definitions', { $defs: { a: { allOf: [{ $ref: '#/$defs/b' }] }, b: { anyOf: [{ $ref: '#/$defs/a' }] } }, $ref: '#/$defs/a' }],
  ]);

  for (const [label, schema] of loops) {
    it(`is refused when it is compiled: ${label}`, () => {
      for (const { collectErrors, $schema } of MODES)
        assert.throws(() => new JarenValidator({ collectErrors }).compile({ ...structuredClone(schema), $schema }), loopRefusal);
    });
  }

  it('names the schema locations on the loop', () => {
    const compile = (/** @type {any} */ schema) => new JarenValidator().compile(schema);
    assert.throws(() => compile({ $id: 'http://loop.test/a', allOf: [{ $ref: '#' }] }), {
      message: 'JK0001: $ref cycle: http://loop.test/a# -> http://loop.test/a#/allOf/0 -> http://loop.test/a# never reads the instance',
    });
    assert.throws(() => compile({
      $id: 'http://loop.test/r', $defs: { a: { allOf: [{ $ref: '#/$defs/b' }] }, b: { anyOf: [{ $ref: '#/$defs/a' }] } }, $ref: '#/$defs/a',
    }), {
      message: 'JK0001: $ref cycle: http://loop.test/r#/$defs/a -> http://loop.test/r#/$defs/a/allOf/0 -> http://loop.test/r#/$defs/b'
        + ' -> http://loop.test/r#/$defs/b/anyOf/0 -> http://loop.test/r#/$defs/a never reads the instance',
    });
  });

  it('is an instance of the exported class', () => {
    try { new JarenValidator().compile({ allOf: [{ $ref: '#' }] }); assert.fail('compiled'); }
    catch (e) { assert.ok(e instanceof SchemaCompileError); assert.equal(/** @type {any} */ (e).code, 'JK0001'); }
  });

  // Each row: a loop only some instances reach and the answers it gave before
  // the bound existed, per mode (boolean then collecting mode, each under
  // draft-07, 2019-09 and 2020-12), per instance (T/F; R where the call
  // overflowed the stack, now refused JK2001).
  const reachedSometimes = /** @type {[string, any, string][]} */ ([
    ['anyOf after a member that can match', { anyOf: [{ type: 'string' }, { $ref: '#' }] },
      'RTRRRRR RTRRRRR RTRRRRR RTRRRRR RTRRRRR RTRRRRR'],
    ['allOf after a member that can fail', { allOf: [{ type: 'string' }, { $ref: '#' }] },
      'FRFFFFF FRFFFFF FRFFFFF RRRRRRR RRRRRRR RRRRRRR'],
    ['allOf beside an assertion', { type: 'string', allOf: [{ $ref: '#' }] },
      'FRFFFFF FRFFFFF FRFFFFF RRRRRRR RRRRRRR RRRRRRR'],
    ['allOf written before an assertion', { allOf: [{ $ref: '#' }], type: 'string' },
      'FRFFFFF FRFFFFF FRFFFFF RRRRRRR RRRRRRR RRRRRRR'],
    ['then behind a condition', { if: { type: 'string' }, then: { $ref: '#' } },
      'TRTTTTT TRTTTTT TRTTTTT TRTTTTT TRTTTTT TRTTTTT'],
    ['else behind a condition', { if: { type: 'string' }, else: { $ref: '#' } },
      'RTRRRRR RTRRRRR RTRRRRR RTRRRRR RTRRRRR RTRRRRR'],
    ['then behind a true condition', { if: true, then: { $ref: '#' } },
      'RRRRRRR RRRRRRR RRRRRRR RRRRRRR RRRRRRR RRRRRRR'],
    ['a dependent schema (a keyword from 2019-09 on)', { dependentSchemas: { a: { $ref: '#' } } },
      'TTTTTTT TTTTTTR TTTTTTR TTTTTTT TTTTTTR TTTTTTR'],
    ['an if with neither then nor else', { if: { $ref: '#' } },
      'TTTTTTT TTTTTTT TTTTTTT TTTTTTT TTTTTTT TTTTTTT'],
    ['a definition no reference reaches', { type: 'string', $defs: { a: { allOf: [{ $ref: '#/$defs/a' }] } } },
      'FTFFFFF FTFFFFF FTFFFFF FTFFFFF FTFFFFF FTFFFFF'],
  ]);

  for (const [label, schema, expected] of reachedSometimes) {
    it(`keeps compiling, answers as before and refuses only the instances that loop: ${label}`, () => {
      const got = MODES.map(({ collectErrors, $schema }) => {
        const validate = new JarenValidator({ collectErrors }).compile({ ...structuredClone(schema), $schema });
        return INSTANCES.map((instance) => {
          try { return answer(validate(instance)) ? 'T' : 'F'; }
          catch (e) { assert.equal(/** @type {any} */ (e).code, 'JK2001'); return 'R'; }
        }).join('');
      }).join(' ');
      assert.equal(got, expected);
    });
  }

  // Each row: a root loop beside keywords that may or may not fail an
  // instance, per mode as above: K where compile() refuses JK0001, else the
  // answers per instance. Every K row answered nothing before (R on every
  // instance in every mode); every other row answers as it did.
  const besideTheLoop = /** @type {[string, any, string, object?][]} */ ([
    ['an unknown x- keyword', { 'x-note': 1, allOf: [{ $ref: '#' }] }, 'K K K K K K'],
    ['format with no compiler registered', { format: 'email', allOf: [{ $ref: '#' }] }, 'K K K K K K'],
    ['format asserting', { format: 'email', allOf: [{ $ref: '#' }] }, 'RFRRRRR RFRRRRR K RRRRRRR RRRRRRR K', { formats: true }],
    ['format asserting by option', { format: 'email', allOf: [{ $ref: '#' }] },
      'RFRRRRR RFRRRRR RFRRRRR RRRRRRR RRRRRRR RRRRRRR', { formats: true, formatAssertion: true }],
    ['contentMediaType', { contentMediaType: 'application/json', allOf: [{ $ref: '#' }] }, 'RFRRRRR K K RRRRRRR K K'],
    ['contentEncoding', { contentEncoding: 'base64', allOf: [{ $ref: '#' }] }, 'RFRRRRR K K RRRRRRR K K'],
    ['unevaluatedProperties: true', { unevaluatedProperties: true, allOf: [{ $ref: '#' }] }, 'K K K K K K'],
    ['additionalProperties: {}', { additionalProperties: {}, allOf: [{ $ref: '#' }] }, 'K K K K K K'],
    ['items: true', { items: true, allOf: [{ $ref: '#' }] }, 'K K K K K K'],
    ['propertyDependencies while it is not a keyword', { propertyDependencies: { a: { b: false } }, allOf: [{ $ref: '#' }] }, 'K K K K K K'],
    // a dynamic reference its document's draft does not define applies nothing
    ['a $dynamicRef to its own anchor', { $dynamicAnchor: 'n', allOf: [{ $dynamicRef: '#n' }] }, 'TTTTTTT TTTTTTT K TTTTTTT TTTTTTT K'],
    ['a bare $dynamicRef', { $dynamicAnchor: 'n', $dynamicRef: '#n' }, 'TTTTTTT TTTTTTT K TTTTTTT TTTTTTT K'],
    ['a $recursiveRef', { $recursiveAnchor: true, allOf: [{ $recursiveRef: '#' }] }, 'TTTTTTT K TTTTTTT TTTTTTT K TTTTTTT'],
    ['a $dynamicRef in an embedded resource, whose dynamic target reads', {
      $id: 'http://loop.test/a', $defs: { r: { $dynamicAnchor: 'n', type: 'string' } },
      allOf: [{ $id: 'http://loop.test/b', $dynamicAnchor: 'n', allOf: [{ $dynamicRef: '#n' }] }],
    }, 'TTTTTTT TTTTTTT FTFFFFF TTTTTTT TTTTTTT FTFFFFF'],
    ['a $dynamicRef beside an assertion', { $dynamicAnchor: 'n', type: 'string', allOf: [{ $dynamicRef: '#n' }] },
      'FTFFFFF FTFFFFF FRFFFFF FTFFFFF FTFFFFF RRRRRRR'],
    ['allOf after {}', { allOf: [{}, { $ref: '#' }] }, 'K K K K K K'],
    ['allOf after an annotation', { allOf: [{ title: 't' }, { $ref: '#' }] }, 'K K K K K K'],
    ['allOf after false', { allOf: [false, { $ref: '#' }] }, 'FFFFFFF FFFFFFF FFFFFFF RRRRRRR RRRRRRR RRRRRRR'],
    ['anyOf after false', { anyOf: [false, { $ref: '#' }] }, 'K K K K K K'],
    ['anyOf after true', { anyOf: [true, { $ref: '#' }] }, 'TTTTTTT TTTTTTT TTTTTTT TTTTTTT TTTTTTT TTTTTTT'],
    ['oneOf after true', { oneOf: [true, { $ref: '#' }] }, 'K K K K K K'],
    ['oneOf after false', { oneOf: [false, { $ref: '#' }] }, 'K K K K K K'],
    ['oneOf after two trues', { oneOf: [true, true, { $ref: '#' }] }, 'FFFFFFF FFFFFFF FFFFFFF FFFFFFF FFFFFFF FFFFFFF'],
  ]);

  for (const [label, schema, expected, options = {}] of besideTheLoop) {
    it(`is refused only where nothing beside the loop can fail: ${label}`, () => {
      const { formats, ...rest } = /** @type {any} */ (options);
      const got = MODES.map(({ collectErrors, $schema }) => {
        const validator = new JarenValidator({ collectErrors, ...rest });
        if (formats) validator.addFormats(stringFormats);
        let validate;
        try { validate = validator.compile({ ...structuredClone(schema), $schema }); }
        catch (e) { assert.equal(/** @type {any} */ (e).code, 'JK0001'); return 'K'; }
        return INSTANCES.map((instance) => {
          try { return answer(validate(instance)) ? 'T' : 'F'; }
          catch (e) { assert.equal(/** @type {any} */ (e).code, 'JK2001'); return 'R'; }
        }).join('');
      }).join(' ');
      assert.equal(got, expected);
    });
  }

  it('names a $dynamicRef on the loop', () => {
    assert.throws(() => new JarenValidator().compile({ $id: 'http://loop.test/d', $dynamicAnchor: 'n', allOf: [{ $dynamicRef: '#n' }] }), {
      message: 'JK0001: $ref cycle: http://loop.test/d# -> http://loop.test/d#/allOf/0 -> http://loop.test/d# never reads the instance',
    });
  });

  it('throws instead of failing, so a loop under not never reads as success', () => {
    const validate = new JarenValidator().compile({ not: { anyOf: [{ type: 'string' }, { $ref: '#' }] } });
    assert.equal(validate('a'), false);
    assert.throws(() => validate(1), depthRefusal);
  });

  it('keeps every reference that descends into the instance', () => {
    const tree = new JarenValidator().compile({ type: 'object', properties: { next: { $ref: '#' } } });
    assert.equal(tree({ next: { next: {} } }), true);
    assert.equal(tree({ next: { next: 1 } }), false);
    const list = new JarenValidator().compile({ anyOf: [{ type: 'integer' }, { type: 'array', items: { $ref: '#' } }] });
    assert.equal(list([1, [2, [3]]]), true);
    assert.equal(list([1, ['x']]), false);
  });
});

describe('the reference depth bound', () => {
  const items = { $id: 'http://depth.test/items', type: ['array', 'integer'], items: { $ref: '#' } };
  const message = 'JK2001: validation nests more than 256 schema references at http://depth.test/items#/items'
    + ' (an instance nested this deep, or a loop of references that never reads it)';

  it('admits an instance 256 references deep and refuses one level more', () => {
    for (const collectErrors of [false, true]) {
      const validate = new JarenValidator({ collectErrors }).compile(structuredClone(items));
      assert.equal(answer(validate(nestedArrays(256))), true);
      assert.throws(() => validate(nestedArrays(257)), { ...depthRefusal, message });
      assert.throws(() => validate(nestedArrays(100000)), { ...depthRefusal, message });
    }
    const members = new JarenValidator().compile({ type: ['object', 'integer'], properties: { a: { $ref: '#' } } });
    assert.equal(members(nestedObjects(256)), true);
    assert.throws(() => members(nestedObjects(257)), depthRefusal);
  });

  it('refuses on the first call and every later one, and is restored after a refusal', () => {
    const validate = new JarenValidator().compile(structuredClone(items));
    for (let call = 0; call < 3; call++) {
      try { validate(nestedArrays(300)); assert.fail('validated'); }
      catch (e) { assert.ok(e instanceof SchemaRuntimeError); assert.equal(/** @type {any} */ (e).code, 'JK2001'); }
      assert.equal(validate(nestedArrays(256)), true);
      assert.equal(validate([[1], ['x']]), false);
    }
  });

  it('leaves a reused validator answering like a fresh one after a refusal', () => {
    const schemas = [
      { $schema: DRAFTS[2], type: ['array', 'integer', 'object'], unevaluatedProperties: false,
        anyOf: [{ type: 'integer' }, { type: 'array', items: { $ref: '#' } }, { type: 'object', properties: { a: { type: 'string' } } }] },
      { $schema: DRAFTS[2], $id: 'http://depth.test/reuse', $dynamicAnchor: 'n', type: ['array', 'integer', 'object'],
        items: { $dynamicRef: '#n' }, properties: { a: { type: 'string' } }, unevaluatedProperties: false },
    ];
    for (const schema of schemas) {
      for (const collectErrors of [false, true]) {
        const reused = new JarenValidator({ collectErrors }).compile(structuredClone(schema));
        assert.throws(() => reused([nestedArrays(400)]), depthRefusal);
        for (const instance of [{ a: 1, b: 2 }, [1, ['x']], { a: 'ok' }]) {
          const fresh = new JarenValidator({ collectErrors }).compile(structuredClone(schema));
          assert.deepEqual(JSON.parse(JSON.stringify(reused(instance))), JSON.parse(JSON.stringify(fresh(instance))));
        }
      }
    }
  });

  it('bounds dynamic and recursive references alike', () => {
    const dynamic = new JarenValidator().compile({
      $schema: DRAFTS[2], $id: 'http://depth.test/dyn', $dynamicAnchor: 'n', type: ['array', 'integer'], items: { $dynamicRef: '#n' },
    });
    assert.equal(dynamic(nestedArrays(10)), true);
    assert.throws(() => dynamic(nestedArrays(100000)), depthRefusal);
    const pointer = new JarenValidator().compile({
      $schema: DRAFTS[2], $defs: { n: { type: ['array', 'integer'], items: { $dynamicRef: '#/$defs/n' } } }, $ref: '#/$defs/n',
    });
    assert.equal(pointer(nestedArrays(10)), true);
    assert.throws(() => pointer(nestedArrays(100000)), depthRefusal);
    const recursive = new JarenValidator().compile({
      $schema: DRAFTS[1], $id: 'http://depth.test/rec', $recursiveAnchor: true, type: ['array', 'integer'], items: { $recursiveRef: '#' },
    });
    assert.equal(recursive(nestedArrays(10)), true);
    assert.throws(() => recursive(nestedArrays(100000)), depthRefusal);
    const loop = new JarenValidator().compile({
      $schema: DRAFTS[2], $id: 'http://depth.test/l', $dynamicAnchor: 'n', anyOf: [{ type: 'string' }, { $dynamicRef: '#n' }],
    });
    assert.equal(loop('a'), true);
    assert.throws(() => loop(1), depthRefusal);
  });

  it('lets the meta-schemas validate themselves and refuses a schema nested past the bound', () => {
    /** @param {number} n */
    const nestedSchema = (n) => { let s = /** @type {any} */ ({ type: 'string' }); for (let i = 0; i < n; i++) s = { items: s }; return s; };
    for (const version of [7, 2019, 2020]) {
      const bundle = structuredClone(getSchemaDraftByVersion(version));
      const validator = new JarenValidator().addMetaSchema(bundle.schema);
      const meta = Array.isArray(bundle.schema) ? bundle.schema[0] : bundle.schema;
      assert.equal(validator.validateSchema(meta), true, `${version}`);
      assert.equal(validator.validateSchema({ $schema: bundle.draft, ...nestedSchema(50) }), true, `${version}`);
      assert.throws(() => validator.validateSchema({ $schema: bundle.draft, ...nestedSchema(100000) }), depthRefusal);
    }
  });
});

describe('the maxReferenceDepth option', () => {
  const items = { type: ['array', 'integer'], items: { $ref: '#' } };

  it('moves the bound both ways', () => {
    const shallow = new JarenValidator({ maxReferenceDepth: 10 }).compile(structuredClone(items));
    assert.equal(shallow(nestedArrays(10)), true);
    assert.throws(() => shallow(nestedArrays(11)), {
      ...depthRefusal,
      message: 'JK2001: validation nests more than 10 schema references at https://github.com/jklarenbeek/jarenjs#/items'
        + ' (an instance nested this deep, or a loop of references that never reads it)',
    });
    const collecting = new JarenValidator({ collectErrors: true, maxReferenceDepth: 300 }).compile(structuredClone(items));
    assert.equal(answer(collecting(nestedArrays(300))), true);
    assert.throws(() => collecting(nestedArrays(301)), depthRefusal);
  });

  it('is refused when a schema compiles unless it is a positive safe integer', () => {
    for (const bad of [0, -1, 1.5, '5', NaN, Infinity, 2 ** 53, true]) {
      assert.throws(() => new JarenValidator({ maxReferenceDepth: /** @type {any} */ (bad) }).compile({ type: 'string' }),
        { name: 'SchemaCompileError', code: 'JK0002' });
    }
    assert.throws(() => new JarenValidator({ maxReferenceDepth: 0 }).compile({ type: 'string' }),
      { message: 'JK0002: maxReferenceDepth must be a positive safe integer, got 0' });
  });

  // Past the default the host's stack decides again, so this half runs in a
  // child process with a known, large stack.
  it('restores the answer past the default on a large enough stack, meta-schema validation included', () => {
    const script = `
      import { JarenValidator } from '@jarenjs/validate';
      import { getSchemaDraftByVersion } from '@jarenjs/refs';
      let deep = 0; for (let i = 0; i < 1500; i++) deep = [deep];
      let schema = { type: 'string' }; for (let i = 0; i < 300; i++) schema = { items: schema };
      const items = { type: ['array', 'integer'], items: { $ref: '#' } };
      const out = [];
      const attempt = (f) => { try { out.push(f()); } catch (e) { out.push(e.code); } };
      attempt(() => new JarenValidator({ maxReferenceDepth: 2000 }).compile(items)(deep));
      attempt(() => new JarenValidator().compile(items)(deep));
      const bundle = getSchemaDraftByVersion(2020);
      attempt(() => new JarenValidator({ maxReferenceDepth: 2000 }).addMetaSchema(bundle.schema).validateSchema({ $schema: bundle.draft, ...schema }));
      attempt(() => new JarenValidator().addMetaSchema(bundle.schema).validateSchema({ $schema: bundle.draft, ...schema }));
      console.log(JSON.stringify(out));`;
    const run = spawnSync(process.execPath, ['--stack-size=4000', '--input-type=module', '-e', script],
      { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [true, 'JK2001', true, 'JK2001']);
  });
});

describe('a $query descendant past its nesting bound', () => {
  it('throws JQ2009 instead of failing, so not never reads it as success', () => {
    const deep = nestedArrays(5000);
    for (const collectErrors of [false, true]) {
      const holds = new JarenValidator({ collectErrors }).compile({ $query: { $exists: '$..*' } });
      const negated = new JarenValidator({ collectErrors }).compile({ not: { $query: { $exists: '$..*' } } });
      assert.throws(() => holds(deep), { name: 'JsonQueryRuntimeError', code: 'JQ2009' });
      assert.throws(() => negated(deep), { name: 'JsonQueryRuntimeError', code: 'JQ2009' });
      assert.equal(answer(holds(nestedArrays(3))), true);
      assert.equal(answer(negated(nestedArrays(3))), false);
    }
  });

  it('still reports a data-shaped query error as a failure', () => {
    const validate = new JarenValidator({ collectErrors: true }).compile({ $query: { $add: ['$.a', 1] } });
    const result = /** @type {any} */ (validate({ a: 'x' }));
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors[0].params, { code: 'JQ2001', docPath: '/$add/0' });
  });
});

describe('the recursive cases of the JSON Schema Test Suite', () => {
  const dir = new URL('./fixtures/recursive-refs/', import.meta.url);
  const remotes = /** @type {[string, any][]} */ (['detached-dynamicref.json', 'extendible-dynamic-ref.json', 'tree.json'].map((name) => [
    `http://localhost:1234/draft2020-12/${name}`,
    JSON.parse(fs.readFileSync(new URL(`remotes/draft2020-12/${name}`, dir), 'utf8')),
  ]));
  for (const [file, draft] of [['draft7-ref.json', 'draft7'], ['draft2019-09-recursiveRef.json', 'draft2019-09'],
    ['draft2020-12-ref.json', 'draft2020-12'], ['draft2020-12-dynamicRef.json', 'draft2020-12']]) {
    it(`${file} answers every case`, () => {
      const validator = new JarenValidator();
      const registered = new Set();
      for (const name of [draft, 'draft7', 'draft2019-09', 'draft2020-12']) {
        const meta = getSchemaDraftByName(name);
        if (registered.has(meta.draft)) continue;
        registered.add(meta.draft);
        validator.addMetaSchema(meta.schema, meta.draft);
      }
      for (const [id, schema] of remotes) validator.addSchema(schema, id + '#');
      let cases = 0;
      for (const group of JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8'))) {
        const validate = validator.compile(group.schema);
        for (const test of group.tests) {
          assert.equal(validate(test.data), test.valid, `${group.description}: ${test.description}`);
          cases++;
        }
      }
      assert.ok(cases > 0);
    });
  }
});

describe('the validator code table', () => {
  it('lists exactly the codes ERROR-MESSAGES.md documents', () => {
    const doc = fs.readFileSync(new URL('../../packages/validate/docs/ERROR-MESSAGES.md', import.meta.url), 'utf8');
    const documented = [...doc.matchAll(/^\|\s*`?(JK[0-9]{4})`?\s*\|/gm)].map((m) => m[1]).sort();
    assert.deepEqual(Object.keys(VALIDATE_CODES).sort(), documented);
    assert.equal(Object.isFrozen(VALIDATE_CODES), true);
  });
});
