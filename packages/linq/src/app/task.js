//@ts-check
/**
 * @file `taskSlot(name, { at, mode?, fail? })` — the async-task
 * convention of TASKS.md written once: the slot's initial value and its
 * four actions, `<name>/start`, `<name>/done`, `<name>/fail` and
 * `<name>/cancel`.
 *
 * What the convention asks a hand-written document to keep right, the
 * slot keeps by construction:
 *
 * - the start action's increment is ONE expression, written into the
 *   patch and into the effect's `with.id` — both evaluate against the
 *   pre-transition state, so a `with.id` that read the patched slot would
 *   ship the old id and every completion would be rejected as stale;
 * - every completion guards on `$payload.id` against the slot's current
 *   id and has no else branch: a stale completion is the empty sequence,
 *   the format's no-op transition.
 *
 * Failures reach `done` by default — the single-completion shape the
 * effect helper defaults to, told apart with `$exists: "$payload.error"`
 * — or, with `fail: true`, an action of their own that the start names
 * in the effect's `fail`. `mode: 'exhaust'` adds the document-side guard
 * (a start while the slot is loading changes nothing); the host still
 * registers `createTaskEffect` with the same mode, because a document
 * cannot carry a host option.
 */

import { isJsonObject } from '@jarenjs/core/object';
import { LinqBuildError } from '../errors.js';
import { isExpression } from '../expression.js';
import { describeValue } from '../json-boundary.js';
import { action, effect, transition } from './action.js';
import { when } from './conditional.js';
import { readPatch, replace } from './patch.js';

/** The members `taskSlot` reads: a closed set. */
const SLOT_OPTIONS = Object.freeze(['at', 'mode', 'fail']);

/** `createTaskEffect`'s concurrency modes (TASKS.md, APP-FORMAT §9.2). */
const MODES = Object.freeze(['switch', 'exhaust', 'concat', 'parallel']);

/** The effect props the slot writes itself. */
const SLOT_PROPS = Object.freeze(['id', 'done', 'fail', 'slot']);

/**
 * What a `start`/`done`/`fail` argument is: a value, or a callback over
 * the action's own scope (where `x.payload` lives).
 * @param {any} value
 * @param {any} state
 * @param {any} externals
 */
const inScope = (value, state, externals) => (typeof value === 'function' ? value(state, externals) : value);

/**
 * The slot's own actions over one location in the state.
 * @param {string} name - the slot name: the actions' prefix and the
 *   effect's `slot` (its concurrency key)
 * @param {{ at: (state: any) => any, mode?: string, fail?: boolean }} options
 * @returns {any} `{ initial, start, done, fail, cancel }`
 * @throws {LinqBuildError} `JL0101` a name, an option or an argument
 *   that is not what it takes
 * @example
 * const list = taskSlot('list', { at: (s) => s.tasks.list });
 * defineApp({ state, initial: { tasks: { list: list.initial } }, view, actions: {
 *   ...list.start('http', { url: '/api/items' }),
 *   ...list.done((s, x) => [replace((st) => st.items, x.payload.result)]),
 * } });
 */
export function taskSlot(name, options) {
  if (typeof name !== 'string' || name === '') {
    throw new LinqBuildError('JL0101', `taskSlot() takes a slot name as a non-empty string, got ${describeValue(name)}`);
  }
  // a plain object, not a JSON one: `at` is a function
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new LinqBuildError('JL0101', `taskSlot() options are { at, mode?, fail? }, got ${describeValue(options)}`);
  }
  for (const key of Object.keys(options)) {
    if (!SLOT_OPTIONS.includes(key)) {
      throw new LinqBuildError('JL0101', `taskSlot() does not take '${key}' — it takes ${SLOT_OPTIONS.join(', ')}`, `/${key}`);
    }
  }
  const { at, mode = 'switch', fail = false } = options;
  if (typeof at !== 'function') {
    throw new LinqBuildError('JL0101',
      `taskSlot() at is a lambda over the state to the slot — (s) => s.tasks.${name} — got ${describeValue(at)}`, '/at');
  }
  if (!MODES.includes(mode)) {
    throw new LinqBuildError('JL0101', `taskSlot() mode is one of ${MODES.join(', ')}, got ${describeValue(mode)}`, '/mode');
  }
  if (typeof fail !== 'boolean') {
    throw new LinqBuildError('JL0101', `taskSlot() fail is a boolean, got ${describeValue(fail)}`, '/fail');
  }
  const names = { start: `${name}/start`, done: `${name}/done`, fail: `${name}/fail`, cancel: `${name}/cancel` };
  /** The slot's location: a path into the state, which every action reads and
   * writes. Anything else is refused by name, here, rather than as the
   * TypeError a member read off it would be. @param {any} state */
  const slotAt = (state) => {
    const slot = at(state);
    if (!isExpression(slot)) {
      throw new LinqBuildError('JL0101', `taskSlot() at is a lambda over the state to the slot — `
        + `(s) => s.tasks.${name} — and answered ${describeValue(slot)}, which is no path into the state`, '/at');
    }
    return slot;
  };
  /** @param {(slot: any) => any} member */
  const path = (member) => (/** @type {any} */ state) => member(slotAt(state));
  /** @param {any} patch @param {any} state @param {any} externals @param {string} who */
  const userPatch = (patch, state, externals, who) => (patch === undefined ? []
    : readPatch(inScope(patch, state, externals), who));
  /** The stale guard every completion opens with. @param {any} state @param {any} externals */
  const current = (state, externals) => externals.payload.id.eq(slotAt(state).id);

  return Object.freeze({
    initial: Object.freeze({ id: 0, status: 'idle', error: null }),
    /**
     * The start action: the slot to loading under its next id, and the
     * effect that carries that id. @param {string} run @param {any} [props]
     */
    start(run, props = undefined) {
      if (typeof run !== 'string' || run === '') {
        throw new LinqBuildError('JL0101', `start() takes the effect handler's name, got ${describeValue(run)}`);
      }
      const declared = action((state, externals) => {
        const given = inScope(props, state, externals) ?? {};
        if (!isJsonObject(given)) {
          throw new LinqBuildError('JL0101', `start() props are an object of the effect's own props, got ${describeValue(given)}`);
        }
        const taken = Object.keys(given).find((key) => SLOT_PROPS.includes(key));
        if (taken !== undefined) {
          throw new LinqBuildError('JL0101',
            `start() props cannot set '${taken}' — id, done, fail and slot are the slot's own (TASKS.md)`, `/${taken}`);
        }
        // the increment, written ONCE: the patch and the effect's id both
        // evaluate against the pre-transition state
        const next = slotAt(state).id.add(1);
        const started = transition({
          patch: [
            replace(path((slot) => slot.id), next),
            replace(path((slot) => slot.status), 'loading'),
            replace(path((slot) => slot.error), null),
          ],
          effects: [effect(run, {
            id: next, done: names.done, ...(fail ? { fail: names.fail } : {}), slot: name, ...given,
          })],
        });
        return mode === 'exhaust' ? when(slotAt(state).status.ne('loading'), started) : started;
      });
      return Object.freeze({ [names.start]: declared });
    },
    /** The completion: the result in, or — without `fail: true` — the
     * error. @param {any} [patch] */
    done(patch = undefined) {
      const declared = action((state, externals) => {
        const succeeded = transition({ patch: [replace(path((slot) => slot.status), 'done'), ...userPatch(patch, state, externals, 'done()')] });
        const settled = fail ? succeeded
          : when(externals.payload.error.exists(), transition({ patch: [
            replace(path((slot) => slot.status), 'error'),
            replace(path((slot) => slot.error), externals.payload.error),
          ] }), succeeded);
        return when(current(state, externals), settled);
      });
      return Object.freeze({ [names.done]: declared });
    },
    /** The failure, when the slot routes it to an action of its own.
     * @param {any} [patch] */
    fail(patch = undefined) {
      if (!fail) {
        throw new LinqBuildError('JL0101',
          `the slot '${name}' sends a failure to ${names.done}, so it has no fail action — create it with `
          + '{ fail: true } to route failures to their own');
      }
      const declared = action((state, externals) => when(current(state, externals), transition({ patch: [
        replace(path((slot) => slot.status), 'error'),
        replace(path((slot) => slot.error), externals.payload.error),
        ...userPatch(patch, state, externals, 'fail()'),
      ] })));
      return Object.freeze({ [names.fail]: declared });
    },
    /**
     * The host's cancellation, in the document. `cancel(slot)` and
     * `cancelAll()` abort the request and dispatch nothing (TASKS.md), so
     * the host that cancels the slot dispatches `<name>/cancel` beside it:
     * a loading slot goes back to `idle` under a new id, an `exhaust`
     * slot takes the next start, and a completion that still arrives is
     * stale. A slot that is not loading is left as it is.
     */
    cancel() {
      const declared = action((state) => when(slotAt(state).status.eq('loading'), transition({ patch: [
        replace(path((slot) => slot.id), slotAt(state).id.add(1)),
        replace(path((slot) => slot.status), 'idle'),
      ] })));
      return Object.freeze({ [names.cancel]: declared });
    },
  });
}
