//@ts-check
/**
 * @file `compileContract`: the shop example compiles into the documented
 * shape (locations, opaque, canonical default, prepared transport
 * normalizer, validators, frozen at every level); the partner's 123-route
 * table compiles as a contract and `match` resolves every probe in both
 * registration orders; a hostile document is refused totally; and every
 * rule of CONTRACT-FORMAT.md §2 has a negative test asserting the code
 * AND the docPath.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { compileContract, ContractCompileError } from '@jarenjs/contract';
import { load, ROUTES, PROBES, routesToContract, opId } from './helpers.js';

const shop = load('./fixtures/shop.contract.json');

/**
 * A minimal valid document around one operation.
 * @param {any} op
 * @param {any} [rootExtra]
 */
function one(op, rootExtra = {}) {
  return { $contract: '0.1', operations: { a: op }, ...rootExtra };
}

/** A minimal valid read operation. */
const READ = Object.freeze({ kind: 'read', output: true, http: { method: 'GET', path: '/a' } });

/**
 * Assert a compile refuses with `code` at `docPath`.
 * @param {any} doc
 * @param {string} code
 * @param {string} docPath
 * @param {RegExp} [message]
 * @param {any} [options]
 */
function refuses(doc, code, docPath, message, options) {
  assert.throws(() => compileContract(doc, options), (err) => {
    assert.ok(err instanceof ContractCompileError, `expected ContractCompileError, got ${String(err)}`);
    assert.strictEqual(err.code, code, `code (message: ${err.message})`);
    assert.strictEqual(err.docPath, docPath, `docPath (message: ${err.message})`);
    if (message !== undefined) assert.match(err.message, message);
    return true;
  });
}

/**
 * Every object/function reachable from `value` is frozen; returns the
 * paths that are not.
 * @param {any} value
 * @param {string} [path]
 * @param {Set<any>} [seen]
 * @returns {string[]}
 */
function unfrozen(value, path = '', seen = new Set()) {
  const out = [];
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value)) return out;
  seen.add(value);
  if (!Object.isFrozen(value)) out.push(path === '' ? '<root>' : path);
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) out.push(...unfrozen(value[key], `${path}/${key}`, seen));
  }
  return out;
}

describe('compileContract — the shop example', () => {
  const contract = compileContract(shop);

  it('lists the operations in document order and resolves the header members', () => {
    assert.deepStrictEqual(contract.ids, ['catalog.load', 'product.save', 'image.bytes', 'product.search', 'product.remove']);
    assert.strictEqual(contract.id, 'shop');
    assert.strictEqual(contract.version, '5');
    assert.deepStrictEqual(contract.compat, ['4']);
    assert.strictEqual(Object.keys(contract.$defs).length, 3);
    assert.strictEqual(contract.doc.$contract, '0.1');
    assert.notStrictEqual(contract.doc, shop, 'the source is snapshotted, not aliased — the caller keeps a mutable copy');
    assert.deepStrictEqual(contract.doc, shop);
  });

  it("product.save: path variable → path, the rest → body as declared, PUT template canonical", () => {
    const op = contract.operations['product.save'];
    assert.deepStrictEqual({ ...op.http.in }, { id: 'path', revision: 'body', product: 'body' });
    assert.strictEqual(op.http.method, 'PUT');
    assert.strictEqual(op.http.path, '/api/products/{id}/master');
    assert.deepStrictEqual(op.http.variables, ['id']);
    assert.strictEqual(op.http.body, null);
    assert.strictEqual(op.http.status, 200);
    assert.strictEqual(op.http.media, 'application/json');
    assert.strictEqual(op.http.opaque, false);
    assert.deepStrictEqual(op.http.template.segments.map((s) => (s.variable ? `{${s.text}}` : s.text)), ['api', 'products', '{id}', 'master']);
    assert.strictEqual(op.kind, 'command');
    assert.strictEqual(op.doc, null);
    assert.deepStrictEqual(op.policy, {
      task: 'exhaust', idempotency: 'required', revision: 'input:/revision', cache: 'none',
      limits: { maxBodyBytes: 1048576 }, errors: { details: 'paths' }, retry: { max: 2, on: ['not-found'] },
      audience: 'public',
    });
    assert.deepStrictEqual(Object.keys(op.errors), ['conflict', 'not-found']);
    assert.strictEqual(op.errors.conflict.status, 409);
    assert.strictEqual(op.errors['not-found'].status, 404);
    assert.strictEqual(op.errors['not-found'].schema, null);
    assert.strictEqual(op.errors['not-found'].validate, null);
    assert.strictEqual(typeof op.errors.conflict.validate, 'function');
    assert.strictEqual(op.errors.conflict.validate({ current: { id: 1, name: 'x', price: 1 } }).valid, true);
    assert.strictEqual(op.errors.conflict.validate({}).valid, false);
  });

  it('catalog.load: read defaults (query, switch, none) with declared cache and doc', () => {
    const op = contract.operations['catalog.load'];
    assert.deepStrictEqual({ ...op.http.in }, { since: 'query' });
    assert.strictEqual(op.policy.task, 'switch');
    assert.strictEqual(op.policy.cache, 'revision');
    assert.strictEqual(op.policy.idempotency, 'none');
    assert.strictEqual(op.doc, 'The whole catalog snapshot.');
    assert.strictEqual(op.errors.stale.status, 409);
    assert.strictEqual(op.errors.stale.schema, null);
  });

  it('image.bytes is opaque: routed, decoded, never validated as JSON', () => {
    const op = contract.operations['image.bytes'];
    assert.strictEqual(op.http.opaque, true);
    assert.strictEqual(op.http.media, 'application/octet-stream');
    assert.deepStrictEqual({ ...op.http.in }, { id: 'path' });
    assert.strictEqual(op.output.validate(Symbol.for('anything')).valid, true, 'output: true accepts anything');
  });

  it('an operation without http gets the canonical POST /<id> with every member in the body', () => {
    const op = contract.operations['product.remove'];
    assert.strictEqual(op.http.method, 'POST');
    assert.strictEqual(op.http.path, '/product.remove');
    assert.deepStrictEqual({ ...op.http.in }, { id: 'body' });
    assert.deepStrictEqual(op.http.variables, []);
    assert.strictEqual(op.input?.transport, null, 'nothing travels as a string');
    assert.deepStrictEqual(op.policy, {
      task: 'exhaust', idempotency: 'optional', revision: null, cache: 'none',
      limits: { maxBodyBytes: 4096 }, errors: { details: 'full' }, retry: null,
      audience: 'public',
    });
    assert.deepStrictEqual(contract.operations['product.save'].policy.retry, { max: 2, on: ['not-found'] });
    assert.deepStrictEqual(contract.match('POST', '/product.remove')?.op.id, 'product.remove');
  });

  it('the prepared transport normalizer coerces path/query strings and leaves unknown members alone', () => {
    const save = contract.operations['product.save'];
    assert.ok(save.input !== null && save.input.transport !== null);
    assert.deepStrictEqual(save.input.transport.members, { path: ['id'], query: [], header: [], repeated: [] });
    assert.deepStrictEqual(save.input.transport.normalize({ id: '12' }), { id: 12 });
    const search = contract.operations['product.search'];
    assert.ok(search.input !== null && search.input.transport !== null);
    assert.deepStrictEqual(search.input.transport.members, { path: [], query: ['q', 'limit', 'tag', 'flag'], header: [], repeated: ['tag'] });
    // an array-typed HEADER member is listed in repeated too (a header list collects lines or splits on commas)
    const withHeaders = compileContract(one({
      kind: 'read',
      input: { type: 'object', properties: { 'x-tags': { type: 'array', items: { type: 'string' } }, 'x-rev': { type: 'integer' }, q: { type: 'array' } } },
      output: true,
      http: { method: 'GET', path: '/a', in: { 'x-tags': 'header', 'x-rev': 'header' } },
    }));
    assert.deepStrictEqual(withHeaders.operations.a.input.transport.members, { path: [], query: ['q'], header: ['x-tags', 'x-rev'], repeated: ['x-tags', 'q'] });
    assert.deepStrictEqual(
      search.input.transport.normalize({ id: '12', limit: '20', flag: 'true' }),
      { id: '12', limit: 20, flag: true },
      'id is not a member of this schema, so its string stays a string');
    assert.deepStrictEqual(search.input.transport.normalize({ tag: ['a', 'b'], limit: 'abc' }), { tag: ['a', 'b'], limit: 'abc' });
  });

  it('body members are never coerced: the input validator sees the body as sent', () => {
    const save = contract.operations['product.save'];
    assert.ok(save.input !== null && save.input.transport !== null);
    assert.deepStrictEqual(save.input.transport.normalize({ id: '1', revision: '3' }), { id: 1, revision: '3' });
    assert.strictEqual(save.input.validate({ id: 1, revision: '3', product: { id: 1, name: 'x', price: 1 } }).valid, false);
    assert.strictEqual(save.input.validate({ id: 1, revision: 3, product: { id: 1, name: 'x', price: 1 } }).valid, true);
  });

  it('output.validate rejects a wrong shape and reports through the validator contract', () => {
    const result = contract.operations['product.save'].output.validate({ id: 'x' });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length >= 1);
    assert.strictEqual(contract.operations['product.save'].output.validate({ id: 1, name: 'x', price: 2.5 }).valid, true);
    assert.strictEqual(contract.operations['catalog.load'].output.validate({ revision: 1, products: [] }).valid, true);
    assert.strictEqual(contract.operations['catalog.load'].output.validate({ revision: 1 }).valid, false);
  });

  it('match resolves the declared and the canonical bindings and returns the compiled operation', () => {
    const hit = contract.match('PUT', '/api/products/12/master');
    assert.ok(hit !== null);
    assert.strictEqual(hit.op, contract.operations['product.save']);
    assert.deepStrictEqual({ ...hit.params }, { id: '12' });
    assert.strictEqual(contract.match('GET', '/api/products')?.op.id, 'product.search');
    assert.strictEqual(contract.match('GET', '/api/products/9'), null, 'no such shape');
    assert.strictEqual(contract.match('GET', '/api/images/9')?.op.id, 'image.bytes');
    assert.strictEqual(contract.match('DELETE', '/api/products/9'), null);
  });

  it('every level of the contract and its operations is frozen, functions included', () => {
    assert.deepStrictEqual(unfrozen(contract), []);
    assert.deepStrictEqual(unfrozen(contract.operations['product.save']), []);
    assert.strictEqual(Object.isFrozen(contract.doc.operations['product.save'].http), true);
    assert.throws(() => { /** @type {any} */ (contract.operations['product.save'].http).method = 'GET'; }, TypeError);
  });

  it('describe() is pure JSON and round-trips', () => {
    const d = contract.describe();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(d)), d);
    assert.strictEqual(d.operations.length, 5);
    assert.strictEqual(d.revision, null);
  });
});

describe('compileContract — the partner table as a contract', () => {
  it('compiles the 123 routes and resolves all 8 probes with the expected op keys and params', () => {
    const contract = compileContract(routesToContract(ROUTES));
    assert.strictEqual(contract.ids.length, 123);
    for (const probe of PROBES) {
      const hit = contract.match(probe.method, probe.path);
      if (probe.key === null) {
        assert.strictEqual(hit, null, `${probe.method} ${probe.path}`);
      }
      else {
        assert.ok(hit !== null, `${probe.method} ${probe.path} must hit`);
        assert.strictEqual(hit.op.id, probe.key);
        assert.deepStrictEqual({ ...hit.params }, probe.params);
      }
    }
  });

  it('static segment wins when registered before the variable sibling', () => {
    const contract = compileContract(routesToContract(ROUTES));
    assert.ok(contract.ids.indexOf(opId('GET', '/api/production-runs/prefill')) < contract.ids.indexOf(opId('GET', '/api/production-runs/:id')));
    assert.strictEqual(contract.match('GET', '/api/production-runs/prefill')?.op.id, opId('GET', '/api/production-runs/prefill'));
    assert.strictEqual(contract.match('GET', '/api/production-runs/42')?.op.id, opId('GET', '/api/production-runs/:id'));
  });

  it('static segment wins when registered after the variable sibling', () => {
    const contract = compileContract(routesToContract(ROUTES.slice().reverse()));
    assert.ok(contract.ids.indexOf(opId('GET', '/api/production-runs/prefill')) > contract.ids.indexOf(opId('GET', '/api/production-runs/:id')));
    assert.strictEqual(contract.match('GET', '/api/production-runs/prefill')?.op.id, opId('GET', '/api/production-runs/prefill'));
    assert.strictEqual(contract.match('GET', '/api/production-runs/42')?.op.id, opId('GET', '/api/production-runs/:id'));
    assert.strictEqual(contract.match('POST', '/api/enrichments/approve-all')?.op.id, opId('POST', '/api/enrichments/approve-all'));
  });

  it('canonicalizes the :id templates and describes them as {id}', () => {
    const contract = compileContract(routesToContract(ROUTES));
    const op = contract.operations[opId('PATCH', '/api/variants/:id/inventory-locations/:warehouseitemId')];
    assert.strictEqual(op.http.path, '/api/variants/{id}/inventory-locations/{warehouseitemId}');
    assert.deepStrictEqual({ ...op.http.in }, { id: 'path', warehouseitemId: 'path' });
    const described = contract.describe().operations.find((o) => o.id === op.id);
    assert.strictEqual(described?.path, '/api/variants/{id}/inventory-locations/{warehouseitemId}');
  });
});

describe('compileContract — options', () => {
  it('resolves an absolute $ref through options.schemas', () => {
    const contract = compileContract(one({
      kind: 'read', output: { $ref: 'https://example.test/schemas/thing' }, http: { method: 'GET', path: '/t' },
    }), { schemas: [{ $id: 'https://example.test/schemas/thing', type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }] });
    assert.strictEqual(contract.operations.a.output.validate({ n: 1 }).valid, true);
    assert.strictEqual(contract.operations.a.output.validate({}).valid, false);
  });

  it('honors an injected validator (boolean mode) and registers the document under a synthetic id', () => {
    const validator = new JarenValidator();
    const contract = compileContract(one({ kind: 'read', output: { type: 'integer' }, http: { method: 'GET', path: '/t' } }), { validator });
    assert.strictEqual(contract.operations.a.output.validate(1), true);
    assert.strictEqual(contract.operations.a.output.validate('x'), false);
    // a second contract through the same validator does not collide
    const second = compileContract(one({ kind: 'read', output: { type: 'string' }, http: { method: 'GET', path: '/t' } }), { validator });
    assert.strictEqual(second.operations.a.output.validate('x'), true);
    assert.strictEqual(contract.operations.a.output.validate('x'), false, 'the first contract keeps its own schema');
  });

  it('refuses a schema without $id in options.schemas as a host mistake', () => {
    assert.throws(() => compileContract(one(READ), { schemas: [{ type: 'object' }] }), TypeError);
    assert.throws(() => compileContract(one(READ), { schemas: /** @type {any} */ ({}) }), TypeError);
  });

  it('input as a $ref to an object $defs entry resolves its properties for locations and transport', () => {
    const contract = compileContract({
      $contract: '0.1',
      $defs: { Q: { type: 'object', properties: { id: { type: 'integer' }, page: { $ref: '#/$defs/Page' } } }, Page: { type: 'integer', minimum: 1 } },
      operations: { 'thing.get': { kind: 'read', input: { $ref: '#/$defs/Q' }, output: true, http: { method: 'GET', path: '/things/{id}' } } },
    });
    const op = contract.operations['thing.get'];
    assert.deepStrictEqual({ ...op.http.in }, { id: 'path', page: 'query' });
    assert.ok(op.input !== null && op.input.transport !== null);
    assert.deepStrictEqual(op.input.transport.normalize({ id: '3', page: '2' }), { id: 3, page: 2 }, 'a member $ref resolves against the document');
    assert.deepStrictEqual(op.input.schema, { $ref: '#/$defs/Q' });
  });
});

describe('compileContract — hostile and non-JSON documents (JC0001)', () => {
  it('a throwing accessor is JC0001 at the member that threw', () => {
    const doc = {
      $contract: '0.1',
      operations: {
        a: { kind: 'read', output: true, get http() { throw new Error('boom'); } },
      },
    };
    refuses(doc, 'JC0001', '/operations/a/http', /threw when read/);
    const deep = { $contract: '0.1', operations: { a: { kind: 'read', output: true, http: { method: 'GET', get path() { throw new Error('x'); } } } } };
    refuses(deep, 'JC0001', '/operations/a/http/path');
  });

  it('a throwing ownKeys / prototype trap is JC0001 at the container', () => {
    const hostile = new Proxy({ kind: 'read', output: true }, { ownKeys() { throw new Error('keys'); } });
    refuses({ $contract: '0.1', operations: { a: hostile } }, 'JC0001', '/operations/a');
  });

  it('non-JSON members are JC0001 where they sit', () => {
    refuses(one({ kind: 'read', output: () => true, http: { method: 'GET', path: '/a' } }), 'JC0001', '/operations/a/output', /function/);
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a', status: NaN } }), 'JC0001', '/operations/a/http/status');
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a' }, doc: Symbol('s') }), 'JC0001', '/operations/a/doc');
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a' }, policy: new Date(0) }), 'JC0001', '/operations/a/policy', /class instance/);
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a' }, errors: { e: { status: 10n } } }), 'JC0001', '/operations/a/errors/e/status');
  });

  it('a cyclic document is JC0001', () => {
    /** @type {any} */
    const op = { kind: 'read', output: true, http: { method: 'GET', path: '/a' } };
    op.errors = { loop: { schema: op } };
    refuses(one(op), 'JC0001', '/operations/a/errors/loop/schema', /cyclic/);
  });

  it('undefined members are absent, as in JSON', () => {
    const contract = compileContract(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a' }, doc: undefined, policy: undefined }));
    assert.strictEqual(contract.operations.a.doc, null);
    assert.strictEqual(Object.hasOwn(contract.doc.operations.a, 'doc'), false);
  });
});

describe('compileContract — every rule has its code and docPath', () => {
  it('JC0001 — the document shape', () => {
    refuses(42, 'JC0001', '');
    refuses(null, 'JC0001', '');
    refuses([], 'JC0001', '');
    refuses({ operations: { a: READ } }, 'JC0001', '/$contract');
    refuses({ $contract: '0.2', operations: { a: READ } }, 'JC0001', '/$contract', /0\.2/);
    refuses({ $contract: 0.1, operations: { a: READ } }, 'JC0001', '/$contract');
    refuses(one(READ, { $defs: [] }), 'JC0001', '/$defs');
    refuses(one(READ, { $defs: { X: 5 } }), 'JC0001', '/$defs/X');
  });

  it('JC0002 — operations', () => {
    refuses({ $contract: '0.1' }, 'JC0002', '/operations');
    refuses({ $contract: '0.1', operations: {} }, 'JC0002', '/operations');
    refuses({ $contract: '0.1', operations: [] }, 'JC0002', '/operations');
    refuses({ $contract: '0.1', operations: { a: 1 } }, 'JC0002', '/operations/a');
  });

  it('JC0003 — operation id', () => {
    for (const bad of ['Bad.Id', 'a..b', 'a.', '.a', '1a', 'a-b', 'a_b', 'a b', '']) {
      refuses({ $contract: '0.1', operations: { [bad]: READ } }, 'JC0003', `/operations/${bad}`);
    }
    refuses({ $contract: '0.1', operations: { 'a/b': READ } }, 'JC0003', '/operations/a~1b', undefined);
    assert.doesNotThrow(() => compileContract({ $contract: '0.1', operations: { 'a.b2.c': READ } }));
  });

  it('JC0004 — kind', () => {
    refuses(one({ output: true, http: { method: 'GET', path: '/a' } }), 'JC0004', '/operations/a/kind');
    refuses(one({ kind: 'write', output: true }), 'JC0004', '/operations/a/kind');
    refuses(one({ kind: 'subscribe', output: true }), 'JC0004', '/operations/a/kind', /subscribe.*stream binding/);
  });

  it('JC0005 — input', () => {
    refuses(one({ kind: 'read', input: true, output: true }), 'JC0005', '/operations/a/input');
    refuses(one({ kind: 'read', input: { type: 'string' }, output: true }), 'JC0005', '/operations/a/input');
    refuses(one({ kind: 'read', input: { properties: { x: { type: 'string' } } }, output: true }), 'JC0005', '/operations/a/input', /"type": "object"/);
    refuses(one({ kind: 'read', input: { $ref: '#/$defs/S' }, output: true }, { $defs: { S: { type: 'string' } } }), 'JC0005', '/operations/a/input');
    refuses(one({ kind: 'read', input: { type: ['object', 'null'] }, output: true }), 'JC0005', '/operations/a/input');
  });

  it('JC0006 — output', () => {
    refuses(one({ kind: 'read' }), 'JC0006', '/operations/a/output');
    refuses(one({ kind: 'read', output: 'yes' }), 'JC0006', '/operations/a/output');
    refuses(one({ kind: 'read', output: null }), 'JC0006', '/operations/a/output');
    assert.doesNotThrow(() => compileContract(one({ kind: 'read', output: false })));
  });

  it('JC0007 — $ref', () => {
    refuses(one({ kind: 'read', output: { $ref: '#/$defs/Nope' } }), 'JC0007', '/operations/a/output/$ref');
    refuses(one({ kind: 'read', output: { $ref: '#nope' } }), 'JC0007', '/operations/a/output/$ref');
    refuses(one({ kind: 'read', output: { $ref: 'https://example.test/none' } }), 'JC0007', '/operations/a/output/$ref', /options\.schemas/);
    refuses(one({ kind: 'read', input: { type: 'object', properties: { p: { $ref: '#/$defs/Nope' } } }, output: true }),
      'JC0007', '/operations/a/input/properties/p/$ref');
    refuses(one({ kind: 'read', output: true, errors: { e: { schema: { $ref: '#/$defs/Nope' } } } }), 'JC0007', '/operations/a/errors/e/schema/$ref');
    refuses(one(READ, { $defs: { X: { $ref: '#/nope' } } }), 'JC0007', '/$defs/X/$ref');
    // a $ref inside a data keyword is data, not a reference
    assert.doesNotThrow(() => compileContract(one({ kind: 'read', output: { const: { $ref: '#/not/a/ref' } } })));
    // a fragment into a registered schema is checked at compile too (the validator would
    // otherwise surface a missing pointer at validation time)
    refuses(one({ kind: 'read', output: { $ref: 'https://example.test/s#/nope' } }), 'JC0007', '/operations/a/output/$ref',
      /fragment/, { schemas: [{ $id: 'https://example.test/s', type: 'object' }] });
    refuses(one({ kind: 'read', output: { $ref: 'https://example.test/s#missing' } }), 'JC0007', '/operations/a/output/$ref',
      /fragment/, { schemas: [{ $id: 'https://example.test/s', type: 'object' }] });
    assert.doesNotThrow(() => compileContract(one({ kind: 'read', output: { $ref: 'https://example.test/s#/$defs/T' } }),
      { schemas: [{ $id: 'https://example.test/s', $defs: { T: { type: 'integer' } } }] }));
    // what the pre-walk cannot see (an embedded resource with its own $id), the
    // validator's whole-document probe catches at the root
    refuses(one({ kind: 'read', output: { $ref: '#/$defs/E' } }, { $defs: { E: { $id: 'https://embedded.test/e', properties: { a: { $ref: '#/$defs/Missing' } } } } }),
      'JC0007', '');
  });

  it('JC0008 — the path template', () => {
    refuses(one({ kind: 'read', output: true, http: { method: 'GET' } }), 'JC0008', '/operations/a/http/path');
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: 'api' } }), 'JC0008', '/operations/a/http/path');
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a/' } }), 'JC0008', '/operations/a/http/path', /trailing/);
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/files/{path+}' } }), 'JC0008', '/operations/a/http/path', /reserved/);
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/x/*' } }), 'JC0008', '/operations/a/http/path', /wildcard/);
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/x/{?q}' } }), 'JC0008', '/operations/a/http/path', /reserved/);
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/x/{id}.json' } }), 'JC0008', '/operations/a/http/path', /whole segment/);
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: 7 } }), 'JC0008', '/operations/a/http/path');
  });

  it('JC0009 — locations', () => {
    const input = { type: 'object', properties: { id: { type: 'integer' }, x: { type: 'string' } } };
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a/{id}' } }), 'JC0009', '/operations/a/http/path', /input\.properties/);
    refuses(one({ kind: 'read', input, output: true, http: { method: 'GET', path: '/a/{zz}' } }), 'JC0009', '/operations/a/http/path');
    refuses(one({ kind: 'read', input, output: true, http: { method: 'GET', path: '/a/{id}', in: { zz: 'query' } } }), 'JC0009', '/operations/a/http/in/zz');
    refuses(one({ kind: 'read', input, output: true, http: { method: 'GET', path: '/a/{id}', in: { x: 'cookie' } } }), 'JC0009', '/operations/a/http/in/x');
    refuses(one({ kind: 'read', input, output: true, http: { method: 'GET', path: '/a/{id}', in: { id: 'query' } } }), 'JC0009', '/operations/a/http/in/id');
    refuses(one({ kind: 'read', input, output: true, http: { method: 'GET', path: '/a/{id}', in: { x: 'path' } } }), 'JC0009', '/operations/a/http/in/x');
    refuses(one({ kind: 'command', input, output: true, http: { method: 'PUT', path: '/a/{id}', body: 'zz' } }), 'JC0009', '/operations/a/http/body');
    refuses(one({ kind: 'command', input, output: true, http: { method: 'PUT', path: '/a/{id}', body: 'id' } }), 'JC0009', '/operations/a/http/body');
    refuses(one({ kind: 'command', input, output: true, http: { method: 'PUT', path: '/a/{id}', body: 'x', in: { x: 'query' } } }), 'JC0009', '/operations/a/http/in/x');
    const three = { type: 'object', properties: { id: { type: 'integer' }, x: { type: 'string' }, y: { type: 'string' } } };
    refuses(one({ kind: 'command', input: three, output: true, http: { method: 'PUT', path: '/a/{id}', body: 'x' } }), 'JC0009', '/operations/a/http/body', /whole body/);
    refuses(one({ kind: 'command', input: three, output: true, http: { method: 'PUT', path: '/a/{id}', body: 'x', in: { y: 'body' } } }), 'JC0009', '/operations/a/http/in/y');
    refuses(one({ kind: 'read', input, output: true, http: { method: 'GET', path: '/a/{id}', in: [] } }), 'JC0009', '/operations/a/http/in');
    // and the legal whole-body form
    const ok = compileContract(one({ kind: 'command', input: three, output: true, http: { method: 'PUT', path: '/a/{id}', body: 'x', in: { y: 'header' } } }));
    assert.deepStrictEqual({ ...ok.operations.a.http.in }, { id: 'path', x: 'body', y: 'header' });
    assert.strictEqual(ok.operations.a.http.body, 'x');
  });

  it('JC0010 — one method + shape per operation', () => {
    refuses({
      $contract: '0.1',
      operations: {
        first: { kind: 'read', input: { type: 'object', properties: { a: { type: 'string' } } }, output: true, http: { method: 'GET', path: '/x/{a}' } },
        second: { kind: 'read', input: { type: 'object', properties: { b: { type: 'string' } } }, output: true, http: { method: 'GET', path: '/x/:b' } },
      },
    }, 'JC0010', '/operations/second/http/path', /GET \/x\/\{\}/);
    refuses({
      $contract: '0.1',
      operations: {
        first: READ,
        second: { kind: 'command', output: true, http: { method: 'GET', path: '/a' } },
      },
    }, 'JC0010', '/operations/second/http/path');
    // a canonical binding colliding with a declared one is reported at the operation
    refuses({
      $contract: '0.1',
      operations: {
        first: { kind: 'command', output: true, http: { method: 'POST', path: '/second' } },
        second: { kind: 'command', output: true },
      },
    }, 'JC0010', '/operations/second');
    // different methods, same shape: fine
    assert.doesNotThrow(() => compileContract({
      $contract: '0.1',
      operations: { first: READ, second: { kind: 'command', output: true, http: { method: 'DELETE', path: '/a' } } },
    }));
  });

  it('JC0011 — errors', () => {
    refuses(one({ kind: 'read', output: true, errors: [] }), 'JC0011', '/operations/a/errors');
    refuses(one({ kind: 'read', output: true, errors: { Bad: {} } }), 'JC0011', '/operations/a/errors/Bad');
    refuses(one({ kind: 'read', output: true, errors: { 'not_found': {} } }), 'JC0011', '/operations/a/errors/not_found');
    refuses(one({ kind: 'read', output: true, errors: { e: 404 } }), 'JC0011', '/operations/a/errors/e');
    refuses(one({ kind: 'read', output: true, errors: { e: { status: 99 } } }), 'JC0011', '/operations/a/errors/e/status');
    refuses(one({ kind: 'read', output: true, errors: { e: { status: 600 } } }), 'JC0011', '/operations/a/errors/e/status');
    refuses(one({ kind: 'read', output: true, errors: { e: { status: '404' } } }), 'JC0011', '/operations/a/errors/e/status');
    refuses(one({ kind: 'read', output: true, errors: { e: { status: 404.5 } } }), 'JC0011', '/operations/a/errors/e/status');
    refuses(one({ kind: 'read', output: true, errors: { e: { schema: 5 } } }), 'JC0011', '/operations/a/errors/e/schema');
    const ok = compileContract(one({ kind: 'read', output: true, errors: { e: {} } }));
    assert.strictEqual(ok.operations.a.errors.e.status, 400, 'the default error status');
  });

  it('JC0012 — method, status, media', () => {
    refuses(one({ kind: 'read', output: true, http: 'GET /a' }), 'JC0012', '/operations/a/http');
    refuses(one({ kind: 'read', output: true, http: { method: 'get', path: '/a' } }), 'JC0012', '/operations/a/http/method', /'GET'/);
    refuses(one({ kind: 'read', output: true, http: { method: 'BREW', path: '/a' } }), 'JC0012', '/operations/a/http/method');
    refuses(one({ kind: 'read', output: true, http: { path: '/a' } }), 'JC0012', '/operations/a/http/method');
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a', status: 199 } }), 'JC0012', '/operations/a/http/status');
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a', status: 300 } }), 'JC0012', '/operations/a/http/status');
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a', status: '200' } }), 'JC0012', '/operations/a/http/status');
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a', media: 'json' } }), 'JC0012', '/operations/a/http/media');
    refuses(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a', media: 7 } }), 'JC0012', '/operations/a/http/media');
    const ok = compileContract(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a', status: 204, media: 'application/problem+json; charset=utf-8' } }));
    assert.strictEqual(ok.operations.a.http.status, 204);
    assert.strictEqual(ok.operations.a.http.opaque, false, 'a +json suffix is JSON');
    assert.strictEqual(compileContract(one({ kind: 'read', output: true, http: { method: 'GET', path: '/a', media: 'text/csv' } })).operations.a.http.opaque, true);
  });

  it('JC0013 — closed sets', () => {
    refuses(one(READ, { extra: 1 }), 'JC0013', '/extra');
    refuses(one(READ, { $schema: 'https://json-schema.org/draft/2020-12/schema' }), 'JC0013', '/$schema');
    refuses(one({ ...READ, extra: 1 }), 'JC0013', '/operations/a/extra');
    refuses(one({ ...READ, policy: { extra: 1 } }), 'JC0013', '/operations/a/policy/extra');
    refuses(one({ ...READ, policy: { limits: { maxBytes: 1 } } }), 'JC0013', '/operations/a/policy/limits/maxBytes');
    refuses(one({ ...READ, policy: { errors: { verbose: true } } }), 'JC0013', '/operations/a/policy/errors/verbose');
    refuses(one({ ...READ, policy: { retry: { max: 1, on: [], backoff: 2 } } }), 'JC0013', '/operations/a/policy/retry/backoff');
    refuses(one({ ...READ, http: { method: 'GET', path: '/a', extra: 1 } }), 'JC0013', '/operations/a/http/extra');
    refuses(one({ ...READ, errors: { e: { status: 404, message: 'x' } } }), 'JC0013', '/operations/a/errors/e/message');
  });

  it('JC0014 — policy', () => {
    refuses(one({ ...READ, policy: 'fast' }), 'JC0014', '/operations/a/policy');
    refuses(one({ ...READ, policy: { task: 'serial' } }), 'JC0014', '/operations/a/policy/task');
    refuses(one({ ...READ, policy: { idempotency: 'maybe' } }), 'JC0014', '/operations/a/policy/idempotency');
    refuses(one({ ...READ, policy: { idempotency: 'required' } }), 'JC0014', '/operations/a/policy/idempotency', /read/);
    refuses(one({ ...READ, policy: { revision: '/revision' } }), 'JC0014', '/operations/a/policy/revision');
    refuses(one({ ...READ, policy: { revision: 'input:revision' } }), 'JC0014', '/operations/a/policy/revision');
    refuses(one({ ...READ, policy: { cache: 'all' } }), 'JC0014', '/operations/a/policy/cache');
    refuses(one({ ...READ, policy: { limits: 1024 } }), 'JC0014', '/operations/a/policy/limits');
    refuses(one({ ...READ, policy: { limits: { maxBodyBytes: 0 } } }), 'JC0014', '/operations/a/policy/limits/maxBodyBytes');
    refuses(one({ ...READ, policy: { limits: { maxBodyBytes: 1.5 } } }), 'JC0014', '/operations/a/policy/limits/maxBodyBytes');
    refuses(one({ ...READ, policy: { errors: 'paths' } }), 'JC0014', '/operations/a/policy/errors');
    refuses(one({ ...READ, policy: { errors: { details: 'some' } } }), 'JC0014', '/operations/a/policy/errors/details');
    refuses(one({ ...READ, policy: { retry: 3 } }), 'JC0014', '/operations/a/policy/retry');
    refuses(one({ ...READ, policy: { retry: { max: -1, on: [] } } }), 'JC0014', '/operations/a/policy/retry/max');
    refuses(one({ ...READ, policy: { retry: { max: 1, on: 'x' } } }), 'JC0014', '/operations/a/policy/retry/on');
    refuses(one({ ...READ, policy: { retry: { max: 1, on: [''] } } }), 'JC0014', '/operations/a/policy/retry/on/0');
    // a retried command runs twice without a key the server can deduplicate on
    refuses(one({ kind: 'command', output: true, policy: { retry: { max: 1, on: ['x'] } } }), 'JC0014', '/operations/a/policy/retry');
    refuses(one({ kind: 'command', output: true, policy: { idempotency: 'optional', retry: { max: 1, on: ['x'] } } }), 'JC0014', '/operations/a/policy/retry');
    assert.deepStrictEqual(compileContract(one({ kind: 'command', output: true, policy: { idempotency: 'required', retry: { max: 1, on: ['x'] } } })).operations.a.policy.retry, { max: 1, on: ['x'] });
    assert.deepStrictEqual(compileContract(one({ ...READ, policy: { retry: { max: 1, on: ['x'] } } })).operations.a.policy.retry, { max: 1, on: ['x'] }, 'a read is idempotent by nature');
    const revInput = { type: 'object', properties: { revision: { $ref: '#/$defs/Rev' } } };
    const ok = compileContract(one({ kind: 'command', input: revInput, output: true, policy: { revision: 'input:', task: 'concat' } }, { $defs: { Rev: { type: 'integer' } } }));
    assert.strictEqual(ok.operations.a.policy.revision, 'input:', 'the empty pointer (the whole input) needs only an input');
    // policy.revision must address a declared input member (03A): the first token names one of input.properties; deeper tokens are not checked
    refuses(one({ kind: 'command', output: true, policy: { revision: 'input:/revision' } }), 'JC0014', '/operations/a/policy/revision', /no input/);
    refuses(one({ kind: 'command', output: true, policy: { revision: 'input:' } }), 'JC0014', '/operations/a/policy/revision', /no input/);
    refuses(one({ kind: 'command', input: revInput, output: true, policy: { revision: 'input:/nope' } }, { $defs: { Rev: { type: 'integer' } } }), 'JC0014', '/operations/a/policy/revision', /'\/nope'.*no member 'nope'/);
    assert.strictEqual(compileContract(one({ kind: 'command', input: revInput, output: true, policy: { revision: 'input:/revision/deep' } }, { $defs: { Rev: { type: 'integer' } } })).operations.a.policy.revision, 'input:/revision/deep', 'deeper tokens are not checked — the member may be a $ref or open');
    assert.strictEqual(compileContract(shop).operations['product.save'].policy.revision, 'input:/revision', 'the shop fixture compiles unchanged');
    assert.strictEqual(ok.operations.a.policy.task, 'concat');
  });

  it('JC0015 — id, version, compat, doc', () => {
    refuses(one(READ, { id: 5 }), 'JC0015', '/id');
    refuses(one(READ, { id: '9shop' }), 'JC0015', '/id');
    refuses(one(READ, { id: 'my shop' }), 'JC0015', '/id');
    refuses(one(READ, { version: '' }), 'JC0015', '/version');
    refuses(one(READ, { version: 5 }), 'JC0015', '/version');
    refuses(one(READ, { compat: '4' }), 'JC0015', '/compat');
    refuses(one(READ, { compat: [1] }), 'JC0015', '/compat/0');
    refuses(one({ ...READ, doc: 5 }), 'JC0015', '/operations/a/doc');
    const ok = compileContract(one(READ, { id: 'my-shop_v2' }));
    assert.strictEqual(ok.id, 'my-shop_v2');
    assert.strictEqual(compileContract(one(READ)).id, null);
  });

  it('JC0016 — a GET body', () => {
    const input = { type: 'object', properties: { x: { type: 'string' } } };
    refuses(one({ kind: 'read', input, output: true, http: { method: 'GET', path: '/a', in: { x: 'body' } } }), 'JC0016', '/operations/a/http/in/x');
    refuses(one({ kind: 'read', input, output: true, http: { method: 'HEAD', path: '/a', body: 'x' } }), 'JC0016', '/operations/a/http/body');
    refuses(one({ kind: 'command', input, output: true, http: { method: 'GET', path: '/a' } }), 'JC0016', '/operations/a/http/method', /command.*GET/);
    assert.doesNotThrow(() => compileContract(one({ kind: 'command', input, output: true, http: { method: 'GET', path: '/a', in: { x: 'query' } } })));
    assert.doesNotThrow(() => compileContract(one({ kind: 'read', input, output: true, http: { method: 'POST', path: '/a', in: { x: 'body' } } })));
  });

  it('JC0017 — an opaque operation with a body-located member (three placements); opaque with path/query/header members compiles', () => {
    const input = { type: 'object', required: ['id', 'note'], properties: { id: { type: 'integer' }, note: { type: 'integer' } } };
    // http.body placed it
    refuses(one({ kind: 'command', input, output: true, http: { method: 'PUT', path: '/blobs/{id}', body: 'note', media: 'application/octet-stream' } }),
      'JC0017', '/operations/a/http/body', /opaque.*octet-stream.*'note'.*http\.body.*query or header/);
    // http.in placed it
    refuses(one({ kind: 'read', input, output: true, http: { method: 'POST', path: '/blobs/{id}', in: { note: 'body' }, media: 'text/plain' } }),
      'JC0017', '/operations/a/http/in/note', /http\.in\.note/);
    // the command default placed it: the media is the member that made the body undecodable
    refuses(one({ kind: 'command', input, output: true, http: { method: 'PUT', path: '/blobs/{id}/note', media: 'application/octet-stream' } }),
      'JC0017', '/operations/a/http/media', /default location of a command member.*make the operation JSON/);
    // the same members on a JSON operation, or on an opaque one outside the body, compile
    assert.doesNotThrow(() => compileContract(one({ kind: 'command', input, output: true, http: { method: 'PUT', path: '/blobs/{id}/note' } })));
    const ok = compileContract(one({ kind: 'command', input, output: true, http: { method: 'PUT', path: '/blobs/{id}', in: { note: 'query' }, media: 'application/octet-stream' } }));
    assert.deepStrictEqual({ ...ok.operations.a.http.in }, { id: 'path', note: 'query' });
    assert.strictEqual(ok.operations.a.http.opaque, true);
    assert.doesNotThrow(() => compileContract(one({ kind: 'command', input, output: true, http: { method: 'PUT', path: '/blobs/{id}', in: { note: 'header' }, media: 'image/png' } })));
    // an opaque operation with no input, or with path members only (image.bytes), compiles
    assert.doesNotThrow(() => compileContract(one({ kind: 'read', output: true, http: { method: 'GET', path: '/raw', media: 'text/plain' } })));
    assert.strictEqual(compileContract(shop).operations['image.bytes'].http.opaque, true);
  });
});
