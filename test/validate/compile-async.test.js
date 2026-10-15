//@ts-check
// compileAsync (@jarenjs/validate/load): loading the schema documents a
// schema references, once each, and refusing what cannot be loaded with a
// code that names the URI and the reference that needed it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator, SchemaCompileError, TraverseOptions, VALIDATE_CODES } from '@jarenjs/validate';
import { compileAsync, DEFAULT_MAX_LOADS } from '@jarenjs/validate/load';

/**
 * A loader serving `docs` from memory, recording every URI it is asked for.
 * @param {Record<string, unknown>} docs
 */
function served(docs) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    /** @param {string} uri */
    loadSchema: async (uri) => {
      calls.push(uri);
      if (!Object.hasOwn(docs, uri)) throw new Error(`no document at ${uri}`);
      return structuredClone(docs[uri]);
    },
  };
}

/**
 * The coded refusal a promise rejects with.
 * @param {Promise<unknown>} promise
 * @returns {Promise<any>}
 */
async function refusal(promise) {
  try {
    await promise;
  }
  catch (e) {
    assert.ok(e instanceof SchemaCompileError, String(e));
    return e;
  }
  assert.fail('expected a refusal');
}

describe('compileAsync loads what a schema references', () => {
  it('runs the README example', async () => {
    const documents = {
      'https://schemas.example.com/person.json': {
        type: 'object',
        properties: { name: { $ref: 'name.json' }, friends: { type: 'array', items: { $ref: '#' } } },
        required: ['name'],
      },
      'https://schemas.example.com/name.json': { type: 'string', minLength: 1 },
    };
    const validator = new JarenValidator();
    const validate = await compileAsync(validator,
      { $ref: 'https://schemas.example.com/person.json' },
      { loadSchema: async (uri) => documents[uri] });
    assert.equal(validate({ name: 'Ada', friends: [{ name: 'Alan' }] }), true);
    assert.equal(validate({ name: 'Ada', friends: [{ name: '' }] }), false);
    assert.deepEqual(Object.keys(documents).map((uri) => validator.getSchema(uri) === documents[uri]), [true, true]);
  });

  it('is the validator a synchronous compile returns over the same documents', async () => {
    const docs = {
      'https://x.test/a.json': { type: 'object', properties: { b: { $ref: 'b.json#/$defs/n' } } },
      'https://x.test/b.json': { $defs: { n: { type: 'integer', minimum: 3 } } },
    };
    const schema = { properties: { a: { $ref: 'https://x.test/a.json' } } };
    const loaded = await compileAsync(new JarenValidator({ collectErrors: true }), schema, served(docs));
    const sync = new JarenValidator({ collectErrors: true });
    for (const [uri, doc] of Object.entries(docs)) sync.addSchema(doc, `${uri}#`);
    const compiled = sync.compile(schema);
    for (const data of [{ a: { b: 3 } }, { a: { b: 2 } }, { a: { b: 'x' } }, { a: 1 }])
      assert.deepEqual(loaded(data), compiled(data));
    assert.equal(loaded({ a: { b: 2 } }).errors[0].keyword, 'minimum');
  });

  it('refuses what compile refuses, with the same error', async () => {
    const loop = { $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' };
    assert.throws(() => new JarenValidator().compile(loop), { code: 'JK0001' });
    const error = await refusal(compileAsync(new JarenValidator(), loop, served({})));
    assert.equal(error.message, (() => { try { new JarenValidator().compile(loop); } catch (e) { return e.message; } })());
    const twice = { $defs: { a: { $id: 'https://x.test/same.json' }, b: { $id: 'https://x.test/same.json' } } };
    await assert.rejects(compileAsync(new JarenValidator(), twice, served({})),
      { message: "Schema 'https://x.test/same.json#' for path '#/%24defs/b' in 'https://github.com/jklarenbeek/jarenjs#' already exists" });
    assert.throws(() => new JarenValidator().compile(twice), { message: "Schema 'https://x.test/same.json#' for path '#/%24defs/b' in 'https://github.com/jklarenbeek/jarenjs#' already exists" });
  });

  it('loads nothing a validator holds, and nothing for a schema without references', async () => {
    const validator = new JarenValidator();
    validator.addSchema({ type: 'integer' }, 'https://x.test/held.json');
    const loader = served({});
    const validate = await compileAsync(validator,
      { anyOf: [{ $ref: 'https://x.test/held.json' }, { $ref: '#/$defs/s' }], $defs: { s: { type: 'string' } } }, loader);
    assert.deepEqual([validate(1), validate('a'), validate(null)], [true, true, false]);
    assert.deepEqual(loader.calls, []);
  });

  it('follows a $dynamicRef into another document', async () => {
    const loader = served({ 'https://x.test/list.json': { $id: 'https://x.test/list.json', $dynamicAnchor: 'item', type: 'array', items: { $dynamicRef: '#item' } } });
    const validate = await compileAsync(new JarenValidator(),
      { $schema: 'https://json-schema.org/draft/2020-12/schema', $dynamicRef: 'https://x.test/list.json#item' }, loader);
    assert.deepEqual([validate([[]]), validate([1])], [true, false]);
    assert.deepEqual(loader.calls, ['https://x.test/list.json']);
  });

  it('loads what a document it loaded references, relative to the URI it was loaded from', async () => {
    const loader = served({
      'https://x.test/dir/a.json': { items: { $ref: 'b.json' } },
      'https://x.test/dir/b.json': { $ref: '../c.json' },
      'https://x.test/c.json': { type: 'boolean' },
    });
    const validate = await compileAsync(new JarenValidator(), { $ref: 'https://x.test/dir/a.json' }, loader);
    assert.deepEqual([validate([true]), validate([1])], [true, false]);
    assert.deepEqual(loader.calls, ['https://x.test/dir/a.json', 'https://x.test/dir/b.json', 'https://x.test/c.json']);
  });

  it('loads what a schema the validator held references and it does not hold', async () => {
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'https://x.test/held.json', properties: { n: { $ref: 'name.json' } } });
    assert.throws(() => validator.compile({ type: 'object' }), /Can not resolve schema for 'https:\/\/x.test\/name.json#'/);
    const loader = served({ 'https://x.test/name.json': { type: 'string' } });
    const validate = await compileAsync(validator, { $ref: 'https://x.test/held.json' }, loader);
    assert.deepEqual([validate({ n: 'a' }), validate({ n: 1 })], [true, false]);
    assert.deepEqual(loader.calls, ['https://x.test/name.json']);
  });

  it('loads a $schema outside json-schema.org, and never a json-schema.org dialect', async () => {
    const meta = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://x.test/no-validation.json',
      $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true, 'https://json-schema.org/draft/2020-12/vocab/applicator': true },
    };
    const loader = served({ 'https://x.test/no-validation.json': meta });
    const annotating = await compileAsync(new JarenValidator(), { $schema: 'https://x.test/no-validation.json', type: 'string' }, loader);
    assert.equal(annotating(1), true, 'the loaded meta-schema drops the validation vocabulary');
    assert.equal(new JarenValidator().compile({ $schema: 'https://x.test/no-validation.json', type: 'string' })(1), false,
      'a synchronous compile without it asserts type');
    assert.deepEqual(loader.calls, ['https://x.test/no-validation.json']);
    const official = served({});
    const asserting = await compileAsync(new JarenValidator(), { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' }, official);
    assert.deepEqual([asserting('a'), asserting(1)], [true, false]);
    assert.deepEqual(official.calls, []);
  });
});

describe('compileAsync loads each document once', () => {
  it('when several references name it at once', async () => {
    const loader = served({ 'https://x.test/n.json': { type: 'number', $defs: { i: { type: 'integer' } } } });
    const validate = await compileAsync(new JarenValidator(), {
      properties: { a: { $ref: 'https://x.test/n.json' }, b: { $ref: 'https://x.test/n.json#' }, c: { $ref: 'https://x.test/n.json#/$defs/i' } },
    }, loader);
    assert.deepEqual([validate({ a: 1, b: 2, c: 3 }), validate({ b: 'x' }), validate({ c: 1.5 })], [true, false, false]);
    assert.deepEqual(loader.calls, ['https://x.test/n.json']);
    const once = await compileAsync(new JarenValidator(), {
      properties: { a: { $ref: 'https://x.test/n.json' }, b: { $ref: 'https://x.test/n.json#' } },
    }, { ...served({ 'https://x.test/n.json': { type: 'number' } }), maxLoads: 1 });
    assert.equal(once({ a: 'x' }), false, 'two references to one document count as one load');
  });

  it('when two calls on one validator need it at once', async () => {
    /** @type {string[]} */
    const calls = [];
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    const loadSchema = async (/** @type {string} */ uri) => {
      calls.push(uri);
      await gate;
      return { type: 'string' };
    };
    const validator = new JarenValidator();
    const first = compileAsync(validator, { $ref: 'https://x.test/s.json' }, { loadSchema });
    const second = compileAsync(validator, { items: { $ref: 'https://x.test/s.json' } }, { loadSchema });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [one, two] = await Promise.all([first, second]);
    assert.deepEqual([one('a'), one(1), two(['a']), two([1])], [true, false, true, false]);
    assert.deepEqual(calls, ['https://x.test/s.json']);
  });

  it('and loads a document again after a load of it failed', async () => {
    let fail = true;
    const calls = [];
    const loadSchema = async (/** @type {string} */ uri) => {
      calls.push(uri);
      if (fail) throw new Error('offline');
      return { type: 'null' };
    };
    const validator = new JarenValidator();
    assert.equal((await refusal(compileAsync(validator, { $ref: 'https://x.test/z.json' }, { loadSchema }))).code, 'JK0004');
    fail = false;
    const validate = await compileAsync(validator, { $ref: 'https://x.test/z.json' }, { loadSchema });
    assert.deepEqual([validate(null), validate(0)], [true, false]);
    assert.deepEqual(calls, ['https://x.test/z.json', 'https://x.test/z.json']);
  });

  it('through a cycle of references between documents', async () => {
    const loader = served({
      'https://x.test/a.json': { properties: { b: { $ref: 'b.json' } } },
      'https://x.test/b.json': { type: 'array', items: { $ref: 'a.json' } },
    });
    const validate = await compileAsync(new JarenValidator(), { $ref: 'https://x.test/a.json' }, loader);
    assert.deepEqual([validate({ b: [{ b: [] }] }), validate({ b: [{ b: 1 }] })], [true, false]);
    assert.deepEqual(loader.calls, ['https://x.test/a.json', 'https://x.test/b.json']);
  });

  it('and refuses a cycle of bare references as a synchronous registration does (JK0001)', async () => {
    const docs = { 'https://x.test/a.json': { $ref: 'b.json' }, 'https://x.test/b.json': { $ref: 'a.json' } };
    const error = await refusal(compileAsync(new JarenValidator(), { $ref: 'https://x.test/a.json' }, served(docs)));
    assert.equal(error.message, 'JK0001: $ref cycle: https://x.test/a.json# -> https://x.test/b.json# -> https://x.test/a.json# never reads the instance');
    const sync = new JarenValidator().addSchema(docs['https://x.test/a.json'], 'https://x.test/a.json#');
    assert.throws(() => sync.addSchema(docs['https://x.test/b.json'], 'https://x.test/b.json#'), { message: error.message });
  });
});

/** One turn of the event loop. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A loader whose loads of `docs` settle only when `release` lets them, in
 * the order it is given; a URI outside `docs` rejects at once.
 * @param {Record<string, unknown>} docs
 */
function gated(docs) {
  /** @type {string[]} */
  const calls = [];
  /** @type {Map<string, () => void>} */
  const waiting = new Map();
  return {
    calls,
    /** @param {string} uri */
    loadSchema: (uri) => {
      calls.push(uri);
      if (!Object.hasOwn(docs, uri)) return Promise.reject(new Error(`no document at ${uri}`));
      return new Promise((resolve) => waiting.set(uri, () => resolve(structuredClone(docs[uri]))));
    },
    /** @param {string[]} order - The URIs to settle, one per turn; one never asked for is passed over */
    async release(order) {
      for (const uri of order) {
        for (let turns = 0; turns < 20 && !waiting.has(uri); turns++) await tick();
        waiting.get(uri)?.();
        waiting.delete(uri);
        for (let turns = 0; turns < 3; turns++) await tick();
      }
    },
  };
}

/**
 * Every order of `items`.
 * @param {string[]} items
 * @returns {string[][]}
 */
function orders(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => orders([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

/**
 * What `compileAsync` answers for each order its loads settle in: the URIs
 * it asked for, and the validator's answers on `instances` (or the refusal).
 * @param {object} schema
 * @param {Record<string, unknown>} docs
 * @param {string[]} settle - The documents whose loads are released, in every order
 * @param {unknown[]} instances
 */
async function everyOrder(schema, docs, settle, instances) {
  const answers = [];
  for (const order of orders(settle)) {
    const loader = gated(docs);
    const [result] = await Promise.allSettled([compileAsync(new JarenValidator(), schema, loader), loader.release(order)]);
    answers.push({
      order: order.join(' '),
      calls: loader.calls,
      answer: result.status === 'fulfilled' ? instances.map((instance) => result.value(instance)) : result.reason.message,
    });
  }
  return answers;
}

describe('compileAsync answers the same whichever load settles first', () => {
  const S = 'https://json-schema.org/draft/2020-12/schema';
  const embeds = { $schema: S, $defs: { e: { $id: 'https://x.test/e.json', type: 'string' } } };

  it('a reference into a resource embedded in a document loaded beside it is held, and never loaded', async () => {
    const docs = { 'https://x.test/d1.json': embeds, 'https://x.test/d2.json': { $schema: S, $ref: 'https://x.test/e.json' } };
    const schema = { $schema: S, properties: { a: { $ref: 'https://x.test/d1.json' }, b: { $ref: 'https://x.test/d2.json' } } };
    const answers = await everyOrder(schema, docs, ['https://x.test/d1.json', 'https://x.test/d2.json'], [{ b: 'x' }, { b: 1 }]);
    const calls = ['https://x.test/d1.json', 'https://x.test/d2.json'];
    assert.deepEqual(answers, [
      { order: 'https://x.test/d1.json https://x.test/d2.json', calls, answer: [true, false] },
      { order: 'https://x.test/d2.json https://x.test/d1.json', calls, answer: [true, false] },
    ]);
    const sync = new JarenValidator();
    for (const [uri, doc] of Object.entries(docs)) sync.addSchema(doc, `${uri}#`);
    assert.deepEqual([sync.compile(schema)({ b: 'x' }), sync.compile(schema)({ b: 1 })], [true, false]);
  });

  it('a failed load of a document embedded in one loaded beside it is no refusal', async () => {
    const docs = { 'https://x.test/d1.json': embeds };
    const schema = { $schema: S, properties: { a: { $ref: 'https://x.test/d1.json' }, b: { $ref: 'https://x.test/e.json' } } };
    const answers = await everyOrder(schema, docs, ['https://x.test/d1.json'], [{ b: 'x' }, { b: 1 }]);
    assert.deepEqual(answers, [
      { order: 'https://x.test/d1.json', calls: ['https://x.test/d1.json', 'https://x.test/e.json'], answer: [true, false] },
    ]);
  });

  it('three documents loaded together, in all six orders', async () => {
    const docs = {
      'https://x.test/d1.json': embeds,
      'https://x.test/d2.json': { $schema: S, properties: { e: { $ref: 'https://x.test/e.json' }, g: { $ref: 'https://x.test/g.json' } } },
      'https://x.test/d3.json': { $schema: S, $defs: { g: { $id: 'https://x.test/g.json', type: 'integer' } } },
    };
    const schema = { $schema: S, allOf: [{ $ref: 'https://x.test/d1.json' }, { $ref: 'https://x.test/d2.json' }, { $ref: 'https://x.test/d3.json' }] };
    const answers = await everyOrder(schema, docs, Object.keys(docs), [{ e: 'x', g: 1 }, { e: 1 }, { g: 1.5 }]);
    assert.equal(answers.length, 6);
    for (const { order, calls, answer } of answers)
      assert.deepEqual({ order, calls, answer }, { order, calls: Object.keys(docs), answer: [true, false, false] });
  });

  it('a failed load is the refusal, before maxLoads stops the loads after it', async () => {
    const loader = served({ 'https://x.test/b.json': { $ref: 'c.json' }, 'https://x.test/c.json': { type: 'string' } });
    const error = await refusal(compileAsync(new JarenValidator(),
      { properties: { a: { $ref: 'https://x.test/a.json' }, b: { $ref: 'https://x.test/b.json' } } }, { ...loader, maxLoads: 2 }));
    assert.equal(error.message, "JK0004: loadSchema('https://x.test/a.json') failed: no document at https://x.test/a.json at #/properties/a/%24ref");
    assert.deepEqual(loader.calls, ['https://x.test/a.json', 'https://x.test/b.json']);
  });

  it('a document another call is loading counts toward that call\'s maxLoads, not this one\'s', async () => {
    const docs = Object.fromEntries(Array.from({ length: 5 }, (_, i) =>
      [`https://x.test/${i}.json`, i < 4 ? { $ref: `https://x.test/${i + 1}.json` } : { type: 'number' }]));
    const first = served(docs);
    const second = served(docs);
    const validator = new JarenValidator();
    const [a, b] = await Promise.all([
      compileAsync(validator, { $ref: 'https://x.test/0.json' }, { ...first, maxLoads: 5 }),
      compileAsync(validator, { items: { $ref: 'https://x.test/0.json' } }, { ...second, maxLoads: 2 }),
    ]);
    assert.deepEqual([a(1), a('1'), b([1]), b(['1'])], [true, false, true, false]);
    assert.deepEqual([first.calls.length, second.calls.length], [5, 0]);
  });
});

describe('compileAsync refusals', () => {
  it('JK0004: the loader throws or rejects, naming the URI, the reference and the cause', async () => {
    const offline = new Error('503 Service Unavailable');
    const error = await refusal(compileAsync(new JarenValidator(),
      { properties: { a: { $ref: 'https://x.test/a.json#/$defs/x' } } },
      { loadSchema: () => { throw offline; } }));
    assert.equal(error.code, 'JK0004');
    assert.equal(error.message, "JK0004: loadSchema('https://x.test/a.json') failed: 503 Service Unavailable at #/properties/a/%24ref");
    assert.equal(error.docPath, '#/properties/a/%24ref');
    assert.equal(error.cause, offline);
    const nested = await refusal(compileAsync(new JarenValidator(), { $ref: 'https://x.test/a.json' },
      served({ 'https://x.test/a.json': { items: [{ $ref: 'b.json' }] } })));
    assert.equal(nested.message, "JK0004: loadSchema('https://x.test/b.json') failed: no document at https://x.test/b.json at https://x.test/a.json#/items/0/%24ref");
    const rejected = await refusal(compileAsync(new JarenValidator(), { $ref: 'https://x.test/a.json' }, { loadSchema: () => Promise.reject('gone') }));
    assert.equal(rejected.message, "JK0004: loadSchema('https://x.test/a.json') failed: gone at #/%24ref");
    assert.equal(rejected.cause, 'gone');
  });

  it('JK0004 for a reference in a schema the validator held says so', async () => {
    const validator = new JarenValidator();
    validator.addSchema({ $id: 'https://x.test/held.json', properties: { n: { $ref: 'name.json#/x' } } });
    const error = await refusal(compileAsync(validator, { type: 'object' }, served({})));
    assert.equal(error.message, "JK0004: loadSchema('https://x.test/name.json') failed: no document at https://x.test/name.json, referenced by a schema the validator held");
    assert.equal(error.docPath, undefined);
  });

  it('JK0005: the loader returns something that is not a schema', async () => {
    const answers = [['{"type":"string"}', "the string '{\"type\":\"string\"}'"], [null, 'null'], [[{}], 'an array'], [42, '42'], [undefined, 'undefined']];
    for (const [value, named] of answers) {
      const error = await refusal(compileAsync(new JarenValidator(), { items: { $ref: 'https://x.test/s.json' } }, { loadSchema: async () => value }));
      assert.equal(error.message, `JK0005: loadSchema('https://x.test/s.json') returned ${named}, not a schema (an object or a boolean) at #/items/%24ref`);
    }
    const yes = await compileAsync(new JarenValidator(), { $ref: 'https://x.test/t.json' }, { loadSchema: async () => true });
    const no = await compileAsync(new JarenValidator(), { $ref: 'https://x.test/f.json' }, { loadSchema: async () => false });
    assert.deepEqual([yes(1), no(1)], [true, false]);
  });

  it('JK0006: a loader that keeps answering with new references is stopped at maxLoads (default 100)', async () => {
    assert.equal(DEFAULT_MAX_LOADS, 100);
    let loaded = 0;
    // A chain of 1000 documents, each referencing the next.
    const loadSchema = async (/** @type {string} */ uri) => {
      loaded++;
      const next = Number(uri.slice('https://x.test/'.length, -'.json'.length)) + 1;
      return next < 1000 ? { $ref: `${next}.json` } : { type: 'integer' };
    };
    const error = await refusal(compileAsync(new JarenValidator(), { $ref: 'https://x.test/0.json' }, { loadSchema }));
    assert.equal(error.message, "JK0006: compileAsync needs more than 100 schema loads (maxLoads); one more is 'https://x.test/100.json' at https://x.test/99.json#/%24ref");
    assert.equal(loaded, 100);
    loaded = 0;
    const bounded = await refusal(compileAsync(new JarenValidator(), { $ref: 'https://x.test/0.json' }, { loadSchema, maxLoads: 2 }));
    assert.equal(bounded.message, "JK0006: compileAsync needs more than 2 schema loads (maxLoads); one more is 'https://x.test/2.json' at https://x.test/1.json#/%24ref");
    assert.equal(loaded, 2);
    const chain = served({ 'https://x.test/a.json': { $ref: 'b.json' }, 'https://x.test/b.json': { type: 'integer' } });
    const enough = await compileAsync(new JarenValidator(), { $ref: 'https://x.test/a.json' }, { ...chain, maxLoads: 2 });
    assert.deepEqual([enough(1), enough('1')], [true, false]);
  });

  it('JK0007: an argument compileAsync does not take', async () => {
    const loadSchema = async () => ({});
    const cases = /** @type {[any, any, string][]} */ ([
      [{}, { loadSchema }, 'compileAsync takes a JarenValidator, got object'],
      [new JarenValidator(), undefined, 'compileAsync takes a loadSchema(uri) function, got undefined'],
      [new JarenValidator(), { loadSchema: 'fetch' }, "compileAsync takes a loadSchema(uri) function, got 'fetch'"],
      [new JarenValidator(), { loadSchema, maxLoads: 0 }, 'maxLoads must be a positive safe integer, got 0'],
      [new JarenValidator(), { loadSchema, maxLoads: 1.5 }, 'maxLoads must be a positive safe integer, got 1.5'],
      [new JarenValidator(), { loadSchema, maxLoads: '3' }, 'maxLoads must be a positive safe integer, got "3"'],
    ]);
    for (const [validator, options, reason] of cases) {
      const error = await refusal(compileAsync(validator, { type: 'string' }, options));
      assert.equal(error.message, `JK0007: ${reason}`);
    }
  });

  it('every new code has its row', () => {
    assert.deepEqual(['JK0004', 'JK0005', 'JK0006', 'JK0007'].map((code) => typeof VALIDATE_CODES[code]), ['string', 'string', 'string', 'string']);
    // what loadSchema's answer is checked for: its kind, not a meta-schema
    assert.equal(VALIDATE_CODES.JK0005, 'compileAsync: a loaded document is not a schema (an object or a boolean)');
  });
});


describe('compileAsync and a relative reference in a schema without $id', () => {
  const BASE = 'https://github.com/jklarenbeek/jarenjs';
  const hint = `; the URI is under the validator's default base '${BASE}', which no $id and no traverse origin names: `
    + 'give the schema an $id, or the validator a base (traverse: new TraverseOptions(base))';

  it('a failed load of a URI under the default base names the base and the repair', async () => {
    const thrown = await refusal(compileAsync(new JarenValidator(), { properties: { n: { $ref: 'name.json' } } }, served({})));
    assert.equal(thrown.code, 'JK0004');
    assert.equal(thrown.docPath, '#/properties/n/%24ref');
    assert.equal(thrown.message, `JK0004: loadSchema('https://github.com/jklarenbeek/name.json') failed: no document at https://github.com/jklarenbeek/name.json${hint} at #/properties/n/%24ref`);
    const returned = await refusal(compileAsync(new JarenValidator(), { $ref: 'name.json' }, { loadSchema: () => '{"type":"string"}' }));
    assert.equal(returned.message, `JK0005: loadSchema('https://github.com/jklarenbeek/name.json') returned the string '{"type":"string"}', not a schema (an object or a boolean)${hint} at #/%24ref`);
  });

  it('answers as before wherever the base was named or the document is held', async () => {
    const name = { type: 'string' };
    // a loader that serves the default-base URI
    const atDefault = served({ 'https://github.com/jklarenbeek/name.json': name });
    const v1 = await compileAsync(new JarenValidator(), { $ref: 'name.json' }, atDefault);
    assert.deepEqual([atDefault.calls, v1('x'), v1(1)], [['https://github.com/jklarenbeek/name.json'], true, false]);
    // the validator names the base
    const atOrigin = served({ 'file:///schemas/name.json': name });
    const v2 = await compileAsync(new JarenValidator({ traverse: new TraverseOptions('file:///schemas/root.json') }), { $ref: 'name.json' }, atOrigin);
    assert.deepEqual([atOrigin.calls, v2('x'), v2(1)], [['file:///schemas/name.json'], true, false]);
    // the schema names the base
    const atId = served({ 'https://ex.test/name.json': name });
    const v3 = await compileAsync(new JarenValidator(), { $id: 'https://ex.test/root.json', $ref: 'name.json' }, atId);
    assert.deepEqual([atId.calls, v3('x'), v3(1)], [['https://ex.test/name.json'], true, false]);
    // a document added under the URI the reference resolves to is held
    const held = new JarenValidator().addSchema(name, 'https://github.com/jklarenbeek/name.json');
    const none = served({});
    const v4 = await compileAsync(held, { $ref: 'name.json' }, none);
    assert.deepEqual([none.calls, v4('x'), v4(1)], [[], true, false]);
    // a refusal under a base the host named carries no hint
    const named = await refusal(compileAsync(new JarenValidator({ traverse: new TraverseOptions('file:///schemas/root.json') }), { $ref: 'name.json' }, served({})));
    assert.equal(named.message, "JK0004: loadSchema('file:///schemas/name.json') failed: no document at file:///schemas/name.json at #/%24ref");
  });
});
