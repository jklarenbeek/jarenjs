//@ts-check
/**
 * @file `diffContracts` (CONTRACT-FORMAT.md §13): one test per rule
 * R1–R16 asserting the class, the `rule` and the `docPath`; the honesty
 * pins (an `anyOf` change lands in `unknown`, NEVER in `neutral`, unless
 * it is a nullable respelling that accepts exactly the same values — R16;
 * a changed `pattern` is unknown while an added one narrows); the R3
 * riders (a moved member location is breaking, a renamed path variable
 * alone is not a binding change); and a whole `shop v1 → v2` scenario.
 * Documents and compiled contracts are both accepted.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { diffContracts } from '@jarenjs/contract/diff';
import { serveHttp } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { openHttpClient } from '@jarenjs/contract/client';
import { load } from './helpers.js';

const shop = load('./fixtures/shop.contract.json');

/**
 * A one-operation document around `op`, with optional root extras.
 * @param {any} op
 * @param {any} [root]
 */
const one = (op, root = {}) => ({ $contract: '0.1', operations: { 'a.b': op }, ...root });

/** @param {any} extra */
const readOp = (extra = {}) => ({ kind: 'read', output: true, http: { method: 'GET', path: '/a' }, ...extra });

/**
 * A command with one body member `x` of `schema`.
 * @param {any} schema
 * @param {any} [extra]
 * @param {any} [$defs]
 */
const commandWith = (schema, extra = {}, $defs = {}) => one({
  kind: 'command',
  input: { type: 'object', required: ['x'], properties: { x: schema } },
  output: true,
  http: { method: 'POST', path: '/a' },
  ...extra,
}, { $defs });

/** The single change of a class, asserted to be alone there. @param {any[]} list */
function only(list) {
  assert.strictEqual(list.length, 1, `expected exactly one change, got ${JSON.stringify(list)}`);
  return list[0];
}

/** Every class empty except the named ones. @param {any} d @param {string[]} except */
function onlyClasses(d, except) {
  for (const name of ['breaking', 'additive', 'neutral', 'unknown']) {
    if (!except.includes(name)) {
      assert.deepStrictEqual(d[name], [], `class '${name}' must be empty`);
    }
  }
}

describe('diffContracts — the rule table, row by row', () => {
  it('R1: an operation removed is breaking', () => {
    const a = { $contract: '0.1', operations: { 'a.b': readOp(), 'a.c': readOp({ http: { method: 'GET', path: '/c' } }) } };
    const d = diffContracts(a, one(readOp()));
    const c = only(d.breaking);
    assert.deepStrictEqual([c.rule, c.kind, c.op, c.docPath], ['R1', 'operation-removed', 'a.c', '/operations/a.c']);
    onlyClasses(d, ['breaking']);
  });

  it('R2: an operation added is additive', () => {
    const b = { $contract: '0.1', operations: { 'a.b': readOp(), 'a.c': readOp({ http: { method: 'GET', path: '/c' } }) } };
    const d = diffContracts(one(readOp()), b);
    const c = only(d.additive);
    assert.deepStrictEqual([c.rule, c.kind, c.op, c.docPath], ['R2', 'operation-added', 'a.c', '/operations/a.c']);
    onlyClasses(d, ['additive']);
  });

  it('R3: method, path shape, status, media and a moved member location are breaking; a renamed variable is not', () => {
    const method = diffContracts(one(readOp()), one({ ...readOp(), kind: 'command', http: { method: 'POST', path: '/a' } }));
    assert.deepStrictEqual(method.breaking.map((c) => [c.rule, c.note ?? c.kind]).sort(),
      [['R3', 'kind'], ['R3', 'method']]);

    const withId = (/** @type {string} */ name) => one({
      kind: 'read',
      input: { type: 'object', required: [name], properties: { [name]: { type: 'string' } } },
      output: true,
      http: { method: 'GET', path: `/a/{${name}}` },
    });
    const renamed = diffContracts(withId('id'), withId('key'));
    assert.deepStrictEqual(renamed.breaking.filter((c) => c.rule === 'R3'), [],
      'a renamed path variable is not a shape change');

    const status = diffContracts(one(readOp()), one({ ...readOp(), http: { method: 'GET', path: '/a', status: 201 } }));
    const s = only(status.breaking);
    assert.deepStrictEqual([s.rule, s.docPath, s.from, s.to], ['R3', '/operations/a.b/http/status', 200, 201]);

    const moved = diffContracts(
      commandWith({ type: 'string' }, { http: { method: 'POST', path: '/a', in: { x: 'query' } } }),
      commandWith({ type: 'string' }, { http: { method: 'POST', path: '/a', in: { x: 'header' } } }));
    const m = only(moved.breaking);
    assert.deepStrictEqual([m.rule, m.docPath, m.from, m.to], ['R3', '/operations/a.b/http/in/x', 'query', 'header']);

    const media = diffContracts(one(readOp()),
      one({ ...readOp(), http: { method: 'GET', path: '/a', media: 'application/octet-stream' } }));
    assert.ok(media.breaking.every((c) => c.rule === 'R3'), 'an opaqueness flip is a binding change');
    assert.ok(media.breaking.some((c) => c.docPath === '/operations/a.b/http/media'));
  });

  it('R3: a media respelled to the same type/subtype — its case or its parameters — is neutral and an old client still matches; another type/subtype is breaking', async () => {
    const note = (/** @type {string | undefined} */ media) => one({
      kind: 'command',
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      output: { type: 'object' },
      http: { method: 'POST', path: '/notes', ...(media === undefined ? {} : { media }) },
    });
    for (const to of ['application/json; charset=utf-8', 'Application/JSON']) {
      const d = diffContracts(note(undefined), note(to));
      const c = only(d.neutral);
      assert.deepStrictEqual([c.rule, c.kind, c.docPath, c.from, c.to], ['R3', 'media-respelled', '/operations/a.b/http/media', 'application/json', to]);
      onlyClasses(d, ['neutral']);
      // what an old client sends is what the new server matches
      const server = serveHttp(compileContract(note(to)), { 'a.b': (input) => ({ saved: input.text }) });
      const r = await server.dispatch({ method: 'POST', url: '/notes', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' });
      assert.strictEqual(r.status, 200, to);
    }
    const vendor = only(diffContracts(note(undefined), note('application/vnd.acme+json')).breaking);
    assert.deepStrictEqual([vendor.rule, vendor.kind, vendor.docPath, vendor.to], ['R3', 'binding-changed', '/operations/a.b/http/media', 'application/vnd.acme+json']);
  });

  it('R4: a member added to required, and a new required member, are breaking', () => {
    const optional = one({ kind: 'command', input: { type: 'object', properties: { x: { type: 'string' } } }, output: true, http: { method: 'POST', path: '/a' } });
    const required = commandWith({ type: 'string' });
    const flipped = only(diffContracts(optional, required).breaking);
    assert.deepStrictEqual([flipped.rule, flipped.kind, flipped.docPath],
      ['R4', 'input-required-added', '/operations/a.b/input/properties/x']);

    const grown = diffContracts(required, one({
      kind: 'command',
      input: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'string' }, y: { type: 'integer' } } },
      output: true, http: { method: 'POST', path: '/a' },
    }));
    const added = only(grown.breaking);
    assert.deepStrictEqual([added.rule, added.kind, added.docPath],
      ['R4', 'input-required-added', '/operations/a.b/input/properties/y']);
  });

  it('R5: a member removed is breaking under additionalProperties:false, neutral (with the note) otherwise', () => {
    const both = (/** @type {boolean} */ closed) => one({
      kind: 'command',
      input: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'string' } }, ...(closed ? { additionalProperties: false } : {}) },
      output: true, http: { method: 'POST', path: '/a' },
    });
    const oneMember = (/** @type {boolean} */ closed) => one({
      kind: 'command',
      input: { type: 'object', properties: { x: { type: 'string' } }, ...(closed ? { additionalProperties: false } : {}) },
      output: true, http: { method: 'POST', path: '/a' },
    });
    const closed = only(diffContracts(both(true), oneMember(true)).breaking);
    assert.deepStrictEqual([closed.rule, closed.kind, closed.docPath],
      ['R5', 'input-member-removed', '/operations/a.b/input/properties/y']);

    const open = diffContracts(both(false), oneMember(false));
    const n = only(open.neutral);
    assert.deepStrictEqual([n.rule, n.kind], ['R5', 'input-member-removed']);
    assert.match(/** @type {string} */ (n.note), /ignored, not validated/);
    onlyClasses(open, ['neutral']);
  });

  it('R6: a narrowed input member — enum shrinks, maximum lowers, minLength rises, pattern added — is breaking', () => {
    const cases = /** @type {[any, any, string][]} */ ([
      [{ enum: ['a', 'b'] }, { enum: ['a'] }, 'enum'],
      [{ type: 'integer', maximum: 10 }, { type: 'integer', maximum: 5 }, 'maximum'],
      [{ type: 'string', minLength: 1 }, { type: 'string', minLength: 3 }, 'minLength'],
      [{ type: 'string' }, { type: 'string', pattern: '^a' }, 'pattern'],
      [{ type: ['string', 'integer'] }, { type: 'string' }, 'type'],
    ]);
    for (const [from, to, keyword] of cases) {
      const d = diffContracts(commandWith(from), commandWith(to));
      const c = only(d.breaking);
      assert.deepStrictEqual([c.rule, c.kind, c.note, c.docPath],
        ['R6', 'input-narrowed', keyword, `/operations/a.b/input/properties/x/${keyword}`]);
      onlyClasses(d, ['breaking']);
    }
  });

  it('R6/R7: const models as a one-value enum — a changed const is honestly BOTH narrowed and widened', () => {
    const d = diffContracts(commandWith({ const: 'a' }), commandWith({ const: 'b' }));
    const narrowed = only(d.breaking);
    assert.deepStrictEqual([narrowed.rule, narrowed.kind, narrowed.note], ['R6', 'input-narrowed', 'const']);
    const widened = only(d.additive);
    assert.deepStrictEqual([widened.rule, widened.kind, widened.note], ['R7', 'input-widened', 'const']);
  });

  it('R7: a widened input member, an optional member added, and required dropped are additive', () => {
    const widened = only(diffContracts(commandWith({ type: 'integer', maximum: 5 }), commandWith({ type: 'integer', maximum: 10 })).additive);
    assert.deepStrictEqual([widened.rule, widened.kind, widened.note], ['R7', 'input-widened', 'maximum']);

    const optionalAdded = diffContracts(commandWith({ type: 'string' }), one({
      kind: 'command',
      input: { type: 'object', required: ['x'], properties: { x: { type: 'string' }, y: { type: 'integer' } } },
      output: true, http: { method: 'POST', path: '/a' },
    }));
    const added = only(optionalAdded.additive);
    assert.deepStrictEqual([added.rule, added.kind, added.docPath],
      ['R7', 'input-member-added', '/operations/a.b/input/properties/y']);

    const dropped = diffContracts(commandWith({ type: 'string' }), one({
      kind: 'command',
      input: { type: 'object', properties: { x: { type: 'string' } } },
      output: true, http: { method: 'POST', path: '/a' },
    }));
    const opt = only(dropped.additive);
    assert.deepStrictEqual([opt.rule, opt.kind], ['R7', 'input-member-optional']);
  });

  // Variance (CONTRACT-FORMAT §13): an input is consumed by the SERVER, so
  // narrowing it refuses what an old client sends (R6, breaking) and
  // widening is additive (R7); an output is consumed by the CLIENT, which
  // validates every answer against its own contract, so a WIDENED output
  // hands an old client values it refuses (R8, breaking — the suite's own
  // HTTP client answers JC2053) and a narrowed output is additive (R9): a
  // client on the wider contract accepts every narrower answer. Member
  // events take the consumer's view on both sides.

  it('R8: an output member removed, made optional, widened, or added to a closed object is breaking', () => {
    const out = (/** @type {any} */ output) => one({ ...readOp(), output });
    const full = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' } } };

    const removed = diffContracts(out(full), out({ type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }));
    assert.ok(removed.breaking.some((c) => c.rule === 'R8' && c.kind === 'output-member-removed'
      && c.docPath === '/operations/a.b/output/properties/name'), JSON.stringify(removed.breaking));

    const optional = diffContracts(out(full), out({ ...full, required: ['id'] }));
    const o = only(optional.breaking);
    assert.deepStrictEqual([o.rule, o.kind], ['R8', 'output-member-optional']);

    const widened = diffContracts(out({ ...full, properties: { ...full.properties, id: { type: 'integer', minimum: 1 } } }), out(full));
    const w = only(widened.breaking);
    assert.deepStrictEqual([w.rule, w.kind, w.docPath], ['R8', 'output-widened', '/operations/a.b/output/properties/id/minimum']);
    onlyClasses(widened, ['breaking']);

    // three widenings: a closed object gaining a member, a type
    // widened to nullable, an enum widened — each is refused by an old client
    const closed = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    const grownClosed = only(diffContracts(out(closed), out({ ...closed, properties: { a: { type: 'string' }, b: { type: 'string' } } })).breaking);
    assert.deepStrictEqual([grownClosed.rule, grownClosed.kind, grownClosed.docPath],
      ['R8', 'output-member-added', '/operations/a.b/output/properties/b']);
    const nullable = only(diffContracts(out({ type: 'string' }), out({ type: ['string', 'null'] })).breaking);
    assert.deepStrictEqual([nullable.rule, nullable.kind, nullable.note], ['R8', 'output-widened', 'type']);
    const wideEnum = only(diffContracts(out({ enum: ['a'] }), out({ enum: ['a', 'b'] })).breaking);
    assert.deepStrictEqual([wideEnum.rule, wideEnum.kind, wideEnum.note], ['R8', 'output-widened', 'enum']);
  });

  it('R9: an output member added to an open object, guaranteed, or narrowed is additive', () => {
    const out = (/** @type {any} */ output) => one({ ...readOp(), output });
    const base = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } };

    const grown = diffContracts(out(base), out({
      type: 'object', required: ['id', 'etag'], properties: { id: { type: 'integer' }, etag: { type: 'string' } },
    }));
    const g = only(grown.additive);
    assert.deepStrictEqual([g.rule, g.kind, g.docPath], ['R9', 'output-member-added', '/operations/a.b/output/properties/etag']);
    onlyClasses(grown, ['additive']);

    const narrowed = diffContracts(out(base), out({ ...base, properties: { id: { type: 'integer', minimum: 1 } } }));
    const n = only(narrowed.additive);
    assert.deepStrictEqual([n.rule, n.kind, n.docPath], ['R9', 'output-narrowed', '/operations/a.b/output/properties/id/minimum']);
    onlyClasses(narrowed, ['additive']);

    // the reverse of those widenings narrows, and is additive
    const unNullable = only(diffContracts(out({ type: ['string', 'null'] }), out({ type: 'string' })).additive);
    assert.deepStrictEqual([unNullable.rule, unNullable.kind], ['R9', 'output-narrowed']);
    const fewer = only(diffContracts(out({ enum: ['a', 'b'] }), out({ enum: ['a'] })).additive);
    assert.deepStrictEqual([fewer.rule, fewer.kind], ['R9', 'output-narrowed']);
  });

  it('the suite\'s own client agrees with the variance: a widened output answer fails an old client, a narrowed one does not', async () => {
    const out = (/** @type {any} */ output) => one({ ...readOp(), output });
    const run = async (/** @type {any} */ clientDoc, /** @type {any} */ serverDoc, /** @type {unknown} */ answer) => {
      const server = serveHttp(compileContract(serverDoc), { 'a.b': () => answer });
      const handler = toFetchHandler(server);
      const client = openHttpClient(compileContract(clientDoc), { baseUrl: 'http://x.test', fetch: (url, init) => handler(new Request(url, init)) });
      return client.invoke('a.b', null);
    };
    const widened = await run(out({ type: 'string' }), out({ type: ['string', 'null'] }), null);
    assert.ok(!widened.ok && widened.error.code === 'JC2053', JSON.stringify(widened));
    const narrowed = await run(out({ type: ['string', 'null'] }), out({ type: 'string' }), 'x');
    assert.strictEqual(narrowed.ok, true);
  });

  it('R10/R11: an error code removed or its status changed is breaking; a code added is additive', () => {
    const errs = (/** @type {any} */ errors) => one({ ...readOp(), errors });
    const removed = only(diffContracts(errs({ gone: { status: 410 } }), errs(undefined)).breaking);
    assert.deepStrictEqual([removed.rule, removed.kind, removed.docPath],
      ['R10', 'error-removed', '/operations/a.b/errors/gone']);

    const status = only(diffContracts(errs({ gone: { status: 410 } }), errs({ gone: { status: 404 } })).breaking);
    assert.deepStrictEqual([status.rule, status.kind, status.from, status.to, status.docPath],
      ['R10', 'error-status-changed', 410, 404, '/operations/a.b/errors/gone/status']);

    const added = only(diffContracts(errs(undefined), errs({ gone: { status: 410 } })).additive);
    assert.deepStrictEqual([added.rule, added.kind, added.docPath], ['R11', 'error-added', '/operations/a.b/errors/gone']);
  });

  it('R12: idempotency → required, and required/optional → none, are breaking; required → optional and none → optional are additive', () => {
    const idem = (/** @type {string | undefined} */ level, /** @type {any} */ extra = {}) => one({
      kind: 'command', output: true, http: { method: 'POST', path: '/a' },
      ...(level === undefined ? {} : { policy: { idempotency: level, ...extra } }),
    });
    const tightened = only(diffContracts(idem(undefined), idem('required')).breaking);
    assert.deepStrictEqual([tightened.rule, tightened.kind, tightened.from, tightened.to, tightened.docPath],
      ['R12', 'idempotency-required', 'none', 'required', '/operations/a.b/policy/idempotency']);
    const fromOptional = only(diffContracts(idem('optional'), idem('required')).breaking);
    assert.strictEqual(fromOptional.rule, 'R12');

    // an old client keeps sending a key and retrying under it; a server that
    // no longer reads the key runs every retry of a lost answer again
    for (const from of ['required', 'optional']) {
      const d = diffContracts(idem(from), idem(undefined));
      const dropped = only(d.breaking);
      assert.deepStrictEqual([dropped.rule, dropped.kind, dropped.from, dropped.to, dropped.docPath],
        ['R12', 'idempotency-dropped', from, 'none', '/operations/a.b/policy/idempotency'], from);
      assert.deepStrictEqual(d.additive, [], from);
    }
    const withRetry = diffContracts(idem('required', { retry: { max: 2, on: [] } }), idem(undefined));
    assert.deepStrictEqual(withRetry.breaking.map((c) => [c.rule, c.kind]), [['R12', 'idempotency-dropped']]);

    const relaxed = only(diffContracts(idem('required'), idem('optional')).additive);
    assert.deepStrictEqual([relaxed.rule, relaxed.kind, relaxed.from, relaxed.to], ['R12', 'idempotency-relaxed', 'required', 'optional']);
    const opened = only(diffContracts(idem(undefined), idem('optional')).additive);
    assert.deepStrictEqual([opened.rule, opened.kind, opened.from, opened.to], ['R12', 'idempotency-relaxed', 'none', 'optional']);
  });

  it('R13: task, retry, cache, policy.revision and doc changes are neutral', () => {
    const a = one({
      kind: 'command',
      input: { type: 'object', required: ['rev'], properties: { rev: { type: 'integer' } } },
      output: true, http: { method: 'POST', path: '/a' },
      policy: { task: 'switch', cache: 'none' }, doc: 'before',
    });
    const b = one({
      kind: 'command',
      input: { type: 'object', required: ['rev'], properties: { rev: { type: 'integer' } } },
      output: true, http: { method: 'POST', path: '/a' },
      policy: { task: 'exhaust', cache: 'revision', revision: 'input:/rev', idempotency: 'required', retry: { max: 2, on: [] } },
      doc: 'after',
    });
    const d = diffContracts(a, b);
    assert.deepStrictEqual(d.neutral.map((c) => [c.rule, c.docPath]).sort(), [
      ['R13', '/operations/a.b/doc'],
      ['R13', '/operations/a.b/policy/cache'],
      ['R13', '/operations/a.b/policy/retry'],
      ['R13', '/operations/a.b/policy/revision'],
      ['R13', '/operations/a.b/policy/task'],
    ]);
    // the idempotency change rode along as R12, nothing else leaked
    assert.deepStrictEqual(d.breaking.map((c) => c.rule), ['R12']);
    assert.deepStrictEqual(d.unknown, []);
  });

  it('R14: audience public → server is breaking, the reverse additive, and the flip subsumes other changes', () => {
    const pub = one(readOp());
    const srv = one({ ...readOp(), output: { type: 'object' }, policy: { audience: 'server' } });
    const narrowed = diffContracts(pub, srv);
    const c = only(narrowed.breaking);
    assert.deepStrictEqual([c.rule, c.kind, c.from, c.to, c.docPath],
      ['R14', 'audience-narrowed', 'public', 'server', '/operations/a.b/policy/audience']);
    onlyClasses(narrowed, ['breaking']);

    const widened = diffContracts(srv, pub);
    const w = only(widened.additive);
    assert.deepStrictEqual([w.rule, w.kind], ['R14', 'audience-widened']);

    // server on BOTH sides: outside the compatibility surface entirely
    const srv2 = one({ ...readOp(), output: { type: 'string' }, policy: { audience: 'server' } });
    const invisible = diffContracts(srv, srv2);
    onlyClasses(invisible, []);
  });

  it('R15: a change to an anyOf whose branches overlap lands in unknown — NEVER in neutral — as do format, a changed pattern and an external $ref', () => {
    // every integer is a number: the new branch is not disjoint from the old one
    const anyOf = diffContracts(
      commandWith({ anyOf: [{ type: 'number' }] }),
      commandWith({ anyOf: [{ type: 'number' }, { type: 'integer' }] }));
    const c = only(anyOf.unknown);
    assert.deepStrictEqual([c.rule, c.kind, c.note, c.docPath],
      ['R15', 'schema-unknown', 'anyOf', '/operations/a.b/input/properties/x/anyOf']);
    assert.deepStrictEqual(anyOf.neutral, [], 'unknown is not neutral');
    onlyClasses(anyOf, ['unknown']);

    const format = only(diffContracts(commandWith({ type: 'string', format: 'uuid' }), commandWith({ type: 'string' })).unknown);
    assert.deepStrictEqual([format.rule, format.note], ['R15', 'format']);

    const pattern = only(diffContracts(commandWith({ type: 'string', pattern: '^a' }), commandWith({ type: 'string', pattern: '^b' })).unknown);
    assert.deepStrictEqual([pattern.rule, pattern.note], ['R15', 'pattern']);

    const registered = (/** @type {string} */ id) => compileContract(commandWith({ $ref: id }), {
      schemas: [{ $id: id, type: 'string' }],
    });
    const external = only(diffContracts(
      registered('https://x.example/s.json'),
      registered('https://y.example/s.json')).unknown);
    assert.strictEqual(external.rule, 'R15');

    const detailsSchema = only(diffContracts(
      one({ ...readOp(), errors: { gone: { status: 410, schema: { type: 'object' } } } }),
      one({ ...readOp(), errors: { gone: { status: 410, schema: { type: 'string' } } } })).unknown);
    assert.deepStrictEqual([detailsSchema.rule, detailsSchema.kind], ['R15', 'error-schema-changed']);
  });

  describe('R16: a nullable respelling that accepts the same values is neutral', () => {
    const unionS = { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] };
    const oneOfS = { oneOf: [{ type: 'null' }, { type: 'string', minLength: 1 }] };
    const arrayS = { type: ['string', 'null'], minLength: 1 };
    /** A read whose output member `x` is `schema`. @param {any} schema */
    const readWith = (schema) => one({ kind: 'read', output: { type: 'object', properties: { x: schema } }, http: { method: 'GET', path: '/a' } });

    for (const [label, from, to] of /** @type {[string, any, any][]} */ ([
      ['anyOf → type array', unionS, arrayS],
      ['type array → anyOf', arrayS, unionS],
      ['oneOf → type array', oneOfS, arrayS],
      ['anyOf → oneOf', unionS, oneOfS],
    ])) {
      it(`${label}: exactly one neutral R16 on an input member and on an output member`, () => {
        const input = diffContracts(commandWith(from), commandWith(to));
        const c = only(input.neutral);
        assert.deepStrictEqual([c.rule, c.kind, c.docPath],
          ['R16', 'schema-respelled', '/operations/a.b/input/properties/x']);
        onlyClasses(input, ['neutral']);

        const output = diffContracts(readWith(from), readWith(to));
        const o = only(output.neutral);
        assert.deepStrictEqual([o.rule, o.kind, o.docPath],
          ['R16', 'schema-respelled', '/operations/a.b/output/properties/x']);
        onlyClasses(output, ['neutral']);
      });
    }

    it('the same respelling where the branch carries a $query stays unknown — the two accept different values', () => {
      const check = { $gt: [{ '$string-length': '$' }, 2] };
      const d = diffContracts(
        commandWith({ anyOf: [{ type: 'string', $query: check }, { type: 'null' }] }),
        commandWith({ type: ['string', 'null'], $query: check }));
      assert.ok(d.unknown.some((c) => c.rule === 'R15'), JSON.stringify(d.unknown));
      assert.deepStrictEqual(d.neutral, [], 'never neutral when the value sets can differ');
    });

    it('a respelling beside a real change reports both, the change read on the type-array spelling', () => {
      const d = diffContracts(commandWith(unionS), commandWith({ type: ['string', 'null'], minLength: 3 }));
      assert.deepStrictEqual(only(d.neutral).rule, 'R16');
      const narrowed = only(d.breaking);
      assert.deepStrictEqual([narrowed.rule, narrowed.note, narrowed.docPath],
        ['R6', 'minLength', '/operations/a.b/input/properties/x/minLength']);
      onlyClasses(d, ['neutral', 'breaking']);
    });

    it('two unions whose non-null branches sit apart: a removal points at the branch where a holds it, the rest where b does', () => {
      /** @param {any} schema */
      const reads = (schema) => one(readOp({ output: schema }));
      const z = { type: 'object', properties: { z: { type: 'string' } } };
      const tight = { type: 'object', maxProperties: 2 };
      /** @type {[any, any, string, string, string[]][]} */
      const cases = [
        [{ anyOf: [{ type: 'null' }, z] }, { anyOf: [tight, { type: 'null' }] }, '/anyOf/1/properties/z', '/anyOf/0/maxProperties', ['unknown', 'breaking']],
        [{ oneOf: [z, { type: 'null' }] }, { anyOf: [tight, { type: 'null' }] }, '/oneOf/0/properties/z', '/anyOf/0/maxProperties', ['neutral', 'unknown', 'breaking']],
      ];
      for (const [from, to, removed, added, classes] of cases) {
        const d = diffContracts(reads(from), reads(to));
        onlyClasses(d, classes);
        assert.deepStrictEqual(d.breaking.map((c) => [c.rule, c.kind, c.docPath]), [['R8', 'output-member-removed', '/operations/a.b/output' + removed]]);
        assert.deepStrictEqual(d.unknown.map((c) => [c.rule, c.note, c.docPath]), [['R15', 'maxProperties', '/operations/a.b/output' + added]]);
      }
    });

    it('a recursive nullable definition, respelled and changed, terminates and reports each once', () => {
      // both spellings canonicalize and differ, so the walk descends the
      // canonical forms into `next` and back to the definition: the pair
      // memo is keyed on the original nodes, so the cycle ends there
      const tree = (/** @type {any} */ node) => ({
        $contract: '0.1',
        $defs: { node },
        operations: { 'a.b': { kind: 'read', output: { $ref: '#/$defs/node' }, http: { method: 'GET', path: '/a' } } },
      });
      const d = diffContracts(
        tree({ type: ['object', 'null'], properties: { next: { $ref: '#/$defs/node' } } }),
        tree({ anyOf: [{ type: 'object', minProperties: 1, properties: { next: { $ref: '#/$defs/node' } } }, { type: 'null' }] }));
      assert.deepStrictEqual(d.neutral.map((c) => [c.rule, c.docPath]), [['R16', '/operations/a.b/output']]);
      assert.deepStrictEqual(d.unknown.map((c) => [c.rule, c.note, c.docPath]),
        [['R15', 'minProperties', '/operations/a.b/output/minProperties']]);
      onlyClasses(d, ['neutral', 'unknown']);
    });
  });
});

describe('diffContracts — behavior of the whole', () => {
  it('a same-document $ref is resolved before comparing: moving a schema into $defs changes nothing', () => {
    const inline = commandWith({ type: 'string', minLength: 1 });
    const referenced = one({
      kind: 'command',
      input: { type: 'object', required: ['x'], properties: { x: { $ref: '#/$defs/X' } } },
      output: true, http: { method: 'POST', path: '/a' },
    }, { $defs: { X: { type: 'string', minLength: 1 } } });
    onlyClasses(diffContracts(inline, referenced), []);
    // ...and a narrowed $defs entry reports at the resolved member path
    const narrowedDefs = one({
      kind: 'command',
      input: { type: 'object', required: ['x'], properties: { x: { $ref: '#/$defs/X' } } },
      output: true, http: { method: 'POST', path: '/a' },
    }, { $defs: { X: { type: 'string', minLength: 5 } } });
    const c = only(diffContracts(inline, narrowedDefs).breaking);
    assert.deepStrictEqual([c.rule, c.docPath], ['R6', '/operations/a.b/input/properties/x/minLength']);
  });

  it('recursive schemas terminate, and equal contracts diff empty (compiled or raw)', () => {
    const recursive = (/** @type {number} */ min) => one({
      kind: 'command',
      input: { type: 'object', required: ['x'], properties: { x: { $ref: '#/$defs/Node' } } },
      output: true, http: { method: 'POST', path: '/a' },
    }, { $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' }, n: { type: 'integer', minimum: min } } } } });
    onlyClasses(diffContracts(recursive(0), recursive(0)), []);
    const d = diffContracts(compileContract(recursive(0)), recursive(1));
    assert.ok(d.breaking.every((c) => c.rule === 'R6'));
    assert.ok(d.breaking.length >= 1, 'the cycle is compared once, not forever');
    onlyClasses(diffContracts(shop, compileContract(shop)), []);
  });

  it('shop v1 → v2: a realistic evolution classifies every change where it belongs', () => {
    const v2 = JSON.parse(JSON.stringify(shop));
    v2.version = '6';
    v2.compat = ['5'];
    // additive: a new operation, a new optional input member, a new declared error
    v2.operations['product.archive'] = {
      kind: 'command',
      input: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      output: true, http: { method: 'POST', path: '/api/products/{id}/archive' },
    };
    v2.operations['product.search'].input.properties.offset = { type: 'integer', minimum: 0 };
    v2.operations['product.save'].errors['too-many'] = { status: 429 };
    // breaking: a required member appears, an error is dropped
    v2.operations['product.save'].input.required = [...v2.operations['product.save'].input.required, 'reason'];
    v2.operations['product.save'].input.properties.reason = { type: 'string' };
    delete v2.operations['product.save'].errors['not-found'];
    // neutral: a task-mode change
    v2.operations['catalog.load'].policy.task = 'exhaust';

    const d = diffContracts(shop, v2);
    assert.deepStrictEqual(d.breaking.map((c) => [c.rule, c.op, c.kind]).sort(), [
      ['R10', 'product.save', 'error-removed'],
      ['R4', 'product.save', 'input-required-added'],
    ]);
    assert.deepStrictEqual(d.additive.map((c) => [c.rule, c.op]).sort(), [
      ['R11', 'product.save'],
      ['R2', 'product.archive'],
      ['R7', 'product.search'],
    ]);
    assert.deepStrictEqual(d.neutral.map((c) => [c.rule, c.op]), [['R13', 'catalog.load']]);
    assert.deepStrictEqual(d.unknown, []);
  });
});

describe('diffContracts — the internal gate and the stream policy', () => {
  const serverOp = (/** @type {any} */ output) => ({ $contract: '0.1', operations: {
    'admin.purge': { kind: 'command', output, http: { method: 'POST', path: '/purge' }, policy: { audience: 'server' } },
  } });

  it('audience: \'all\' classifies a server operation\'s changes with the same rules, each marked audience: \'server\'; the default ignores them', () => {
    const a = serverOp({ type: 'string' });
    const b = serverOp({ type: ['string', 'null'] });
    onlyClasses(diffContracts(a, b), []);
    onlyClasses(diffContracts(a, b, { audience: 'public' }), []);
    const all = diffContracts(a, b, { audience: 'all' });
    const c = only(all.breaking);
    assert.deepStrictEqual([c.rule, c.kind, c.audience], ['R8', 'output-widened', 'server']);
    onlyClasses(all, ['breaking']);
    // an added or removed server operation, too (beside one public operation)
    const plain = { $contract: '0.1', operations: { 'a.read': readOp() } };
    const withServer = { $contract: '0.1', operations: { 'a.read': readOp(), ...a.operations } };
    assert.deepStrictEqual(only(diffContracts(plain, withServer, { audience: 'all' }).additive).audience, 'server');
    assert.deepStrictEqual(only(diffContracts(withServer, plain, { audience: 'all' }).breaking).audience, 'server');
    onlyClasses(diffContracts(plain, withServer), []);
    // a public operation's changes carry no audience member
    const pub = (/** @type {any} */ output) => one({ ...readOp(), output });
    assert.strictEqual(Object.hasOwn(only(diffContracts(pub({ type: 'string' }), pub({ type: ['string', 'null'] }), { audience: 'all' }).breaking), 'audience'), false);
  });

  it('options are a closed set (JC1008)', () => {
    const doc = one(readOp());
    for (const options of [{ audiance: 'all' }, { audience: 'server' }, 'all', null]) {
      assert.throws(() => diffContracts(doc, doc, /** @type {any} */ (options)), (e) => e.code === 'JC1008', JSON.stringify(options));
    }
  });

  it('a policy.stream change is reported R13: neutral, but a slower heartbeat breaks an older client', () => {
    const sub = (/** @type {number} */ heartbeatMs, resume = 'snapshot') => one({ kind: 'subscribe', output: { type: 'object' },
      http: { method: 'GET', path: '/a' }, policy: { stream: { heartbeatMs, resume } } });
    // faster, or another resume policy: neutral
    const faster = only(diffContracts(sub(30000), sub(15000)).neutral);
    assert.deepStrictEqual([faster.rule, faster.kind, faster.docPath], ['R13', 'policy-changed', '/operations/a.b/policy/stream']);
    assert.deepStrictEqual([faster.from.heartbeatMs, faster.to.heartbeatMs], [30000, 15000]);
    onlyClasses(diffContracts(sub(15000), sub(15000, 'replay')), ['neutral']);
    // slower: the old client's watchdog (twice its own interval) reports
    // the stream lost before the new server's first heartbeat
    const slower = diffContracts(sub(15000), sub(30000));
    onlyClasses(slower, ['breaking']);
    const c = only(slower.breaking);
    assert.deepStrictEqual([c.rule, c.kind, c.docPath, c.from, c.to], ['R13', 'heartbeat-slowed', '/operations/a.b/policy/stream/heartbeatMs', 15000, 30000]);
    // slower AND another resume policy: both, each once
    const both = diffContracts(sub(15000), sub(30000, 'replay'));
    assert.deepStrictEqual([both.breaking.map((x) => x.kind), both.neutral.map((x) => x.kind)], [['heartbeat-slowed'], ['policy-changed']]);
  });
});

describe('diffContracts — validation behind a same-document $ref is compared as it resolves', () => {
  /** A projection whose `required` list and `b`'s enum the cases move. @param {string[]} required @param {string[]} [en] */
  const proj = (required, en = ['x', 'y']) => ({
    type: 'object', properties: { a: { type: 'string' }, b: { type: 'string', enum: en } }, required,
  });
  const ref = { $ref: '#/$defs/proj' };
  /**
   * Each shape wraps the reference; `at` is where the reference sits
   * inside it and `note` the keyword the walk does not model there;
   * `decided` marks a position whose direction the walk reads.
   * @type {Record<string, { wrap: any, at: string, note: string, decided?: true }>}
   */
  const shapes = {
    'a discriminated oneOf variant': {
      wrap: { oneOf: [
        { type: 'object', properties: { ok: { const: true }, value: ref }, required: ['ok', 'value'] },
        { type: 'object', properties: { ok: { const: false } }, required: ['ok'] },
      ] },
      at: '/oneOf/0/properties/value', note: 'oneOf', decided: true,
    },
    'an anyOf branch another branch overlaps': { wrap: { anyOf: [ref, { type: 'object' }] }, at: '/anyOf/0', note: 'anyOf' },
    'an anyOf branch a type tells apart': { wrap: { anyOf: [ref, { type: 'string' }] }, at: '/anyOf/0', note: 'anyOf', decided: true },
    'an allOf conjunct': { wrap: { allOf: [ref] }, at: '/allOf/0', note: 'allOf', decided: true },
    'a not': { wrap: { type: 'object', not: ref }, at: '/not', note: 'not' },
    'an if': { wrap: { if: ref, then: { type: 'object' } }, at: '/if', note: 'if' },
    'a then': { wrap: { if: { type: 'object' }, then: ref }, at: '/then', note: 'then', decided: true },
    'an else': { wrap: { if: { type: 'string' }, else: ref }, at: '/else', note: 'else', decided: true },
    'a dependentSchemas member': { wrap: { type: 'object', dependentSchemas: { a: ref } }, at: '/dependentSchemas/a', note: 'dependentSchemas', decided: true },
    'a prefixItems entry': { wrap: { type: 'array', prefixItems: [ref] }, at: '/prefixItems/0', note: 'prefixItems', decided: true },
    'a contains': { wrap: { type: 'array', contains: ref }, at: '/contains', note: 'contains' },
    'a patternProperties member': { wrap: { type: 'object', patternProperties: { '^p': ref } }, at: '/patternProperties/^p', note: 'patternProperties' },
    'a $ref beside a sibling': { wrap: { ...ref, description: 'the projection' }, at: '', note: '$ref' },
    'a nullable union whose branch is the $ref': { wrap: { anyOf: [ref, { type: 'null' }] }, at: '/anyOf/0', note: 'anyOf', decided: true },
    'a $ref into a nested definitions': {
      wrap: { allOf: [{ $ref: '#/$defs/holder/definitions/proj' }] }, at: '/allOf/0', note: 'allOf', decided: true,
    },
    'a $ref reached through another $ref': { wrap: { allOf: [{ $ref: '#/$defs/mid' }] }, at: '/allOf/0', note: 'allOf', decided: true },
  };
  /**
   * The four positions validation is reached from: what an operation
   * returns, a member of what it takes, its input's own `allOf` (whose
   * one conjunct is read by direction), and a declared error's schema.
   * @type {Record<string, { op: (w: any) => any, at: string, note?: string, kind: string }>}
   */
  const positions = {
    output: { op: (w) => ({ output: w }), at: '/output', kind: 'schema-unknown' },
    'input member': { op: (w) => ({ input: { type: 'object', properties: { m: w } } }), at: '/input/properties/m', kind: 'schema-unknown' },
    'input root': { op: (w) => ({ input: { type: 'object', properties: { m: {} }, allOf: [w] } }), at: '/input/allOf/0', kind: 'schema-unknown' },
    'error schema': {
      op: (w) => ({ errors: { conflict: { status: 409, schema: w } } }), at: '/errors/conflict/schema',
      note: 'the rule table does not model error-schema evolution', kind: 'error-schema-changed',
    },
  };
  /**
   * A document whose operation reaches `$defs.w` from `position`;
   * `holder` keeps a second copy of the projection under `definitions`
   * and `mid` is a `$ref` to it.
   * @param {any} p @param {any} wrap @param {(w: any) => any} position @param {any} [policy]
   */
  const doc = (p, wrap, position, policy) => ({
    $contract: '0.1',
    $defs: { proj: p, holder: { definitions: { proj: p } }, mid: ref, w: wrap },
    operations: { 'a.do': {
      kind: 'command', output: true, http: { method: 'POST', path: '/a' }, ...position({ $ref: '#/$defs/w' }),
      ...(policy === undefined ? {} : { policy }),
    } },
  });

  for (const [shape, { wrap, at, note }] of Object.entries(shapes).filter(([, s]) => !s.decided)) {
    it(`${shape}: a required member removed or added behind the $ref reports R15 where the resolved schemas differ, in every position`, () => {
      for (const [position, p] of Object.entries(positions)) {
        for (const [from, to] of [[['a', 'b'], ['a']], [['a'], ['a', 'b']]]) {
          const d = diffContracts(doc(proj(from), wrap, p.op), doc(proj(to), wrap, p.op));
          onlyClasses(d, ['unknown']);
          assert.deepStrictEqual(only(d.unknown), {
            kind: p.kind, op: 'a.do', docPath: `/operations/a.do${p.at}${at}/required`, from, to, rule: 'R15', note: p.note ?? note,
          }, `${position}: ${from} -> ${to}`);
        }
      }
    });
  }

  for (const [shape, { wrap, at }] of Object.entries(shapes).filter(([, s]) => s.decided)) {
    it(`${shape}: a required member removed or added behind the $ref classifies as on a bare object, in every position but an error's`, () => {
      const pick = (/** @type {any} */ c) => [c.rule, c.kind, c.docPath, c.from, c.to, c.note];
      /** @type {[string, string[], string[], 'breaking' | 'additive', any[]][]} */
      const cases = [
        ['output', ['a', 'b'], ['a'], 'breaking', ['R8', 'output-member-optional', `/operations/a.do/output${at}/properties/b`, 'b', 'b', undefined]],
        ['output', ['a'], ['a', 'b'], 'additive', ['R9', 'output-member-guaranteed', `/operations/a.do/output${at}/properties/b`, 'b', 'b', undefined]],
        ['input member', ['a', 'b'], ['a'], 'additive', ['R7', 'input-widened', `/operations/a.do/input/properties/m${at}/properties/b`, 'b', 'b', 'made-optional']],
        ['input member', ['a'], ['a', 'b'], 'breaking', ['R6', 'input-narrowed', `/operations/a.do/input/properties/m${at}/properties/b`, 'b', 'b', 'made-required']],
        ['input root', ['a', 'b'], ['a'], 'additive', ['R7', 'input-widened', `/operations/a.do/input/allOf/0${at}/properties/b`, 'b', 'b', 'made-optional']],
        ['input root', ['a'], ['a', 'b'], 'breaking', ['R6', 'input-narrowed', `/operations/a.do/input/allOf/0${at}/properties/b`, 'b', 'b', 'made-required']],
      ];
      for (const [position, from, to, cls, expected] of cases) {
        const d = diffContracts(doc(proj(from), wrap, positions[position].op), doc(proj(to), wrap, positions[position].op));
        onlyClasses(d, [cls]);
        assert.deepStrictEqual(pick(only(d[cls])), expected, `${position}: ${from} -> ${to}`);
      }
      const error = positions['error schema'];
      const d = diffContracts(doc(proj(['a', 'b']), wrap, error.op), doc(proj(['a']), wrap, error.op));
      onlyClasses(d, ['unknown']);
      assert.deepStrictEqual(only(d.unknown), {
        kind: error.kind, op: 'a.do', docPath: `/operations/a.do${error.at}${at}/required`, from: ['a', 'b'], to: ['a'], rule: 'R15', note: error.note,
      });
    });
  }

  it('an enum narrowed behind the $ref in a discriminated union classifies at the enum, and in one whose branches overlap reports R15 there', () => {
    const { wrap } = shapes['a discriminated oneOf variant'];
    const d = diffContracts(doc(proj(['a']), wrap, positions.output.op), doc(proj(['a'], ['x']), wrap, positions.output.op));
    onlyClasses(d, ['additive']);
    assert.deepStrictEqual(only(d.additive), {
      kind: 'output-narrowed', op: 'a.do', docPath: '/operations/a.do/output/oneOf/0/properties/value/properties/b/enum',
      from: ['x', 'y'], to: ['x'], rule: 'R9', note: 'enum',
    });
    const either = shapes['an anyOf branch another branch overlaps'].wrap;
    const u = diffContracts(doc(proj(['a']), either, positions.output.op), doc(proj(['a'], ['x']), either, positions.output.op));
    onlyClasses(u, ['unknown']);
    assert.deepStrictEqual(only(u.unknown), {
      kind: 'schema-unknown', op: 'a.do', docPath: '/operations/a.do/output/anyOf/0/properties/b/enum',
      from: ['x', 'y'], to: ['x'], rule: 'R15', note: 'anyOf',
    });
  });

  it('where the walk models the position the $ref sits in, the change classifies as through a direct $ref', () => {
    /** @type {[string, any, string][]} */
    const modeled = [
      ['additionalProperties', { type: 'object', additionalProperties: ref }, '/additionalProperties/properties/b'],
      ['a nullable type array', { type: ['object', 'null'], properties: { v: ref } }, '/properties/v/properties/b'],
      ['a nullable union', { anyOf: [{ type: 'object', properties: { v: ref } }, { type: 'null' }] }, '/anyOf/0/properties/v/properties/b'],
    ];
    for (const [name, wrap, at] of modeled) {
      const out = (/** @type {string[]} */ r) => doc(proj(r), wrap, positions.output.op);
      const inp = (/** @type {string[]} */ r) => doc(proj(r), wrap, positions['input member'].op);
      const pick = (/** @type {any} */ c) => [c.rule, c.kind, c.docPath, c.note];
      const looser = diffContracts(out(['a', 'b']), out(['a']));
      onlyClasses(looser, ['breaking']);
      assert.deepStrictEqual(pick(only(looser.breaking)), ['R8', 'output-member-optional', `/operations/a.do/output${at}`, undefined], name);
      const tighter = diffContracts(out(['a']), out(['a', 'b']));
      onlyClasses(tighter, ['additive']);
      assert.deepStrictEqual(pick(only(tighter.additive)), ['R9', 'output-member-guaranteed', `/operations/a.do/output${at}`, undefined], name);
      const required = diffContracts(inp(['a']), inp(['a', 'b']));
      onlyClasses(required, ['breaking']);
      assert.deepStrictEqual(pick(only(required.breaking)), ['R6', 'input-narrowed', `/operations/a.do/input/properties/m${at}`, 'made-required'], name);
      const optional = diffContracts(inp(['a', 'b']), inp(['a']));
      onlyClasses(optional, ['additive']);
      assert.deepStrictEqual(pick(only(optional.additive)), ['R7', 'input-widened', `/operations/a.do/input/properties/m${at}`, 'made-optional'], name);
    }
  });

  it('stays empty where the resolved schemas validate alike: the same document, an annotation, a reorder, a $ref inside a const', () => {
    for (const { wrap } of Object.values(shapes)) {
      for (const p of Object.values(positions)) {
        onlyClasses(diffContracts(doc(proj(['a', 'b']), wrap, p.op), doc(proj(['a', 'b']), wrap, p.op)), []);
        onlyClasses(diffContracts(doc(proj(['a', 'b']), wrap, p.op), doc({ ...proj(['b', 'a'], ['y', 'x']), description: 'moved' }, wrap, p.op)), []);
      }
    }
    // a `const` holds data: a `$ref` member inside it names nothing
    const quoted = { oneOf: [{ const: { $ref: '#/$defs/proj' } }, { type: 'string' }] };
    onlyClasses(diffContracts(doc(proj(['a', 'b']), quoted, positions.output.op), doc(proj(['a']), quoted, positions.output.op)), []);
  });

  it('a recursive definition behind a union terminates: alike is empty, a change deep inside reports once', () => {
    /** @param {string} leaf */
    const tree = (leaf) => ({
      $contract: '0.1',
      $defs: { node: { type: 'object', properties: { name: { type: leaf }, kids: { type: 'array', items: { $ref: '#/$defs/node' } } } } },
      operations: { 'a.do': { kind: 'read', output: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'object' }] }, http: { method: 'GET', path: '/a' } } },
    });
    onlyClasses(diffContracts(tree('string'), tree('string')), []);
    const d = diffContracts(tree('string'), tree('integer'));
    onlyClasses(d, ['unknown']);
    assert.deepStrictEqual(only(d.unknown), {
      kind: 'schema-unknown', op: 'a.do', docPath: '/operations/a.do/output/anyOf/0/properties/name/type',
      from: 'string', to: 'integer', rule: 'R15', note: 'anyOf',
    });
  });

  it('a 40-level diamond of $refs compares each pair once (linear, not 2^40)', () => {
    const depth = 40;
    /** @param {string} leaf */
    const diamond = (leaf) => {
      /** @type {Record<string, any>} */
      const defs = { [`d${depth}`]: { type: leaf } };
      for (let i = depth - 1; i >= 0; i--) defs[`d${i}`] = { allOf: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
      return { $contract: '0.1', $defs: defs, operations: { 'a.do': { kind: 'read', output: { $ref: '#/$defs/d0' }, http: { method: 'GET', path: '/a' } } } };
    };
    onlyClasses(diffContracts(diamond('string'), diamond('string')), []);
    const d = diffContracts(diamond('string'), diamond('number'));
    // each level's two conjuncts constrain the same location: R15, not a direction
    onlyClasses(d, ['unknown']);
    assert.deepStrictEqual([only(d.unknown).rule, only(d.unknown).note, only(d.unknown).docPath], ['R15', 'allOf', `/operations/a.do/output${'/allOf/0'.repeat(depth)}/type`]);
  });

  it("under audience: 'all' a server operation's change behind a $ref is reported and marked; the public default skips it", () => {
    const { wrap } = shapes['a discriminated oneOf variant'];
    const a = doc(proj(['a', 'b']), wrap, positions.output.op, { audience: 'server' });
    const b = doc(proj(['a']), wrap, positions.output.op, { audience: 'server' });
    onlyClasses(diffContracts(a, b), []);
    const all = diffContracts(a, b, { audience: 'all' });
    onlyClasses(all, ['breaking']);
    const c = only(all.breaking);
    assert.deepStrictEqual([c.rule, c.docPath, c.audience], ['R8', '/operations/a.do/output/oneOf/0/properties/value/properties/b', 'server']);
  });

  it("the input's own keywords beside its members are compared: an applicator, a bound, the siblings of the $ref it is spelled as", () => {
    /** @param {any} input @param {any} [defs] */
    const take = (input, defs = {}) => one({ kind: 'command', input, output: true, http: { method: 'POST', path: '/a' } }, { $defs: defs });
    const base = { type: 'object', properties: { m: { type: 'string' } } };
    const bound = diffContracts(take(base), take({ ...base, minProperties: 1 }));
    onlyClasses(bound, ['unknown']);
    assert.deepStrictEqual(only(bound.unknown), {
      kind: 'schema-unknown', op: 'a.b', docPath: '/operations/a.b/input/minProperties', from: undefined, to: 1, rule: 'R15', note: 'minProperties',
    });
    const applicator = diffContracts(take({ ...base, allOf: [{ required: ['m'] }] }), take({ ...base, allOf: [] }));
    onlyClasses(applicator, ['unknown']);
    assert.deepStrictEqual([only(applicator.unknown).docPath, only(applicator.unknown).note], ['/operations/a.b/input/allOf', 'allOf']);
    // a sibling of the input's $ref validates the request, though its members are read from the target
    const In = { In: { type: 'object', properties: { m: { type: 'string' }, n: { type: 'string' } } } };
    const sibling = diffContracts(take({ $ref: '#/$defs/In', required: ['m'] }, In), take({ $ref: '#/$defs/In', required: ['m', 'n'] }, In));
    onlyClasses(sibling, ['unknown']);
    assert.deepStrictEqual([only(sibling.unknown).docPath, only(sibling.unknown).note], ['/operations/a.b/input', '$ref']);
    onlyClasses(diffContracts(take({ $ref: '#/$defs/In', required: ['m'] }, In), take({ $ref: '#/$defs/In', required: ['m'] }, In)), []);
    // ... and so does a sibling whose own $ref resolves to a changed schema
    const extra = (/** @type {string[]} */ required) => ({ ...In, Extra: { required } });
    const spelled = { $ref: '#/$defs/In', allOf: [{ $ref: '#/$defs/Extra' }] };
    const behind = diffContracts(take(spelled, extra(['m'])), take(spelled, extra(['m', 'n'])));
    onlyClasses(behind, ['unknown']);
    assert.deepStrictEqual(only(behind.unknown), {
      kind: 'schema-unknown', op: 'a.b', docPath: '/operations/a.b/input/allOf/0/required', from: ['m'], to: ['m', 'n'], rule: 'R15', note: '$ref',
    });
    // an R6 keyword on the input itself classifies as on a member
    const narrowed = diffContracts(take({ ...base, enum: [{ m: 'a' }, { m: 'b' }] }), take({ ...base, enum: [{ m: 'a' }] }));
    onlyClasses(narrowed, ['breaking']);
    assert.deepStrictEqual([only(narrowed.breaking).rule, only(narrowed.breaking).kind, only(narrowed.breaking).docPath], ['R6', 'input-narrowed', '/operations/a.b/input/enum']);
  });
});

describe('diffContracts — a change inside an applicator whose direction is decidable classifies as on a bare schema', () => {
  const at = { input: '/operations/a.b/input/properties/x', output: '/operations/a.b/output' };
  /**
   * An operation that takes `schema` as its body member `x`, or returns it.
   * @param {'input' | 'output'} where @param {any} schema @param {any} [defs] @param {any} [policy]
   */
  const take = (where, schema, defs = {}, policy = undefined) => {
    const extra = policy === undefined ? {} : { policy };
    return where === 'input' ? commandWith(schema, extra, defs) : one(readOp({ output: schema, ...extra }), { $defs: defs });
  };
  /** @param {string} k @param {any} v */
  const variant = (k, v) => ({ type: 'object', properties: { k: { const: k }, v }, required: ['k'] });
  /**
   * Each position, spelled with a bound `n` it moves: `n = 5` is the
   * wider schema, `n = 3` the narrower; `keyword` sits at `pointer`.
   * @type {[string, (n: number) => any, string, string][]}
   */
  const decided = [
    ['an allOf conjunct', (n) => ({ allOf: [{ type: 'string' }, { maxLength: n }] }), '/allOf/1/maxLength', 'maxLength'],
    ['a oneOf variant a const discriminates', (n) => ({ oneOf: [variant('a', { type: 'string', maxLength: n }), variant('b', { type: 'string' })] }), '/oneOf/0/properties/v/maxLength', 'maxLength'],
    ['an anyOf branch an enum discriminates', (n) => ({ anyOf: [
      { type: 'object', properties: { k: { enum: ['a', 'b'] }, v: { type: 'string', maxLength: n } }, required: ['k'] },
      { type: ['object'], properties: { k: { enum: ['c'] } }, required: ['k'] },
    ] }), '/anyOf/0/properties/v/maxLength', 'maxLength'],
    ['a then under the same if', (n) => ({ if: { type: 'string' }, then: { maxLength: n } }), '/then/maxLength', 'maxLength'],
    ['an else under the same if', (n) => ({ if: { type: 'string' }, else: { maximum: n } }), '/else/maximum', 'maximum'],
    ['a dependentSchemas member under the same key', (n) => ({ type: 'object', dependentSchemas: { a: { properties: { b: { type: 'string', maxLength: n } } } } }), '/dependentSchemas/a/properties/b/maxLength', 'maxLength'],
    ['a prefixItems entry', (n) => ({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'string', maxLength: n }] }), '/prefixItems/1/maxLength', 'maxLength'],
  ];
  const pick = (/** @type {any} */ c) => [c.rule, c.kind, c.docPath, c.from, c.to, c.note];

  for (const [name, spell, pointer, keyword] of decided) {
    it(`${name}: narrowed or widened, inline and behind a $ref, input and output`, () => {
      /** @type {['input' | 'output', number, number, 'breaking' | 'additive', string, string][]} */
      const cases = [
        ['input', 5, 3, 'breaking', 'R6', 'input-narrowed'],
        ['input', 3, 5, 'additive', 'R7', 'input-widened'],
        ['output', 5, 3, 'additive', 'R9', 'output-narrowed'],
        ['output', 3, 5, 'breaking', 'R8', 'output-widened'],
      ];
      for (const [where, from, to, cls, rule, kind] of cases) {
        const expected = [rule, kind, at[where] + pointer, from, to, keyword];
        const inline = diffContracts(take(where, spell(from)), take(where, spell(to)));
        onlyClasses(inline, [cls]);
        assert.deepStrictEqual(pick(only(inline[cls])), expected, `${where} inline ${from} -> ${to}`);
        const ref = { $ref: '#/$defs/w' };
        const behind = diffContracts(take(where, ref, { w: spell(from) }), take(where, ref, { w: spell(to) }));
        onlyClasses(behind, [cls]);
        assert.deepStrictEqual(pick(only(behind[cls])), expected, `${where} behind a $ref ${from} -> ${to}`);
      }
    });
  }

  it("the reported result envelope: a member dropped from the projection a discriminated anyOf variant returns, as the object helper spells it", () => {
    /** @param {Record<string, any>} properties */
    const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
    /** @param {any} shape */
    const result = (shape) => ({ anyOf: [
      object({ ok: { const: true }, value: shape }),
      object({ ok: { const: false }, issues: { type: 'array', items: { type: 'string' } } }),
    ] });
    const both = object({ a: { type: 'string' }, b: { type: 'string' } });
    const defs = (/** @type {any} */ proj) => ({ proj, result: result({ $ref: '#/$defs/proj' }) });
    const ref = { $ref: '#/$defs/result' };
    const member = '/anyOf/0/properties/value/properties/b';
    /** @type {[string, any, any, 'input' | 'output', 'breaking' | 'additive', any[]][]} */
    const cases = [
      ['dropped', both, object({ a: { type: 'string' } }), 'output', 'breaking', ['R8', 'output-member-removed', at.output + member, 'b', 'b', undefined]],
      ['dropped', both, object({ a: { type: 'string' } }), 'input', 'breaking', ['R6', 'input-narrowed', at.input + member, 'b', 'b', 'removed']],
      ['added', object({ a: { type: 'string' } }), both, 'output', 'breaking', ['R8', 'output-member-added', at.output + member, 'b', 'b', undefined]],
      ['added', object({ a: { type: 'string' } }), both, 'input', 'breaking', ['R6', 'input-narrowed', at.input + member, 'b', 'b', 'added-required']],
      ['made optional', both, { ...both, required: ['a'] }, 'output', 'breaking', ['R8', 'output-member-optional', at.output + member, 'b', 'b', undefined]],
      ['made optional', both, { ...both, required: ['a'] }, 'input', 'additive', ['R7', 'input-widened', at.input + member, 'b', 'b', 'made-optional']],
      ['made required', { ...both, required: ['a'] }, both, 'output', 'additive', ['R9', 'output-member-guaranteed', at.output + member, 'b', 'b', undefined]],
      ['made required', { ...both, required: ['a'] }, both, 'input', 'breaking', ['R6', 'input-narrowed', at.input + member, 'b', 'b', 'made-required']],
    ];
    for (const [change, from, to, where, cls, expected] of cases) {
      const d = diffContracts(take(where, ref, defs(from)), take(where, ref, defs(to)));
      onlyClasses(d, [cls]);
      assert.deepStrictEqual(pick(only(d[cls])), expected, `${where}: ${change}`);
    }
  });

  it('stays R15 wherever the direction is not proven, both ways, input and output', () => {
    const x = { minLength: 1 };
    const y = { maxLength: 5 };
    const z = { pattern: '^a' };
    /**
     * Each: what changed, the R15 entries it reports (`note pointer`, the
     * pointer under the position), the two spellings, and the `$defs`.
     * @type {[string, string[], any, any, [Record<string, any>, Record<string, any>]?][]}
     */
    const unproven = [
      ['an allOf beside unevaluatedProperties', ['allOf /allOf'], { allOf: [{ properties: { c: { type: 'string' } } }], unevaluatedProperties: false }, { allOf: [{ properties: {} }], unevaluatedProperties: false }],
      ['a prefixItems beside unevaluatedItems', ['prefixItems /prefixItems'], { type: 'array', prefixItems: [{ maxLength: 5 }], unevaluatedItems: false }, { type: 'array', prefixItems: [{ maxLength: 3 }], unevaluatedItems: false }],
      ['allOf conjuncts that traded places', ['allOf /allOf'], { allOf: [x, y] }, { allOf: [y, x] }],
      ['an allOf conjunct moved to the end', ['allOf /allOf'], { allOf: [x, y] }, { allOf: [z, x] }],
      ['an allOf conjunct moved to the front', ['allOf /allOf'], { allOf: [x, y] }, { allOf: [y, z] }],
      ['two conjuncts respelled', ['allOf /allOf'], { allOf: [{ minLength: 1 }, { maxLength: 5 }] }, { allOf: [{ maxLength: 4 }, { minLength: 2 }] }],
      ['an allOf that grew', ['allOf /allOf'], { allOf: [x] }, { allOf: [x, y] }],
      ['a constraint moved into a conjunct', ['allOf /allOf', 'minLength /minLength'], { minLength: 1, allOf: [{}] }, { allOf: [{ minLength: 1 }] }],
      ['a member moved into a conjunct', ['allOf /allOf', 'properties /properties/a'], { type: 'object', properties: { a: {} }, allOf: [{}] }, { type: 'object', allOf: [{ properties: { a: {} } }] }],
      ['members that traded places with a conjunct', ['allOf /allOf', 'properties /properties/a', 'properties /properties/b'],
        { type: 'object', properties: { a: {} }, allOf: [{ properties: { b: {} } }] }, { type: 'object', properties: { b: {} }, allOf: [{ properties: { a: {} } }] }],
      ['a requirement moved into a conjunct', ['allOf /allOf', 'required /required'], { type: 'object', required: ['a'], allOf: [{}] }, { type: 'object', allOf: [{ required: ['a'] }] }],
      ['variants that share a discriminator value', ['oneOf /oneOf'], { oneOf: [variant('a', { maxLength: 5 }), variant('a', {})] }, { oneOf: [variant('a', { maxLength: 3 }), variant('a', {})] }],
      ['a variant that is not an object schema', ['oneOf /oneOf'], { oneOf: [variant('a', { maxLength: 5 }), { properties: { k: { const: 'b' } }, required: ['k'] }] },
        { oneOf: [variant('a', { maxLength: 3 }), { properties: { k: { const: 'b' } }, required: ['k'] }] }],
      ['a variant that does not require the discriminator', ['anyOf /anyOf'], { anyOf: [variant('a', { maxLength: 5 }), { type: 'object', properties: { k: { const: 'b' } } }] },
        { anyOf: [variant('a', { maxLength: 3 }), { type: 'object', properties: { k: { const: 'b' } } }] }],
      ['a variant that stopped requiring the discriminator', ['anyOf /anyOf'], { anyOf: [variant('a', { maxLength: 5 }), variant('b', {})] },
        { anyOf: [variant('a', { maxLength: 3 }), { type: 'object', properties: { k: { const: 'b' } } }] }],
      ['a discriminator value set that grew into another variant\'s', ['anyOf /anyOf'],
        { anyOf: [{ ...variant('a', { maxLength: 5 }), properties: { k: { enum: ['a'] }, v: { maxLength: 5 } } }, variant('b', {})] },
        { anyOf: [{ ...variant('a', { maxLength: 3 }), properties: { k: { enum: ['a', 'b'] }, v: { maxLength: 3 } } }, variant('c', {})] }],
      ['a discriminator value set that shrank', ['anyOf /anyOf'],
        { anyOf: [{ ...variant('a', {}), properties: { k: { enum: ['a', 'c'] }, v: { maxLength: 5 } } }, variant('b', {})] },
        { anyOf: [{ ...variant('a', {}), properties: { k: { enum: ['a'] }, v: { maxLength: 3 } } }, variant('b', {})] }],
      ['branches whose types overlap (an integer is a number)', ['anyOf /anyOf'], { anyOf: [{ type: 'number', maximum: 5 }, { type: 'integer' }] }, { anyOf: [{ type: 'number', maximum: 3 }, { type: 'integer' }] }],
      ['a branch whose type set grew', ['anyOf /anyOf'], { anyOf: [{ type: 'string', maxLength: 5 }, { type: 'integer' }] }, { anyOf: [{ type: ['string', 'boolean'], maxLength: 3 }, { type: 'integer' }] }],
      ['a branch without a type beside a typed one', ['anyOf /anyOf'], { anyOf: [{ maxLength: 5 }, { type: 'integer' }] }, { anyOf: [{ maxLength: 3 }, { type: 'integer' }] }],
      ['a branch whose own union has an untyped variant', ['anyOf /anyOf'],
        { anyOf: [{ anyOf: [{ type: 'string', maxLength: 5 }, { minimum: 1 }] }, { type: 'null' }] }, { anyOf: [{ anyOf: [{ type: 'string', maxLength: 3 }, { minimum: 1 }] }, { type: 'null' }] }],
      ['a variant whose discriminator admits no value', ['anyOf /anyOf'],
        { anyOf: [{ ...variant('a', { maxLength: 5 }), properties: { k: { enum: [] }, v: { maxLength: 5 } } }, variant('b', {})] },
        { anyOf: [{ ...variant('a', { maxLength: 3 }), properties: { k: { enum: [] }, v: { maxLength: 3 } } }, variant('b', {})] }],
      ['an empty union', ['anyOf /anyOf'], { anyOf: [] }, { anyOf: [{ type: 'string' }] }],
      ['a variant added beside a node that constrains it', ['oneOf /oneOf/2'],
        { type: 'object', oneOf: [variant('a', {}), variant('b', {})] }, { type: 'object', oneOf: [variant('a', {}), variant('b', {}), variant('c', {})] }],
      ['a then beside a changed if', ['if /if', 'then /then'], { if: { type: 'string' }, then: { maxLength: 5 } }, { if: { type: 'number' }, then: { maxLength: 3 } }],
      ['a then behind an if whose $ref resolves apart', ['if /if/type', 'then /then'], { if: { $ref: '#/$defs/c' }, then: { maxLength: 5 } }, { if: { $ref: '#/$defs/c' }, then: { maxLength: 3 } }, [{ c: { type: 'string' } }, { c: { type: 'number' } }]],
      ['a then without an if', ['then /then'], { then: { maxLength: 5 } }, { then: { maxLength: 3 } }],
      ['a then that appeared', ['then /then'], { if: { type: 'string' } }, { if: { type: 'string' }, then: { maxLength: 3 } }],
      ['a dependentSchemas key added', ['dependentSchemas /dependentSchemas'], { dependentSchemas: { a: { maxProperties: 5 } } }, { dependentSchemas: { a: { maxProperties: 5 }, b: {} } }],
      ['a prefixItems that grew', ['prefixItems /prefixItems'], { type: 'array', prefixItems: [{ maxLength: 5 }] }, { type: 'array', prefixItems: [{ maxLength: 3 }, {}] }],
      ['a constraint another conjunct still holds', ['allOf /allOf/1/minLength'],
        { allOf: [{ minLength: 1 }, { minLength: 1, maxLength: 5 }] }, { allOf: [{ minLength: 1 }, { maxLength: 5 }] }],
      ['a constraint the node still holds beside a then', ['then /then/minLength'],
        { minLength: 1, if: { type: 'string' }, then: { minLength: 1 } }, { minLength: 1, if: { type: 'string' }, then: {} }],
      ['a member the node constrains beside a variant', ['oneOf /oneOf/0/properties/v/maxLength'],
        { type: 'object', properties: { v: { maxLength: 9 } }, oneOf: [variant('a', { maxLength: 5 }), variant('b', {})] },
        { type: 'object', properties: { v: { maxLength: 9 } }, oneOf: [variant('a', { maxLength: 3 }), variant('b', {})] }],
      ['a requirement another dependentSchemas entry holds', ['dependentSchemas /dependentSchemas/a/required'],
        { dependentSchemas: { a: { required: ['c'] }, b: { required: ['c'] } } }, { dependentSchemas: { a: {}, b: { required: ['c'] } } }],
      ['an entry a contains beside prefixItems may constrain', ['prefixItems /prefixItems/0/maxLength'],
        { type: 'array', prefixItems: [{ maxLength: 5 }], contains: { minLength: 1 } }, { type: 'array', prefixItems: [{ maxLength: 3 }], contains: { minLength: 1 } }],
      ['identical conjuncts behind one changed $ref', ['allOf /allOf/0/maxLength'],
        { allOf: [{ $ref: '#/$defs/c' }, { $ref: '#/$defs/c' }] }, { allOf: [{ $ref: '#/$defs/c' }, { $ref: '#/$defs/c' }] }, [{ c: { maxLength: 5 } }, { c: { maxLength: 3 } }]],
      ['a conjunct beside one that holds an applicator', ['allOf /allOf/1/maxLength'],
        { allOf: [{ anyOf: [{ maxLength: 5 }, { type: 'integer' }] }, { maxLength: 5 }] }, { allOf: [{ anyOf: [{ maxLength: 5 }, { type: 'integer' }] }, { maxLength: 3 }] }],
      ['a not', ['not /not'], { not: { maxLength: 5 } }, { not: { maxLength: 3 } }],
      ['a contains', ['contains /contains'], { type: 'array', contains: { maxLength: 5 } }, { type: 'array', contains: { maxLength: 3 } }],
    ];
    for (const [name, expected, from, to, extraDefs] of unproven) {
      for (const where of /** @type {const} */ (['input', 'output'])) {
        for (const [p, q] of [[from, to], [to, from]]) {
          // the $ref cases: the text is equal, the target is not
          const [defsP, defsQ] = extraDefs ?? [{}, {}];
          const d = diffContracts(take(where, p, defsP), take(where, q, defsQ));
          onlyClasses(d, ['unknown']);
          assert.ok(d.unknown.every((/** @type {any} */ c) => c.rule === 'R15'), name);
          assert.deepStrictEqual(d.unknown.map((/** @type {any} */ c) => `${c.note} ${c.docPath.slice(at[where].length)}`).sort(), expected, `${name} (${where})`);
        }
      }
    }
  });

  describe('a union whose variants are provably disjoint pairs them by type or discriminator value, not by position', () => {
    /** @param {string} k @param {any} [v] */
    const sum = (k, v = {}) => variant(k, v);
    /**
     * Each: the wider spelling, the narrower one, and what the change from
     * the wider to the narrower (`narrowed`) and back (`widened`) reports:
     * `[pointer, from, to, note]`, the pointer under the position.
     * @type {[string, any, any, any[], any[]][]}
     */
    const cases = [
      ['branches a type tells apart', { anyOf: [{ type: 'string', maxLength: 5 }, { type: 'integer' }] }, { anyOf: [{ type: 'string', maxLength: 3 }, { type: 'integer' }] },
        ['/anyOf/0/maxLength', 5, 3, 'maxLength'], ['/anyOf/0/maxLength', 3, 5, 'maxLength']],
      ['a branch typed by its own union, beside a null', { anyOf: [{ anyOf: [sum('a', { type: 'string', maxLength: 5 }), sum('b')] }, { type: 'null' }] },
        { anyOf: [{ anyOf: [sum('a', { type: 'string', maxLength: 3 }), sum('b')] }, { type: 'null' }] },
        ['/anyOf/0/anyOf/0/properties/v/maxLength', 5, 3, 'maxLength'], ['/anyOf/0/anyOf/0/properties/v/maxLength', 3, 5, 'maxLength']],
      ['reordered variants a const discriminates', { oneOf: [sum('a', { type: 'string', maxLength: 5 }), sum('b')] }, { oneOf: [sum('b'), sum('a', { type: 'string', maxLength: 3 })] },
        ['/oneOf/1/properties/v/maxLength', 5, 3, 'maxLength'], ['/oneOf/0/properties/v/maxLength', 3, 5, 'maxLength']],
      ['reordered branches a type tells apart', { anyOf: [{ type: 'integer' }, { type: 'string', maxLength: 5 }] }, { anyOf: [{ type: 'string', maxLength: 3 }, { type: 'integer' }] },
        ['/anyOf/0/maxLength', 5, 3, 'maxLength'], ['/anyOf/1/maxLength', 3, 5, 'maxLength']],
      ['a variant under a new discriminator value', { oneOf: [sum('a'), sum('b'), sum('c')] }, { oneOf: [sum('a'), sum('b')] },
        ['/oneOf/2', sum('c'), undefined, 'schema'], ['/oneOf/2', undefined, sum('c'), 'schema']],
      ['a variant under a new discriminator value, the others reordered', { oneOf: [sum('c'), sum('a'), sum('b')] }, { oneOf: [sum('b'), sum('a')] },
        ['/oneOf/0', sum('c'), undefined, 'schema'], ['/oneOf/0', undefined, sum('c'), 'schema']],
      ['a variant of a new type', { anyOf: [{ type: 'string' }, { type: 'array' }, { type: 'boolean' }] }, { anyOf: [{ type: 'string' }, { type: 'boolean' }] },
        ['/anyOf/1', { type: 'array' }, undefined, 'schema'], ['/anyOf/1', undefined, { type: 'array' }, 'schema']],
      ['a null variant', { anyOf: [{ type: 'object', properties: { a: { $ref: '#/$defs/n' } } }, { type: 'null' }] }, { anyOf: [{ type: 'object', properties: { a: { $ref: '#/$defs/n' } } }] },
        ['/anyOf/1', { type: 'null' }, undefined, 'schema'], ['/anyOf/1', undefined, { type: 'null' }, 'schema']],
      ['a variant typed by a union it reaches twice', { anyOf: [{ anyOf: [{ $ref: '#/$defs/s' }, { $ref: '#/$defs/s' }] }, { type: 'boolean' }, { type: 'null' }] },
        { anyOf: [{ anyOf: [{ $ref: '#/$defs/s' }, { $ref: '#/$defs/s' }] }, { type: 'null' }] },
        ['/anyOf/1', { type: 'boolean' }, undefined, 'schema'], ['/anyOf/1', undefined, { type: 'boolean' }, 'schema']],
    ];
    /** @type {['input' | 'output', 'narrowed' | 'widened', 'breaking' | 'additive', string, string][]} */
    const ways = [
      ['input', 'narrowed', 'breaking', 'R6', 'input-narrowed'],
      ['input', 'widened', 'additive', 'R7', 'input-widened'],
      ['output', 'narrowed', 'additive', 'R9', 'output-narrowed'],
      ['output', 'widened', 'breaking', 'R8', 'output-widened'],
    ];
    const n = { n: { type: 'string' }, s: { anyOf: [{ type: 'string' }, { type: 'integer' }] } };
    const server = { audience: 'server' };
    for (const [name, wide, narrow, narrowed, widened] of cases) {
      it(`${name}: narrowed or widened, inline and behind a $ref, input and output, for both audiences`, () => {
        for (const [where, direction, cls, rule, kind] of ways) {
          const [p, q, [pointer, from, to, note]] = direction === 'narrowed' ? [wide, narrow, narrowed] : [narrow, wide, widened];
          const expected = [rule, kind, at[where] + pointer, from, to, note];
          const inline = diffContracts(take(where, p, n), take(where, q, n));
          onlyClasses(inline, [cls]);
          assert.deepStrictEqual(pick(only(inline[cls])), expected, `${where} inline ${direction}`);
          const ref = { $ref: '#/$defs/w' };
          const behind = diffContracts(take(where, ref, { ...n, w: p }), take(where, ref, { ...n, w: q }));
          onlyClasses(behind, [cls]);
          assert.deepStrictEqual(pick(only(behind[cls])), expected, `${where} behind a $ref ${direction}`);
          // a server operation: skipped by the public default, classed alike and marked under audience 'all'
          onlyClasses(diffContracts(take(where, p, n, server), take(where, q, n, server)), []);
          const all = diffContracts(take(where, p, n, server), take(where, q, n, server), { audience: 'all' });
          onlyClasses(all, [cls]);
          assert.deepStrictEqual([...pick(only(all[cls])), only(all[cls]).audience], [...expected, 'server'], `${where} audience all ${direction}`);
        }
      });
    }

    it('a union whose variant is the union itself, untyped, ends unbounded: R15, no endless descent', () => {
      // the bound beside the union reads the instance, so the loop compiles
      /** @param {number} n */
      const defs = (n) => ({ u: { minLength: 1, anyOf: [{ $ref: '#/$defs/u' }, { type: 'string', maxLength: n }] } });
      for (const where of /** @type {const} */ (['input', 'output'])) {
        const d = diffContracts(take(where, { $ref: '#/$defs/u' }, defs(5)), take(where, { $ref: '#/$defs/u' }, defs(3)));
        onlyClasses(d, ['unknown']);
        assert.deepStrictEqual(pick(only(d.unknown)), ['R15', 'schema-unknown', at[where] + '/anyOf', defs(5).u.anyOf, defs(3).u.anyOf, 'anyOf']);
      }
    });

    it('a reorder alone, by discriminator value or by type, is no change', () => {
      for (const where of /** @type {const} */ (['input', 'output'])) {
        onlyClasses(diffContracts(take(where, { oneOf: [sum('a'), sum('b'), sum('c')] }), take(where, { oneOf: [sum('c'), sum('a'), sum('b')] })), []);
        onlyClasses(diffContracts(take(where, { anyOf: [{ type: 'null' }, { $ref: '#/$defs/n' }] }, { n: { type: 'object' } }),
          take(where, { anyOf: [{ $ref: '#/$defs/n' }, { type: 'null' }] }, { n: { type: ['object'] } })), []);
      }
    });

    it('a change that names what only a holds points into a, where the reordered variant sat there; the rest into b', () => {
      const before = { oneOf: [sum('a', { type: 'object', maxProperties: 5, properties: { z: { type: 'string' }, y: { type: 'string', maxLength: 4 } } }), sum('b')] };
      const after = { oneOf: [sum('b'), sum('a', { type: 'object', properties: { y: { type: 'string' }, w: { type: 'string' } } })] };
      const d = diffContracts(take('output', before), take('output', after));
      const v = (/** @type {number} */ i) => `${at.output}/oneOf/${i}/properties/v`;
      assert.deepStrictEqual(d.unknown.map(pick), [['R15', 'schema-unknown', v(0) + '/maxProperties', 5, undefined, 'maxProperties']]);
      assert.deepStrictEqual(d.breaking.map(pick), [
        ['R8', 'output-member-removed', v(0) + '/properties/z', 'z', 'z', undefined],
        ['R8', 'output-widened', v(0) + '/properties/y/maxLength', 4, undefined, 'maxLength'],
      ]);
      assert.deepStrictEqual(d.additive.map(pick), [['R9', 'output-member-added', v(1) + '/properties/w', 'w', 'w', undefined]]);
      onlyClasses(d, ['unknown', 'breaking', 'additive']);
    });

    it('a discriminator value that moved: the variant it named is removed, the one it names now is added, the one kept is read in place', () => {
      const before = { anyOf: [sum('a', { type: 'string', maxLength: 5 }), sum('b')] };
      const after = { anyOf: [sum('a', { type: 'string', maxLength: 3 }), sum('c')] };
      /** @type {['input' | 'output', any[][]][]} */
      const expected = [
        ['input', [['R6', 'input-narrowed', '/anyOf/0/properties/v/maxLength', 5, 3, 'maxLength'], ['R7', 'input-widened', '/anyOf/1', undefined, sum('c'), 'schema'],
          ['R6', 'input-narrowed', '/anyOf/1', sum('b'), undefined, 'schema']]],
        ['output', [['R9', 'output-narrowed', '/anyOf/0/properties/v/maxLength', 5, 3, 'maxLength'], ['R8', 'output-widened', '/anyOf/1', undefined, sum('c'), 'schema'],
          ['R9', 'output-narrowed', '/anyOf/1', sum('b'), undefined, 'schema']]],
      ];
      for (const [where, changes] of expected) {
        const d = diffContracts(take(where, before), take(where, after));
        onlyClasses(d, ['breaking', 'additive']);
        const all = [...d.breaking, ...d.additive].map(pick);
        assert.deepStrictEqual(all.sort(), changes.map((c) => [c[0], c[1], at[where] + c[2], ...c.slice(3)]).sort(), where);
      }
    });
  });

  it("an input spelled as a $ref beside unevaluatedProperties reads its target's conjuncts by text", () => {
    /** @param {Record<string, any>} c */
    const defs = (c) => ({
      In: { type: 'object', properties: { m: { type: 'string' } }, allOf: [{ $ref: '#/$defs/Extra' }] },
      Extra: { properties: c },
    });
    /** @param {any} input @param {any} $defs */
    const takes = (input, $defs) => one({ kind: 'command', input, output: true, http: { method: 'POST', path: '/a' } }, { $defs });
    const closed = { $ref: '#/$defs/In', unevaluatedProperties: false };
    const d = diffContracts(takes(closed, defs({ c: { type: 'string' } })), takes(closed, defs({})));
    onlyClasses(d, ['unknown']);
    assert.deepStrictEqual(only(d.unknown), {
      kind: 'schema-unknown', op: 'a.b', docPath: '/operations/a.b/input/allOf/0/properties/c', from: { type: 'string' }, to: undefined, rule: 'R15', note: 'allOf',
    });
    // without the sibling, the conjunct is read by direction: c is no longer constrained
    const open = { $ref: '#/$defs/In' };
    const widened = diffContracts(takes(open, defs({ c: { type: 'string' } })), takes(open, defs({})));
    onlyClasses(widened, ['additive']);
    assert.deepStrictEqual(pick(only(widened.additive)), ['R7', 'input-widened', '/operations/a.b/input/allOf/0/properties/c', 'c', 'c', 'removed']);
  });
});

describe("diffContracts — the input's own members read closedness and catch-alls as a nested object's do", () => {
  /** @param {any} input */
  const take = (input) => one({ kind: 'command', input, output: true, http: { method: 'POST', path: '/a' } });
  const m = { type: 'string' };
  const n = { type: 'number' };

  it('a member removed under unevaluatedProperties: false is refused from an older client: R5 breaking', () => {
    const d = diffContracts(take({ type: 'object', properties: { m, n }, unevaluatedProperties: false }),
      take({ type: 'object', properties: { m }, unevaluatedProperties: false }));
    onlyClasses(d, ['breaking']);
    assert.deepStrictEqual(only(d.breaking), { kind: 'input-member-removed', op: 'a.b', docPath: '/operations/a.b/input/properties/n', from: 'n', rule: 'R5' });
  });

  it('a member removed or added beside a catch-all that constrains it is judged by the catch-all: R15, never "ignored, not validated"', () => {
    for (const [keyword, catchAll] of /** @type {[string, any][]} */ ([
      ['additionalProperties', { additionalProperties: { type: 'string' } }],
      ['patternProperties', { patternProperties: { '^n': { type: 'string' } } }],
      ['propertyNames', { propertyNames: { maxLength: 4 } }],
    ])) {
      const removed = diffContracts(take({ type: 'object', properties: { m, n }, ...catchAll }), take({ type: 'object', properties: { m }, ...catchAll }));
      onlyClasses(removed, ['unknown']);
      assert.deepStrictEqual(only(removed.unknown), {
        kind: 'schema-unknown', op: 'a.b', docPath: '/operations/a.b/input/properties/n', from: 'n', to: 'n', rule: 'R15', note: keyword,
      });
      const added = diffContracts(take({ type: 'object', properties: { m }, ...catchAll }), take({ type: 'object', properties: { m, n }, ...catchAll }));
      onlyClasses(added, ['unknown']);
      assert.deepStrictEqual([only(added.unknown).docPath, only(added.unknown).note], ['/operations/a.b/input/properties/n', keyword]);
    }
    // a required member added is refused from an older client whatever the catch-all says
    const required = diffContracts(take({ type: 'object', properties: { m }, additionalProperties: { type: 'string' } }),
      take({ type: 'object', properties: { m, n }, required: ['n'], additionalProperties: { type: 'string' } }));
    onlyClasses(required, ['breaking']);
    assert.deepStrictEqual([only(required.breaking).rule, only(required.breaking).kind], ['R4', 'input-required-added']);
  });
});

describe('diffContracts — a member declared false is no member: it compares as what the other side applies to an unnamed one', () => {
  /** @param {any} input @param {any} [output] @param {any} [root] */
  const take = (input, output = true, root = {}) => one({ kind: 'command', input, output, http: { method: 'POST', path: '/a' } }, root);
  const x = { type: 'string' };
  /** @param {any} properties @param {any} [more] */
  const closed = (properties, more = {}) => ({ type: 'object', properties, additionalProperties: false, ...more });
  /** @param {any} properties @param {any} [more] */
  const open = (properties, more = {}) => ({ type: 'object', properties, ...more });
  /** Each change as [class, rule, kind, docPath]. @param {any} d */
  const flat = (d) => ['breaking', 'additive', 'neutral', 'unknown'].flatMap((name) => d[name].map((/** @type {any} */ c) => [name, c.rule, c.kind, c.docPath]));
  const at = (/** @type {string} */ rest) => '/operations/a.b' + rest;

  it('a closed input that drops or adds a forbidden member accepts the same requests: no change (was breaking R5 / additive R7)', () => {
    assert.deepStrictEqual(flat(diffContracts(take(closed({ x, m: false })), take(closed({ x })))), []);
    assert.deepStrictEqual(flat(diffContracts(take(closed({ x })), take(closed({ x, m: false })))), []);
    // the same through a $ref that resolves to false
    const never = { $defs: { never: false } };
    assert.deepStrictEqual(flat(diffContracts(take(closed({ x, m: { $ref: '#/$defs/never' } }), true, never), take(closed({ x }), true, never))), []);
  });

  it('an open input that forbids a member it allowed refuses an older client that sends it: breaking R6 (was additive R7)', () => {
    assert.deepStrictEqual(flat(diffContracts(take(open({ x })), take(open({ x, m: false })))),
      [['breaking', 'R6', 'input-narrowed', at('/input/properties/m')]]);
    const never = { $defs: { never: false } };
    assert.deepStrictEqual(flat(diffContracts(take(open({ x }), true, never), take(open({ x, m: { $ref: '#/$defs/never' } }), true, never))),
      [['breaking', 'R6', 'input-narrowed', at('/input/properties/m')]]);
  });

  it('an open input that drops a forbidden member now accepts it: additive R7 (was neutral R5 "ignored, not validated")', () => {
    assert.deepStrictEqual(flat(diffContracts(take(open({ x, m: false })), take(open({ x })))),
      [['additive', 'R7', 'input-widened', at('/input/properties/m')]]);
  });

  it('a closed input that opens beside a forbidden member reports the catch-all, not the member', () => {
    assert.deepStrictEqual(flat(diffContracts(take(closed({ x })), take(open({ x, m: false })))),
      [['additive', 'R7', 'input-widened', at('/input/additionalProperties')]]);
  });

  it('one level down, a closed object that drops or adds a forbidden member moves nothing (was breaking R6 / additive R7)', () => {
    const nest = (/** @type {any} */ o) => take(open({ o }));
    assert.deepStrictEqual(flat(diffContracts(nest(closed({ x, m: false })), nest(closed({ x })))), []);
    assert.deepStrictEqual(flat(diffContracts(nest(closed({ x })), nest(closed({ x, m: false })))), []);
    // an open nested object still narrows when it forbids, widens when it stops forbidding
    assert.deepStrictEqual(flat(diffContracts(nest(open({ x })), nest(open({ x, m: false })))),
      [['breaking', 'R6', 'input-narrowed', at('/input/properties/o/properties/m')]]);
    assert.deepStrictEqual(flat(diffContracts(nest(open({ x, m: false })), nest(open({ x })))),
      [['additive', 'R7', 'input-widened', at('/input/properties/o/properties/m')]]);
  });

  it('an output closed around a forbidden member never carried it: dropping or adding it is no change (was breaking R8)', () => {
    const out = (/** @type {any} */ o) => take(open({ x }), o);
    assert.deepStrictEqual(flat(diffContracts(out(closed({ x, m: false })), out(closed({ x })))), []);
    assert.deepStrictEqual(flat(diffContracts(out(closed({ x })), out(closed({ x, m: false })))), []);
    // open: forbidding narrows the answers (additive R9), allowing again widens them (breaking R8)
    assert.deepStrictEqual(flat(diffContracts(out(open({ x })), out(open({ x, m: false })))),
      [['additive', 'R9', 'output-narrowed', at('/output/properties/m')]]);
    assert.deepStrictEqual(flat(diffContracts(out(open({ x, m: false })), out(open({ x })))),
      [['breaking', 'R8', 'output-widened', at('/output/properties/m')]]);
  });

  it('a false member that is required, or beside a catch-all or applicator that may judge it, keeps the member rows', () => {
    // required and false: the input accepts nothing now
    assert.deepStrictEqual(flat(diffContracts(take(open({ x }, { required: ['x'] })), take(open({ x: false }, { required: ['x'] })))),
      [['breaking', 'R6', 'input-narrowed', at('/input/properties/x')]]);
    assert.deepStrictEqual(flat(diffContracts(take(open({ x })), take(open({ x, m: false }, { required: ['m'] })))),
      [['breaking', 'R4', 'input-required-added', at('/input/properties/m')]]);
    // a member the other side requires by name alone: every older request lacked it, so requiring it refuses them
    assert.deepStrictEqual(flat(diffContracts(take(open({ x, m: false })), take(open({ x }, { required: ['m'] })))),
      [['breaking', 'R4', 'input-required-added', at('/input/properties/m')]]);
    // a constraining catch-all judges the member on the other side
    assert.deepStrictEqual(flat(diffContracts(take(open({ x }, { additionalProperties: x })), take(open({ x, m: false }, { additionalProperties: x })))),
      [['unknown', 'R15', 'schema-unknown', at('/input/properties/m')]]);
    // a patternProperties beside a closed object admits the member a dropped false refused: never "no change"
    const pp = { patternProperties: { '^m': {} } };
    assert.notDeepStrictEqual(flat(diffContracts(take(closed({ x, m: false }, pp)), take(closed({ x }, pp)))), []);
    // a catch-all beside the $ref the input is spelled as refuses the member on both sides: never breaking
    for (const keyword of ['additionalProperties', 'unevaluatedProperties']) {
      const spelled = { $ref: '#/$defs/I', [keyword]: false };
      const before = { $defs: { I: open({ x }) } };
      const after = { $defs: { I: open({ x, m: false }) } };
      assert.deepStrictEqual(diffContracts(take(spelled, true, before), take(spelled, true, after)).breaking, [], keyword);
      assert.deepStrictEqual(diffContracts(take(spelled, true, after), take(spelled, true, before)).breaking, [], keyword);
    }
    // an applicator under unevaluatedProperties: false may name the member: undecidable, R15
    const nest = (/** @type {any} */ o) => take(open({ o }));
    const viaAllOf = (/** @type {any} */ properties) => ({ type: 'object', properties, allOf: [{ properties: { m: {} } }], unevaluatedProperties: false });
    assert.deepStrictEqual(flat(diffContracts(nest(viaAllOf({ x, m: false })), nest(viaAllOf({ x })))),
      [['unknown', 'R15', 'schema-unknown', at('/input/properties/o/properties/m')]]);
  });
});
