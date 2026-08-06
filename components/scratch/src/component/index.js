//@ts-check
/**
 * @file The scratchpad COMPONENT — `createScratchComponent(options)`, the
 * suite's factory convention (like `@jarenjs/calc` / `@jarenjs/studio`). It
 * hands the host the JSLT view (`rules` + `mode` + `modes`), the pure
 * derivation (`viewModel`), and the headless engine surface its run loop
 * binds (`runExample`, the registry, the example library). The reducer
 * `scratch/*` actions and the debounced live-run are wired at the host.
 */

import { ENGINES, EXAMPLES, engineIds, runExample } from '../index.js';
import { scratchViewModel } from './viewmodel.js';
import { scratchRules, scratchModes, SCRATCH_MODE, SCRATCH_BASE } from './view.js';

/**
 * Build the scratchpad component.
 * @param {{ operators?: { toOptions: () => any } }} [options] - a host
 *   operator registry threaded to the query/jslt engines
 */
export function createScratchComponent(options = {}) {
  return {
    mode: SCRATCH_MODE,
    rules: scratchRules,
    modes: scratchModes,
    viewModel: scratchViewModel,
    // the engine surface the host's run loop binds
    engines: ENGINES,
    examples: EXAMPLES,
    engineIds,
    runExample,
    operators: options.operators,
  };
}

export {
  scratchViewModel, scratchRules, scratchModes, SCRATCH_MODE, SCRATCH_BASE,
  ENGINES, EXAMPLES, engineIds, runExample,
};
