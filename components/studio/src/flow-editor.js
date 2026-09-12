//@ts-check
/** @typedef {{ kind: 'fsm'|'dag'|null, document: any, revision: string, result: any }} FlowSnapshot */
/** @typedef {{ ok: boolean, document?: any, revision?: string, conflict?: boolean, error?: string,
 * errors?: any[], valid?: boolean, total?: number, code?: string, output?: any, started?: boolean }} EditorReceipt */
/** Revision-checked Flow publication over the editor's own queued actions. */
import { semanticKey } from '@jarenjs/core/object';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { validateFlowDocument } from './flow-document.js';

/** @param {{ kind?: 'fsm'|'dag'|null, document?: any, input?: any }} [options] */
export function createFlowState(options = {}) {
  return {
    kind: options.kind ?? null, doc: options.document == null ? null : structuredClone(options.document),
    selection: null, connect: null, tab: 'diagram', parseError: null, history: { past: [], future: [] },
    run: null, runContext: structuredClone(options.input ?? null),
    dagInput: options.input === undefined ? '' : JSON.stringify(options.input), revision: 0, mobilePane: 'diagram',
  };
}

/** @param {{ getApp: () => any, runtime: any }} env */
export function createFlowController(env) {
  let stopped = false, detach = null, sequence = 0;
  const requests = new Map(), listeners = new Set();
  const copy = value => structuredClone(value);
  /** @returns {FlowSnapshot} */
  function read() {
    const { kind, doc, run } = env.getApp().getState().flow;
    return { kind, document: copy(doc), revision: semanticKey({ kind, doc }), result: copy(run) };
  }
  /** @param {any} candidate @param {'fsm'|'dag'} [kind] */
  function validate(candidate, kind = env.getApp().getState().flow.kind) { return validateFlowDocument(kind, candidate); }
  function settle(id, result) { const resolve = requests.get(id); requests.delete(id); resolve?.({ ...read(), ...result }); }
  /** @param {any} candidate @param {{ expectedRevision?: string, kind?: 'fsm'|'dag' }} [options]
   * @returns {Promise<EditorReceipt>}
   */
  function replace(candidate, options = {}) {
    if (stopped) return Promise.resolve({ ok: false, error: 'The Flow editor is disposed.' });
    const before = read(), kind = options.kind ?? before.kind;
    if (before.kind !== null && kind !== before.kind) return Promise.resolve({ ok: false, error: 'A replacement must keep the current Flow kind; open a new document to change it.' });
    if (options.expectedRevision !== before.revision) return Promise.resolve({ ok: false, conflict: true, ...before });
    const checked = validate(candidate, kind);
    if (!checked.valid) return Promise.resolve({ ok: false, ...checked });
    return new Promise(resolve => {
      const id = ++sequence; requests.set(id, resolve);
      env.getApp().dispatch('flow/replace', { requestId: id, expected: { kind: before.kind, doc: before.document }, kind, doc: copy(candidate) });
    });
  }
  /** @param {Parameters<typeof applyJSONPatch>[1]} patch @param {{ expectedRevision?: string, kind?: 'fsm'|'dag' }} [options]
   * @returns {Promise<EditorReceipt>}
   */
  function apply(patch, options) {
    try { return replace(applyJSONPatch(read().document, patch), options); }
    catch (error) { return Promise.resolve({ ok: false, error: error.message, code: error.code }); }
  }
  /** Execute with the host's task registry and explicit input; return the settled DAG result or machine start receipt.
   * @param {{ input?: any, event?: string }} [options]
   * @returns {Promise<EditorReceipt>}
   */
  function run(options = {}) {
    if (stopped) return Promise.resolve({ ok: false, error: 'The Flow editor is disposed.' });
    const state = env.getApp().getState().flow;
    if (state.doc === null) return Promise.resolve({ ok: false, error: 'No Flow document is open.' });
    return new Promise(resolve => {
      const id = ++sequence; requests.set(id, resolve);
      env.getApp().dispatch('flow/execute', { requestId: id, input: options.input ?? state.runContext,
        inputText: options.input === undefined ? state.dagInput : JSON.stringify(options.input), event: options.event ?? null });
    });
  }
  /** @param {(snapshot: FlowSnapshot) => void} listener */
  function subscribe(listener) { if (stopped) return () => {}; listeners.add(listener); return () => listeners.delete(listener); }
  function attach() {
    if (stopped || detach) return;
    let revision = read().revision;
    detach = env.getApp().subscribe(() => {
      const current = read();
      if (current.revision !== revision) { revision = current.revision; for (const listener of listeners) listener(current); }
    });
  }
  function dispose() {
    if (stopped) return;
    stopped = true; detach?.(); detach = null; listeners.clear(); env.runtime.dispose();
    for (const resolve of requests.values()) resolve({ ok: false, error: 'The Flow editor is disposed.' });
    requests.clear();
  }
  const effects = {
    'flow-accepted': id => { env.runtime.effects['flow-dag-abort'](); settle(id, { ok: true }); },
    'flow-refused': id => settle(id, { ok: false, conflict: true }),
    'flow-editor-run': Object.assign(async (props, dispatch) => {
      if (stopped) { settle(props.requestId, { ok: false, error: 'The Flow editor is disposed.' }); return; }
      if (props.kind === 'fsm') {
        dispatch(props.event === null ? 'flow/run' : 'flow/send', props.event);
        settle(props.requestId, { ok: true, started: props.event === null });
      }
      else settle(props.requestId, await env.runtime.effects['flow-dag-run'](props, dispatch));
    }, { dispose }),
  };
  return { read, validate, replace, apply, run, subscribe, attach, effects, dispose };
}
