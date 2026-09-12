//@ts-check
/**
 * The complete project editor and composable host pieces. A host can mount
 * the editor directly, or compose the same actions, projections and controller
 * into its application. Preview runners, templates and storage are injected.
 */

import { describe, validateFile, classifyChange, parseProject } from '../index.js';
import { projectViewModel } from './viewmodel.js';
import { projectRules, projectModes, PROJECT_MODE, PROJECT_BASE } from './view.js';
import { hostPolicy, reconcileBuffer } from './host.js';
import { editorTextarea, errorLine, KIND_BADGE } from './editor.js';

/**
 * Build the Studio component.
 * @param {{ operators?: { toOptions: () => any } }} [options] - a host
 *   operator registry threaded to every per-file validator/derivation
 */
export function createStudioComponent(options = {}) {
  const operators = options.operators;
  return {
    mode: PROJECT_MODE,
    rules: projectRules,
    modes: projectModes,
    /** The IDE view model for the `$.project` slice. */
    viewModel: (state) => projectViewModel(state, { operators }),
    // the two hard-problem policies the stage host / editor consume
    hostPolicy,
    reconcileBuffer,
    // the engine surface a host binds at mount time
    describe: (project) => describe(project, { operators }),
    validateFile: (file) => validateFile(file, { operators }),
    classifyChange,
    parseProject,
  };
}

export {
  projectViewModel, projectRules, projectModes, PROJECT_MODE, PROJECT_BASE,
  hostPolicy, reconcileBuffer, editorTextarea, errorLine, KIND_BADGE,
};

export { createStudioDocumentHost } from './document.js';
export { createProjectHost } from './project.js';
export { p, cards, table, callout, code, errorMessage, error, details, chart, article, search, more } from './shared/nodes.js';
export { tabRule, UI_RULES } from './shared/ui.js';
export { memo1 } from './shared/memo.js';
export { OUR_SCHEMA_OPTIONS } from './shared/schema-options.js';
export { createHostWidget } from './shared/host-widget.js';

export { PROJECT_ACTIONS } from './project-actions.js';
export { createProjectState } from './project-state.js';
export { createProjectController } from './project-controller.js';

export { mountStudioEditor } from './mount.js';

export { editorTextarea as sharedEditorTextarea, errorLine as editorErrorLine, paneSwitcher } from './shared/studio-kit.js';
