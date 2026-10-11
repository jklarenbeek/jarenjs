//@ts-check
/**
 * @file Input members named after `Object.prototype` members. A member called
 * `constructor`, `valueOf` or `toString` is an ordinary member: when the
 * caller leaves it out, nothing inherited stands in for it — not in the
 * location the compiler assigns it, not in the header the server reads, not
 * in the query, header or body the client writes, not in what `describe()` and
 * `diffContracts` report. The same holds for an error code named
 * `constructor`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { diffContracts } from '@jarenjs/contract/diff';
import { serveHttp } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { openHttpClient } from '@jarenjs/contract/client';

const OBJECT_MEMBERS = ['constructor', 'valueOf', 'toString', 'hasOwnProperty'];

/** @param {string[]} names */
const optional = (names) => Object.fromEntries(names.map((n) => [n, { type: 'string' }]));

const contract = compileContract({
  $contract: '0.1',
  id: 'protomembers',
  operations: {
    'read.default': { kind: 'read', input: { type: 'object', properties: optional(OBJECT_MEMBERS) }, output: true, http: { method: 'GET', path: '/read' } },
    'command.default': { kind: 'command', input: { type: 'object', properties: { ...optional(OBJECT_MEMBERS), ok: { type: 'string' } } }, output: true, http: { method: 'POST', path: '/command' } },
    'read.header': { kind: 'read', input: { type: 'object', properties: optional(['constructor', 'x']) }, output: true, http: { method: 'GET', path: '/header', in: { constructor: 'header' } } },
    'command.whole': { kind: 'command', input: { type: 'object', properties: { constructor: { type: 'object' } } }, output: true, http: { method: 'POST', path: '/whole', body: 'constructor' } },
  },
});

describe('input members named after Object.prototype members', () => {
  it('the compiler gives an undeclared member its default location, never one inherited from the in map', () => {
    const readIn = contract.operations['read.default'].http.in;
    const commandIn = contract.operations['command.default'].http.in;
    assert.deepStrictEqual(Object.entries(readIn), OBJECT_MEMBERS.map((n) => [n, 'query']));
    assert.deepStrictEqual(Object.entries(commandIn), [...OBJECT_MEMBERS.map((n) => [n, 'body']), ['ok', 'body']]);
    assert.deepStrictEqual(Object.entries(contract.operations['read.header'].http.in), [['constructor', 'header'], ['x', 'query']]);
  });

  it('a request without the header a member named constructor declares is not a repeated header', async () => {
    /** @type {any[]} */
    const seen = [];
    const server = serveHttp(contract, {
      'read.default': () => null, 'command.default': () => null, 'command.whole': () => null,
      'read.header': (input) => { seen.push(input); return input; },
    });
    const absent = await server.dispatch({ method: 'GET', url: '/header', headers: {}, body: null });
    assert.strictEqual(absent.status, 200, String(absent.body));
    const given = await server.dispatch({ method: 'GET', url: '/header', headers: { constructor: 'v' }, body: null });
    assert.strictEqual(given.status, 200, String(given.body));
    assert.deepStrictEqual(seen.map((input) => Object.entries(input)), [[], [['constructor', 'v']]]);
  });

  it('the client sends only the members the caller gave, in the query, a header and the body', async () => {
    /** @type {{ url: string, headers: Record<string, string>, body: string | null }[]} */
    const wire = [];
    /** @type {any[]} */
    const seen = [];
    const handler = toFetchHandler(serveHttp(contract, {
      'read.default': (input) => { seen.push(input); return input; },
      'command.default': (input) => { seen.push(input); return input; },
      'read.header': (input) => { seen.push(input); return input; },
      'command.whole': (input) => { seen.push(input); return input; },
    }));
    const client = openHttpClient(contract, {
      baseUrl: 'http://protomembers.local',
      fetch: (url, init) => {
        wire.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), body: typeof init?.body === 'string' ? init.body : null });
        return handler(new Request(url, init));
      },
    });
    const outcomes = [
      await client.invoke('read.default', {}),
      await client.invoke('read.default', { toString: 't' }),
      await client.invoke('command.default', { ok: 'x' }),
      await client.invoke('read.header', { x: 'y' }),
      await client.invoke('command.whole', {}),
    ];
    for (const outcome of outcomes) assert.strictEqual(outcome.ok, true, JSON.stringify(outcome));
    assert.deepStrictEqual(wire.map((w) => w.url.replace('http://protomembers.local', '')),
      ['/read', '/read?toString=t', '/command', '/header?x=y', '/whole']);
    assert.deepStrictEqual(wire.map((w) => w.body), [null, null, '{"ok":"x"}', null, null]);
    assert.deepStrictEqual(wire.map((w) => Object.hasOwn(w.headers, 'constructor') || Object.hasOwn(w.headers, 'valueof')), [false, false, false, false, false]);
    assert.deepStrictEqual(seen.map((input) => Object.entries(input)), [[], [['toString', 't']], [['ok', 'x']], [['x', 'y']], []]);
  });

  it('describe() lists a member the document did not map as inferred, whatever it is called', () => {
    const described = compileContract({
      $contract: '0.1', id: 'd',
      operations: { x: { kind: 'read', input: { type: 'object', properties: { constructor: { type: 'string' }, toString: { type: 'string' }, mapped: { type: 'string' } } },
        output: true, http: { method: 'GET', path: '/x', in: { mapped: 'header' } } } },
    }).describe();
    assert.deepStrictEqual(described.operations[0].inferred.in, ['constructor', 'toString']);
  });

  it('diffContracts classifies an added or removed error code or input member named constructor like any other', () => {
    /** @param {Record<string, any>} errors @param {Record<string, any>} properties */
    const version = (errors, properties) => compileContract({
      $contract: '0.1', id: 'v',
      operations: { x: { kind: 'read', input: { type: 'object', properties }, output: true, http: { method: 'GET', path: '/x' }, errors } },
    });
    const bare = version({}, {});
    const full = version({ constructor: { status: 409 } }, { constructor: { type: 'string' } });
    const kinds = (/** @type {import('@jarenjs/contract/diff').Change[]} */ changes) => changes.map((c) => `${c.kind}:${c.rule}`);

    const added = diffContracts(bare, full);
    assert.deepStrictEqual(kinds(added.breaking), []);
    assert.deepStrictEqual(kinds(added.additive), ['input-member-added:R7', 'error-added:R11']);
    assert.deepStrictEqual(added.additive.map((c) => c.to), ['constructor', 'constructor']);

    const removed = diffContracts(full, bare);
    assert.deepStrictEqual(kinds(removed.breaking), ['error-removed:R10']);
    assert.deepStrictEqual(kinds(removed.neutral), ['input-member-removed:R5']);
    assert.deepStrictEqual(kinds(removed.additive), []);
  });
});
