//@ts-check
/** The existing Flow editor as a project-file widget. Its private app only
 * receives the editor's local effects; document effects are recorded, never
 * delegated to the website. Destroy owns the nested app and pending DAG. */
import { createApp, createFormView, formEventFields } from '@jarenjs/app';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { semanticKey } from '@jarenjs/core/object';
import { FLOW_ACTIONS } from '../app/flow-actions.js';
import { FLOW_RULES } from '../views/flowstudio.js';
import { createFlowRuntime, flowPageViewModel } from './flowstudio.js';

const view = {
  $jslt: '0.1', modes: { flow: { unmatched: 'error' } },
  rules: [
    { match: '$', body: ['div', { class: 'project-flow' }, { $apply: ['$.ui.flow.live', 'flow'] }] },
    ...FLOW_RULES,
    ...createFormView({ root: '$.ui.flow.live.inspector.form', actions: {
      input: 'flow/f-input', check: 'flow/f-check', number: 'flow/f-number',
      json: 'flow/f-json', add: 'flow/f-add', remove: 'flow/f-remove',
    } }).map((rule) => ({ ...rule, mode: 'flow' })),
  ],
};

export function createProjectFlowWidget(env = {}) {
  const boot = (handle, props) => {
    const runtime = createFlowRuntime(env);
    handle.runtime = runtime;
    handle.name = props.name;
    handle.revision = props.revision;
    handle.key = semanticKey(props.doc);
    handle.inputKey = semanticKey(props.input ?? null);
    handle.pendingEcho = false;
    let app;
    app = createApp({ state: { flow: {
      kind: props.kind, doc: props.doc, selection: null, connect: null,
      tab: 'diagram', parseError: null, history: { past: [], future: [] },
      run: null, runContext: props.input ?? null, dagInput: JSON.stringify(props.input ?? null),
      revision: 0, mobilePane: 'diagram',
    } }, view, actions: { ...FLOW_ACTIONS,
      // New resets this file; it never opens a different document kind.
      'flow/clear': { effects: [{ run: 'project-flow-reset' }] },
    } }, {
      node: handle.host, document: handle.host.ownerDocument, schedule: env.schedule,
      compileTypeTest: createTypeTestCompiler(), eventFields: formEventFields,
      viewModel: (state) => ({ ui: { flow: flowPageViewModel(state.flow) } }),
      widgets: { 'flow-doc': runtime.widget },
      effects: { ...runtime.effects,
        'project-flow-reset': () => app.setState({ flow: { ...app.getState().flow,
          doc: props.doc, selection: null, run: null, history: { past: [], future: [] } } }),
        'flow-mint': (p, dispatch) => {
          const doc = app.getState().flow.doc;
          const ids = p.kind === 'state' ? new Set(doc.states.map((s) => typeof s === 'string' ? s : s.id))
            : new Set(Object.keys(doc.nodes));
          const prefix = p.kind === 'state' ? 's' : 'n';
          let n = 1;
          while (ids.has(prefix + n)) n++;
          dispatch(p.kind === 'state' ? 'flow/state-minted' : 'flow/node-minted', prefix + n);
        },
      },
      onError: (err) => handle.emit({ action: 'project/stage-error', with: err.message }),
    });
    handle.app = app;
    app.subscribe((state) => {
      const key = semanticKey(state.flow.doc);
      if (key === handle.key) return;
      handle.key = key;
      handle.pendingEcho = true;
      handle.emit({ action: 'project/artifact-edit', with: { name: handle.name, doc: state.flow.doc } });
    });
  };
  const destroy = (h) => { h.runtime?.dispose(); h.app?.destroy(); h.app = null; };
  return {
    mount(host, props, emit) { const h = { host, emit }; boot(h, props); return h; },
    update(h, props) {
      // An echo of our own edit preserves selection, undo and the run pane.
      if (h.name === props.name && h.key === semanticKey(props.doc)
        && h.inputKey === semanticKey(props.input ?? null)
        && (h.pendingEcho || h.revision === props.revision)) {
        h.pendingEcho = false;
        h.revision = props.revision;
        return;
      }
      destroy(h); boot(h, props);
    },
    unmount: destroy,
  };
}
