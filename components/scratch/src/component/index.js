//@ts-check
/**
 * @file The scratchpad COMPONENT — `createScratchComponent()`, the suite's
 * factory convention (like `@jarenjs/calc` / `@jarenjs/studio`). The JSLT
 * view (example rail + source panes + dataset switcher + run stage), the
 * pure `scratchViewModel`, and the `scratch` mode land in the next order;
 * for now the factory hands the host the headless engine surface it
 * composes.
 */

import { ENGINES, EXAMPLES, engineIds, runExample } from '../index.js';

/**
 * Build the scratchpad component.
 * @param {{ operators?: { toOptions: () => any } }} [options] - a host
 *   operator registry threaded to the query/jslt engines
 */
export function createScratchComponent(options = {}) {
  return {
    engines: ENGINES,
    examples: EXAMPLES,
    engineIds,
    runExample,
    operators: options.operators,
  };
}

export { ENGINES, EXAMPLES, engineIds, runExample };
