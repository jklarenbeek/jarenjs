//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileFsm, createFsmSession, fsmToApp, fsmStateSchema, FlowCompileError } from '@jarenjs/flow';
import { createApp } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { transformJson } from '@jarenjs/json/jslt';
import { parseMermaid } from '@jarenjs/mermaid';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();

const MINIMAL_VIEW = [{ match: '$', body: ['main', {}] }];

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const querySchema = load('../../packages/json/schemas/jaren-query.schema.json');

/** The README loader machine from the fsm suite. */
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

/** Every effect run name a machine document can schedule. */
function runNames(fsmDoc) {
  const names = new Set();
  for (const s of fsmDoc.states) {
    if (typeof s === 'object') {
      for (const e of s.entry ?? []) names.add(e.run);
      for (const e of s.exit ?? []) names.add(e.run);
    }
  }
  for (const t of fsmDoc.transitions) {
    for (const e of t.effects ?? []) names.add(e.run);
  }
  return [...names];
}

/**
 * Host a machine headlessly with capturing effect handlers.
 * @param {any} fsmDoc
 * @param {{ data?: object, extraActions?: object, validateState?: Function }} [opts]
 */
function host(fsmDoc, opts = {}) {
  const { slice, actions, events } = fsmToApp(fsmDoc);
  const captured = [];
  const errors = [];
  const records = [];
  /** @type {Record<string, Function>} */
  const effects = {};
  for (const name of runNames(fsmDoc)) {
    effects[name] = (props) => captured.push({ run: name, with: props });
  }
  const app = createApp({
    state: { ...(opts.data ?? {}), fsm: slice },
    view: MINIMAL_VIEW,
    actions: { ...actions, ...(opts.extraActions ?? {}) },
  }, {
    schedule: sync,
    effects,
    onError: (err) => errors.push(err),
    ...(opts.validateState !== undefined ? { validateState: opts.validateState } : {}),
  });
  app.observe((tx) => records.push(tx));
  return { app, captured, errors, records, events };
}

/**
 * The twin oracle: drive the headless engine and the generated-actions
 * app through the same script; after every event the control state and
 * the effect descriptor lists must agree (`with` normalized `?? null`
 * on both sides — the app hands handlers null for an absent member).
 * @param {any} fsmDoc
 * @param {Array<{ event: string, payload?: any }>} script
 * @param {object} [data] - the host's data state
 */
function oracle(fsmDoc, script, data) {
  const hosted = host(fsmDoc, { data });
  const session = createFsmSession(compileFsm(fsmDoc));
  for (const [i, step] of script.entries()) {
    const context = hosted.app.getState();
    const before = hosted.captured.length;
    hosted.app.dispatch(`fsm/${step.event}`, step.payload ?? null);
    const expected = session.send(step.event, { payload: step.payload ?? null, context });
    assert.deepStrictEqual(expected.errors, [], `step ${i}: clean corpus machines never record errors`);
    assert.strictEqual(hosted.app.getState().fsm.current, session.state,
      `step ${i} ('${step.event}'): control state agrees`);
    const appEffects = hosted.captured.slice(before);
    const flowEffects = expected.effects.map((e) => ({ run: e.run, with: e.with ?? null }));
    assert.deepStrictEqual(appEffects, flowEffects,
      `step ${i} ('${step.event}'): effect descriptors agree`);
  }
  assert.deepStrictEqual(hosted.errors, [], 'clean corpus scripts raise no app errors');
  return { hosted, session };
}

describe('fsmToApp — the twin oracle (headless engine ≡ generated actions)', function () {
  it('loader machine: guards on payload, entry effect reading context', function () {
    oracle(loaderDoc(), [
      { event: 'start' },
      { event: 'ok', payload: { fresh: false } },   // guard false → both no-op
      { event: 'ok', payload: { fresh: true } },
      { event: 'start' },                            // unhandled in done → both no-op
    ], { url: '/api' });
  });

  it('wildcard fallback: guarded named match falls through in document order', function () {
    const doc = {
      initial: 'a', states: ['a', 'b', 'c'],
      transitions: [
        { from: 'a', event: 'go', guard: '$.payload.ok', to: 'b' },
        { from: 'a', event: null, to: 'c' },
      ],
    };
    oracle(doc, [{ event: 'go', payload: { ok: true } }]);
    oracle(doc, [{ event: 'go', payload: { ok: false } }]);
  });

  it('a wildcard listed first shadows a named match listed later', function () {
    const doc = {
      initial: 'a', states: ['a', 'b', 'c'],
      transitions: [
        { from: 'a', event: null, to: 'c' },
        { from: 'a', event: 'go', to: 'b' },
      ],
    };
    oracle(doc, [{ event: 'go' }]);
  });

  it('effect ordering: exit → transition → entry, self-transitions skip both, empty with omits', function () {
    const doc = {
      initial: 'a',
      states: [
        { id: 'a', exit: [{ run: 'exitA', with: { from: '$.state' } }] },
        { id: 'b', entry: [{ run: 'enterB', with: { ev: '$.event' } }] },
      ],
      transitions: [
        { from: 'a', event: 'self', to: 'a', effects: [{ run: 'during' }] },
        { from: 'a', event: 'quiet', to: 'b', effects: [{ run: 'silent', with: '$.payload.missing' }] },
        { from: 'a', event: 'go', to: 'b', effects: [{ run: 'during', with: { p: '$.payload' } }] },
      ],
    };
    oracle(doc, [{ event: 'self' }, { event: 'go', payload: 42 }]);
    oracle(doc, [{ event: 'quiet', payload: {} }]);
  });

  it('$-leading state, event and run names survive as escaped literals', function () {
    const doc = {
      initial: '$start', states: ['$start', 'ok'],
      transitions: [{
        from: '$start', event: '$go', to: 'ok',
        effects: [{ run: '$note', with: { ev: '$.event', st: '$.state' } }],
      }],
    };
    const { hosted } = oracle(doc, [{ event: '$go' }]);
    assert.deepStrictEqual(hosted.captured, [
      { run: '$note', with: { ev: '$go', st: '$start' } },
    ]);
  });

  it('the mermaid projection drives an app unchanged', function () {
    const stylesheet = JSON.parse(readFileSync(
      new URL('../../components/mermaid/stylesheets/state-to-workflow.jslt.json', import.meta.url),
      'utf8'));
    const source = [
      'stateDiagram-v2',
      '  [*] --> draft',
      '  draft --> review : submit',
      '  review --> published : approve',
      '  review --> draft : reject',
    ].join('\n');
    const workflow = transformJson(stylesheet, parseMermaid(source));
    const { session } = oracle(workflow, [
      { event: 'submit' }, { event: 'reject' },
      { event: 'submit' }, { event: 'approve' },
    ]);
    assert.strictEqual(session.state, 'published');
  });
});

describe('fsmToApp — the documented guard-throw divergence', function () {
  it('hosted, a throwing guard fails the transaction (JA2002); headless it reads false and falls through', function () {
    const doc = {
      initial: 'a', states: ['a', 'b', 'c'],
      transitions: [
        { from: 'a', event: 'go', guard: { $eq: ['$mystery', 1] }, to: 'b' },
        { from: 'a', event: null, to: 'c' },
      ],
    };
    const headless = compileFsm(doc).step('a', 'go');
    assert.strictEqual(headless.state, 'c', 'headless: fail closed, the fallback fires');
    assert.strictEqual(headless.errors[0].code, 'JF2003');

    const hosted = host(doc);
    hosted.app.dispatch('fsm/go');
    assert.strictEqual(hosted.app.getState().fsm.current, 'a', 'hosted: no transition at all');
    assert.strictEqual(hosted.errors.length, 1);
    assert.strictEqual(/** @type {any} */ (hosted.errors[0]).code, 'JA2002');
    assert.strictEqual(hosted.records.at(-1)?.status, 'failed');
  });
});

describe('the worked example (docs/APP-INTEGRATION.md, run verbatim)', function () {
  const md = readFileSync(
    new URL('../../packages/flow/docs/APP-INTEGRATION.md', import.meta.url), 'utf8');
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)];
  assert.strictEqual(blocks.length, 1,
    'APP-INTEGRATION.md carries exactly one json block: the review machine');
  const reviewDoc = JSON.parse(blocks[0][1]);

  function reviewApp() {
    const { slice, actions } = fsmToApp(reviewDoc);
    const log = [];
    const errors = [];
    const records = [];
    const validate = new JarenValidator().compile({
      type: 'object',
      required: ['fsm'],
      properties: { fsm: fsmStateSchema(reviewDoc), reviewer: { type: 'string' } },
    });
    const app = createApp({
      state: { fsm: slice },
      view: [{ match: '$', body: ['main', {}] }],
      actions: {
        ...actions,
        assign: { patch: [{ op: 'add', path: '/reviewer', value: '$payload' }] },
        corrupt: { patch: [{ op: 'replace', path: '/fsm/current', value: 'nonsense' }] },
      },
    }, {
      schedule: sync,
      effects: { notify: (props) => log.push(props) },
      onError: (err) => errors.push(err),
      validateState: (s) => validate(s),
    });
    app.observe((tx) => records.push(tx));
    return { app, log, errors, records };
  }

  it('steps 1–4: submit, blocked approve, assign, approve', function () {
    const { app, log, errors, records } = reviewApp();

    app.dispatch('fsm/submit');
    assert.strictEqual(app.getState().fsm.current, 'in-review');
    assert.strictEqual(records[0].action, 'fsm/submit');
    assert.strictEqual(records[0].status, 'applied');
    assert.deepStrictEqual(records[0].changedPaths, ['/fsm/current']);
    assert.deepStrictEqual(log, [{ from: 'draft' }],
      'reviewer is omitted (the member does not exist yet); from is pre-transition');

    app.dispatch('fsm/approve');
    assert.strictEqual(records[1].status, 'noop', 'no reviewer → the guard blocks, no error');
    assert.strictEqual(app.getState().fsm.current, 'in-review');

    app.dispatch('assign', 'sam');
    assert.strictEqual(app.getState().reviewer, 'sam');

    app.dispatch('fsm/approve');
    assert.strictEqual(app.getState().fsm.current, 'approved');
    assert.strictEqual(records[3].status, 'applied');
    assert.deepStrictEqual(errors, []);
  });

  it('the reject path resolves payload into the transition effect', function () {
    const { app, log } = reviewApp();
    app.dispatch('fsm/submit');
    app.dispatch('fsm/reject', { reason: 'typos' });
    assert.strictEqual(app.getState().fsm.current, 'rejected');
    assert.deepStrictEqual(log.at(-1), { reason: 'typos' });
  });

  it('fsmStateSchema + validateState fail closed: a rogue action is rejected with JA2005', function () {
    const { app, errors, records } = reviewApp();
    app.dispatch('corrupt');
    assert.strictEqual(app.getState().fsm.current, 'draft', 'the transition was NOT applied');
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2005');
    assert.strictEqual(records[0].status, 'rejected');
  });

  it('an out-of-vocabulary name is the app\'s ordinary unknown action (JA2001)', function () {
    const { app, errors, records } = reviewApp();
    app.dispatch('fsm/bogus');
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2001');
    assert.strictEqual(records[0].status, 'failed');
  });
});

describe('fsmToApp — multiple machines in one app', function () {
  it('disjoint pointers and namespaces never touch each other', function () {
    const wizard = { initial: 'one', states: ['one', 'two'], transitions: [{ from: 'one', event: 'next', to: 'two' }] };
    const upload = { initial: 'idle', states: ['idle', 'busy'], transitions: [{ from: 'idle', event: 'begin', to: 'busy' }] };
    const w = fsmToApp(wizard, { pointer: '/wizard', namespace: 'wizard/' });
    const u = fsmToApp(upload, { pointer: '/upload', namespace: 'upload/' });
    assert.deepStrictEqual(
      Object.keys(w.actions).filter((k) => k in u.actions), [],
      'action names are disjoint by construction');

    const records = [];
    const app = createApp({
      state: { wizard: w.slice, upload: u.slice },
      view: MINIMAL_VIEW,
      actions: { ...w.actions, ...u.actions },
    }, { schedule: sync, onError: (e) => { throw e; } });
    app.observe((tx) => records.push(tx));

    app.dispatch('wizard/next');
    assert.strictEqual(app.getState().wizard.current, 'two');
    assert.strictEqual(app.getState().upload.current, 'idle', 'the other machine never moved');
    assert.deepStrictEqual(records[0].changedPaths, ['/wizard/current']);

    app.dispatch('upload/begin');
    assert.strictEqual(app.getState().upload.current, 'busy');
    assert.strictEqual(app.getState().wizard.current, 'two');
  });
});

describe('fsmToApp — output hygiene', function () {
  it('emits pure JSON: round-trip identity', function () {
    const out = fsmToApp(loaderDoc());
    assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), out);
  });

  it('every generated action validates against the published query grammar', function () {
    const validate = new JarenValidator().compile(querySchema);
    const { actions } = fsmToApp(loaderDoc());
    for (const [name, doc] of Object.entries(actions)) {
      assert.strictEqual(validate(doc), true, `${name} is a valid jaren-query document`);
    }
  });

  it('bakes literals: the slice is read only by the scope binding and the branch conditions', function () {
    const doc = loaderDoc();
    const out = fsmToApp(doc);
    const branchCount = out.events.reduce((n, e) =>
      n + doc.transitions.filter((t) => t.event === e || t.event == null).length, 0);
    const sliceReads = JSON.stringify(out.actions).split('"$.fsm.current"').length - 1;
    assert.strictEqual(sliceReads, out.events.length + branchCount,
      'one read per action ($let scope) + one per branch ($eq) — none in effects or patches');
    for (const action of Object.values(out.actions)) {
      const patches = JSON.stringify(action).match(/"value":"[^"]*"/g) ?? [];
      for (const v of patches) {
        assert.ok(!v.includes('$.'), 'patch values are literal state ids, never reads');
      }
    }
  });

  it('rejects bad machine documents with the same JF codes as compileFsm', function () {
    assert.throws(
      () => fsmToApp({ initial: null, states: ['a'], transitions: [{ from: 'a', to: 'zz' }] }),
      (err) => err instanceof FlowCompileError && /** @type {any} */ (err).code === 'JF0006');
  });

  it('rejects malformed options and the reserved __fsm binding with TypeErrors', function () {
    const doc = { initial: 'a', states: ['a'], transitions: [] };
    assert.throws(() => fsmToApp(doc, { pointer: 'fsm' }), TypeError);
    assert.throws(() => fsmToApp(doc, { pointer: '/bad seg' }), TypeError);
    assert.throws(() => fsmToApp(doc, { namespace: /** @type {any} */ (5) }), TypeError);
    assert.throws(() => fsmToApp({
      initial: 'a', states: ['a'],
      transitions: [{ from: 'a', event: 'go', to: 'a', guard: { $let: { __fsm: 1 }, $return: true } }],
    }), /reserves the variable name "__fsm"/);
  });

  it('fsmStateSchema is the enum of declared ids', function () {
    const schema = fsmStateSchema(loaderDoc());
    assert.deepStrictEqual(schema.properties.current.enum, ['idle', 'loading', 'done']);
    const validate = new JarenValidator().compile(schema);
    assert.strictEqual(validate({ current: 'idle' }), true);
    assert.strictEqual(validate({ current: 'zz' }), false);
    assert.strictEqual(validate({}), false);
  });

  it('a null-initial machine still generates a driveable table', function () {
    const doc = { initial: null, states: ['a', 'b'], transitions: [{ from: 'a', event: 'go', to: 'b' }] };
    const out = fsmToApp(doc);
    assert.deepStrictEqual(out.slice, { current: null });
    const app = createApp({
      state: { fsm: { current: 'a' } },   // the host chose a start state
      view: MINIMAL_VIEW,
      actions: out.actions,
    }, { schedule: sync, onError: (e) => { throw e; } });
    app.dispatch('fsm/go');
    assert.strictEqual(app.getState().fsm.current, 'b');
  });
});
