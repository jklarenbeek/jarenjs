//@ts-check
/**
 * @file A `$ref` written inside a schema another document holds (one
 * registered through `options.schemas`) reads against that document — its
 * `$defs`, its anchors, its embedded resources, the documents it names in
 * turn — wherever the contract reads it: the validators of an operation's
 * input, output, error and subscription schemas, the input's members and
 * their transport, the output's null check, and `diffContracts`. The
 * oracle is the validator itself over the other document: a
 * `JarenValidator` holding it and compiling a `$ref` to the schema answers
 * every instance as the contract must.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { compileContract, lintContract } from '@jarenjs/contract';
import { openHttpClient } from '@jarenjs/contract/client';
import { diffContracts } from '@jarenjs/contract/diff';
import { toMarkdown, toOpenApi } from '@jarenjs/contract/project';

const LIB = 'https://x.example/lib.json';
const LIB2 = 'https://y.example/lib2.json';

/**
 * A validator's answer, or the code it threw.
 * @param {(value: unknown) => any} fn
 * @param {unknown} value
 */
function verdict(fn, value) {
  try {
    const result = fn(value);
    return typeof result === 'boolean' ? result : result.valid;
  }
  catch (err) {
    return `throws ${/** @type {any} */ (err).code}`;
  }
}

/**
 * The oracle: a validator holding the documents, compiling `schema`.
 * @param {any[]} docs
 * @param {any} schema
 * @returns {(value: unknown) => unknown}
 */
function oracle(docs, schema) {
  const validator = new JarenValidator({ collectErrors: true, skipErrors: false });
  for (const doc of docs) validator.addSchema(doc);
  let fn;
  try {
    fn = validator.compile(schema);
  }
  catch (err) {
    return () => `compile throws ${/** @type {any} */ (err).code}`;
  }
  const compiled = fn;
  return (value) => verdict(compiled, value);
}

const VALUES = [1, 1.5, 'a', '', true, false, null, {}, [], ['a'], { m: 'a' }, { m: 1 }];

/**
 * Input instances over member names: each value at each member, the same
 * value one object down, and the empty object.
 * @param {string[]} names
 */
function instances(names) {
  /** @type {unknown[]} */
  const out = [{}];
  for (const name of names) {
    for (const value of VALUES) out.push({ [name]: value }, { [name]: { m: value } });
  }
  return out;
}

/** @param {any} input @param {any} [$defs] */
const command = (input, $defs) => ({
  $contract: '0.1', ...($defs === undefined ? {} : { $defs }),
  operations: { 'a.b': { kind: 'command', input, output: true, http: { method: 'POST', path: '/a' } } },
});

/** @param {string} type */
const typed = (type) => ({ type });

/** @param {any} S @param {Record<string, any>} [defs] - more definitions */
const lib = (S, defs = {}) => ({
  $id: LIB,
  $defs: { S, In: { type: 'object', properties: { m: { $ref: '#/$defs/S' } } }, ...defs },
});

const IN = { $ref: `${LIB}#/$defs/In` };

/**
 * Each case: the documents registered, the operation's input, the
 * contract's own definitions, what the input means as a schema the
 * oracle compiles, and the member names its instances use.
 * @type {[string, any[], any, any, any, string[]][]}
 */
const AGREE = [
  ['the contract holds no definition of that name', [lib(typed('string'))], IN, undefined, IN, ['m']],
  ['the contract holds one of another type', [lib(typed('string'))], IN, { S: typed('number') }, IN, ['m']],
  ['the contract holds one of the same type', [lib(typed('string'))], IN, { S: typed('string') }, IN, ['m']],
  ['a chain of references inside the other document', [lib({ $ref: '#/$defs/T' }, { T: typed('integer') })], IN,
    { S: typed('boolean'), T: typed('string') }, IN, ['m']],
  ['a resource embedded in the other document, with its own definitions',
    [{ $id: LIB, $defs: { T: typed('string'), In: { $id: 'in.json', type: 'object', properties: { m: { $ref: '#/$defs/T' } }, $defs: { T: typed('boolean') } } } }],
    IN, { T: typed('number') }, IN, ['m']],
  ['an anchor', [{ $id: LIB, $defs: { S: { $anchor: 'str', type: 'string' }, In: { $anchor: 'in', type: 'object', properties: { m: { $ref: '#str' } } } } }],
    { $ref: `${LIB}#in` }, { X: { $anchor: 'str', type: 'number' } }, { $ref: `${LIB}#in` }, ['m']],
  ['a second document the first names by an absolute reference',
    [lib(typed('string'), { In: { type: 'object', properties: { n: { $ref: `${LIB2}#/$defs/B` } } } }),
      { $id: LIB2, $defs: { U: typed('boolean'), B: { type: 'object', properties: { m: { $ref: '#/$defs/U' } } } } }],
    IN, { U: typed('number') }, IN, ['n']],
  ['a second document the first names by a relative reference',
    [lib(typed('string'), { In: { type: 'object', properties: { m: { $ref: 'lib3.json#/$defs/U' } } } }),
      { $id: 'https://x.example/lib3.json', $defs: { U: typed('boolean') } }],
    IN, { U: typed('number') }, IN, ['m']],
  ['a chain of bare references across two documents',
    [lib(typed('string'), { A: { $ref: `${LIB2}#/$defs/B` } }),
      { $id: LIB2, $defs: { U: typed('boolean'), B: { type: 'object', properties: { m: { $ref: '#/$defs/U' } } } } }],
    { $ref: `${LIB}#/$defs/A` }, { U: typed('number') }, { $ref: `${LIB}#/$defs/A` }, ['m']],
  ['a contract definition that refers to the other document', [lib(typed('string'))], { $ref: '#/$defs/I' },
    { I: IN, S: typed('number') }, IN, ['m']],
  ['a reference beside annotations', [lib(typed('string'))], { ...IN, title: 'In', description: 'the input' },
    { S: typed('number') }, IN, ['m']],
  ['a member referring to a contract definition that refers to the other document', [lib(typed('string'))],
    { type: 'object', properties: { x: { $ref: '#/$defs/L' } } }, { L: IN, S: typed('number') },
    { type: 'object', properties: { x: IN } }, ['x']],
];

describe('a reference inside a schema another document holds reads against that document', () => {
  for (const [name, docs, input, $defs, meaning, names] of AGREE) {
    it(`input validation answers as the validator over the document: ${name}`, () => {
      const contract = compileContract(command(input, $defs), { schemas: docs });
      const validate = /** @type {any} */ (contract.operations['a.b'].input).validate;
      const want = oracle(docs, meaning);
      for (const value of instances(names)) {
        assert.deepStrictEqual(verdict(validate, value), want(value), `${JSON.stringify(value)}`);
      }
    });
  }

  const OUT = { $id: LIB, $defs: { S: typed('string'), Out: { type: 'object', properties: { m: { $ref: '#/$defs/S' } } } } };
  const outRef = { $ref: `${LIB}#/$defs/Out` };

  it('an output, an error schema and a subscription read it there too', () => {
    const contract = compileContract({
      $contract: '0.1', $defs: { S: typed('number') },
      operations: {
        'a.read': { kind: 'read', output: outRef, errors: { gone: { status: 410, schema: outRef } }, http: { method: 'GET', path: '/r' } },
        'a.watch': { kind: 'subscribe', output: outRef, http: { method: 'GET', path: '/w' } },
      },
    }, { schemas: [OUT] });
    const read = contract.operations['a.read'];
    const watch = contract.operations['a.watch'];
    const answers = (/** @type {any} */ fn) => [verdict(fn, { m: 'a' }), verdict(fn, { m: 1 })];
    assert.deepStrictEqual(answers(read.output.validate), [true, false]);
    assert.deepStrictEqual(answers(read.errors.gone.validate), [true, false]);
    assert.deepStrictEqual(answers(watch.output.validate), [true, false]);
  });

  it('a constraint the other document holds names its own location in the error', () => {
    const contract = compileContract(command(IN), { schemas: [lib(typed('string'))] });
    const result = /** @type {any} */ (contract.operations['a.b'].input).validate({ m: 1 });
    assert.deepStrictEqual(result.errors.map((/** @type {any} */ e) => [e.instancePath, e.schemaPath]),
      [['/m', `${LIB}#/$defs/S`]]);
  });

  it("the input's members come from the schema the other document's chain reaches", () => {
    const docs = [lib(typed('string'), { In2: { $ref: '#/$defs/In' }, In: { type: 'object', properties: { id: typed('integer') } } })];
    const input = { $ref: `${LIB}#/$defs/In2` };
    const alone = compileContract(command(input), { schemas: docs });
    assert.deepStrictEqual(Object.keys(alone.operations['a.b'].http.in), ['id']);
    assert.strictEqual(alone.operations['a.b'].input?.effective, docs[0].$defs.In);
    const shadowed = compileContract(command(input, { In: { type: 'object', properties: { other: typed('string') } } }), { schemas: docs });
    assert.deepStrictEqual(Object.keys(shadowed.operations['a.b'].http.in), ['id']);
  });

  it('a schema the other document resolves to that the contract would refuse is refused when it compiles', () => {
    /** @param {() => unknown} fn */
    const refused = (fn) => {
      try {
        fn();
        return null;
      }
      catch (err) {
        return [/** @type {any} */ (err).code, /** @type {any} */ (err).docPath];
      }
    };
    // the contract's own definitions of the same names would have passed
    const notObject = [lib(typed('string'), { In2: { $ref: '#/$defs/In' }, In: typed('string') })];
    assert.deepStrictEqual(refused(() => compileContract(command({ $ref: `${LIB}#/$defs/In2` }, { In: { type: 'object' } }), { schemas: notObject })),
      ['JC0005', '/operations/a.b/input']);
    const notNull = [{ $id: LIB, $defs: { Nothing: { $ref: '#/$defs/Null' }, Null: typed('string') } }];
    assert.deepStrictEqual(refused(() => compileContract({
      $contract: '0.1', $defs: { Null: typed('null') },
      operations: { 'a.b': { kind: 'command', output: { $ref: `${LIB}#/$defs/Nothing` }, http: { method: 'POST', path: '/a', status: 204 } } },
    }, { schemas: notNull })), ['JC0012', '/operations/a.b/http/status']);
  });

  it("an output's null check reads the other document", () => {
    const docs = [{ $id: LIB, $defs: { Nothing: { $ref: '#/$defs/Null' }, Null: typed('null') } }];
    const contract = compileContract({
      $contract: '0.1', $defs: { Null: typed('string') },
      operations: { 'a.b': { kind: 'command', output: { $ref: `${LIB}#/$defs/Nothing` }, http: { method: 'POST', path: '/a', status: 204 } } },
    }, { schemas: docs });
    const output = contract.operations['a.b'].output;
    assert.strictEqual(output.admitsNull, true);
    assert.deepStrictEqual([verdict(output.validate, null), verdict(output.validate, 'a')], [true, false]);
  });

  it('query members the other document types decode as the same members held in the contract', () => {
    const defs = {
      Int: typed('integer'), Tags: { type: 'array', items: { $ref: '#/$defs/Int' } },
      Q: { type: 'object', properties: { n: { $ref: '#/$defs/Int' }, tags: { $ref: '#/$defs/Tags' }, maybe: { anyOf: [{ $ref: '#/$defs/Int' }, typed('null')] } } },
    };
    /** @param {any} input @param {any} $defs @param {any[]} schemas */
    const transportOf = (input, $defs, schemas) => /** @type {any} */ (compileContract({
      $contract: '0.1', $defs,
      operations: { 'a.q': { kind: 'read', input, output: true, http: { method: 'GET', path: '/q' } } },
    }, { schemas }).operations['a.q'].input);
    const held = transportOf({ $ref: `${LIB}#/$defs/Q` }, { Int: typed('string') }, [{ $id: LIB, $defs: defs }]);
    const own = transportOf({ $ref: '#/$defs/Q' }, defs, []);
    const raw = { n: '5', tags: ['1', '2'], maybe: '7' };
    assert.deepStrictEqual(held.transport.members.repeated, ['tags']);
    assert.deepStrictEqual(held.transport.normalize(raw), { n: 5, tags: ['1', '2'], maybe: 7 });
    assert.deepStrictEqual([held.transport.members, held.transport.normalize(raw), verdict(held.validate, held.transport.normalize(raw))],
      [own.transport.members, own.transport.normalize(raw), verdict(own.validate, own.transport.normalize(raw))]);
  });

  it('a query member decodes through every document the references reach, however deep', () => {
    /** @param {any} n @param {any[]} schemas @param {any} [input] */
    const decode = (n, schemas, input = { $ref: `${LIB}#/$defs/Q` }) => /** @type {any} */ (compileContract({
      $contract: '0.1', $defs: { Int: typed('string') },
      operations: { 'a.q': { kind: 'read', input, output: true, http: { method: 'GET', path: '/q' } } },
    }, { schemas }).operations['a.q'].input).transport.normalize({ n });
    const second = { $id: LIB2, $defs: { Int: typed('integer') } };
    // the other document names a second one only below an applicator
    assert.deepStrictEqual(decode('5', [{ $id: LIB, $defs: { Q: { type: 'object', properties: { n: { allOf: [{ $ref: `${LIB2}#/$defs/Int` }] } } } } }, second]), { n: 5 });
    // the contract names the other document only below an applicator
    assert.deepStrictEqual(decode('5', [second], { type: 'object', properties: { n: { allOf: [{ $ref: `${LIB2}#/$defs/Int` }] } } }), { n: 5 });
  });

  it('the input a pointer below a non-schema position reaches reads its references in its document', () => {
    /** @param {string} type */
    const docs = (type) => [{ $id: LIB, $defs: { S: typed(type) }, x: { In: { type: 'object', properties: { m: { $ref: '#/$defs/S' } } } } }];
    const input = { $ref: `${LIB}#/x/In` };
    const a = compileContract(command(input, { S: typed('string') }), { schemas: docs('string') });
    const b = compileContract(command(input, { S: typed('string') }), { schemas: docs('number') });
    assert.deepStrictEqual(diffContracts(a, b).breaking.map((c) => [c.rule, c.docPath]), [['R6', '/operations/a.b/input/properties/m/type']]);
  });

  it('a query member the contract types by an absolute reference is decoded by the schema it names', () => {
    const contract = compileContract({
      $contract: '0.1',
      operations: { 'a.q': { kind: 'read', input: { type: 'object', properties: { n: { $ref: `${LIB}#/$defs/Int` } } }, output: true, http: { method: 'GET', path: '/q' } } },
    }, { schemas: [{ $id: LIB, $defs: { Int: typed('integer') } }] });
    const input = /** @type {any} */ (contract.operations['a.q'].input);
    assert.deepStrictEqual(input.transport.normalize({ n: '5' }), { n: 5 });
  });
});

describe('diffContracts reads a change inside another document by what requests it admits', () => {
  /** @param {any} d */
  const changes = (d) => ['breaking', 'additive', 'neutral', 'unknown'].flatMap((name) => d[name].map((/** @type {any} */ c) => [name, c.rule, c.kind, c.docPath]));
  /** @param {any} doc @param {any[]} docs */
  const compiled = (doc, docs) => compileContract(doc, { schemas: docs });
  /** @param {any} contract @param {'input' | 'output'} where @param {unknown} value */
  const admits = (contract, where, value) => verdict(contract.operations['a.b'][where].validate, value);
  /** @param {any} output */
  const read = (output) => ({ $contract: '0.1', operations: { 'a.b': { kind: 'read', output, http: { method: 'GET', path: '/a' } } } });

  it('a definition the input reaches in the other document changing type is breaking, whatever the contract defines under its name', () => {
    for (const $defs of [undefined, { S: typed('string') }]) {
      const a = compiled(command(IN, $defs), [lib(typed('string'))]);
      const b = compiled(command(IN, $defs), [lib(typed('number'))]);
      assert.deepStrictEqual(changes(diffContracts(a, b)), [
        ['breaking', 'R6', 'input-narrowed', '/operations/a.b/input/properties/m/type'],
        ['additive', 'R7', 'input-widened', '/operations/a.b/input/properties/m/type'],
      ]);
      // the witnesses: a request a accepted that b refuses, and one b gained
      assert.deepStrictEqual([admits(a, 'input', { m: 'a' }), admits(b, 'input', { m: 'a' })], [true, false]);
      assert.deepStrictEqual([admits(a, 'input', { m: 1 }), admits(b, 'input', { m: 1 })], [false, true]);
    }
  });

  it('a member the contract types by an absolute reference is read through it', () => {
    const member = { type: 'object', properties: { m: { $ref: `${LIB}#/$defs/S` } } };
    const a = compiled(command(member), [lib(typed('string'))]);
    const b = compiled(command(member), [lib(typed('number'))]);
    assert.deepStrictEqual(changes(diffContracts(a, b)), [
      ['breaking', 'R6', 'input-narrowed', '/operations/a.b/input/properties/m/type'],
      ['additive', 'R7', 'input-widened', '/operations/a.b/input/properties/m/type'],
    ]);
    assert.deepStrictEqual([admits(a, 'input', { m: 'a' }), admits(b, 'input', { m: 'a' })], [true, false]);
  });

  it('a second document the first names is read too', () => {
    /** @param {string} type */
    const docs = (type) => [lib(typed('string'), { In: { type: 'object', properties: { n: { $ref: `${LIB2}#/$defs/B` } } } }),
      { $id: LIB2, $defs: { U: typed(type), B: { type: 'object', properties: { m: { $ref: '#/$defs/U' } } } } }];
    const a = compiled(command(IN, { U: typed('boolean') }), docs('boolean'));
    const b = compiled(command(IN, { U: typed('boolean') }), docs('string'));
    assert.deepStrictEqual(changes(diffContracts(a, b)), [
      ['breaking', 'R6', 'input-narrowed', '/operations/a.b/input/properties/n/properties/m/type'],
      ['additive', 'R7', 'input-widened', '/operations/a.b/input/properties/n/properties/m/type'],
    ]);
    assert.deepStrictEqual([admits(a, 'input', { n: { m: true } }), admits(b, 'input', { n: { m: true } })], [true, false]);
  });

  it('an output that may now answer null is breaking for the old reader', () => {
    const out = (/** @type {any} */ S) => ({ $id: LIB, $defs: { S, Out: { type: 'object', properties: { m: { $ref: '#/$defs/S' } } } } });
    const a = compiled(read({ $ref: `${LIB}#/$defs/Out` }), [out(typed('string'))]);
    const b = compiled(read({ $ref: `${LIB}#/$defs/Out` }), [out({ type: ['string', 'null'] })]);
    assert.deepStrictEqual(changes(diffContracts(a, b)), [
      ['breaking', 'R8', 'output-widened', '/operations/a.b/output/properties/m/type'],
    ]);
    assert.deepStrictEqual([admits(b, 'output', { m: null }), admits(a, 'output', { m: null })], [true, false]);
  });

  it('a construct compared by its text reads a reference inside it against the other document', () => {
    /** @param {string} type */
    const docs = (type) => [lib(typed(type), { T: typed('string'), In: { type: 'object', properties: { m: { anyOf: [{ $ref: '#/$defs/S' }, { $ref: '#/$defs/T' }] } } } })];
    const a = compiled(command(IN), docs('string'));
    const b = compiled(command(IN), docs('number'));
    assert.deepStrictEqual(changes(diffContracts(a, b)), [['unknown', 'R15', 'schema-unknown', '/operations/a.b/input/properties/m/anyOf/0/type']]);
    assert.deepStrictEqual([admits(a, 'input', { m: 1 }), admits(b, 'input', { m: 1 })], [false, true]);
  });

  it('nothing changes where the other document did not', () => {
    const a = compiled(command(IN), [lib(typed('string'))]);
    const b = compiled(command(IN, { S: typed('number') }), [lib(typed('string'))]);
    assert.deepStrictEqual(changes(diffContracts(a, a)), []);
    assert.deepStrictEqual(changes(diffContracts(a, b)), []);
  });
});

describe('the readers of a compiled contract read a member another document holds there', () => {
  const docs = [{
    $id: LIB, $defs: {
      Id: { type: 'integer', minimum: 1 }, Int: typed('integer'), Text: { type: 'string', minLength: 20 },
      Q: { type: 'object', required: ['id'], properties: { id: { $ref: '#/$defs/Id' }, n: { $ref: '#/$defs/Int' } } },
      Body: { type: 'object', required: ['text'], properties: { text: { $ref: '#/$defs/Text' } } },
    },
  }];
  // the contract defines the same names otherwise, so a reading against it shows
  const contract = compileContract({
    $contract: '0.1', $defs: { Id: typed('string'), Int: typed('string'), Text: typed('string') },
    operations: {
      'a.q': { kind: 'read', input: { $ref: `${LIB}#/$defs/Q` }, output: true, http: { method: 'GET', path: '/q/{id}' } },
      'a.page': { kind: 'read', input: { type: 'object', properties: { page: { $ref: `${LIB}#/$defs/Int` } } }, output: true, http: { method: 'GET', path: '/p' } },
      'a.put': { kind: 'command', input: { $ref: `${LIB}#/$defs/Body` }, output: true, http: { method: 'POST', path: '/b' }, policy: { limits: { maxBodyBytes: 30 } } },
    },
  }, { schemas: docs });

  it("the client's URL check", () => {
    const client = openHttpClient(contract, { baseUrl: 'http://x', fetch: () => Promise.reject(new Error('not sent')) });
    assert.strictEqual(client.url('a.q', { id: 7, n: 2 }), 'http://x/q/7?n=2');
    assert.throws(() => client.url('a.q', { id: 0 }), { code: 'JC1008' });
    assert.strictEqual(client.url('a.page', { page: 3 }), 'http://x/p?page=3');
    assert.throws(() => client.url('a.page', { page: 'x' }), { code: 'JC1008' });
  });

  it('the OpenAPI projection keeps the reference to where it points', () => {
    const { document } = toOpenApi(contract);
    const parameters = /** @type {any} */ (document.paths)['/q/{id}'].get.parameters;
    assert.deepStrictEqual(parameters.map((/** @type {any} */ p) => [p.name, p.schema]), [
      ['id', { $ref: `${LIB}#/$defs/Id` }], ['n', { $ref: `${LIB}#/$defs/Int` }],
    ]);
  });

  it('the Markdown reference labels it by that URI', () => {
    const text = toMarkdown(contract);
    assert.ok(text.includes(`| \`n\` | query | no | \`${LIB}#/$defs/Int\` |`), text);
  });

  it('lint sizes a body by the definitions the other document holds', () => {
    const findings = lintContract(contract).filter((f) => f.op === 'a.put');
    assert.deepStrictEqual(findings.map((f) => [f.rule, f.docPath]), [['body-limit-unsatisfiable', '/operations/a.put/policy/limits/maxBodyBytes']]);
    assert.match(findings[0].message, /at least 31 bytes/);
  });
});

describe('a fragment into another document is percent-decoded once, as the validator decodes it', () => {
  /** @param {string} ref */
  const command = (ref) => ({
    $contract: '0.1',
    operations: { 'a.b': { kind: 'command', input: { type: 'object', properties: { m: { $ref: ref } } }, output: true } },
  });
  /** @param {any} contract @param {unknown} m */
  const admits = (contract, m) => {
    const result = contract.operations['a.b'].input.validate({ m });
    return result === true || result?.valid === true;
  };

  it('compiles an escaped percent sign and validates by the member it names', () => {
    const contract = compileContract(command(`${LIB}#/$defs/a%2520b`),
      { schemas: [{ $id: LIB, $defs: { 'a%20b': { type: 'string' } } }] });
    assert.deepStrictEqual([admits(contract, 'x'), admits(contract, 1)], [true, false]);
  });

  it('tells a member spelled with an escape apart from one spelled with a space', () => {
    const schemas = [{ $id: LIB, $defs: { 'a%20b': { type: 'string' }, 'a b': { type: 'number' } } }];
    const escaped = compileContract(command(`${LIB}#/$defs/a%2520b`), { schemas });
    const spaced = compileContract(command(`${LIB}#/$defs/a%20b`), { schemas });
    assert.deepStrictEqual([admits(escaped, 'x'), admits(escaped, 1)], [true, false]);
    assert.deepStrictEqual([admits(spaced, 'x'), admits(spaced, 1)], [false, true]);
  });

  it('reads an input another document holds under an escaped name as the object it is', () => {
    const contract = compileContract({
      $contract: '0.1',
      operations: { 'a.b': { kind: 'command', input: { $ref: `${LIB}#/$defs/in%2520put` }, output: true } },
    }, { schemas: [{ $id: LIB, $defs: { 'in%20put': { type: 'object', properties: { m: { type: 'string' } } } } }] });
    assert.deepStrictEqual([admits(contract, 'x'), admits(contract, 1)], [true, false]);
  });

  it('still refuses a fragment that names nothing there, a malformed escape included', () => {
    const schemas = [{ $id: LIB, $defs: { 'a%20b': { type: 'string' } } }];
    for (const fragment of ['#/$defs/a%20b', '#/$defs/missing', '#/$defs/a%']) {
      assert.throws(() => compileContract(command(`${LIB}${fragment}`), { schemas }),
        (/** @type {any} */ error) => error.code === 'JC0007' && /fragment does not resolve/.test(error.message),
        fragment);
    }
  });
});
