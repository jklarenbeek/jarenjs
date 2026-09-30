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
 */
const commandWith = (schema, extra = {}) => one({
  kind: 'command',
  input: { type: 'object', required: ['x'], properties: { x: schema } },
  output: true,
  http: { method: 'POST', path: '/a' },
  ...extra,
});

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

  it('R12: idempotency none/optional → required is breaking; required → optional/none is additive', () => {
    const idem = (/** @type {string | undefined} */ level) => one({
      kind: 'command', output: true, http: { method: 'POST', path: '/a' },
      ...(level === undefined ? {} : { policy: { idempotency: level } }),
    });
    const tightened = only(diffContracts(idem(undefined), idem('required')).breaking);
    assert.deepStrictEqual([tightened.rule, tightened.kind, tightened.from, tightened.to, tightened.docPath],
      ['R12', 'idempotency-required', 'none', 'required', '/operations/a.b/policy/idempotency']);
    const fromOptional = only(diffContracts(idem('optional'), idem('required')).breaking);
    assert.strictEqual(fromOptional.rule, 'R12');

    const relaxed = only(diffContracts(idem('required'), idem('optional')).additive);
    assert.deepStrictEqual([relaxed.rule, relaxed.kind], ['R12', 'idempotency-relaxed']);
    assert.strictEqual(only(diffContracts(idem('required'), idem(undefined)).additive).rule, 'R12');
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

  it('R15: an anyOf change lands in unknown — NEVER in neutral — as do format, a changed pattern and an external $ref', () => {
    const anyOf = diffContracts(
      commandWith({ anyOf: [{ type: 'string' }] }),
      commandWith({ anyOf: [{ type: 'string' }, { type: 'integer' }] }));
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
