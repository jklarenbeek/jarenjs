//@ts-check
/**
 * @file The playground COMPONENT — `createPlayComponent(options)`, the
 * suite's factory convention (like `@jarenjs/calc` / `@jarenjs/studio`). It
 * hands the host the JSLT view (`rules` + `mode` + `modes`), the pure
 * derivation (`viewModel`), and the headless engine surface its run loop
 * binds (`runExample`, the registry, the example library). The reducer
 * `play/*` actions and the debounced live-run are wired at the host.
 */

import { ENGINES, EXAMPLES, engineIds, runExample, switchOption, playMessagesEn, playText } from '../index.js';
import { playViewModel } from './viewmodel.js';
import { playRules, playModes, PLAY_MODE, PLAY_BASE } from './view.js';

/**
 * Build the playground component.
 *
 * The host seams are configured ONCE here and become defaults for every
 * `runExample` call the returned component makes (and, for `messages`,
 * every `viewModel` derivation); a per-call option of the same name still
 * wins, so a caller can vary one run — or switch the language per call. Configuring
 * them at the factory and having them silently ignored is the trap this
 * shape exists to close — a host that registered its operator packs here
 * would otherwise watch `$mean` and `$npv` go missing at run time.
 *
 * @param {{ operators?: { toOptions: () => any },
 *   renderers?: Record<string, Function>, validate?: Function,
 *   messages?: Readonly<Record<string, unknown>> }} [options]
 *   `operators` reaches the query/jslt engines, `renderers` the visual
 *   engines (markdown/mermaid/charts/mdx), `validate` the JSON Schema one,
 *   `messages` (a compiled catalog, see `RunOptions.messages`) the words
 *   of the engines and of the view model
 */
export function createPlayComponent(options = {}) {
  const seams = {};
  if (options.operators !== undefined) seams.operators = options.operators;
  if (options.renderers !== undefined) seams.renderers = options.renderers;
  if (options.validate !== undefined) seams.validate = options.validate;
  if (options.messages !== undefined) seams.messages = options.messages;
  const language = options.messages === undefined ? {} : { messages: options.messages };
  return {
    mode: PLAY_MODE,
    rules: playRules,
    modes: playModes,
    viewModel: (/** @type {{ play?: any }} */ state, /** @type {{ messages?: Readonly<Record<string, unknown>> }} */ perCall = {}) =>
      playViewModel(state, { ...language, ...perCall }),
    // the engine surface the host's run loop binds
    engines: ENGINES,
    examples: EXAMPLES,
    engineIds,
    runExample: (engineId, source, data, perCall = {}) =>
      runExample(engineId, source, data, { ...seams, ...perCall }),
    switchOption,
    operators: options.operators,
  };
}

export {
  playViewModel, playRules, playModes, PLAY_MODE, PLAY_BASE,
  ENGINES, EXAMPLES, engineIds, runExample, switchOption, playMessagesEn, playText,
};
