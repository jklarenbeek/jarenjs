//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { textLossReason, flowText } from '../../packages/website/src/boundaries/flowstudio.js';
import { FLOW_TEMPLATES, flowTemplate } from '../../packages/website/src/content/flowTemplates.js';
import { compileFsm, createFsmSession, compileDag } from '@jarenjs/flow';
import { createStubHost, fire } from '../view/dom.stub.js';

/** A headless site over the stub DOM, opened on the Flow page. */
function mountSite() {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (cb) => { routeCb = cb; cb(parseHash('#/flow')); },
    navigate: (h) => routeCb(parseHash(h)),
    storage: { read: () => null, write: () => {} },
    onError: (err) => { throw err; },
  });
  return { app, container };
}

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.childNodes ?? []) {
    const hit = find(c, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const byDataId = (container, id) => find(container, (n) =>
  n.getAttribute?.('data-id') === id);
const findButton = (container, label) => find(container, (n) =>
  n.tagName === 'button' && n.childNodes?.[0]?.nodeValue === label);
const flowState = (app) => app.getState().flow;

/** A plain machine every pane can edit (no entry/exit/final members). */
const PLAIN_FSM = {
  initial: 'a',
  states: ['a', 'b'],
  transitions: [{ from: 'a', event: 'go', to: 'b' }],
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('website — the Flow studio', function () {
  it('the seed templates are complete: machines compile, graphs compile', function () {
    for (const t of FLOW_TEMPLATES) {
      if (t.kind === 'fsm') assert.doesNotThrow(() => compileFsm(t.doc), t.name);
      else {
        assert.doesNotThrow(() => compileDag(t.doc, {
          tasks: { lookup: async () => null },
        }), t.name);
      }
    }
  });

  it('loads a template into the live editor with a decorated diagram', function () {
    const { app, container } = mountSite();
    fire(findButton(container, 'Load'), 'click');
    assert.strictEqual(flowState(app).kind, 'fsm');
    const draft = byDataId(container, 'draft');
    assert.ok(draft, 'the state graph rendered with identity attributes');
    assert.match(draft.getAttribute('class'), /mm-pick/);
  });

  it('click = pick: the selection lands in state and the inspector opens', function () {
    const { app, container } = mountSite();
    fire(findButton(container, 'Load'), 'click');
    fire(byDataId(container, 'draft'), 'click');
    assert.deepStrictEqual(flowState(app).selection,
      { type: 'state', id: 'draft', path: '/states/0' });
    assert.match(byDataId(container, 'draft').getAttribute('class'), /mm-selected/);
  });

  it('add state → connect (click-click) → delete cascades; undo/redo round-trips', function () {
    const { app, container } = mountSite();
    app.dispatch('flow/load', { kind: 'fsm', doc: PLAIN_FSM, runContext: null, dagInput: '' });

    app.dispatch('flow/add-state');
    assert.deepStrictEqual(flowState(app).doc.states, ['a', 'b', 's3']);
    assert.deepStrictEqual(flowState(app).selection,
      { type: 'state', id: 's3', path: '/states/2' });

    // connect: arm on the selected new state, then click a target node
    fire(findButton(container, 'Connect'), 'click');
    assert.strictEqual(flowState(app).connect, 's3');
    fire(byDataId(container, 'b'), 'click');
    assert.strictEqual(flowState(app).connect, null);
    assert.deepStrictEqual(flowState(app).doc.transitions.at(-1),
      { from: 's3', event: null, to: 'b' });
    assert.strictEqual(flowState(app).selection.type, 'transition');

    // delete the state 'b': the transitions touching it cascade away
    fire(byDataId(container, 'b'), 'click');
    app.dispatch('flow/delete');
    const doc = flowState(app).doc;
    assert.deepStrictEqual(doc.states, ['a', 's3']);
    assert.deepStrictEqual(doc.transitions, [], 'both b-touching transitions cascaded');
    assert.doesNotThrow(() => compileFsm(doc), 'the cascade left a compilable machine');

    // undo unwinds all three gestures; redo replays them
    app.dispatch('flow/undo');
    assert.strictEqual(flowState(app).doc.transitions.length, 2);
    app.dispatch('flow/undo');
    app.dispatch('flow/undo');
    assert.deepStrictEqual(flowState(app).doc, PLAIN_FSM);
    app.dispatch('flow/redo');
    app.dispatch('flow/redo');
    app.dispatch('flow/redo');
    assert.deepStrictEqual(flowState(app).doc.states, ['a', 's3']);
    assert.deepStrictEqual(flowState(app).doc.transitions, []);
  });

  it('the inspector is the generated form and writes through the selection pointer', function () {
    const { app, container } = mountSite();
    app.dispatch('flow/load', { kind: 'fsm', doc: PLAIN_FSM, runContext: null, dagInput: '' });
    // select the only transition via its edge group (AST edge 1: the
    // [*] pseudo-edge is 0)
    const edge = find(container, (n) => n.getAttribute?.('data-edge') === '1');
    assert.ok(edge, 'the transition edge carries identity');
    fire(edge, 'click');
    assert.deepStrictEqual(flowState(app).selection,
      { type: 'transition', index: 0, path: '/transitions/0' });

    // the generated form rendered a text control for /event — the only
    // input whose current value is the transition's event name
    const eventInput = find(container, (n) => n.tagName === 'input' && n.value === 'go');
    assert.ok(eventInput, 'the forms stylesheet rendered the event field');
    fire(eventInput, 'input', { target: { value: 'go!' } });
    assert.strictEqual(flowState(app).doc.transitions[0].event, 'go!');
  });

  it('text commits fail closed: garbage never replaces the document', function () {
    const { app, container } = mountSite();
    app.dispatch('flow/load', { kind: 'fsm', doc: PLAIN_FSM, runContext: null, dagInput: '' });
    const before = flowState(app).doc;
    assert.strictEqual(textLossReason('fsm', before), null, 'the plain machine is text-editable');

    app.dispatch('flow/tab', 'text');
    const textarea = find(container, (n) => n.tagName === 'textarea');
    fire(textarea, 'change', { target: { value: 'pie\n"A" : 1' } });
    assert.strictEqual(flowState(app).doc, before, 'the document is untouched');
    assert.match(flowState(app).parseError, /expected a state diagram/);
    assert.ok(find(container, (n) => n.getAttribute?.('class') === 'error-line'),
      'the error strip rendered');
    app.dispatch('flow/tab', 'diagram');
    assert.ok(byDataId(container, 'a'), 'the last good diagram is still live');
    app.dispatch('flow/tab', 'text');

    fire(textarea, 'change', { target: { value: 'stateDiagram-v2\n  [*] --> a\n  a --> c : leap' } });
    assert.strictEqual(flowState(app).parseError, null);
    assert.deepStrictEqual(flowState(app).doc.transitions,
      [{ from: 'a', event: 'leap', to: 'c' }]);
  });

  it('documents with members text cannot express are read-only there, with the reason', function () {
    const { app, container } = mountSite();
    fire(findButton(container, 'Load'), 'click');   // the review machine: entry + final
    assert.match(/** @type {string} */ (textLossReason('fsm', flowState(app).doc)), /entry\/exit\/final/);
    app.dispatch('flow/tab', 'text');
    const textarea = find(container, (n) => n.tagName === 'textarea');
    assert.strictEqual(textarea.getAttribute('readonly'), '');
    const dag = /** @type {any} */ (flowTemplate('enrich'));
    assert.match(/** @type {string} */ (textLossReason('dag', dag.doc)), /do not fit in diagram text/);
  });

  it('runs the machine as a nested app: highlight follows, stop unmounts, reruns are fresh', function () {
    const { app, container } = mountSite();
    app.dispatch('flow/load', {
      kind: 'fsm',
      doc: { ...PLAIN_FSM, transitions: [{ from: 'a', event: 'go', to: 'b' }] },
      runContext: null, dagInput: '',
    });
    fire(findButton(container, 'Run machine'), 'click');
    assert.ok(find(container, (n) => n.nodeValue === 'current: '),
      'the nested app rendered into the host widget');
    assert.match(byDataId(container, 'a').getAttribute('class'), /mm-active/);

    app.dispatch('flow/send', 'go');
    assert.strictEqual(flowState(app).run.current, 'b');
    assert.match(byDataId(container, 'b').getAttribute('class'), /mm-active/);
    assert.ok(flowState(app).run.log.length > 0, 'the transaction log recorded the step');

    fire(findButton(container, 'Stop'), 'click');
    assert.strictEqual(flowState(app).run, null);
    assert.strictEqual(find(container, (n) => n.nodeValue === 'current: '), undefined,
      'the nested app unmounted deterministically');

    fire(findButton(container, 'Run machine'), 'click');
    assert.strictEqual(flowState(app).run.current, 'a', 'a rerun starts fresh');
    app.dispatch('flow/send', 'go');
    assert.strictEqual(flowState(app).run.current, 'b');
  });

  it('the ported Libero Coke machine loads, renders as a graph, and drives with its effects logged', function () {
    const { app, container } = mountSite();
    const coke = /** @type {any} */ (flowTemplate('coke-machine'));
    assert.ok(coke && coke.kind === 'fsm', 'the Libero Coke machine is a seed');
    app.dispatch('flow/load', { kind: 'fsm', doc: coke.doc, runContext: {}, dagInput: '' });

    // it renders as a state graph with the Libero state ids
    assert.ok(byDataId(container, 'should-be-gently-humming'), 'the initial state rendered');
    assert.ok(byDataId(container, 'cooperate'), 'a mid state rendered');

    // run it and walk the canonical path: Ok → Clink → Ok → Coke
    fire(findButton(container, 'Run machine'), 'click');
    assert.match(byDataId(container, 'should-be-gently-humming').getAttribute('class'), /mm-active/);

    // one step: the current state glows and the edge just taken flows
    app.dispatch('flow/send', 'Ok');
    assert.match(byDataId(container, 'something-happened').getAttribute('class'), /mm-active/,
      'the new current state glows');
    assert.strictEqual(flowState(app).run.prev, 'should-be-gently-humming',
      'the previous state is tracked for the fired-edge highlight');
    const firedEdge = find(container, (n) =>
      /mm-fired/.test(n.getAttribute?.('class') ?? '')
      && n.getAttribute?.('data-from') === 'should-be-gently-humming'
      && n.getAttribute?.('data-to') === 'something-happened');
    assert.ok(firedEdge, 'the transition just taken is marked mm-fired for the flow animation');

    for (const ev of ['Clink', 'Ok', 'Coke']) app.dispatch('flow/send', ev);
    assert.strictEqual(flowState(app).run.current, 'something-happened',
      'a full cooperate cycle returns to something-happened');
    const runs = flowState(app).run.log.map((l) => l.run);
    assert.ok(runs.includes('accept-punters-cash'), 'a Libero action reached the run log');
    assert.ok(runs.includes('eject-appropriate-can'), 'the drink was ejected');

    // the nasty branch really ejects the OPPOSITE can (the joke works)
    const nasty = compileFsm(coke.doc).step('lets-be-nasty', 'Coke');
    assert.strictEqual(nasty.effects[0].run, 'eject-opposite-can');
  });

  it('the ported Libero expression evaluator parses a token stream to done', function () {
    const parser = /** @type {any} */ (flowTemplate('expression-parser'));
    assert.ok(parser && parser.kind === 'fsm', 'the lrcalc parser is a seed');
    const fsm = compileFsm(parser.doc);
    const session = createFsmSession(fsm);
    // 2 * (3 + 4) as token TYPES — Libero's model: a lexer classifies chars
    const tokens = ['Ok', 'Number', 'Factor-Op', 'Left-Par', 'Number', 'Term-Op', 'Number', 'Right-Par', 'End-Mark'];
    for (const ev of tokens) session.send(ev);
    assert.strictEqual(session.state, 'done', 'a valid expression parses to the final state');
    assert.strictEqual(session.done, true);
    // the shunting-yard action fires at the close
    const close = fsm.step('expecting-operator', 'End-Mark');
    assert.ok(close.effects.map((e) => e.run).includes('unstack-all-operators'),
      'the operator stack is flushed at End-Mark');
    // a leading operator is the documented error (no unary signs)
    assert.strictEqual(fsm.step('expecting-initial', 'Term-Op').state, 'done');
  });

  it('runs the dag: nodes settle to ok, the output shows, and abort fails closed', async function () {
    const { app, container } = mountSite();
    // load the dag seed directly
    const t = /** @type {any} */ (flowTemplate('enrich'));
    app.dispatch('flow/load', {
      kind: 'dag', doc: t.doc, runContext: null,
      dagInput: JSON.stringify(t.runInput),
    });

    fire(findButton(container, 'Run graph'), 'click');
    assert.strictEqual(flowState(app).run.running, true);
    await settle(600);
    const run = flowState(app).run;
    assert.strictEqual(run.running, false);
    assert.strictEqual(run.error, null);
    assert.deepStrictEqual(run.output,
      ['ul', {}, [['li', {}, 'ada'], ['li', {}, 'lin']]],
      'the dag produced the exact vnode');
    assert.strictEqual(run.nodes.stamp, 'ok');
    assert.match(byDataId(container, 'stamp').getAttribute('class'), /mm-run-ok/);

    // abort a fresh run while the task is in flight
    fire(findButton(container, 'Run graph'), 'click');
    fire(findButton(container, 'Abort'), 'click');
    await settle(50);
    assert.strictEqual(flowState(app).run.running, false);
    assert.match(flowState(app).run.error, /JF2007/);
  });

  it('the three panes are one document: a diagram gesture updates the text projection', function () {
    const { app } = mountSite();
    app.dispatch('flow/load', { kind: 'fsm', doc: PLAIN_FSM, runContext: null, dagInput: '' });
    const before = flowText('fsm', flowState(app).doc);
    app.dispatch('flow/add-state');
    const after = flowText('fsm', flowState(app).doc);
    assert.notStrictEqual(before, after);
    assert.match(after, /s3/);
  });
});

describe('website — Flow runtime edges', function () {
  function mount() {
    return mountSite();
  }

  it('a machine with entry effects logs them through the sandbox registry', function () {
    const { app, container } = mount();
    fire(findButton(container, 'Load'), 'click');           // the review machine
    fire(findButton(container, 'Run machine'), 'click');
    app.dispatch('flow/send', 'submit');
    const log = flowState(app).run.log;
    assert.ok(log.some((l) => l.run === 'notify'),
      'the entry effect surfaced as a run-log record');
    assert.strictEqual(flowState(app).run.current, 'in-review');
  });

  it('a hosted evaluation failure lands in the log through the nested error sink', function () {
    const { app, container } = mount();
    app.dispatch('flow/load', {
      kind: 'fsm',
      doc: {
        initial: 'a', states: ['a', 'b'],
        transitions: [{ from: 'a', event: 'go', guard: { $eq: ['$oops', 1] }, to: 'b' }],
      },
      runContext: null, dagInput: '',
    });
    fire(findButton(container, 'Run machine'), 'click');
    app.dispatch('flow/send', 'go');
    const log = flowState(app).run.log;
    assert.ok(log.some((l) => l.run === 'error' && /JA2002/.test(l.props)),
      'the guard-throw divergence surfaces as the documented app error');
    assert.strictEqual(flowState(app).run.current, 'a', 'no fallback fired (fail closed)');
  });

  it('re-running while running reboots the nested app through the widget update path', function () {
    const { app, container } = mount();
    app.dispatch('flow/load', { kind: 'fsm', doc: PLAIN_FSM, runContext: null, dagInput: '' });
    fire(findButton(container, 'Run machine'), 'click');
    app.dispatch('flow/send', 'go');
    assert.strictEqual(flowState(app).run.current, 'b');
    app.dispatch('flow/run');                               // revision bump, same widget
    assert.strictEqual(flowState(app).run.current, 'a', 'the rebooted machine starts fresh');
    app.dispatch('flow/send', 'go');
    assert.strictEqual(flowState(app).run.current, 'b', 'and the fresh instance answers');
  });

  it('aborting a task genuinely in flight exercises the demo registry abort path', async function () {
    const { app, container } = mount();
    const t = /** @type {any} */ (flowTemplate('enrich'));
    app.dispatch('flow/load', {
      kind: 'dag', doc: t.doc, runContext: null,
      dagInput: JSON.stringify(t.runInput),
    });
    fire(findButton(container, 'Run graph'), 'click');
    await settle(60);                                       // the lookup task is now waiting
    fire(findButton(container, 'Abort'), 'click');
    await settle(30);
    assert.strictEqual(flowState(app).run.running, false);
    assert.match(flowState(app).run.error, /JF2007/);
    assert.strictEqual(flowState(app).run.nodes.stamp, 'aborted',
      'the in-flight task recorded its abort');
  });
});
