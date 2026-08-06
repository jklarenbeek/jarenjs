//@ts-check
/**
 * @file The Studio COMPONENT — the IDE. Following the suite's component
 * convention (`createXComponent`), `createStudioComponent(options)` hands
 * the host the pieces it composes into the site's `@jarenjs/app` document:
 * the JSLT view (`rules` + `mode`), the derivation (`viewModel`), the two
 * hard-problem policies (`hostPolicy`, `reconcileBuffer`), and the engine
 * surface. The reducer `project/*` actions, the DOM stage/splitter
 * widgets, and the live site mount are wired at the host; the chrome and
 * its derivation — everything renderable without a DOM — live here and
 * are tested headlessly.
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
