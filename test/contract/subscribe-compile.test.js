//@ts-check
/**
 * @file The subscribe grammar (docs/CONTRACT-FORMAT.md §17): the kind
 * compiles with its canonical GET binding and forced media, the stream
 * policy materializes with its defaults, and every rule the compiler
 * enforces — `JC0018` task, `JC0019` method, `JC0020` idempotency, the
 * `JC0012` media conflict, `JC0014` stream on the wrong kind, `JC0013`
 * an unknown stream member — refuses with the docPath of the member at
 * fault.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract, ContractCompileError } from '@jarenjs/contract';

/**
 * @param {any} op
 */
function one(op) {
  return { $contract: '0.1', operations: { a: op } };
}

/**
 * @param {any} doc
 * @param {string} code
 * @param {string} docPath
 * @param {RegExp} [message]
 */
function refuses(doc, code, docPath, message) {
  assert.throws(() => compileContract(doc), (/** @type {any} */ err) => {
    assert.ok(err instanceof ContractCompileError, `expected ContractCompileError, got ${err}`);
    assert.strictEqual(err.code, code);
    assert.strictEqual(err.docPath, docPath);
    if (message !== undefined) assert.match(err.message, message);
    return true;
  });
}

const LIVE = {
  kind: 'subscribe',
  input: { type: 'object', required: ['collection'], properties: { collection: { type: 'string' } } },
  output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
};

describe('subscribe — the compiled shape', () => {
  it('the canonical binding is GET /<op-id> with every member in the query, media forced to text/event-stream, never opaque', () => {
    const contract = compileContract({ $contract: '0.1', operations: { 'data.live': LIVE } });
    const op = contract.operations['data.live'];
    assert.strictEqual(op.kind, 'subscribe');
    assert.strictEqual(op.http.method, 'GET');
    assert.strictEqual(op.http.path, '/data.live');
    assert.deepStrictEqual(op.http.in, { collection: 'query' });
    assert.strictEqual(op.http.media, 'text/event-stream');
    assert.strictEqual(op.http.opaque, false);
    assert.strictEqual(contract.match('GET', '/data.live')?.op.id, 'data.live');
  });

  it('a declared GET binding with a path variable compiles; describe() shows the forced media and the stream policy', () => {
    const contract = compileContract(one({
      ...LIVE,
      input: { type: 'object', required: ['room'], properties: { room: { type: 'string' } } },
      http: { method: 'GET', path: '/rooms/{room}/feed' },
    }));
    const op = contract.operations.a;
    assert.deepStrictEqual(op.http.in, { room: 'path' });
    assert.strictEqual(op.http.media, 'text/event-stream');
    const described = contract.describe().operations[0];
    assert.strictEqual(described.media, 'text/event-stream');
    assert.deepStrictEqual(described.stream, { resume: 'snapshot', heartbeatMs: 15000, maxPatchBytes: null });
    assert.strictEqual(Object.hasOwn(/** @type {any} */ (compileContract(one({ kind: 'read', output: true })).describe().operations[0]), 'stream'), false,
      'a read shows no stream member');
  });

  it('policy.stream materializes with its defaults; declared members are kept; task defaults to switch', () => {
    const defaulted = compileContract(one(LIVE)).operations.a.policy;
    assert.strictEqual(defaulted.task, 'switch');
    assert.strictEqual(defaulted.idempotency, 'none');
    assert.deepStrictEqual(defaulted.stream, { resume: 'snapshot', heartbeatMs: 15000, maxPatchBytes: null });
    const declared = compileContract(one({
      ...LIVE, policy: { stream: { resume: 'replay', heartbeatMs: 2000, maxPatchBytes: 65536 } },
    })).operations.a.policy;
    assert.deepStrictEqual(declared.stream, { resume: 'replay', heartbeatMs: 2000, maxPatchBytes: 65536 });
    assert.strictEqual(compileContract(one({ kind: 'read', output: true })).operations.a.policy.stream, null,
      'a read carries stream: null');
  });
});

describe('subscribe — the compile refusals, each with its docPath', () => {
  it('JC0018 — policy.task must be switch', () => {
    for (const task of ['exhaust', 'concat', 'parallel']) {
      refuses(one({ ...LIVE, policy: { task } }), 'JC0018', '/operations/a/policy/task', /replaced, never queued/);
    }
    assert.doesNotThrow(() => compileContract(one({ ...LIVE, policy: { task: 'switch' } })));
  });

  it('JC0019 — the binding must be GET', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      refuses(one({ ...LIVE, http: { method, path: '/live' } }), 'JC0019', '/operations/a/http/method', /fetched, not sent/);
    }
  });

  it('JC0020 — policy.idempotency must be none', () => {
    for (const idempotency of ['optional', 'required']) {
      refuses(one({ ...LIVE, policy: { idempotency } }), 'JC0020', '/operations/a/policy/idempotency');
    }
    assert.doesNotThrow(() => compileContract(one({ ...LIVE, policy: { idempotency: 'none' } })));
  });

  it('JC0012 — a declared conflicting media is refused, never silently overridden', () => {
    refuses(one({ ...LIVE, http: { method: 'GET', path: '/live', media: 'application/json' } }),
      'JC0012', '/operations/a/http/media', /text\/event-stream/);
    assert.doesNotThrow(() => compileContract(one({ ...LIVE, http: { method: 'GET', path: '/live', media: 'text/event-stream' } })));
  });

  it('JC0014 — policy.stream on a read or command, and mistyped stream members', () => {
    refuses(one({ kind: 'read', output: true, policy: { stream: {} } }), 'JC0014', '/operations/a/policy/stream', /subscribe operations only/);
    refuses(one({ kind: 'command', output: true, policy: { stream: { resume: 'snapshot' } } }), 'JC0014', '/operations/a/policy/stream');
    refuses(one({ ...LIVE, policy: { stream: { resume: 'rewind' } } }), 'JC0014', '/operations/a/policy/stream/resume');
    refuses(one({ ...LIVE, policy: { stream: { heartbeatMs: 500 } } }), 'JC0014', '/operations/a/policy/stream/heartbeatMs');
    refuses(one({ ...LIVE, policy: { stream: { heartbeatMs: 1.5 } } }), 'JC0014', '/operations/a/policy/stream/heartbeatMs');
    refuses(one({ ...LIVE, policy: { stream: { maxPatchBytes: 0 } } }), 'JC0014', '/operations/a/policy/stream/maxPatchBytes');
    refuses(one({ ...LIVE, policy: { stream: 5 } }), 'JC0014', '/operations/a/policy/stream');
  });

  it('JC0013 — an unknown stream member is refused (the closed vocabulary)', () => {
    refuses(one({ ...LIVE, policy: { stream: { pace: 5 } } }), 'JC0013', '/operations/a/policy/stream/pace');
  });

  it('JC0016 — a body-located member on the forced GET stays refused', () => {
    refuses(one({ ...LIVE, http: { method: 'GET', path: '/live', in: { collection: 'body' } } }),
      'JC0016', '/operations/a/http/in/collection');
  });
});
