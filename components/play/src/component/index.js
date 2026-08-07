//@ts-check
/**
 * @file The playground COMPONENT — `createPlayComponent(options)`, the
 * suite's factory convention (like `@jarenjs/calc` / `@jarenjs/studio`). It
 * hands the host the JSLT view (`rules` + `mode` + `modes`), the pure
 * derivation (`viewModel`), and the headless engine surface its run loop
 * binds (`runExample`, the registry, the example library). The reducer
 * `play/*` actions and the debounced live-run are wired at the host.
 */

import { ENGINES, EXAMPLES, engineIds, runExample } from '../index.js';
import { playViewModel } from './viewmodel.js';
import { playRules, playModes, PLAY_MODE, PLAY_BASE } from './view.js';

/**
 * Build the playground component.
 * @param {{ operators?: { toOptions: () => any } }} [options] - a host
 *   operator registry threaded to the query/jslt engines
 */
export function createPlayComponent(options = {}) {
  return {
    mode: PLAY_MODE,
    rules: playRules,
    modes: playModes,
    viewModel: playViewModel,
    // the engine surface the host's run loop binds
    engines: ENGINES,
    examples: EXAMPLES,
    engineIds,
    runExample,
    operators: options.operators,
  };
}

export {
  playViewModel, playRules, playModes, PLAY_MODE, PLAY_BASE,
  ENGINES, EXAMPLES, engineIds, runExample,
};
