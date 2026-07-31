//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileFsm, createFsmSession, FlowCompileError, FlowRuntimeError } from '@jarenjs/flow';
import { transformJson } from '@jarenjs/json/jslt';
import { parseMermaid } from '@jarenjs/mermaid';

/** The README loader machine — guards, entry effects, a final state. */
function loaderDoc() {
  return {
    $fsm: '0.1',
    initial: 'idle',
    states: [
      'idle',
      { id: 'loading', entry: [{ run: 'fetch', with: { url: '$.context.url' } }] },
      { id: 'done', final: true },
    ],
    transitions: [
      { from: 'idle', event: 'start', to: 'loading' },
      { from: 'loading', event: 'ok', guard: '$.payload.fresh', to: 'done' },
      { from: 'loading', event: 'fail', to: 'idle' },
    ],
  };
}

/** Deep-freeze a JSON value in place (test aid for the purity contract). */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** assert.throws matcher for one JF code + docPath. */
function flowError(Type, code, docPath) {
  return (err) => {
    assert.ok(err instanceof Type, `expected ${Type.name}, got ${err?.constructor?.name}`);
    assert.strictEqual(err.code, code);
    if (docPath !== undefined) assert.strictEqual(err.docPath, docPath);
    return true;
  };
}

describe('compileFsm — document validation (JF0xxx)', function () {
  it('JF0001 — non-object documents and unknown versions', function () {
    assert.throws(() => compileFsm(null), flowError(FlowCompileError, 'JF0001', ''));
    assert.throws(() => compileFsm([]), flowError(FlowCompileError, 'JF0001', ''));
    assert.throws(() => compileFsm({ $fsm: '0.2', initial: null, states: [], transitions: [] }),
      flowError(FlowCompileError, 'JF0001', '/$fsm'));
  });

  it('JF0002 — malformed states', function () {
    assert.throws(() => compileFsm({ initial: null, states: {}, transitions: [] }),
      flowError(FlowCompileError, 'JF0002', '/states'));
    assert.throws(() => compileFsm({ initial: null, states: [42], transitions: [] }),
      flowError(FlowCompileError, 'JF0002', '/states/0'));
    assert.throws(() => compileFsm({ initial: null, states: [{}], transitions: [] }),
      flowError(FlowCompileError, 'JF0002', '/states/0'));
    assert.throws(() => compileFsm({ initial: null, states: [{ id: 'a', final: 'yes' }], transitions: [] }),
      flowError(FlowCompileError, 'JF0002', '/states/0/final'));
  });

  it('JF0003 — duplicate state ids (string and object forms collide)', function () {
    assert.throws(() => compileFsm({ initial: null, states: ['a', { id: 'a' }], transitions: [] }),
      flowError(FlowCompileError, 'JF0003', '/states/1'));
  });

  it('JF0004 — initial must be null or a declared state', function () {
    assert.throws(() => compileFsm({ initial: 5, states: ['a'], transitions: [] }),
      flowError(FlowCompileError, 'JF0004', '/initial'));
    assert.throws(() => compileFsm({ initial: 'zz', states: ['a'], transitions: [] }),
      flowError(FlowCompileError, 'JF0004', '/initial'));
  });

  it('JF0005 — malformed transitions', function () {
    assert.throws(() => compileFsm({ initial: null, states: ['a'], transitions: {} }),
      flowError(FlowCompileError, 'JF0005', '/transitions'));
    assert.throws(() => compileFsm({ initial: null, states: ['a'], transitions: [42] }),
      flowError(FlowCompileError, 'JF0005', '/transitions/0'));
    assert.throws(() => compileFsm({ initial: null, states: ['a'], transitions: [{ to: 'a' }] }),
      flowError(FlowCompileError, 'JF0005', '/transitions/0/from'));
    assert.throws(() => compileFsm({ initial: null, states: ['a'], transitions: [{ from: 'a' }] }),
      flowError(FlowCompileError, 'JF0005', '/transitions/0/to'));
    assert.throws(() => compileFsm({ initial: null, states: ['a'], transitions: [{ from: 'a', to: 'a', event: 42 }] }),
      flowError(FlowCompileError, 'JF0005', '/transitions/0/event'));
  });

  it('JF0006 — transitions must reference declared states', function () {
    assert.throws(() => compileFsm({ initial: null, states: ['a'], transitions: [{ from: 'zz', to: 'a' }] }),
      flowError(FlowCompileError, 'JF0006', '/transitions/0/from'));
    assert.throws(() => compileFsm({ initial: null, states: ['a'], transitions: [{ from: 'a', to: 'zz' }] }),
      flowError(FlowCompileError, 'JF0006', '/transitions/0/to'));
  });

  it('JF0007 — a guard that cannot compile is a compile error, with cause', function () {
    assert.throws(
      () => compileFsm({ initial: null, states: ['a'], transitions: [{ from: 'a', to: 'a', guard: { $bogus: [1] } }] }),
      (err) => {
        flowError(FlowCompileError, 'JF0007', '/transitions/0/guard')(err);
        assert.ok(err.cause instanceof Error, 'the query compile error travels as cause');
        return true;
      });
  });

  it('JF0008 — malformed effects lists and descriptors', function () {
    assert.throws(() => compileFsm({ initial: null, states: [{ id: 'a', entry: {} }], transitions: [] }),
      flowError(FlowCompileError, 'JF0008', '/states/0/entry'));
    assert.throws(() => compileFsm({ initial: null, states: [{ id: 'a', entry: [42] }], transitions: [] }),
      flowError(FlowCompileError, 'JF0008', '/states/0/entry/0'));
    assert.throws(
      () => compileFsm({ initial: null, states: ['a'], transitions: [{ from: 'a', to: 'a', effects: [{ run: '' }] }] }),
      flowError(FlowCompileError, 'JF0008', '/transitions/0/effects/0'));
  });

  it('JF0009 — an effect "with" that cannot compile, with cause', function () {
    assert.throws(
      () => compileFsm({
        initial: null, states: ['a'],
        transitions: [{ from: 'a', to: 'a', effects: [{ run: 'x', with: { $bogus: [1] } }] }],
      }),
      (err) => {
        flowError(FlowCompileError, 'JF0009', '/transitions/0/effects/0/with')(err);
        assert.ok(err.cause instanceof Error);
        return true;
      });
  });
});

describe('step — the pure core', function () {
  it('drives the README machine through its happy path', function () {
    const fsm = compileFsm(loaderDoc());
    assert.strictEqual(fsm.initial, 'idle');
    assert.deepStrictEqual([...fsm.states], ['idle', 'loading', 'done']);

    const started = fsm.step('idle', 'start', { context: { url: '/api' } });
    assert.strictEqual(started.changed, true);
    assert.strictEqual(started.state, 'loading');
    assert.deepStrictEqual(started.effects, [{ run: 'fetch', with: { url: '/api' } }]);
    assert.strictEqual(started.final, false);
    assert.deepStrictEqual(started.errors, []);

    const done = fsm.step('loading', 'ok', { payload: { fresh: true } });
    assert.deepStrictEqual(done, { changed: true, state: 'done', effects: [], final: true, errors: [] });
  });

  it('ignores an event no transition answers (changed: false, no error)', function () {
    const fsm = compileFsm(loaderDoc());
    assert.deepStrictEqual(fsm.step('idle', 'ok'),
      { changed: false, state: 'idle', effects: [], final: false, errors: [] });
  });

  it('throws JF2001/JF2002 only for caller mistakes', function () {
    const fsm = compileFsm(loaderDoc());
    assert.throws(() => fsm.step('zz', 'start'), flowError(FlowRuntimeError, 'JF2001'));
    assert.throws(() => fsm.step('idle', /** @type {any} */ (5)), flowError(FlowRuntimeError, 'JF2002'));
    assert.throws(() => fsm.events('zz'), flowError(FlowRuntimeError, 'JF2001'));
    assert.throws(() => fsm.final('zz'), flowError(FlowRuntimeError, 'JF2001'));
  });

  it('is pure: frozen documents compile, repeated steps agree, input is never mutated', function () {
    const doc = loaderDoc();
    const snapshot = JSON.stringify(doc);
    const fsm = compileFsm(deepFreeze(doc));
    const a = fsm.step('loading', 'ok', { payload: { fresh: true } });
    const b = fsm.step('loading', 'ok', { payload: { fresh: true } });
    assert.deepStrictEqual(a, b);
    assert.notStrictEqual(a, b, 'each step returns a fresh result object');
    assert.strictEqual(JSON.stringify(doc), snapshot, 'the compiled document is read, never written');
  });

  it('exposes per-state introspection: events() and final()', function () {
    const fsm = compileFsm(loaderDoc());
    assert.deepStrictEqual([...fsm.events('loading')], ['ok', 'fail']);
    assert.deepStrictEqual([...fsm.events('done')], []);
    assert.strictEqual(fsm.final('done'), true);
    assert.strictEqual(fsm.final('idle'), false);
  });
});

describe('guards — EBV semantics, fail closed', function () {
  /** One-transition machine with the given guard. */
  function guarded(guard) {
    return compileFsm({
      initial: 'a', states: ['a', 'b'],
      transitions: [{ from: 'a', event: 'go', guard, to: 'b' }],
    });
  }

  it('asserts by effective boolean value', function () {
    assert.strictEqual(guarded('$.payload.fresh').step('a', 'go', { payload: { fresh: true } }).changed, true);
    assert.strictEqual(guarded('$.payload.fresh').step('a', 'go', { payload: { fresh: false } }).changed, false);
    assert.strictEqual(guarded('$.payload.missing').step('a', 'go', { payload: {} }).changed, false,
      'an empty sequence is false');
    assert.strictEqual(guarded('$.payload.n').step('a', 'go', { payload: { n: 0 } }).changed, false, 'zero is false');
    assert.strictEqual(guarded('$.payload.s').step('a', 'go', { payload: { s: '' } }).changed, false,
      'the empty string is false');
    assert.strictEqual(guarded('$.context.items').step('a', 'go', { context: { items: [1, 2] } }).changed, true,
      'an array ITEM is true (D3)');
    assert.strictEqual(guarded({ $gt: ['$.context.count', 3] }).step('a', 'go', { context: { count: 4 } }).changed, true);
  });

  it('a plain non-$ string guard is a literal and therefore vacuously true', function () {
    const result = guarded('count > 3').step('a', 'go');
    assert.strictEqual(result.changed, true,
      'projection-produced display guards must not change execution');
  });

  it('a guard that throws reads false and is recorded (JF2003), selection continues', function () {
    // an unbound external reference throws JQ2006 at evaluation time
    const fsm = compileFsm({
      initial: 'a', states: ['a', 'b', 'c'],
      transitions: [
        { from: 'a', event: 'go', guard: { $eq: ['$mystery', 1] }, to: 'b' },
        { from: 'a', event: 'go', to: 'c' },
      ],
    });
    const result = fsm.step('a', 'go');
    assert.strictEqual(result.state, 'c', 'fail closed: the throwing guard did not fire; the fallback did');
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].code, 'JF2003');
    assert.strictEqual(result.errors[0].docPath, '/transitions/0/guard');
  });

  it('a multi-item guard result has no EBV: false, recorded', function () {
    const result = guarded('$.context.items[*]').step('a', 'go', { context: { items: [1, 2] } });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.errors[0].code, 'JF2003');
  });
});

describe('selection — document order is the priority scheme', function () {
  it('a null event is a wildcard: any name matches, nothing fires spontaneously', function () {
    const fsm = compileFsm({
      initial: 'a', states: ['a', 'b', 'c'],
      transitions: [
        { from: 'a', event: 'go', guard: '$.payload.ok', to: 'b' },
        { from: 'a', event: null, to: 'c' },
      ],
    });
    assert.strictEqual(fsm.step('a', 'go', { payload: { ok: true } }).state, 'b');
    assert.strictEqual(fsm.step('a', 'go', { payload: { ok: false } }).state, 'c',
      'the guarded match falls through to the wildcard fallback');
    assert.strictEqual(fsm.step('a', 'anything').state, 'c');
  });

  it('a wildcard listed first shadows a named match listed later', function () {
    const fsm = compileFsm({
      initial: 'a', states: ['a', 'b', 'c'],
      transitions: [
        { from: 'a', event: null, to: 'c' },
        { from: 'a', event: 'go', to: 'b' },
      ],
    });
    assert.strictEqual(fsm.step('a', 'go').state, 'c', 'document order, no specificity ranking');
  });
});

describe('effects — resolved descriptors in exit → transition → entry order', function () {
  const doc = {
    initial: 'a',
    states: [
      { id: 'a', exit: [{ run: 'exitA', with: { from: '$.state' } }] },
      { id: 'b', entry: [{ run: 'enterB', with: { ev: '$.event' } }] },
    ],
    transitions: [
      { from: 'a', event: 'go', to: 'b', effects: [{ run: 'during', with: { p: '$.payload' } }] },
      { from: 'a', event: 'self', to: 'a', effects: [{ run: 'during' }] },
      { from: 'a', event: 'quiet', to: 'b', effects: [{ run: 'silent', with: '$.payload.missing' }] },
      { from: 'a', event: 'boom', to: 'b', effects: [{ run: 'kaput', with: { $add: ['$mystery', 1] } }] },
    ],
  };

  it('orders and resolves against the scope', function () {
    const result = compileFsm(doc).step('a', 'go', { payload: 42 });
    assert.deepStrictEqual(result.effects, [
      { run: 'exitA', with: { from: 'a' } },
      { run: 'during', with: { p: 42 } },
      { run: 'enterB', with: { ev: 'go' } },
    ]);
  });

  it('a self-transition runs neither exit nor entry', function () {
    const result = compileFsm(doc).step('a', 'self');
    assert.deepStrictEqual(result, {
      changed: true, state: 'a', effects: [{ run: 'during' }], final: false, errors: [],
    });
  });

  it('an empty "with" result omits the member', function () {
    const result = compileFsm(doc).step('a', 'quiet', { payload: {} });
    assert.deepStrictEqual(result.effects.find((e) => e.run === 'silent'), { run: 'silent' });
  });

  it('a throwing "with" omits the effect and records JF2004; the step completes', function () {
    const result = compileFsm(doc).step('a', 'boom');
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.effects.some((e) => e.run === 'kaput'), false, 'the effect was omitted');
    assert.deepStrictEqual(result.effects.map((e) => e.run), ['exitA', 'enterB'],
      'siblings still resolved');
    const record = result.errors.find((e) => e.code === 'JF2004');
    assert.ok(record);
    assert.strictEqual(record.docPath, '/transitions/3/effects/0/with');
  });
});

describe('createFsmSession — the thin mutable wrapper', function () {
  it('starts at initial, advances, answers can() as a dry run, reports done', function () {
    const fsm = compileFsm(loaderDoc());
    const s = createFsmSession(fsm);
    assert.strictEqual(s.state, 'idle');
    assert.strictEqual(s.can('start'), true);
    assert.strictEqual(s.can('ok'), false);
    assert.strictEqual(s.state, 'idle', 'can() changed nothing');
    s.send('start', { context: { url: '/api' } });
    assert.strictEqual(s.state, 'loading');
    s.send('ok', { payload: { fresh: true } });
    assert.strictEqual(s.state, 'done');
    assert.strictEqual(s.done, true);
  });

  it('JF2005 without any start state; JF2001 for an undeclared one; explicit start wins', function () {
    const fsm = compileFsm({ initial: null, states: ['a'], transitions: [] });
    assert.throws(() => createFsmSession(fsm), flowError(FlowRuntimeError, 'JF2005'));
    assert.throws(() => createFsmSession(fsm, 'zz'), flowError(FlowRuntimeError, 'JF2001'));
    assert.strictEqual(createFsmSession(fsm, 'a').state, 'a');
  });
});

describe('the mermaid projection is executable input (the superset contract)', function () {
  it('parseMermaid → state-to-workflow JSLT → compileFsm, unchanged', function () {
    const stylesheet = JSON.parse(readFileSync(
      new URL('../../components/mermaid/stylesheets/state-to-workflow.jslt.json', import.meta.url),
      'utf8'));
    const source = [
      'stateDiagram-v2',
      '  [*] --> draft',
      '  draft --> review : submit',
      '  review --> published : approve',
      '  review --> draft : reject',
      '  published --> [*]',
    ].join('\n');

    const workflow = transformJson(stylesheet, parseMermaid(source));
    assert.strictEqual(workflow.initial, 'draft');

    const fsm = compileFsm(workflow);
    const s = createFsmSession(fsm);
    assert.strictEqual(s.state, 'draft');
    assert.strictEqual(s.send('approve').changed, false, 'unhandled events are ignored');
    s.send('submit');
    assert.strictEqual(s.state, 'review');
    s.send('reject');
    assert.strictEqual(s.state, 'draft');
    s.send('submit');
    s.send('approve');
    assert.strictEqual(s.state, 'published');
    assert.deepStrictEqual([...fsm.events('review')], ['approve', 'reject']);
  });
});
