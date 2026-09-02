//@ts-check
/**
 * @file The one place a contract binding reads its `runtime` option:
 * the record is resolved through `@jarenjs/core/runtime` — nothing given
 * is the platform's own clock, identifier and source — and a malformed
 * record is refused as the binding's OWN host error (`JC1001` for a
 * server, `JC1008` for a client), naming the option, so the refusal
 * reads like every other option refusal of that constructor. Every
 * binding then takes its host facts from the record only where its
 * explicit option (`trace`, `keys`, `now`) is absent: the record
 * injects, it never replaces a published option.
 */

import { resolveRuntime } from '@jarenjs/core/runtime';

/**
 * @typedef {import('@jarenjs/core/runtime').Runtime} Runtime
 */

/**
 * Resolve a binding's `options.runtime`, or refuse it as that binding's
 * host error under the code it refuses every malformed option with.
 * @param {Partial<Runtime> | undefined | null} candidate - `options.runtime`
 * @param {(code: any, reason: string) => Error} host - the binding's host
 *   error constructor
 * @param {'JC1001' | 'JC1008'} code - the binding's malformed-option code
 * @returns {Readonly<Runtime>}
 */
export function resolveHostRuntime(candidate, host, code) {
  try {
    return resolveRuntime(candidate);
  }
  catch (error) {
    throw host(code, `options.runtime: ${error instanceof Error ? error.message : String(error)}`);
  }
}
