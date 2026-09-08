//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileDag, FlowCompileError, FlowRuntimeError } from '@jarenjs/flow';
import { createApp, createTaskEffect } from '@jarenjs/app';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();
const MINIMAL_VIEW = [{ match: '$', body: ['main', {}] }];

/** A test-controlled promise. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve: /** @type {any} */ (resolve), reject: /** @type {any} */ (reject) };
}

const flush = () => new Promise((res) => setImmediate(res));

/** assert.throws matcher for one JF code + docPath. */
function flowError(Type, code, docPath) {
  return (err) => {
    assert.ok(err instanceof Type, `expected ${Type.name}, got ${err?.constructor?.name}`);
    assert.strictEqual(err.code, code);
    if (docPath !== undefined) assert.strictEqual(err.docPath, docPath);
    return true;
  };
}

describe('compileDag — document validation (JF0xxx)', function () {
  const out = { kind: 'output' };

  it('JF0010 — non-object documents and missing/unknown versions', function () {
    assert.throws(() => compileDag(null), flowError(FlowCompileError, 'JF0010', ''));
    assert.throws(() => compileDag({ nodes: {}, edges: [] }),
      flowError(FlowCompileError, 'JF0010', '/$dag'));
    assert.throws(() => compileDag({ $dag: '0.2', nodes: {}, edges: [] }),
      flowError(FlowCompileError, 'JF0010', '/$dag'));
  });

  it('JF0011 — malformed nodes and kinds', function () {
    assert.throws(() => compileDag({ $dag: '0.1', nodes: [], edges: [] }),
      flowError(FlowCompileError, 'JF0011', '/nodes'));
    assert.throws(() => compileDag({ $dag: '0.1', nodes: { x: 42, o: out }, edges: [] }),
      flowError(FlowCompileError, 'JF0011', '/nodes/x'));
    assert.throws(() => compileDag({ $dag: '0.1', nodes: { x: { kind: 'mystery' }, o: out }, edges: [] }),
      flowError(FlowCompileError, 'JF0011', '/nodes/x/kind'));
    assert.throws(() => compileDag({ $dag: '0.1', nodes: { x: { kind: 'const' }, o: out }, edges: [] }),
      flowError(FlowCompileError, 'JF0011', '/nodes/x'));
    assert.throws(() => compileDag({ $dag: '0.1', nodes: { x: { kind: 'query' }, o: out }, edges: [] }),
      flowError(FlowCompileError, 'JF0011', '/nodes/x'));
    assert.throws(() => compileDag({ $dag: '0.1', nodes: { x: { kind: 'task', run: '' }, o: out }, edges: [] }),
      flowError(FlowCompileError, 'JF0011', '/nodes/x/run'));
  });

  it('JF0012/JF0013 — malformed edges and unknown endpoints', function () {
    const base = { $dag: '0.1', nodes: { i: { kind: 'input' }, o: out } };
    assert.throws(() => compileDag({ ...base, edges: {} }),
      flowError(FlowCompileError, 'JF0012', '/edges'));
    assert.throws(() => compileDag({ ...base, edges: [42] }),
      flowError(FlowCompileError, 'JF0012', '/edges/0'));
    assert.throws(() => compileDag({ ...base, edges: [{ to: 'o' }] }),
      flowError(FlowCompileError, 'JF0012', '/edges/0/from'));
    assert.throws(() => compileDag({ ...base, edges: [{ from: 'i', to: 'o', port: '' }] }),
      flowError(FlowCompileError, 'JF0012', '/edges/0/port'));
    assert.throws(() => compileDag({ ...base, edges: [{ from: 'zz', to: 'o' }] }),
      flowError(FlowCompileError, 'JF0013', '/edges/0/from'));
    assert.throws(() => compileDag({ ...base, edges: [{ from: 'i', to: 'zz' }] }),
      flowError(FlowCompileError, 'JF0013', '/edges/0/to'));
  });

  it('JF0014 — embedded documents that cannot compile, with cause', function () {
    assert.throws(
      () => compileDag({ $dag: '0.1', nodes: { q: { kind: 'query', query: { $bogus: [1] } }, o: out }, edges: [{ from: 'q', to: 'o' }] }),
      (err) => {
        flowError(FlowCompileError, 'JF0014', '/nodes/q/query')(err);
        assert.ok(err.cause instanceof Error);
        return true;
      });
    assert.throws(
      () => compileDag({ $dag: '0.1', nodes: { j: { kind: 'jslt', stylesheet: [{ match: 5, body: '$' }] }, o: out }, edges: [{ from: 'j', to: 'o' }] }),
      flowError(FlowCompileError, 'JF0014', '/nodes/j/stylesheet'));
    assert.throws(
      () => compileDag({
        $dag: '0.1',
        nodes: { t: { kind: 'task', run: 'x', with: { $bogus: [1] } }, o: out },
        edges: [{ from: 't', to: 'o' }],
      }, { tasks: { x: async () => null } }),
      flowError(FlowCompileError, 'JF0014', '/nodes/t/with'));
    assert.throws(
      () => compileDag({
        $dag: '0.1', nodes: { i: { kind: 'input' }, o: out },
        edges: [{ from: 'i', to: 'o', select: { $bogus: [1] } }],
      }),
      flowError(FlowCompileError, 'JF0014', '/edges/0/select'));
  });

  it('JF0015 — wiring rules', function () {
    assert.throws(() => compileDag({
      $dag: '0.1', nodes: { i: { kind: 'input' }, c: { kind: 'const', value: 1 }, o: out },
      edges: [{ from: 'c', to: 'i' }, { from: 'i', to: 'o' }],
    }), flowError(FlowCompileError, 'JF0015', '/edges/0/to'));
    assert.throws(() => compileDag({
      $dag: '0.1', nodes: { i: { kind: 'input' }, q: { kind: 'query', query: '$' }, o: out },
      edges: [{ from: 'i', to: 'o' }, { from: 'o', to: 'q' }],
    }), flowError(FlowCompileError, 'JF0015', '/edges/1/from'));
    assert.throws(() => compileDag({
      $dag: '0.1', nodes: { q: { kind: 'query', query: '$' }, i: { kind: 'input' }, o: out },
      edges: [{ from: 'i', to: 'o' }],
    }), flowError(FlowCompileError, 'JF0015', '/nodes/q'));
    assert.throws(() => compileDag({
      $dag: '0.1', nodes: { a: { kind: 'input' }, b: { kind: 'input' }, o: out },
      edges: [{ from: 'a', to: 'o' }, { from: 'b', to: 'o' }],
    }), flowError(FlowCompileError, 'JF0015', '/edges/0'),
    'unported fan-in reports the first inbound edge');
    assert.throws(() => compileDag({
      $dag: '0.1', nodes: { a: { kind: 'input' }, b: { kind: 'input' }, o: out },
      edges: [{ from: 'a', to: 'o', port: 'x' }, { from: 'b', to: 'o' }],
    }), flowError(FlowCompileError, 'JF0015', '/edges/1'), 'mixed ports');
    assert.throws(() => compileDag({
      $dag: '0.1', nodes: { a: { kind: 'input' }, b: { kind: 'input' }, o: out },
      edges: [{ from: 'a', to: 'o', port: 'x' }, { from: 'b', to: 'o', port: 'x' }],
    }), flowError(FlowCompileError, 'JF0015', '/edges/1/port'), 'duplicate port');
  });

  it('JF0016 — cycles fail at compile, naming only the cyclic core', function () {
    assert.throws(() => compileDag({
      $dag: '0.1',
      nodes: {
        q1: { kind: 'query', query: '$' },
        q2: { kind: 'query', query: '$' },
        o: out,
      },
      edges: [
        { from: 'q1', to: 'o' },
        { from: 'q1', to: 'q2' },
        { from: 'q2', to: 'q1' },
      ],
    }), (err) => {
      flowError(FlowCompileError, 'JF0016', '/edges/1')(err);
      assert.match(err.message, /q1, q2/);
      assert.doesNotMatch(err.message, /\bo\b/, 'the downstream output is not accused');
      return true;
    });
  });

  it('JF0017 — exactly one output', function () {
    assert.throws(() => compileDag({ $dag: '0.1', nodes: { i: { kind: 'input' } }, edges: [] }),
      flowError(FlowCompileError, 'JF0017', '/nodes'));
    assert.throws(() => compileDag({
      $dag: '0.1', nodes: { i: { kind: 'input' }, o1: out, o2: out },
      edges: [{ from: 'i', to: 'o1' }, { from: 'i', to: 'o2' }],
    }), flowError(FlowCompileError, 'JF0017', '/nodes'));
  });

  it('JF0018 — a task without a registered handler; TypeErrors for registry/option misuse', function () {
    const doc = {
      $dag: '0.1', nodes: { t: { kind: 'task', run: 'nope' }, i: { kind: 'input' }, o: out },
      edges: [{ from: 'i', to: 't' }, { from: 't', to: 'o' }],
    };
    assert.throws(() => compileDag(doc), flowError(FlowCompileError, 'JF0018', '/nodes/t/run'));
    assert.throws(() => compileDag(doc, { tasks: /** @type {any} */ ([]) }), TypeError);
    assert.throws(() => compileDag(doc, { tasks: { nope: /** @type {any} */ (42) } }), TypeError);
    const good = compileDag(doc, { tasks: { nope: async () => null } });
    assert.throws(() => good.run(null, { signal: /** @type {any} */ (42) }), TypeError);
    assert.throws(() => good.run(null, { onNode: /** @type {any} */ (42) }), TypeError);
  });
});

describe('compileDag — THE PROGRAM THESIS', function () {
  it('a dag wires rows through a query and a JSLT stylesheet to an exact vnode, with zero view imports', async function () {
    const doc = {
      $dag: '0.1',
      nodes: {
        rows: { kind: 'input' },
        adults: {
          kind: 'query',
          query: { $for: { r: '$[*]' }, $where: { $ge: ['$r.age', 18] }, $return: '$r' },
        },
        view: {
          kind: 'jslt',
          stylesheet: [{
            match: '$',
            body: ['ul', {}, [{ $for: { p: '$[*]' }, $return: ['li', {}, '$p.name'] }]],
          }],
        },
        out: { kind: 'output' },
      },
      edges: [
        { from: 'rows', to: 'adults' },
        { from: 'adults', to: 'view' },
        { from: 'view', to: 'out' },
      ],
    };
    const dag = compileDag(doc);
    assert.deepStrictEqual([...dag.nodes], ['rows', 'adults', 'view', 'out']);
    assert.strictEqual(dag.output, 'out');

    const result = await dag.run([
      { name: 'ada', age: 36 }, { name: 'kid', age: 8 }, { name: 'lin', age: 64 },
    ]);
    assert.deepStrictEqual(result,
      ['ul', {}, [['li', {}, 'ada'], ['li', {}, 'lin']]],
      'the exact vnode JSON, engine to engine, no rendering package anywhere');

    const manifest = JSON.parse(readFileSync(
      new URL('../../packages/flow/package.json', import.meta.url), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.dependencies).sort(),
      ['@jarenjs/core', '@jarenjs/json'],
      'the composition is data-only: flow depends on the json engines '
      + 'and the core primitives (the coded-error base), nothing else');
  });
});

describe('compileDag — the run', function () {
  it('preserves every named port as an own member on repeated runs', async function () {
    const ports = ['__proto__', 'constructor', 'toString'];
    const dag = compileDag({
      $dag: '0.1',
      nodes: { i: { kind: 'input' }, o: { kind: 'output' } },
      edges: ports.map((port) => ({ from: 'i', to: 'o', port })),
    });
    for (const value of [{ n: 1 }, { n: 2 }]) {
      const result = await dag.run(value);
      assert.deepStrictEqual(Object.keys(result), ports);
      assert.strictEqual(Object.getPrototypeOf(result), Object.prototype);
      for (const port of ports) {
        assert.strictEqual(Object.hasOwn(result, port), true);
        assert.strictEqual(result[port], value);
      }
    }
  });

  it('fan-in: completion order cannot change the value or the port member order', async function () {
    const doc = {
      $dag: '0.1',
      nodes: {
        seed: { kind: 'input' },
        ta: { kind: 'task', run: 'ta' },
        tb: { kind: 'task', run: 'tb' },
        merged: { kind: 'query', query: { a: '$.pa', b: '$.pb' } },
        o: { kind: 'output' },
      },
      edges: [
        { from: 'seed', to: 'ta' },
        { from: 'seed', to: 'tb' },
        { from: 'ta', to: 'merged', port: 'pa' },
        { from: 'tb', to: 'merged', port: 'pb' },
        { from: 'merged', to: 'o' },
      ],
    };
    /** @param {'ab'|'ba'} order */
    async function runWithCompletionOrder(order) {
      const da = deferred();
      const db = deferred();
      const dag = compileDag(doc, { tasks: { ta: () => da.promise, tb: () => db.promise } });
      const run = dag.run(null);
      if (order === 'ab') { da.resolve('A'); await flush(); db.resolve('B'); }
      else { db.resolve('B'); await flush(); da.resolve('A'); }
      return run;
    }
    const first = await runWithCompletionOrder('ab');
    const second = await runWithCompletionOrder('ba');
    assert.deepStrictEqual(first, second);
    assert.strictEqual(JSON.stringify(first), JSON.stringify(second),
      'port members assemble in edge document order, not completion order');
    assert.deepStrictEqual(first, { a: 'A', b: 'B' });
  });

  it('select reshapes per delivery; an empty select delivers null', async function () {
    const doc = {
      $dag: '0.1',
      nodes: {
        i: { kind: 'input' },
        q: { kind: 'query', query: { picked: '$.p', missing: { $eq: ['$.m', null] } } },
        o: { kind: 'output' },
      },
      edges: [
        { from: 'i', to: 'q', port: 'p', select: '$.value' },
        { from: 'i', to: 'q', port: 'm', select: '$.absent' },
        { from: 'q', to: 'o' },
      ],
    };
    const result = await compileDag(doc).run({ value: 41 });
    assert.deepStrictEqual(result, { picked: 41, missing: true });
  });

  it('const/input/output plumbing: absent input reads null, const passes by reference', async function () {
    const value = { frozen: true };
    const doc = {
      $dag: '0.1',
      nodes: { c: { kind: 'const', value }, o: { kind: 'output' } },
      edges: [{ from: 'c', to: 'o' }],
    };
    const result = await compileDag(doc).run();
    assert.strictEqual(result, value, 'values pass by reference');

    const echo = {
      $dag: '0.1',
      nodes: { i: { kind: 'input' }, o: { kind: 'output' } },
      edges: [{ from: 'i', to: 'o' }],
    };
    assert.strictEqual(await compileDag(echo).run(), null, 'undefined input reads as null');
  });

  it('two input nodes both yield the run input', async function () {
    const doc = {
      $dag: '0.1',
      nodes: {
        i1: { kind: 'input' }, i2: { kind: 'input' },
        pair: { kind: 'query', query: { $eq: ['$.a', '$.b'] } },
        o: { kind: 'output' },
      },
      edges: [
        { from: 'i1', to: 'pair', port: 'a' },
        { from: 'i2', to: 'pair', port: 'b' },
        { from: 'pair', to: 'o' },
      ],
    };
    assert.strictEqual(await compileDag(doc).run({ x: 1 }), true);
  });

  it('a task receives { with, input } and the shared signal; undefined resolves to null', async function () {
    /** @type {any[]} */
    const seen = [];
    const doc = {
      $dag: '0.1',
      nodes: {
        i: { kind: 'input' },
        t: { kind: 'task', run: 'probe', with: { double: { $mul: ['$.n', 2] } } },
        o: { kind: 'output' },
      },
      edges: [{ from: 'i', to: 't' }, { from: 't', to: 'o' }],
    };
    const dag = compileDag(doc, {
      tasks: {
        probe: (props, signal) => {
          seen.push({ props, isSignal: typeof signal?.aborted === 'boolean' });
          return undefined;   // a sync, undefined-returning handler is legal
        },
      },
    });
    assert.strictEqual(await dag.run({ n: 21 }), null);
    assert.deepStrictEqual(seen, [{ props: { with: { double: 42 }, input: { n: 21 } }, isSignal: true }]);
  });

  it('onNode records every node exactly once on success; a throwing observer is isolated', async function () {
    const doc = {
      $dag: '0.1',
      nodes: {
        i: { kind: 'input' },
        q: { kind: 'query', query: '$' },
        o: { kind: 'output' },
      },
      edges: [{ from: 'i', to: 'q' }, { from: 'q', to: 'o' }],
    };
    /** @type {any[]} */
    const records = [];
    const result = await compileDag(doc).run(7, {
      onNode: (rec) => { records.push(rec); throw new Error('observer misbehaves'); },
    });
    assert.strictEqual(result, 7);
    assert.deepStrictEqual(records.map((r) => [r.id, r.status]).sort(),
      [['i', 'ok'], ['o', 'ok'], ['q', 'ok']]);
    for (const rec of records) assert.strictEqual(typeof rec.ms, 'number');
  });
});

describe('compileDag — failure and abort (§7.3)', function () {
  const fanDoc = {
    $dag: '0.1',
    nodes: {
      i: { kind: 'input' },
      boom: { kind: 'task', run: 'boom' },
      slow: { kind: 'task', run: 'slow' },
      join: { kind: 'query', query: { a: '$.a', b: '$.b' } },
      o: { kind: 'output' },
    },
    edges: [
      { from: 'i', to: 'boom' },
      { from: 'i', to: 'slow' },
      { from: 'boom', to: 'join', port: 'a' },
      { from: 'slow', to: 'join', port: 'b' },
      { from: 'join', to: 'o' },
    ],
  };

  it('first failure wins: JF2006 with nodeId/docPath/cause; the sibling sees the abort', async function () {
    const boom = deferred();
    let sawAbort = false;
    /** @type {any[]} */
    const records = [];
    const dag = compileDag(fanDoc, {
      tasks: {
        boom: () => boom.promise,
        slow: (_props, signal) => new Promise((_res, rej) => {
          signal.addEventListener('abort', () => { sawAbort = true; rej(new Error('cancelled')); });
        }),
      },
    });
    const run = dag.run(null, { onNode: (rec) => records.push(rec) });
    boom.reject(new Error('kaput'));
    await assert.rejects(run, (err) => {
      assert.ok(err instanceof FlowRuntimeError);
      assert.strictEqual(/** @type {any} */ (err).code, 'JF2006');
      assert.strictEqual(/** @type {any} */ (err).nodeId, 'boom');
      assert.strictEqual(/** @type {any} */ (err).docPath, '/nodes/boom');
      assert.strictEqual(/** @type {any} */ (err.cause).message, 'kaput');
      return true;
    });
    await flush();
    assert.strictEqual(sawAbort, true, 'the in-flight sibling observed signal.aborted');
    const byId = Object.fromEntries(records.map((r) => [r.id, r.status]));
    assert.strictEqual(byId.boom, 'error');
    assert.strictEqual(byId.slow, 'aborted');
    assert.strictEqual('join' in byId, false, 'a node whose inputs never arrived has no record');
  });

  it('the caller signal rejects the run with JF2007 and aborts in-flight tasks', async function () {
    let sawAbort = false;
    const dag = compileDag(fanDoc, {
      tasks: {
        boom: () => new Promise(() => {}),
        // a well-behaved handler honors an already-aborted signal too
        slow: (_props, signal) => new Promise((_res, rej) => {
          const cancel = () => { sawAbort = true; rej(new Error('cancelled')); };
          if (signal.aborted) cancel();
          else signal.addEventListener('abort', cancel);
        }),
      },
    });
    const controller = new AbortController();
    const run = dag.run(null, { signal: controller.signal });
    await flush();          // the tasks are now genuinely in flight
    controller.abort();
    await assert.rejects(run, flowError(FlowRuntimeError, 'JF2007'));
    assert.strictEqual(sawAbort, true);

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      dag.run(null, { signal: aborted.signal }),
      flowError(FlowRuntimeError, 'JF2007'),
      'a pre-aborted signal rejects before anything starts');
  });

  it('a failing select is attributed to its edge', async function () {
    const doc = {
      $dag: '0.1',
      nodes: { i: { kind: 'input' }, q: { kind: 'query', query: '$' }, o: { kind: 'output' } },
      edges: [
        { from: 'i', to: 'q', select: { $eq: ['$mystery', 1] } },
        { from: 'q', to: 'o' },
      ],
    };
    await assert.rejects(compileDag(doc).run(1), (err) => {
      assert.strictEqual(/** @type {any} */ (err).code, 'JF2006');
      assert.strictEqual(/** @type {any} */ (err).nodeId, 'q');
      assert.strictEqual(/** @type {any} */ (err).docPath, '/edges/0/select');
      return true;
    });
  });
});

describe('the dag-as-one-effect recipe (docs/APP-INTEGRATION.md)', function () {
  it('runs a dag as a single app effect behind the id-guard convention', async function () {
    const enrichDoc = {
      $dag: '0.1',
      nodes: {
        rows: { kind: 'input' },
        stamp: { kind: 'task', run: 'lookup' },
        o: { kind: 'output' },
      },
      edges: [{ from: 'rows', to: 'stamp' }, { from: 'stamp', to: 'o' }],
    };
    const dag = compileDag(enrichDoc, {
      tasks: {
        lookup: async ({ input }) => input.map((r) => ({ ...r, region: 'eu' })),
      },
    });

    const app = createApp({
      state: { rows: [{ id: 1 }], tasks: { enrich: { id: 0, status: 'idle' } }, result: null },
      view: MINIMAL_VIEW,
      actions: {
        start: {
          patch: [
            { op: 'replace', path: '/tasks/enrich/id', value: { $add: ['$.tasks.enrich.id', 1] } },
            { op: 'replace', path: '/tasks/enrich/status', value: 'busy' },
          ],
          effects: [{
            run: 'enrich',
            with: { input: '$.rows', id: { $add: ['$.tasks.enrich.id', 1] }, done: 'done' },
          }],
        },
        done: {
          $if: [
            { $eq: ['$payload.id', '$.tasks.enrich.id'] },
            {
              patch: [
                { op: 'replace', path: '/result', value: '$payload.result' },
                { op: 'replace', path: '/tasks/enrich/status', value: 'idle' },
              ],
            },
          ],
        },
      },
    }, {
      schedule: sync,
      effects: { enrich: createTaskEffect((props, signal) => dag.run(props.input, { signal })) },
      onError: (err) => { throw err; },
    });

    app.dispatch('start');
    assert.strictEqual(app.getState().tasks.enrich.status, 'busy');
    await flush();
    assert.deepStrictEqual(app.getState().result, [{ id: 1, region: 'eu' }]);
    assert.strictEqual(app.getState().tasks.enrich.status, 'idle');
    app.destroy();
  });
});
