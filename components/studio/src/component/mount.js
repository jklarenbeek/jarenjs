import { createProjectFlowWidget } from './flow/project-widget.js';
//@ts-check
/** Mount the complete project chrome with the same transitions used by composed hosts. */
import { createApp, formEventFields } from '@jarenjs/app';
import { createProjectController } from './project-controller.js';
import { createProjectState } from './project-state.js';
import { PROJECT_ACTIONS } from './project-actions.js';
import { UI_RULES } from './shared/ui.js';

/**
 * Execution, document rendering, seeds and private data ownership are host services.
 * The returned surface publishes document operations; the app state stays private.
 * @param {HTMLElement | null} node
 * @param {{ project: object, host: any, projectData?: any, projectTemplate?: Function,
 *   templates?: any[], widgets?: Record<string, any>, schedule?: (flush: () => void) => void,
 *   debounceMs?: number, download?: Function, exportProject?: Function, onError?: (error: Error) => void }} options
 */
export function mountStudioEditor(node, options) {
  let app;
  const host = options.host, component = host.projectComponent;
  const controller = createProjectController({ ...options, getApp: () => app });
  app = createApp({
    state: { project: createProjectState(options.project), ide: { shared: null } },
    actions: { ...PROJECT_ACTIONS, 'ide/shared': { patch: [{ op: 'replace', path: '/ide/shared', value: '$payload' }] } },
    view: { $jslt: '0.1', modes: { ...component.modes, ui: { unmatched: 'error' } }, rules: [
      { match: '$', body: { $apply: ['$.ui.project', 'project'] } }, ...component.rules, ...UI_RULES,
    ] },
  }, {
    node, document: node?.ownerDocument, schedule: options.schedule, onError: options.onError,
    eventFields: formEventFields(), effects: controller.effects,
    widgets: { 'studio-flow': createProjectFlowWidget({ schedule: options.schedule }),
      ...(options.projectData ? { 'studio-data': options.projectData.widget } : {}),
      'studio-stage': host.createProjectStageWidget({ schedule: options.schedule }),
      'studio-splitter': host.createProjectSplitterWidget(), ...options.widgets },
    viewModel: state => ({ ui: { project: { ...component.viewModel(state), templates: options.templates ?? [] } } }),
  });
  controller.attach(); controller.commit(); controller.runActive();
  return {
    read: controller.read, validate: controller.validate, replace: controller.replace,
    apply: controller.apply, run: controller.run, subscribe: controller.subscribe,
    dispose() { controller.dispose(); app.destroy(); },
  };
}
