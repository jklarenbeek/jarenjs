//@ts-check
/** @typedef {{ document: { model: any, query: any }, buffers: { modelText: string, queryText: string }, revision: string, result: any, explain: any }} DataSnapshot */
/** @typedef {{ ok: boolean, document?: any, revision?: string, conflict?: boolean, error?: string,
 * errors?: any[], valid?: boolean, total?: number, code?: string, result?: any, explain?: any, model?: any }} EditorReceipt */
/** Data document publication and execution use the same queued actions as the UI. */
import { semanticKey } from '@jarenjs/core/object';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { validateFile } from '../validate.js';

/** @param {{ getApp: () => any, runtime: any, operators?: { toOptions: () => any } }} env */
export function createDataController(env) {
  let disposed = false, detach = null, sequence = 0;
  const pending = new Map(), listeners = new Set();
  const parse = text => { try { return JSON.parse(text); } catch { return null; } };
  /** @returns {DataSnapshot} */
  function read() {
    const data = env.getApp().getState().data;
    const buffers = { modelText: data.modelText, queryText: data.queryText };
    return { document: { model: parse(data.modelText), query: parse(data.queryText) }, buffers,
      revision: semanticKey(buffers), result: structuredClone(data.results), explain: structuredClone(data.explain) };
  }
  /** @param {{ model: any, query: any }} candidate */
  function validate(candidate) {
    try {
      if (candidate === null || typeof candidate !== 'object' || !Object.hasOwn(candidate, 'model') || !Object.hasOwn(candidate, 'query'))
        throw new TypeError('A Data document contains model and query members.');
      const errors = ['model', 'query'].flatMap(kind => validateFile({ kind, text: JSON.stringify(candidate[kind]) }, { operators: env.operators })
        .errors.map(error => ({ ...error, member: kind })));
      return { valid: errors.length === 0, total: errors.length, errors };
    }
    catch (error) { return { valid: false, total: 1, errors: [{ code: error.code ?? null, message: error.message }] }; }
  }
  function settle(id, outcome) { const resolve = pending.get(id); pending.delete(id); resolve?.({ ...read(), ...outcome }); }
  /** @param {{ model: any, query: any }} candidate @param {{ expectedRevision?: string }} [options]
   * @returns {Promise<EditorReceipt>}
   */
  function replace(candidate, options = {}) {
    if (disposed) return Promise.resolve({ ok: false, error: 'The Data editor is disposed.' });
    const before = read();
    if (before.revision !== options.expectedRevision) return Promise.resolve({ ok: false, conflict: true, ...before });
    const checked = validate(candidate);
    if (!checked.valid) return Promise.resolve({ ok: false, ...checked });
    return new Promise(resolve => {
      const id = ++sequence; pending.set(id, resolve);
      env.getApp().dispatch('data/replace', { requestId: id, expected: before.buffers,
        modelText: JSON.stringify(candidate.model, null, 2), queryText: JSON.stringify(candidate.query, null, 2) });
    });
  }
  /** @param {Parameters<typeof applyJSONPatch>[1]} patch @param {{ expectedRevision?: string }} [options]
   * @returns {Promise<EditorReceipt>}
   */
  function apply(patch, options) {
    try { return replace(applyJSONPatch(read().document, patch), options); }
    catch (error) { return Promise.resolve({ ok: false, error: error.message, code: error.code }); }
  }
  /** Query the open store, or explicitly recreate it through the owning host.
   * @param {{ operation?: 'query'|'open', externals?: Record<string, any> }} [options]
   * @returns {Promise<EditorReceipt>}
   */
  function run(options = {}) {
    if (disposed) return Promise.resolve({ ok: false, error: 'The Data editor is disposed.' });
    const operation = options.operation ?? 'query';
    if (!['query', 'open'].includes(operation)) return Promise.resolve({ ok: false, error: 'The Data operation must be query or open.' });
    return new Promise(resolve => {
      const id = ++sequence; pending.set(id, resolve);
      env.getApp().dispatch('data/execute', { requestId: id, operation, externals: options.externals ?? {} });
    });
  }
  /** @param {(snapshot: DataSnapshot) => void} listener */
  function subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); }
  function attach() {
    if (disposed || detach) return;
    let revision = read().revision;
    detach = env.getApp().subscribe(() => {
      const value = read();
      if (revision !== value.revision) { revision = value.revision; for (const listener of listeners) listener(value); }
    });
  }
  function dispose() {
    if (disposed) return;
    disposed = true; detach?.(); detach = null; listeners.clear(); env.runtime.dispose();
    for (const resolve of pending.values()) resolve({ ok: false, error: 'The Data editor is disposed.' });
    pending.clear();
  }
  const effects = {
    'data-accepted': id => settle(id, { ok: true }),
    'data-refused': id => settle(id, { ok: false, conflict: true }),
    'data-editor-run': Object.assign(async (props, dispatch) => {
      if (disposed) { settle(props.requestId, { ok: false, error: 'The Data editor is disposed.' }); return; }
      const result = await env.runtime.effects[props.operation === 'open' ? 'data-open' : 'data-run'](props, dispatch);
      settle(props.requestId, result);
    }, { dispose }),
  };
  return { read, validate, replace, apply, run, subscribe, attach, effects, dispose };
}
