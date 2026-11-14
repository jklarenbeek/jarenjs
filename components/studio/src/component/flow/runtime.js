import { validateDagDoc } from '../../flow-document.js';
//@ts-check
/**
 * The Flow studio's JS boundary: the projection chain (flow document →
 * mermaid text → decorated SVG vnode), the selection vocabulary, the
 * inspector form models, and the run-mode runtime (a nested @jarenjs/app
 * driven by fsmToApp's generated actions, and a compileDag runner with
 * abort). The page itself stays a stylesheet; JavaScript enters here,
 * at the derivation and registry boundaries only.
 *
 * One document, three faces: every gesture patches `/flow/doc`, and the
 * diagram, the text pane and the inspector are all derived projections
 * of it — they cannot disagree.
 */

import { compileFsm, compileDag, fsmToApp } from '@jarenjs/flow';
import { parseMermaid, toMermaid, diagramDocument, compileMermaid } from '@jarenjs/mermaid';
import { transformJson } from '@jarenjs/json/jslt';
import { pickAllowed } from '@jarenjs/core/array';
import { encodeJSONPointerSegment, decodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { createApp } from '@jarenjs/app';
import { buildFormModel, buildFormViewModel, formChromeLabels } from '@jarenjs/forms';


import workflowToState from '@jarenjs/mermaid/stylesheets/workflow-to-state.jslt.json' with { type: 'json' };
import stateToWorkflow from '@jarenjs/mermaid/stylesheets/state-to-workflow.jslt.json' with { type: 'json' };
import dagToFlowchart from '@jarenjs/mermaid/stylesheets/dag-to-flowchart.jslt.json' with { type: 'json' };
import flowchartToDag from '@jarenjs/mermaid/stylesheets/flowchart-to-dag.jslt.json' with { type: 'json' };

import { memo1 } from '../shared/memo.js';
import { errorMessage } from '../shared/nodes.js';
import { createHostWidget } from '../shared/host-widget.js';
import { studioTextOf, catalogOf, wordsBy } from '../../messages.js';

/** The phone panes, in switcher order. */
const FLOW_PANES = ['diagram', 'inspector', 'run'];

// ------------------------------------------------------------------
// The projection chain: document → mermaid text → decorated vnode
// ------------------------------------------------------------------

/** Read a JSON Pointer from a document (the inspector's selection). */
export function memberAt(doc, pointer) {
  if (pointer === '') return doc;
  let value = doc;
  for (const raw of pointer.split('/').slice(1)) {
    const seg = decodeJSONPointerSegment(raw);
    if (value === null || typeof value !== 'object') return undefined;
    value = Array.isArray(value) ? value[Number(seg)] : value[seg];
  }
  return value;
}

const fsmToText = memo1((doc) => {
  const ast = transformJson(workflowToState, doc);
  return toMermaid(diagramDocument('state', {}, ast, { hash: '0', direction: null, title: null }));
});

const dagToText = memo1((doc) => {
  const ast = transformJson(dagToFlowchart, doc);
  return toMermaid(diagramDocument('flowchart', {}, ast, { hash: '0', direction: 'TD', title: null }));
});

/** @param {'fsm'|'dag'} kind @param {any} doc @returns {string} */
export function flowText(kind, doc) {
  return kind === 'fsm' ? fsmToText(doc) : dagToText(doc);
}

const compiledFor = memo1((text) => compileMermaid(text));

/**
 * The selection targets a click can produce, precomputed per document
 * so the decorated vnode's bindings carry ready JSON Pointers.
 * @param {'fsm'|'dag'} kind @param {any} doc
 */
const selectables = memo1((kind, doc) => {
  /** @type {Record<string, { type: string, id: string, path: string }>} */
  const nodes = {};
  /** @type {Record<number, { type: string, index: number, path: string }>} */
  const edges = {};
  if (kind === 'fsm') {
    doc.states.forEach((s, i) => {
      const id = typeof s === 'string' ? s : s.id;
      nodes[id] = { type: 'state', id, path: `/states/${i}` };
    });
    const offset = doc.initial !== null ? 1 : 0;   // the [*] pseudo-edge
    doc.transitions.forEach((t, i) => {
      edges[i + offset] = { type: 'transition', index: i, path: `/transitions/${i}` };
    });
  }
  else {
    for (const id of Object.keys(doc.nodes)) {
      nodes[id] = { type: 'node', id, path: `/nodes/${encodeJSONPointerSegment(id)}` };
    }
    doc.edges.forEach((_e, i) => {
      edges[i] = { type: 'edge', index: i, path: `/edges/${i}` };
    });
  }
  return { nodes, edges };
});

/**
 * Decorate the compiled SVG vnode: click bindings on every selectable
 * group (by `data-id`/`data-edge`) plus the marker classes — selection,
 * the armed connect source, the running machine's active state, the
 * dag run's per-node status. Pure copy; the compiled vnode is shared
 * and never mutated.
 */
function decorate(vnode, targets, marks) {
  const walk = (node) => {
    if (!Array.isArray(node) || typeof node[0] !== 'string') {
      return Array.isArray(node) ? node.map(walk) : node;
    }
    const [tag, props, ...children] = node;
    let nextProps = props;
    if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
      const id = props['data-id'];
      const edge = props['data-edge'];
      if (typeof id === 'string' && targets.nodes[id] !== undefined) {
        const target = targets.nodes[id];
        let cls = `${props.class ?? ''} mm-pick`;
        if (marks.selectedPath === target.path) cls += ' mm-selected';
        if (marks.armed === id) cls += ' mm-armed';
        if (marks.activeId === id) cls += ' mm-active';
        const status = marks.nodeStatus?.[id];
        if (status !== undefined) cls += ` mm-run-${status}`;
        nextProps = {
          ...props, class: cls, role: 'button', tabindex: '0',
          'aria-label': selectionLabel(marks.t, target, 'target'),
          on: { click: { action: 'flow/pick', with: target }, keydown: { action: 'flow/key-pick', with: target } },
        };
      }
      else if (typeof edge === 'number' && targets.edges[edge] !== undefined) {
        const target = targets.edges[edge];
        let cls = `${props.class ?? ''} mm-pick`;
        if (marks.selectedPath === target.path) cls += ' mm-selected';
        // the transition just taken flows from the old state to the new
        // one — matched by endpoints, so every parallel edge that could
        // have fired lights up (a machine with 4 drinks → 4 glowing arcs)
        if (marks.firedFrom != null
          && props['data-from'] === marks.firedFrom && props['data-to'] === marks.firedTo) {
          cls += ' mm-fired';
        }
        nextProps = {
          ...props, class: cls, role: 'button', tabindex: '0',
          'aria-label': selectionLabel(marks.t, target, 'target'),
          on: { click: { action: 'flow/pick', with: target }, keydown: { action: 'flow/key-pick', with: target } },
        };
      }
    }
    return [tag, nextProps, ...children.map(walk)];
  };
  return walk(vnode);
}

// ------------------------------------------------------------------
// Text round-trip honesty: which documents survive the text projection
// ------------------------------------------------------------------

/**
 * The text pane is read-only when the document carries members the
 * diagram text cannot represent — committing an edit would silently
 * destroy them (APP-INTEGRATION honesty rule, MERMAID-FORMAT §5.1).
 * @param {'fsm'|'dag'} kind @param {any} doc
 * @param {any} [messages] - the compiled catalog the explanation speaks
 *   (or a function answering it); English when absent
 * @returns {string|null} the human explanation, or null when editable
 */
export function textLossReason(kind, doc, messages) {
  const t = studioTextOf(messages);
  if (kind === 'fsm') {
    if (doc.states.some((s) => typeof s !== 'string')) {
      return t('studio/flow/loss-states');
    }
    if (doc.transitions.some((tr) => tr.guard !== undefined && tr.guard !== null && typeof tr.guard !== 'string')) {
      return t('studio/flow/loss-guard');
    }
    if (doc.transitions.some((tr) => Array.isArray(tr.effects)
      && tr.effects.some((e) => e.with !== undefined))) {
      return t('studio/flow/loss-effect');
    }
    return null;
  }
  const stubOnly = Object.entries(doc.nodes).every(([id, n]) =>
    (n.kind === 'task' && n.run === id && n.with === undefined)
    || n.kind === 'input' || n.kind === 'output');
  if (!stubOnly) return t('studio/flow/loss-documents');
  if (doc.edges.some((e) => e.select !== undefined)) {
    return t('studio/flow/loss-selectors');
  }
  return null;
}

// ------------------------------------------------------------------
// Inspector: forms-generated, zero hand-written field rendering
// ------------------------------------------------------------------

/** The inspector's form models, their field titles in one language,
 * built once per catalog. */
const inspectorModels = wordsBy((t) => {
  /** Whole-member JSON editor: string states, object states, dag nodes. */
  const member = buildFormModel({ title: t('studio/flow/field-member') });
  return {
    transition: buildFormModel({
      type: 'object',
      properties: {
        from: { type: 'string', title: t('studio/flow/field-from-state') },
        event: { type: ['string', 'null'], title: t('studio/flow/field-event') },
        guard: { title: t('studio/flow/field-guard') },
        to: { type: 'string', title: t('studio/flow/field-to-state') },
        effects: { title: t('studio/flow/field-effects') },
      },
    }),
    edge: buildFormModel({
      type: 'object',
      properties: {
        from: { type: 'string', title: t('studio/flow/field-from-node') },
        to: { type: 'string', title: t('studio/flow/field-to-node') },
        port: { type: 'string', title: t('studio/flow/field-port') },
        select: { title: t('studio/flow/field-select') },
      },
    }),
    state: member,
    node: member,
  };
});

// the forms' own chrome (array buttons, the JSON hint, field alerts)
// speaks the same catalog the titles do
const inspectorForm = memo1((models, type, value, catalog) =>
  buildFormViewModel(models[type], value, catalog == null
    ? { session: { idPrefix: 'flow-insp' } } : { session: { idPrefix: 'flow-insp' }, catalog }));

/** The words of the Flow studio's live panes, once per catalog. */
const liveWords = wordsBy((t) => ({
  machine: t('studio/flow/machine'), dataflow: t('studio/flow/dataflow'), addState: t('studio/flow/add-state'),
  addNode: t('studio/flow/add-node'), connect: t('studio/flow/connect'), connectArmed: t('studio/flow/connect-armed'),
  delete: t('studio/flow/delete'), undo: t('studio/flow/undo'), redo: t('studio/flow/redo'), new: t('studio/flow/new'),
  tabDiagram: t('studio/flow/tab-diagram'), tabText: t('studio/flow/tab-text'), textHint: t('studio/flow/text-hint'),
  inspector: t('studio/flow/inspector'), inspectorHint: t('studio/flow/inspector-hint'),
  run: t('studio/flow/run'), stop: t('studio/flow/stop'), runMachine: t('studio/flow/run-machine'),
  runMachineHint: t('studio/flow/run-machine-hint'), runInput: t('studio/flow/run-input'),
  runGraph: t('studio/flow/run-graph'), abort: t('studio/flow/abort'), panes: t('studio/panes'),
  paneDiagram: t('studio/flow/pane-diagram'), paneInspector: t('studio/flow/pane-inspector'), paneRun: t('studio/flow/pane-run'),
}));

/** The seed picker's words, once per catalog (a seed card is its own rule). */
const pickerWords = wordsBy((t) => ({ lead: t('studio/flow/picker-lead'), load: t('studio/flow/load') }));

/**
 * What the inspector is editing (`selected`), or what a diagram target
 * picks (`target`), in the reader's words.
 * @param {(id: string, params?: Record<string, unknown>) => string} t
 * @param {{ type: string, id?: string, index?: number }} selection
 * @param {'selected' | 'target'} [as]
 */
function selectionLabel(t, selection, as = 'selected') {
  if (selection.type === 'transition' || selection.type === 'edge') {
    return t(`studio/flow/${as}-${selection.type}`, { index: selection.index });
  }
  return t(`studio/flow/${as}-${selection.type}`, { id: selection.id });
}

// ------------------------------------------------------------------
// The page view model (called from app/viewmodel.js)
// ------------------------------------------------------------------

const picker = memo1((templates, w) => ({ w, templates: templates.map(t => ({
  name: t.name, title: t.title, lead: t.lead, w,
  preview: JSON.stringify(t.doc, null, 1).slice(0, 220) + '…',
})) }));
const NO_TEMPLATES = [];

const fsmEvents = memo1((doc) => {
  const names = [];
  for (const t of doc.transitions) {
    if (typeof t.event === 'string' && !names.includes(t.event)) names.push(t.event);
  }
  return names;
});

const composeDiagram = memo1((kind, doc, selectedPath, armed, activeId, nodeStatus, firedFrom, firedTo, t) => {
  const compiled = compiledFor(flowText(kind, doc));
  return decorate(compiled.toVnode(), selectables(kind, doc), {
    selectedPath, armed, activeId, nodeStatus, firedFrom, firedTo, t,
  });
});

/** The inspector form's chrome (array buttons, the JSON hint), read by
 * the form rules at render time, once per catalog. */
const formLabels = memo1((catalog) => formChromeLabels(catalog ?? undefined));

/**
 * @param {any} flow - the `state.flow` slice
 * @param {any[]} [templates] - the seed cards the picker offers
 * @param {{ messages?: any }} [options] - `messages`: the reader's compiled
 *   catalog (or a function answering it); English when absent
 * @returns {any} the `$.ui.flow` node
 */
export function flowPageViewModel(flow, templates = NO_TEMPLATES, options = {}) {
  if (flow.doc === null) return { picker: picker(templates, pickerWords(options.messages)) };
  const t = studioTextOf(options.messages);
  const kind = flow.kind;
  const run = flow.run;
  const selection = flow.selection;
  const lossReason = textLossReason(kind, flow.doc, options.messages);
  const value = selection === null ? undefined : memberAt(flow.doc, selection.path);
  return {
    live: {
      w: liveWords(options.messages),
      kind,
      tab: flow.tab,
      diagram: composeDiagram(kind, flow.doc, selection?.path ?? null, flow.connect,
        run !== null && kind === 'fsm' ? run.current : null,
        run !== null && kind === 'dag' ? run.nodes : null,
        // the transition just taken: old → new state, only on a real move
        run !== null && kind === 'fsm' && run.prev != null && run.prev !== run.current ? run.prev : null,
        run !== null && kind === 'fsm' ? run.current : null, t),
      text: flowText(kind, flow.doc),
      textReadOnly: lossReason !== null,
      textLossReason: lossReason,
      readOnlyText: lossReason === null ? null : t('studio/flow/read-only', { reason: lossReason }),
      parseError: flow.parseError,
      connectArmed: flow.connect !== null,
      canConnect: selection !== null && (selection.type === 'state' || selection.type === 'node'),
      canDelete: selection !== null,
      canUndo: flow.history.past.length > 0,
      canRedo: flow.history.future.length > 0,
      isFsm: kind === 'fsm',
      selection: selection === null || value === undefined ? null : {
        ...selection,
        label: selectionLabel(t, selection),
      },
      formLabels: formLabels(catalogOf(options.messages)),
      inspector: selection === null || value === undefined ? null : {
        form: inspectorForm(inspectorModels(options.messages), selection.type, value, catalogOf(options.messages)),
      },
      run: run === null ? null : {
        ...run,
        revision: flow.revision,
        logLines: run.log.map((entry) => JSON.stringify(entry)),
        outputText: run.output === undefined || run.output === null
          ? null : JSON.stringify(run.output, null, 1),
      },
      events: kind === 'fsm' ? fsmEvents(flow.doc) : [],
      dagInput: flow.dagInput,
      // the phone pane (Diagram · Inspector · Run)
      mobilePane: pickAllowed(flow.mobilePane, FLOW_PANES, 'diagram'),
      mount: run !== null && kind === 'fsm'
        ? runMount(flow.doc, flow.revision, flow.runContext)
        : null,
    },
  };
}

const runMount = memo1((doc, revision, context) => ({ doc, revision, context }));

// ------------------------------------------------------------------
// The run-mode runtime: nested app widget + dag runner + parse effect
// ------------------------------------------------------------------

/** Every effect run name a machine document can schedule. */
function runNames(doc) {
  const names = new Set();
  for (const s of doc.states) {
    if (typeof s === 'object') {
      for (const e of s.entry ?? []) names.add(e.run);
      for (const e of s.exit ?? []) names.add(e.run);
    }
  }
  for (const t of doc.transitions) for (const e of t.effects ?? []) names.add(e.run);
  return [...names];
}

// One shared normalizer (lib/nodes.js): coded errors compose their own
// `code: reason at path` message now, so the hand prefix this module
// used to add would print the code twice.
const message = errorMessage;

/**
 * The Flow studio runtime: the nested-app host widget for machine runs
 * and the effect registry (template loading, fail-closed text parsing,
 * machine sends, dag runs with abort). One closure ref ties the
 * running instances to their effects.
 * @param {{ schedule?: any, template?: (name: string) => any, tasks?: Record<string, Function>, getFlow?: () => any, mintFromCount?: boolean,
 *   messages?: any }} [env] - `messages`: the compiled catalog, or a function
 *   answering the current one, the run's lines and refusals speak
 */
export function createFlowRuntime(env = {}) {
  const words = () => studioTextOf(env.messages);
  const ref = { app: null, controller: null, generation: 0, disposed: false };

  const boot = (handle, props) => {
    try {
      const { slice, actions } = fsmToApp(props.doc);
      /** @type {Record<string, any>} */
      const effects = {
};
      for (const name of runNames(props.doc)) {
        effects[name] = (p) => handle.emit({
          action: 'flow/run-log',
          with: { run: name, props: p ?? null },
        });
      }
      const app = createApp({
        state: { fsm: slice, ...(props.context ?? {}) },
        view: [{ match: '$', body: ['div', { class: 'flow-run-current' }, { $const: `${words()('studio/flow/current')} ` }, '$.fsm.current'] }],
        actions,
      }, {
        node: handle.host,
        document: handle.host.ownerDocument,
        schedule: env.schedule,
        effects,
        onError: (err) => handle.emit({ action: 'flow/run-log', with: { run: 'error', props: message(err) } }),
      });
      app.observe((tx) => handle.emit({
        action: 'flow/run-tx',
        with: { action: tx.action, status: tx.status, current: app.getState().fsm.current },
      }));
      handle.app = app;
      ref.app = app;
    }
    catch (err) {
      handle.app = null;
      handle.emit({ action: 'flow/run-log', with: { run: 'error', props: message(err) } });
    }
  };
  const destroy = (handle) => {
    try { handle.app?.destroy(); }
    catch { /* teardown must never throw into the patcher */ }
    if (ref.app === handle.app) ref.app = null;
    handle.app = null;
  };

  const widget = createHostWidget({ boot, destroy });

  const effects = {
    'flow-mint': (props, dispatch) => {
      const doc = env.getFlow?.().doc;
      if (doc == null) return;
      const ids = props.kind === 'state'
        ? new Set((doc.states ?? []).map(s => typeof s === 'string' ? s : s.id))
        : new Set(Object.keys(doc.nodes ?? {}));
      const prefix = props.kind === 'state' ? 's' : 'n';
      let n = env.mintFromCount === false ? 1 : ids.size + 1;
      while (ids.has(prefix + n)) n++;
      dispatch(props.kind === 'state' ? 'flow/state-minted' : 'flow/node-minted', prefix + n);
    },

    'flow-template': (props, dispatch) => {
      const t = env.template?.(props.name);
      if (t == null) return;
      dispatch('flow/load', {
        kind: t.kind, doc: t.doc,
        runContext: t.runContext ?? null,
        dagInput: t.runInput === undefined ? '' : JSON.stringify(t.runInput, null, 1),
      });
    },
    // fail closed: a broken edit never replaces the document — the last
    // good diagram stays live and the error strip says why
    'flow-parse': (props, dispatch) => {
      try {
        const parsed = parseMermaid(props.text);
        const expected = props.kind === 'fsm' ? 'state' : 'flowchart';
        if (parsed.diagram !== expected) {
          throw new Error(words()('studio/flow/expected-diagram', { expected, got: parsed.diagram }));
        }
        const doc = props.kind === 'fsm'
          ? transformJson(stateToWorkflow, parsed)
          : transformJson(flowchartToDag, parsed);
        // fsm: the projection always compiles (the superset contract).
        // dag: a text-projected SKELETON is deliberately incomplete
        // (all-task stubs, no output yet), so the gate is the published
        // schema — compile problems surface at run, where they belong.
        if (props.kind === 'fsm') compileFsm(doc);
        else if (!validateDagDoc(doc)) throw new Error(words()('studio/flow/dag-schema'));
        dispatch('flow/parsed', { doc });
      }
      catch (err) {
        dispatch('flow/parse-error', { message: message(err) });
      }
    },
    'flow-run-send': (props) => {
      ref.app?.dispatch(`fsm/${props.event}`);
    },
    'flow-dag-run': (props, dispatch) => {
      if (ref.disposed) return Promise.resolve({ ok: false, error: 'The Flow editor is disposed.' });
      ref.controller?.abort();
      const generation = ++ref.generation;
      const send = (action, payload) => {
        if (!ref.disposed && generation === ref.generation) dispatch(action, payload);
      };
      let input = null;
      if (typeof props.inputText === 'string' && props.inputText.trim() !== '') {
        try { input = JSON.parse(props.inputText); }
        catch (err) {
          const error = words()('studio/flow/input-not-json', { reason: message(err) });
          send('flow/dag-fail', { message: error });
          return Promise.resolve({ ok: false, error });
        }
      }
      let dag;
      try { dag = compileDag(props.doc, { tasks: env.tasks ?? {} }); }
      catch (err) {
        send('flow/dag-fail', { message: message(err) });
        return Promise.resolve({ ok: false, error: message(err) });
      }
      const controller = new AbortController();
      ref.controller = controller;
      return dag.run(input, {
        signal: controller.signal,
        onNode: (rec) => send('flow/dag-node', rec),
      }).then(
        output => {
          if (ref.disposed || generation !== ref.generation) return { ok: false, error: 'The run was superseded or disposed.' };
          send('flow/dag-done', { output }); return { ok: true, output };
        },
        err => {
          const error = err?.nodeId !== undefined ? words()('studio/flow/node-failed', { message: message(err), node: err.nodeId }) : message(err);
          send('flow/dag-fail', { message: error }); return { ok: false, error };
        },
      );
    },
    'flow-dag-abort': () => {
      ref.controller?.abort();
    },
  };

  const dispose = () => { ref.disposed = true; ref.generation++; ref.controller?.abort(); };
  effects['flow-dag-run'].dispose = dispose;
  return { widget, effects, dispose };
}
