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
import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';
import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import { OUR_SCHEMA_OPTIONS } from '../lib/schema-options.js';

import dagSchema from '@jarenjs/flow/schemas/jaren-dag.schema.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };

import workflowToState from '@jarenjs/mermaid/stylesheets/workflow-to-state.jslt.json' with { type: 'json' };
import stateToWorkflow from '@jarenjs/mermaid/stylesheets/state-to-workflow.jslt.json' with { type: 'json' };
import dagToFlowchart from '@jarenjs/mermaid/stylesheets/dag-to-flowchart.jslt.json' with { type: 'json' };
import flowchartToDag from '@jarenjs/mermaid/stylesheets/flowchart-to-dag.jslt.json' with { type: 'json' };

import { flowTemplate, FLOW_TEMPLATES } from '../content/flowTemplates.js';
import { memo1 } from '../lib/format.js';
import { errorMessage } from '../lib/nodes.js';
import { createHostWidget } from './host-widget.js';

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
          ...props, class: cls,
          on: { click: { action: 'flow/pick', with: target } },
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
          ...props, class: cls,
          on: { click: { action: 'flow/pick', with: target } },
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
 * @returns {string|null} the human explanation, or null when editable
 */
export function textLossReason(kind, doc) {
  if (kind === 'fsm') {
    if (doc.states.some((s) => typeof s !== 'string')) {
      return 'states carry entry/exit/final members, which diagram text cannot express';
    }
    if (doc.transitions.some((t) => t.guard !== undefined && t.guard !== null && typeof t.guard !== 'string')) {
      return 'a structured guard would flatten to the […] placeholder';
    }
    if (doc.transitions.some((t) => Array.isArray(t.effects)
      && t.effects.some((e) => e.with !== undefined))) {
      return 'an effect carries props, which the / label drops';
    }
    return null;
  }
  const stubOnly = Object.entries(doc.nodes).every(([id, n]) =>
    (n.kind === 'task' && n.run === id && n.with === undefined)
    || n.kind === 'input' || n.kind === 'output');
  if (!stubOnly) return 'query, stylesheet and task documents do not fit in diagram text';
  if (doc.edges.some((e) => e.select !== undefined)) {
    return 'edge selectors do not fit in diagram text';
  }
  return null;
}

// ------------------------------------------------------------------
// Inspector: forms-generated, zero hand-written field rendering
// ------------------------------------------------------------------

const TRANSITION_MODEL = buildFormModel({
  type: 'object',
  properties: {
    from: { type: 'string', title: 'From state' },
    event: { type: ['string', 'null'], title: 'Event (empty = any)' },
    guard: { title: 'Guard (query document)' },
    to: { type: 'string', title: 'To state' },
    effects: { title: 'Effects' },
  },
});
const DAG_EDGE_MODEL = buildFormModel({
  type: 'object',
  properties: {
    from: { type: 'string', title: 'From node' },
    to: { type: 'string', title: 'To node' },
    port: { type: 'string', title: 'Port' },
    select: { title: 'Select (query document)' },
  },
});
/** Whole-member JSON editor: string states, object states, dag nodes. */
const MEMBER_MODEL = buildFormModel({ title: 'Member (JSON)' });

const MODELS = {
  transition: TRANSITION_MODEL,
  edge: DAG_EDGE_MODEL,
  state: MEMBER_MODEL,
  node: MEMBER_MODEL,
};

const inspectorForm = memo1((type, value) =>
  buildFormViewModel(MODELS[type], value, { session: { idPrefix: 'flow-insp' } }));

// ------------------------------------------------------------------
// The page view model (called from app/viewmodel.js)
// ------------------------------------------------------------------

const FLOW_PICKER = {
  templates: FLOW_TEMPLATES.map((t) => ({
    name: t.name, title: t.title, lead: t.lead,
    preview: JSON.stringify(t.doc, null, 1).slice(0, 220) + '…',
  })),
};

const fsmEvents = memo1((doc) => {
  const names = [];
  for (const t of doc.transitions) {
    if (typeof t.event === 'string' && !names.includes(t.event)) names.push(t.event);
  }
  return names;
});

const composeDiagram = memo1((kind, doc, selectedPath, armed, activeId, nodeStatus, firedFrom, firedTo) => {
  const compiled = compiledFor(flowText(kind, doc));
  return decorate(compiled.toVnode(), selectables(kind, doc), {
    selectedPath, armed, activeId, nodeStatus, firedFrom, firedTo,
  });
});

/**
 * @param {any} flow - the `state.flow` slice
 * @returns {any} the `$.ui.flow` node
 */
export function flowPageViewModel(flow) {
  if (flow.doc === null) return { picker: FLOW_PICKER };
  const kind = flow.kind;
  const run = flow.run;
  const selection = flow.selection;
  const lossReason = textLossReason(kind, flow.doc);
  const value = selection === null ? undefined : memberAt(flow.doc, selection.path);
  return {
    live: {
      kind,
      tab: flow.tab,
      diagram: composeDiagram(kind, flow.doc, selection?.path ?? null, flow.connect,
        run !== null && kind === 'fsm' ? run.current : null,
        run !== null && kind === 'dag' ? run.nodes : null,
        // the transition just taken: old → new state, only on a real move
        run !== null && kind === 'fsm' && run.prev != null && run.prev !== run.current ? run.prev : null,
        run !== null && kind === 'fsm' ? run.current : null),
      text: flowText(kind, flow.doc),
      textReadOnly: lossReason !== null,
      textLossReason: lossReason,
      parseError: flow.parseError,
      connectArmed: flow.connect !== null,
      canConnect: selection !== null && (selection.type === 'state' || selection.type === 'node'),
      canDelete: selection !== null,
      canUndo: flow.history.past.length > 0,
      canRedo: flow.history.future.length > 0,
      isFsm: kind === 'fsm',
      selection: selection === null || value === undefined ? null : {
        ...selection,
        label: `${selection.type} ${selection.type === 'transition' || selection.type === 'edge'
          ? '#' + selection.index : selection.id}`,
      },
      inspector: selection === null || value === undefined ? null : {
        form: inspectorForm(selection.type, value),
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

const validateDagDoc = new JarenValidator(OUR_SCHEMA_OPTIONS)
  .addFormats(jsonFormats)
  .addSchema(querySchema)
  .addSchema(jsltSchema)
  .compile(dagSchema);

/** A signal-aware pause for the demo task registry. */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/** The dag demo registry — pure and local, no network. */
const DEMO_TASKS = {
  lookup: async ({ input }, signal) => {
    await wait(350, signal);
    return (Array.isArray(input) ? input : []).map((r) => ({ ...r, region: 'eu' }));
  },
};

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
 * @param {{ schedule?: any }} [env]
 */
export function createFlowRuntime(env = {}) {
  const ref = { app: null, controller: null };

  const boot = (handle, props) => {
    try {
      const { slice, actions } = fsmToApp(props.doc);
      /** @type {Record<string, any>} */
      const effects = {};
      for (const name of runNames(props.doc)) {
        effects[name] = (p) => handle.emit({
          action: 'flow/run-log',
          with: { run: name, props: p ?? null },
        });
      }
      const app = createApp({
        state: { fsm: slice, ...(props.context ?? {}) },
        view: [{ match: '$', body: ['div', { class: 'flow-run-current' }, 'current: ', '$.fsm.current'] }],
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
    'flow-template': (props, dispatch) => {
      const t = flowTemplate(props.name);
      if (t === null) return;
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
          throw new Error(`expected a ${expected} diagram, got '${parsed.diagram}'`);
        }
        const doc = props.kind === 'fsm'
          ? transformJson(stateToWorkflow, parsed)
          : transformJson(flowchartToDag, parsed);
        // fsm: the projection always compiles (the superset contract).
        // dag: a text-projected SKELETON is deliberately incomplete
        // (all-task stubs, no output yet), so the gate is the published
        // schema — compile problems surface at run, where they belong.
        if (props.kind === 'fsm') compileFsm(doc);
        else if (!validateDagDoc(doc)) throw new Error('the projected dag failed jaren-dag schema validation');
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
      let input = null;
      if (typeof props.inputText === 'string' && props.inputText.trim() !== '') {
        try { input = JSON.parse(props.inputText); }
        catch (err) {
          dispatch('flow/dag-fail', { message: `the input is not JSON: ${message(err)}` });
          return;
        }
      }
      let dag;
      try { dag = compileDag(props.doc, { tasks: DEMO_TASKS }); }
      catch (err) {
        dispatch('flow/dag-fail', { message: message(err) });
        return;
      }
      const controller = new AbortController();
      ref.controller = controller;
      dag.run(input, {
        signal: controller.signal,
        onNode: (rec) => dispatch('flow/dag-node', rec),
      }).then(
        (output) => dispatch('flow/dag-done', { output }),
        (err) => dispatch('flow/dag-fail', {
          message: /** @type {any} */ (err)?.nodeId !== undefined
            ? `${message(err)} (node '${/** @type {any} */ (err).nodeId}')`
            : message(err),
        }),
      );
    },
    'flow-dag-abort': () => {
      ref.controller?.abort();
    },
  };

  return { widget, effects };
}
