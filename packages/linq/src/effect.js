//@ts-check
/**
 * @file The effect descriptor two formats spell identically —
 * `{ run, with? }` — under a machine's `entry`/`exit`/`effects`
 * (FLOW-FORMAT §2) and under an app transition's `effects`
 * (APP-FORMAT §5.1). One shape, one brand, one reader; what differs is
 * only where the props come from, which each pen passes in: the flow
 * pen captures them over the step scope, the app pen leaves them to the
 * action capture already in progress.
 *
 * `run` is a name the pen writes and never resolves — the host's
 * registry owns the handler. What an unregistered name costs differs by
 * engine and neither cost is the pen's: an app document's action loop
 * refuses it (`JA2006`), while `compileFsm` never looks one up at all,
 * because FLOW-FORMAT §1.1 makes effect EXECUTION a non-goal — the
 * descriptor comes back as data and the host decides what to do with it.
 */

import { LinqBuildError } from './errors.js';
import { describeValue } from './json-boundary.js';

/** The descriptor brand: how a pen tells `effect()`'s result apart. */
export const EFFECT = Symbol.for('@jarenjs/linq/effect-descriptor');

/**
 * One `{ run, with? }` descriptor, branded and frozen.
 * @param {string} run - the host-registered handler name
 * @param {any} props - the `with` member, or `undefined`
 * @param {(props: any) => any} readProps - how this pen spells the props
 * @returns {any} the effect declaration
 */
export function effectDescriptor(run, props, readProps) {
  if (typeof run !== 'string' || run === '') {
    throw new LinqBuildError('JL0101',
      `effect() takes the handler name as a non-empty string, got ${describeValue(run)}`, '/run');
  }
  const out = { run };
  if (props !== undefined) out.with = readProps(props);
  Object.defineProperty(out, EFFECT, { value: true, enumerable: false });
  return Object.freeze(out);
}

/**
 * An effects list, as a document carries it: plain `{ run, with? }`
 * objects, the brand dropped.
 * @param {any} list
 * @param {string} what - the member, for the message
 * @returns {any[]}
 */
export function readEffects(list, what) {
  if (!Array.isArray(list)) {
    throw new LinqBuildError('JL0101',
      `${what} is an array of effect() descriptors, got ${describeValue(list)}`);
  }
  return list.map((declared, i) => {
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)
      || declared[EFFECT] !== true) {
      throw new LinqBuildError('JL0101',
        `${what}[${i}] is effect(run, with?), got ${describeValue(declared)}`);
    }
    const out = { run: declared.run };
    if (declared.with !== undefined) out.with = declared.with;
    return out;
  });
}
