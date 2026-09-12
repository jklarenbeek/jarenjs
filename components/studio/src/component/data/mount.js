//@ts-check
/** Mount the same Data component used by composed hosts, with an injected transport. */
import { createApp, formEventFields } from '@jarenjs/app';
import { createDataRuntime } from '../../data/runtime.js';
import { createDataController } from '../../data/editor.js';
import { createDataState } from '../../data/state.js';
import { DATA_ACTIONS } from './actions.js';
import { DATA_RULES } from './views.js';
import { dataViewModel } from './viewmodel.js';

/**
 * @param {HTMLElement|null} node
 * @param {{ model: any, query: any, transport: () => ReturnType<typeof import('../../data/transport.js').createTransport>,
 *   seeds?: any[], createRow?: (text: string) => any, migration?: (model: any, collection: string) => { to: any, id: string },
 *   trip?: any, corpus?: () => Promise<any>, executor?: string, operators?: { toOptions: () => any }, lifecycleTarget?: any,
 *   schedule?: (flush: () => void) => void, onError?: (error: Error) => void }} options
 */
export function mountDataEditor(node, options) {
  let app, settleReady, disposed = false, active = true;
  /** @type {Promise<{ ok: boolean, error?: string | { code: string, stage: string, message: string } }>} */
  let ready = new Promise(resolve => { settleReady = resolve; });
  const runtime = createDataRuntime(options), controller = createDataController({ ...options, getApp: () => app, runtime });
  app = createApp({
    state: { active: true, data: createDataState() }, actions: { ...DATA_ACTIONS,
      'data/active': { patch: [{ op: 'replace', path: '/active', value: '$payload' },
        { op: 'replace', path: '/data/status', value: { $if: ['$payload', 'boot', '$.data.status'] } }] },
    }, subs: [{ run: 'data-owner', when: '$.active' }],
    view: { $jslt: '0.1', modes: { data: { unmatched: 'error' } }, rules: [
      { match: '$', body: { $apply: ['$.ui.data', 'data'] } }, ...DATA_RULES,
    ] },
  }, {
    node, document: node?.ownerDocument, schedule: options.schedule, onError: options.onError,
    eventFields: formEventFields(), effects: { ...runtime.effects, ...controller.effects },
    subs: { 'data-owner': runtime.ownerSub }, viewModel: state => ({ ui: { data: dataViewModel(state, options) } }),
  });
  const stopReady = app.subscribe(state => {
    if (!state.active) return;
    if (state.data.status === 'ready') settleReady({ ok: true });
    else if (state.data.status === 'error') settleReady({ ok: false, error: state.data.boot });
  });
  controller.attach();
  return { get ready() { return ready; }, read: controller.read, validate: controller.validate, replace: controller.replace,
    apply: controller.apply,
    /** @param {Parameters<typeof controller.run>[0]} [options] */
    run(options = {}) { return active && !disposed ? controller.run(options)
      : Promise.resolve({ ok: false, error: disposed ? 'The Data editor is disposed.' : 'The Data editor is inactive.' }); },
    subscribe: controller.subscribe,
    /** Release ownership on route exit while retaining every raw editing buffer.
     * Reactivation reopens the last accepted model and never seeds over typing.
     * @param {boolean} next */
    setActive(next) {
      if (disposed) return Promise.resolve({ ok: false, error: 'The Data editor is disposed.' });
      if (next === active) return ready;
      active = next;
      settleReady({ ok: false, error: 'The Data editor is inactive.' });
      ready = next ? new Promise(resolve => { settleReady = resolve; })
        : Promise.resolve({ ok: false, error: 'The Data editor is inactive.' });
      app.dispatch('data/active', next);
      return ready;
    },
    dispose() { if (disposed) return; disposed = true; settleReady({ ok: false, error: 'The Data editor is disposed.' }); stopReady(); controller.dispose(); app.destroy(); },
  };
}
