//@ts-check
/** Assemble the shared Flow component. The public mount exposes only document operations. */
import { createApp, formEventFields } from '@jarenjs/app';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { createFlowState, createFlowController } from '../../flow-editor.js';
import { FLOW_ACTIONS } from './actions.js';
import { FLOW_RULES, FLOW_FORM_RULES } from './views.js';
import { createFlowRuntime, flowPageViewModel } from './runtime.js';

/** @param {HTMLElement|null} node @param {any} options
 * @returns {{ app: ReturnType<typeof createApp>, editor: Pick<ReturnType<typeof createFlowController>, 'read'|'validate'|'replace'|'apply'|'run'|'subscribe'|'dispose'> }} */
export function createFlowEditor(node, options) {
  let app;
  const runtime = createFlowRuntime({ ...options, getFlow: () => app.getState().flow });
  const controller = createFlowController({ getApp: () => app, runtime });
  app = createApp({
    state: { flow: createFlowState(options) },
    actions: { ...FLOW_ACTIONS, ...(options.resetDocument ? {
      'flow/clear': { effects: [{ run: 'flow-reset-document' }] },
    } : {}) },
    view: { $jslt: '0.1', modes: { flow: { unmatched: 'error' } }, rules: [
      { match: '$', body: options.resetDocument
        ? ['div', { class: 'project-flow' }, { $apply: ['$.ui.flow', 'flow'] }]
        : { $apply: ['$.ui.flow', 'flow'] } }, ...FLOW_RULES, ...FLOW_FORM_RULES,
    ] },
  }, {
    node, document: node?.ownerDocument, schedule: options.schedule,
    compileTypeTest: createTypeTestCompiler(), eventFields: formEventFields,
    viewModel: state => ({ ui: { flow: flowPageViewModel(state.flow, options.templates) } }),
    widgets: { 'flow-doc': runtime.widget },
    effects: { ...runtime.effects, ...controller.effects,
      'flow-reset-document': () => app.dispatch('flow/load', { kind: options.kind,
        doc: structuredClone(options.document), runContext: structuredClone(options.input ?? null),
        dagInput: JSON.stringify(options.input ?? null) }),
    },
    onError: options.onError,
  });
  controller.attach();
  const editor = {
    read: controller.read, validate: controller.validate, replace: controller.replace,
    apply: controller.apply, run: controller.run, subscribe: controller.subscribe,
    dispose() { controller.dispose(); app.destroy(); },
  };
  return { app, editor };
}

/**
 * @param {HTMLElement|null} node
 * @param {{ kind?: 'fsm'|'dag'|null, document?: any, input?: any, templates?: any[],
 *   template?: (name: string) => any, tasks?: Record<string, Function>,
 *   schedule?: (flush: () => void) => void, onError?: (error: Error) => void }} [options]
 */
export function mountFlowEditor(node, options = {}) { return createFlowEditor(node, options).editor; }
