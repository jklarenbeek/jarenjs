//@ts-check
// A reference may name a place no registration walk entered: a schema below
// a keyword no draft defines, as an operation's schema in a contract
// document or a member of `components/schemas` in an OpenAPI document. A
// compile that reaches such a reference walks that place then, as a
// registration walks a document, and reads what the place reaches: the held
// schemas its references lead to, and no other. A reference-shaped object
// that is data, or that lies below such a keyword without being named, is
// no reference of the place that holds it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

const UNHELD = 'no schema the validator holds has that URI; register it with addSchema, load it with compileAsync, or fix the reference';
/** What `fn` returns, or the class, code, message and place of what it throws. @param {() => unknown} fn */
const outcome = (fn) => {
  try { return fn(); }
  catch (e) { const error = /** @type {any} */ (e); return [error.constructor.name, error.code, error.message, error.docPath]; }
};
/** The refusal of a reference to `target` that nothing holds. @param {string} target @param {string} [at] */
const unresolved = (target, at) => ['SchemaCompileError', 'JK0009', `JK0009: Can not resolve schema for '${target}': ${UNHELD}${at === undefined ? '' : ` at ${at}`}`, at];
/** The answers of a compiled schema. @param {any} validate @param {unknown[]} instances */
const answers = (validate, instances) => instances.map((instance) => validate(instance));
/** A registered document holding a reference nothing resolves: a compile that reads it is refused. */
const dangling = () => ({ $id: 'https://f.test/dangling.json', properties: { x: { $ref: 'https://f.test/none.json' } } });
/** The refusal of a compile that reads every schema the validator holds, `dangling` among them: it names no place. */
const READ_ALL = unresolved('https://f.test/none.json#');
/** @param {number} depth */
const nest = (depth) => { let value = {}; for (let i = 0; i < depth; i++) value = { n: value }; return value; };
/** The deepest nesting a compiled schema answers under the reference depth bound. @param {any} validate */
const deepest = (validate) => {
  for (let depth = 1; depth < 200; depth++) {
    try { validate(nest(depth)); }
    catch (e) { assert.equal(/** @type {any} */ (e).code, 'JK2001'); return depth - 1; }
  }
  return Infinity;
};
/** @param {string} ref */
const step = (ref) => ({ properties: { n: { $ref: ref } } });

describe('a place below a keyword no draft defines is read by what it reaches', () => {
  const open = () => ({ $id: 'https://f.test/open.json', 'x-defs': { a: { $ref: '#/x-defs/b' }, b: { type: 'string' } }, properties: { p: { $ref: '#/x-defs/a' } } });

  it('answers a document that holds such references, and each such place, beside a held reference nothing resolves', () => {
    const validator = new JarenValidator().addSchema(open()).addSchema(dangling());
    assert.deepEqual(answers(validator.compile({ $ref: 'https://f.test/open.json' }), [{ p: 'x' }, { p: 1 }]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://f.test/open.json#/x-defs/a' }), ['x', 1]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://f.test/open.json#/x-defs/b' }), ['x', 1]), [true, false]);
  });

  it('refuses, naming the place, the compile whose place leads to a reference nothing resolves', () => {
    const validator = new JarenValidator()
      .addSchema({ $id: 'https://f.test/open.json', 'x-defs': { a: { properties: { n: { $ref: 'https://f.test/dangling.json' } } }, b: { type: 'string' } } })
      .addSchema(dangling());
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://f.test/open.json#/x-defs/a' })),
      unresolved('https://f.test/none.json#', 'https://f.test/dangling.json#/properties/x/%24ref'));
    assert.deepEqual(answers(validator.compile({ $ref: 'https://f.test/open.json#/x-defs/b' }), ['x', 1]), [true, false]);
  });

  it('names the reference below such a keyword where it is the one that leads there', () => {
    // a walked place asks for the same target, so the validator holds its name; the compile reaches it through `x-defs`
    const validator = new JarenValidator().addSchema({
      $id: 'https://f.test/doc.json', properties: { q: { $ref: 'none.json' } },
      'x-defs': { a: { properties: { n: { $ref: 'none.json' } } }, b: { type: 'string' } },
    });
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://f.test/doc.json#/x-defs/a' })),
      unresolved('https://f.test/none.json#', 'https://f.test/doc.json#/x-defs/a/properties/n/%24ref'));
    assert.deepEqual(answers(validator.compile({ $ref: 'https://f.test/doc.json#/x-defs/b' }), ['x', 1]), [true, false]);
  });

  it('reads a meta-schema held by addMetaSchema the same', () => {
    const meta = () => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://g.test/meta', properties: { deep: { $ref: '#/$defs/d' } }, $defs: { d: { type: 'string' } }, 'x-defs': { u: { $ref: '#/$defs/d' } } });
    const validator = new JarenValidator().addMetaSchema(meta(), 'https://g.test/meta').addSchema(dangling());
    assert.deepEqual(answers(validator.compile({ $ref: 'https://g.test/meta' }), [{ deep: 'x' }, { deep: 1 }]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://g.test/meta#/x-defs/u' }), ['x', 1]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://g.test/meta#/properties/deep' }), ['x', 1]), [true, false]);
  });

  it('answers the same whatever was compiled before', () => {
    const document = () => ({ $id: 'https://p.test/doc.json', 'x-defs': { a: { properties: { n: { $ref: 'https://p.test/other.json' } } } } });
    const other = () => ({ $id: 'https://p.test/other.json', type: 'number' });
    /** @param {(validator: JarenValidator, document: any) => void} prepare */
    const read = (prepare) => {
      const held = document();
      const validator = new JarenValidator();
      prepare(validator, held);
      return answers(validator.compile({ $ref: 'https://p.test/doc.json#/x-defs/a' }), [{ n: 1 }, { n: 'x' }]);
    };
    // the place's own object compiled first, on the validator that holds its document and before it does
    assert.deepEqual(read((validator, held) => { validator.addSchema(held).addSchema(other()).addSchema(dangling()); }), [true, false]);
    assert.deepEqual(read((validator, held) => { validator.addSchema(held).addSchema(other()).addSchema(dangling()); validator.compile({ type: 'object' }); outcome(() => validator.compile(held['x-defs'].a)); }), [true, false]);
    assert.deepEqual(read((validator, held) => { validator.addSchema(other()); validator.compile(held['x-defs'].a); validator.addSchema(held).addSchema(dangling()); }), [true, false]);
  });
});

describe('a contract document', () => {
  /** @param {number} n */
  const contract = (n) => ({
    $id: `urn:x:contract:${n}`, $contract: '0.1', id: 'things',
    $defs: {
      Thing: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'probe' } } },
      Page: { type: 'object', properties: { things: { type: 'array', items: { $ref: '#/$defs/Thing' } } } },
      Problem: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', format: 'probe' } } },
    },
    operations: {
      'thing.get': { kind: 'read', input: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'probe' } } }, output: { $ref: '#/$defs/Thing' }, errors: { missing: { status: 404, schema: { $ref: '#/$defs/Problem' } } } },
      'thing.list': { kind: 'read', input: { type: 'object' }, output: { $ref: '#/$defs/Page' } },
      'thing.put': { kind: 'command', input: { type: 'object', required: ['thing'], properties: { thing: { $ref: '#/$defs/Thing' } } }, output: { $ref: '#/operations/thing.get/output' } },
    },
  });
  const PLACES = ['#/operations/thing.get/input', '#/operations/thing.get/output', '#/operations/thing.get/errors/missing/schema',
    '#/operations/thing.list/output', '#/operations/thing.put/input', '#/operations/thing.put/output', '#/$defs/Page', '#'];
  const INSTANCES = [{ id: 'a' }, { id: 1 }, { things: [{ id: 'a' }] }, { things: [{}] }, { thing: { id: 'a' } }, { thing: {} }, { reason: 'r' }, {}, 5];

  it('builds, for the schema of an operation, the places that schema reaches', () => {
    // a format's compiler runs once for each place holding it that is built: of three contracts held,
    // one operation's schema builds its own places and the definition it leads to
    let built = 0;
    const validator = new JarenValidator({ formatAssertion: true }).addFormats({ probe: () => { built++; return () => true; } });
    for (const n of [1, 2, 3]) validator.addSchema(contract(n));
    /** @param {any} schema */
    const builds = (schema) => { built = 0; validator.compile(schema); return built; };
    assert.deepEqual(PLACES.map((place) => builds({ $ref: `urn:x:contract:2${place}` })), [1, 1, 1, 1, 1, 1, 1, 1]);
    assert.equal(builds({ type: 'string' }), 0);
  });

  it('answers each of its places as the document held alone answers it', () => {
    const formats = { probe: () => () => true };
    const alone = new JarenValidator().addFormats(formats).addSchema(contract(2));
    const beside = new JarenValidator().addFormats(formats).addSchema(contract(1)).addSchema(dangling()).addSchema(contract(2)).addSchema(contract(3));
    for (const place of PLACES) {
      const expected = answers(alone.compile({ $ref: `urn:x:contract:2${place}` }), INSTANCES);
      assert.deepEqual(answers(beside.compile({ $ref: `urn:x:contract:2${place}` }), INSTANCES), expected, place);
    }
    assert.deepEqual(answers(beside.compile({ $ref: 'urn:x:contract:2#/operations/thing.put/input' }), INSTANCES),
      [false, false, false, false, true, false, false, false, false]);
    assert.deepEqual(answers(beside.compile({ $ref: 'urn:x:contract:3#/operations/thing.put/output' }), [{ id: 'a' }, { id: 1 }, {}]), [true, false, false]);
  });
});

describe('an OpenAPI document', () => {
  const api = () => ({
    $id: 'https://api.test/openapi.json', openapi: '3.1.0',
    paths: { '/pets': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pets' } } } } } } } },
    components: { schemas: {
      Pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
      Pet: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, tag: { $ref: '#/components/schemas/Tag' }, owner: { $ref: '#/$defs/Owner' } } },
      Tag: { type: 'string', minLength: 1 },
    } },
    $defs: { Owner: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, pets: { $ref: '#/components/schemas/Pets' } } } },
  });

  it('reads a member of `components/schemas`, and the schema of a path, by what each reaches', () => {
    const validator = new JarenValidator().addSchema(api()).addSchema(dangling());
    const pets = [[{ name: 'a', tag: 't', owner: { id: 1, pets: [] } }], [{ name: 'a', tag: '' }], [{ name: 'a', owner: { id: 'x' } }], [{}]];
    assert.deepEqual(answers(validator.compile({ $ref: 'https://api.test/openapi.json#/paths/~1pets/get/responses/200/content/application~1json/schema' }), pets), [true, false, false, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://api.test/openapi.json#/components/schemas/Pet' }), pets.map((list) => list[0])), [true, false, false, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://api.test/openapi.json#/components/schemas/Tag' }), ['t', '']), [true, false]);
    // a walked place that leads to them, and the document
    assert.deepEqual(answers(validator.compile({ $ref: 'https://api.test/openapi.json#/$defs/Owner' }), [{ id: 1, pets: [{ name: 'b' }] }, { id: 1, pets: [{}] }]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://api.test/openapi.json' }), [{}, 5]), [true, true]);
  });
});

describe('an object that only looks like a reference', () => {
  it('is no reference where a held document holds it as data, or in a `$query` literal', () => {
    const validator = new JarenValidator()
      .addSchema({ $id: 'https://g.test/data.json', properties: { k: { const: { $ref: 'https://f.test/none.json' } }, e: { enum: [{ $ref: 'nope' }] }, d: { default: { $ref: '#/x' } } } })
      .addSchema({ $id: 'https://g.test/q.json', type: 'object', $query: { $valid: ['$.n', { $ref: 'https://g.test/num.json' }] } })
      .addSchema({ $id: 'https://g.test/num.json', type: 'number' })
      .addSchema(dangling());
    assert.deepEqual(answers(validator.compile({ $ref: 'https://g.test/data.json' }), [{ k: { $ref: 'https://f.test/none.json' } }, { k: 1 }, { e: { $ref: 'nope' } }, { e: 1 }]), [true, false, true, false]);
    // the literal is compiled by itself, and reads what it reaches
    assert.deepEqual(answers(validator.compile({ $ref: 'https://g.test/q.json' }), [{ n: 1 }, { n: 'x' }]), [true, false]);
  });

  it('ends what a compile reads in its own document: it reads every schema the validator holds', () => {
    const validator = new JarenValidator().addSchema({ $id: 'https://g.test/plain.json', type: 'string' }).addSchema(dangling());
    assert.deepEqual(outcome(() => validator.compile({ const: { $ref: 'https://f.test/none.json' } })), READ_ALL);
    assert.deepEqual(outcome(() => validator.compile({ $ref: '#/x-defs/a', 'x-defs': { a: { type: 'string' }, b: { $ref: '#/x-defs/a' } } })), READ_ALL);
    assert.deepEqual(answers(validator.compile({ const: { ref: 'https://f.test/none.json' } }), [{ ref: 'https://f.test/none.json' }, 1]), [true, false]);
  });
});

describe('a place whose references are not known is read with every schema the validator holds', () => {
  it('where the place declares an identifier of its own; an anchor is none', () => {
    // no walk registered the identifier: a compile reads it by what it has built
    const validator = new JarenValidator().addSchema({
      $id: 'https://g.test/doc.json',
      'x-defs': {
        a: { $id: 'https://g.test/inner.json', properties: { n: { $ref: '#/$defs/t' } }, $defs: { t: { type: 'string' } } },
        b: { $anchor: 'bee', properties: { n: { $ref: '#/x-defs/c' } } },
        c: { type: 'string' },
      },
    }).addSchema(dangling());
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://g.test/doc.json#/x-defs/a' })), READ_ALL);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://g.test/doc.json#/x-defs/b' }), [{ n: 'x' }, { n: 1 }]), [true, false]);
  });

  it('where an identifier above the place sets another base than its document\'s; under that identifier it is read by what it reaches', () => {
    const validator = new JarenValidator()
      .addSchema({ $id: 'https://g.test/root.json', properties: { m: { $id: 'https://g.test/sub/res.json', 'x-defs': { w: { properties: { n: { $ref: 'leaf.json' } } } } } } })
      .addSchema({ $id: 'https://g.test/sub/leaf.json', type: 'string' }).addSchema(dangling());
    // whichever is compiled first
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://g.test/root.json#/properties/m/x-defs/w' })), READ_ALL);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://g.test/sub/res.json#/x-defs/w' }), [{ n: 'x' }, { n: 1 }]), [true, false]);
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://g.test/root.json#/properties/m/x-defs/w' })), READ_ALL);
  });

  it('where a registration left a place unread that declares an identifier twice, and a reference lies below it', () => {
    /** @param {boolean} referring */
    const twice = (referring) => {
      const place = () => (referring ? { $id: 'https://g.test/same.json', properties: { n: { $ref: '#/$defs/t' } }, $defs: { t: { type: 'string' } } } : { $id: 'https://g.test/same.json', type: 'object' });
      return { $id: 'https://g.test/twice.json', $defs: { a: place(), b: place() } };
    };
    const validator = new JarenValidator().addSchema(twice(true)).addSchema(dangling());
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://g.test/twice.json' })), READ_ALL);
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://g.test/twice.json#/$defs/b' })), READ_ALL);
    // the place that keeps the identifier was read, and one without a reference below it holds none
    assert.deepEqual(answers(validator.compile({ $ref: 'https://g.test/same.json' }), [{ n: 'x' }, { n: 1 }]), [true, false]);
    assert.deepEqual(answers(new JarenValidator().addSchema(twice(false)).addSchema(dangling()).compile({ $ref: 'https://g.test/twice.json' }), [{}, 5]), [true, true]);
  });

  it('where a walk left `propertyDependencies` unread, and a reference lies below it', () => {
    const S = 'https://json-schema.org/draft/2020-12/schema';
    /** @param {string} dialect @param {any} below */
    const using = (dialect, below) => ({ $schema: dialect, $id: 'https://g.test/pd.json', propertyDependencies: { kind: { a: below } }, $defs: { t: { type: 'string' } } });
    const referring = { properties: { n: { $ref: '#/$defs/t' } } };
    const instances = [{ kind: 'a', n: 'x' }, { kind: 'a', n: 1 }];
    // read under a dialect the registration cannot resolve, the keyword is none: a compile that holds
    // the dialect's meta-schema would read it
    const foreign = new JarenValidator({ propertyDependencies: true }).addSchema(using('https://g.test/dialect', referring)).addSchema(dangling());
    assert.deepEqual(outcome(() => foreign.compile({ $ref: 'https://g.test/pd.json' })), READ_ALL);
    // a meta-schema is walked without the keyword, which a validator that reads it compiles
    const meta = new JarenValidator({ propertyDependencies: true }).addMetaSchema(using(S, referring), 'https://g.test/pd.json').addSchema(dangling());
    assert.deepEqual(outcome(() => meta.compile({ $schema: S, $ref: 'https://g.test/pd.json' })), READ_ALL);
    // a registration that reads the keyword records its references; without one below it, nothing is unknown
    const read = new JarenValidator({ propertyDependencies: true }).addSchema(using(S, referring)).addSchema(dangling());
    assert.deepEqual(answers(read.compile({ $schema: S, $ref: 'https://g.test/pd.json' }), instances), [true, false]);
    const plain = new JarenValidator({ propertyDependencies: true }).addSchema(using('https://g.test/dialect', { required: ['n'] })).addSchema(dangling());
    assert.deepEqual(answers(plain.compile({ $ref: 'https://g.test/pd.json' }), [{ kind: 'a' }]), [true]);
  });
});

describe('a reference object held at more than one place', () => {
  it('is read by what it asks for where every place asks for the same, and is not known where they differ', () => {
    // one `$ref` object at two places of a document and in a second document: the same target from each
    const shared = { $ref: 'https://s.test/leaf.json' };
    const validator = new JarenValidator()
      .addSchema({ $id: 'https://s.test/a.json', properties: { x: shared, y: shared } })
      .addSchema({ $id: 'https://s.test/b.json', properties: { z: shared } })
      .addSchema({ $id: 'https://s.test/leaf.json', type: 'string' }).addSchema(dangling());
    assert.deepEqual(answers(validator.compile({ $ref: 'https://s.test/a.json' }), [{ x: 's', y: 's' }, { x: 1 }]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://s.test/b.json' }), [{ z: 's' }, { z: 1 }]), [true, false]);
    // a relative `$ref` shared by two documents of two bases names two targets
    const relative = { $ref: 'leaf.json' };
    const apart = new JarenValidator()
      .addSchema({ $id: 'https://s.test/one/a.json', properties: { x: relative } })
      .addSchema({ $id: 'https://s.test/two/b.json', properties: { z: relative } })
      .addSchema({ $id: 'https://s.test/one/leaf.json', type: 'string' }).addSchema({ $id: 'https://s.test/two/leaf.json', type: 'number' }).addSchema(dangling());
    assert.deepEqual(outcome(() => apart.compile({ $ref: 'https://s.test/one/a.json' })), READ_ALL);
    assert.deepEqual(answers(apart.compile({ $ref: 'https://s.test/one/leaf.json' }), ['s', 1]), [true, false]);
  });
});

describe('a held place built only because its references are not known', () => {
  const twice = () => ({ $id: 'https://w.test/same.json', properties: { n: { $ref: '#/$defs/t' } }, $defs: { t: { type: 'string' } } });
  const plain = () => ({ $id: 'https://w.test/plain.json', type: 'string' });
  /** The code a compile is refused with. @param {JarenValidator} validator @param {string} ref */
  const refused = (validator, ref) => /** @type {any[]} */ (outcome(() => validator.compile({ $ref: ref })))[1];

  it('does not refuse the compile where a query literal fails its own build, or the build of the document around it', () => {
    // a `$query` literal that leads back to its own document refuses the compile that builds it; its document
    // also declares an identifier twice, so every compile that holds a reference builds it
    const looping = { $id: 'https://w.test/r.json', $query: { $valid: ['$', { $ref: 'https://w.test/r.json' }] }, $defs: { a: twice(), b: twice() } };
    const validator = new JarenValidator().addSchema(looping).addSchema(plain());
    assert.deepEqual(answers(validator.compile({ $ref: 'https://w.test/plain.json' }), ['x', 1]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: '#/$defs/s', $defs: { s: { type: 'string' } } }), ['x', 1]), [true, false]);
    assert.equal(refused(validator, 'https://w.test/r.json'), 'JQ0009');
    // the place whose references are not known is an embedded resource of the document whose build fails
    const nested = { $id: 'https://w.test/outer.json', $query: { $valid: ['$', { $ref: 'https://w.test/outer.json' }] }, $defs: { e: { $id: 'https://w.test/inner.json', $defs: { a: twice(), b: twice() } } } };
    const around = new JarenValidator().addSchema(nested).addSchema(plain());
    assert.deepEqual(answers(around.compile({ $ref: 'https://w.test/plain.json' }), ['x', 1]), [true, false]);
    assert.equal(refused(around, 'https://w.test/inner.json'), 'JQ0009');
  });
});

describe('a place no walk recorded comes into being where a compile of everything built it', () => {
  it('builds a held document whose references are not known for a compile that holds a reference, and for no other', () => {
    // a format's compiler runs once for each place holding it that is built: the document that declares an
    // identifier twice is built beside what a reference reaches, and a compile without a reference builds nothing
    let built = 0;
    const place = () => ({ $id: 'https://u.test/same.json', properties: { n: { $ref: '#/$defs/t' } }, $defs: { t: { type: 'string' } } });
    const validator = new JarenValidator({ formatAssertion: true }).addFormats({ probe: () => { built++; return () => true; } })
      .addSchema({ $id: 'https://u.test/unknown.json', format: 'probe', $defs: { a: place(), b: place() } })
      .addSchema({ $id: 'https://u.test/plain.json', type: 'string', format: 'probe' });
    /** @param {any} schema */
    const builds = (schema) => { built = 0; validator.compile(schema); return built; };
    assert.deepEqual([builds({ type: 'string' }), builds(true), builds({ $ref: 'https://u.test/plain.json' })], [0, 0, 2]);
  });


  it('counts the same references toward the reference depth bound, entering a ring through such places', () => {
    // at the root of the compile and at an inner place, alone and beside another document
    const D = 'https://x.test/d.json';
    const ring = () => ({ $id: D, 'x-defs': { x2: step('#/x-defs/x1'), x1: step('#/properties/p') }, properties: { p: step('#/x-defs/x2') } });
    const C = 'urn:x:contract:1';
    const contract = () => ({ $id: C, $defs: { node: step('#/operations/walk/input') }, operations: { walk: { input: step('#/operations/walk/output'), output: step('#/$defs/node') } } });
    for (const options of [{ maxReferenceDepth: 16 }, { maxReferenceDepth: 16, collectErrors: true }]) {
      for (const others of [[], [{ $id: 'https://x.test/other.json', type: 'object' }]]) {
        const validator = new JarenValidator(options).addSchema(ring()).addSchema(contract());
        for (const other of others) validator.addSchema(other);
        assert.deepEqual(['#/x-defs/x1', '#/x-defs/x2', '#/properties/p', '#/x-defs/x2/properties/n', '#/properties/p/properties/n'].map((place) => deepest(validator.compile({ $ref: `${D}${place}` }))),
          [23, 23, 22, 22, 21]);
        assert.deepEqual(['#/operations/walk/input', '#/operations/walk/output', '#/$defs/node', '#/operations/walk/input/properties/n'].map((place) => deepest(validator.compile({ $ref: `${C}${place}` }))),
          [22, 23, 46, 21]);
      }
    }
  });

  it('keeps the bound of a ring through a root member where its document also holds an object no walk recorded as a reference', () => {
    // read up to such an object and no further, the document was not known to bring the ring's member
    // into being with it, and the ring answered half as deep (22 levels for 46)
    const D = 'https://x.test/d.json';
    /** @param {object} extra */
    const ring = (extra) => ({ $id: D, $defs: { x2: step('#/$defs/x1'), x1: step('#/properties/p') }, properties: { p: step('#/$defs/x2') }, ...extra });
    for (const extra of [{}, { 'x-note': { $ref: '#/$defs/x1' } }, { default: { $ref: 'nowhere' } }, { examples: [{ $ref: '#/$defs/x1' }] }]) {
      for (const options of [{ maxReferenceDepth: 16 }, { maxReferenceDepth: 16, collectErrors: true }]) {
        const validator = new JarenValidator(options).addSchema(ring(extra)).addSchema({ $id: 'https://x.test/other.json', type: 'object' });
        assert.deepEqual(['#/$defs/x1', '#/$defs/x2', '#/properties/p', '#/properties/p/properties/n'].map((place) => deepest(validator.compile({ $ref: `${D}${place}` }))),
          [46, 47, 45, 44], JSON.stringify(extra));
      }
    }
  });

  it('keeps the bound where an item reference builds such a place at once, and that place the next', () => {
    // `b` holds a reference to its place `u2`, whose lone item `$ref` builds `a`'s place `v0` when it
    // compiles, whose own builds `u0`: a compile of `u0`'s ring reaches none of them, and they are built
    // all the same, in the order a compile of everything builds them
    const A = 'https://x.test/a.json';
    const B = 'https://x.test/b.json';
    const a = () => ({ $id: A, 'x-defs': { u0: step(`${A}#/x-defs/u2/properties/n`), u2: step(`${A}#/x-defs/u0`), nest: { deep: { v0: { items: { $ref: `${A}#/x-defs/u0` } } } } } });
    const b = () => ({ $id: B, $defs: { x2: { $ref: `${B}#/x-defs/u2` } }, 'x-defs': { u2: { items: { $ref: `${A}#/x-defs/nest/deep/v0` } } } });
    /** @param {any[]} documents */
    const bounds = (documents) => {
      const validator = new JarenValidator({ maxReferenceDepth: 16 });
      for (const document of documents) validator.addSchema(document);
      return ['#/x-defs/u2/properties/n', '#/x-defs/u0', '#/x-defs/u2'].map((place) => deepest(validator.compile({ $ref: `${A}${place}` })));
    };
    assert.deepEqual(bounds([a()]), [14, 15, 15]);
    assert.deepEqual(bounds([b(), a()]), [15, 15, 16]);
    assert.deepEqual(bounds([a(), b()]), [15, 15, 16]);
  });

  it('keeps the bound beside a document whose references are not all known: every compile builds it', () => {
    // `q` declares an identifier twice, with a reference below the second place: what it builds when it
    // compiles is not known, so it is built for every compile, as a compile of everything built it
    const P = 'https://x.test/p.json';
    const Q = 'https://x.test/q.json';
    const p = () => ({ $id: P, $defs: { x0: step('https://x.test/one.json'), one: { $id: 'https://x.test/one.json', properties: { n: { $ref: `${Q}#/properties/p0` } } } } });
    /** @param {boolean} twice */
    const q = (twice) => ({
      $id: Q, properties: { p0: { not: { not: { $ref: `${P}#/$defs/x0` } } } },
      ...(twice ? { $defs: { dupA: { $id: 'https://x.test/dup.json' }, dupB: { $id: 'https://x.test/dup.json', properties: { n: { $ref: 'https://x.test/dup.json' } } } } } : {}),
    });
    for (const options of [{ maxReferenceDepth: 16 }, { maxReferenceDepth: 16, collectErrors: true }]) {
      for (const twice of [false, true])
        assert.equal(deepest(new JarenValidator(options).addSchema(q(twice)).addSchema(p()).compile({ $ref: `${Q}#/properties/p0` })), 29);
    }
  });
});
