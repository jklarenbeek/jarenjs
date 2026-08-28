//@ts-check
/**
 * @file `defineFsm()` — one `jaren-fsm` 0.1 document
 * (FLOW-FORMAT.md §2), deep-frozen, that `compileFsm` and `fsmToApp`
 * take unchanged. `state()` declares one state, `on()` one transition
 * (`.when()` its guard, `.to()` its target, `.effects()` its
 * descriptors) and `effect()` one `{ run, with? }`.
 *
 * Guards and `with` members are captured over FLOW-FORMAT §3's scope —
 * `{ state, event, payload, context }` at `$` — so `(s) =>
 * s.payload.fresh` writes `"$.payload.fresh"` and `() => ({ text:
 * 'retrying' })` writes the constructor the format's own example
 * carries. The one trap the format names is refused here: a guard given
 * as a plain STRING is `JL0102`, because §3 makes a non-`$` literal
 * vacuously TRUE and a picture's display annotation must never decide
 * execution.
 *
 * State ids are literal types, so a transition into an undeclared state
 * is a compile error; at runtime it is `JL0102` naming the state,
 * before the compiler's `JF0006`. What the pen does NOT judge is the
 * compiler's: duplicate ids (`JF0003`), a guard's operators (`JF0007`)
 * and everything else §5.1 lists.
 */

import { deepFreeze } from '@jarenjs/core/object';

import { LinqBuildError } from '../errors.js';
import { effectDescriptor, readEffects } from '../effect.js';
import { describeValue } from '../json-boundary.js';
import { isSchemaBuilder } from '../schema/brand.js';
import { queryMember } from './capture.js';

const FSM_VERSION = '0.1';

/** FLOW-FORMAT §3's scope, for a `JL0104` message. */
const SCOPE = 'the step scope { state, event, payload, context } (FLOW-FORMAT §3)';

/** The state-declaration brand: how `defineFsm` tells one apart. */
const STATE = Symbol.for('@jarenjs/linq/flow-state');
/** The transition brand; the entry it carries lives under it. */
const TRANSITION = Symbol.for('@jarenjs/linq/flow-transition');

/** The members `state()` takes, in the order §2 writes them. */
const STATE_MEMBERS = Object.freeze(['entry', 'exit', 'final']);
/** The members `on()` takes beside its two positional arguments. */
const ON_MEMBERS = Object.freeze(['payload']);
/** The members `defineFsm()` takes. */
const FSM_MEMBERS = Object.freeze(['initial', 'states', 'transitions', 'context']);

/** @param {any} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A member set the pen knows, or `JL0101` naming the one it does not.
 * @param {any} spec
 * @param {readonly string[]} members
 * @param {string} what
 * @param {string} [at]
 */
function closedTo(spec, members, what, at = '') {
  for (const key of Object.keys(spec)) {
    if (!members.includes(key)) {
      throw new LinqBuildError('JL0101',
        `${what} does not take '${key}' — it takes ${members.join(', ')}`, `${at}/${key}`);
    }
  }
}

/**
 * A state id: a non-empty string, or `JL0101`.
 * @param {any} id
 * @param {string} what
 * @returns {string}
 */
function readId(id, what) {
  if (typeof id !== 'string' || id === '') {
    throw new LinqBuildError('JL0101',
      `${what} takes a state id — a non-empty string, got ${describeValue(id)}`);
  }
  return id;
}

/**
 * One effect descriptor (§2): `{ run, with? }`, its props captured over
 * the step scope. The engine never executes it — the host's registry
 * does — so `run` is a name the pen writes and never resolves.
 * @param {string} run - the host-registered handler name
 * @param {any} [props] - `(s) => ({ … })`, or a query document
 * @returns {any} the effect declaration
 * @example
 * effect('fetch', (s) => ({ url: s.context.url }));   // { run, with }
 * effect('toast', () => ({ text: 'retrying' }));      // a constructor, not $const
 */
export function effect(run, props = undefined) {
  return effectDescriptor(run, props, (p) => queryMember('effect() with', SCOPE, p));
}

/**
 * One state declaration (§2): `{ id, entry?, exit?, final? }`. A bare
 * string in `states` is the format's own shorthand for `{ id }` and
 * stays one — it is the shape the `jaren-workflow` projection carries.
 * @param {string} id - the state id transitions refer to
 * @param {{ entry?: readonly any[], exit?: readonly any[], final?: boolean }} [options]
 * @returns {any} the state declaration
 * @example
 * state('loading', { entry: [effect('fetch', (s) => ({ url: s.context.url }))] });
 * state('done', { final: true });
 */
export function state(id, options = undefined) {
  const out = { id: readId(id, 'state()') };
  if (options !== undefined) {
    if (!isPlainObject(options)) {
      throw new LinqBuildError('JL0101',
        `state() options are { entry?, exit?, final? }, got ${describeValue(options)}`);
    }
    closedTo(options, STATE_MEMBERS, 'state()');
    if (options.entry !== undefined) out.entry = readEffects(options.entry, 'state() entry');
    if (options.exit !== undefined) out.exit = readEffects(options.exit, 'state() exit');
    if (options.final !== undefined) {
      if (typeof options.final !== 'boolean') {
        throw new LinqBuildError('JL0101',
          `state() final is a boolean, got ${describeValue(options.final)}`, '/final');
      }
      out.final = options.final;
    }
  }
  Object.defineProperty(out, STATE, { value: true, enumerable: false });
  return Object.freeze(out);
}

/**
 * A guard, as the document carries it: a captured body, or a query
 * document by hand. A plain STRING is the one trap FLOW-FORMAT §3 names
 * itself, and the pen refuses it.
 * @param {any} value
 * @returns {any}
 */
function readGuard(value) {
  if (typeof value === 'string') {
    throw new LinqBuildError('JL0102',
      'a guard given as a plain string is asserted by effective boolean value, and a '
      + 'non-empty literal is therefore VACUOUSLY TRUE (FLOW-FORMAT §3: a projected '
      + `display guard must not change execution) — got ${JSON.stringify(value)}; pass a `
      + 'body instead: .when((s) => s.payload.fresh)', '/guard');
  }
  return queryMember('when()', SCOPE, value);
}

/**
 * The transition builder: immutable, one new builder per call, its
 * entry carried under the brand.
 * @param {any} entry
 * @returns {any}
 */
function transition(entry) {
  const out = {
    /**
     * The transition's guard (§3), captured over the step scope.
     * @param {any} guard - `(s) => …`, or a query document
     */
    when(guard) { return transition({ ...entry, guard: readGuard(guard) }); },
    /**
     * The state this transition enters.
     * @param {string} to
     */
    to(to) { return transition({ ...entry, to: readId(to, 'to()') }); },
    /**
     * The transition's own effects, fired between exit and entry (§4).
     * @param {readonly any[]} effects
     */
    effects(effects) {
      return transition({ ...entry, effects: readEffects(effects, 'effects()') });
    },
  };
  Object.defineProperty(out, TRANSITION, { value: entry, enumerable: false });
  return Object.freeze(out);
}

/**
 * One transition (§2), left open until `.to()` names its target.
 * Document order is the whole priority scheme (§4), so the order of the
 * `transitions` array is the order the pen writes.
 * @param {string} from - the state this transition leaves
 * @param {string|null} [event] - the event name; null or absent is a wildcard
 * @param {{ payload?: any }} [options] - the event's payload schema; a
 *   TYPE only, the format carries no payload schema
 * @returns {any} the transition builder
 * @example
 * on('draft', 'submit').to('review');
 * on('review', 'approve').when((s) => s.payload.fresh).to('published');
 * on('review').to('draft');                        // a wildcard, listed last
 */
export function on(from, event = null, options = undefined) {
  const entry = { from: readId(from, 'on()') };
  if (event !== null && event !== undefined) {
    if (typeof event !== 'string' || event === '') {
      throw new LinqBuildError('JL0101',
        'on() takes an event name as a non-empty string, or null for the wildcard that '
        + `matches any event (FLOW-FORMAT §2), got ${describeValue(event)}`, '/event');
    }
    entry.event = event;
  }
  if (options !== undefined) {
    if (!isPlainObject(options)) {
      throw new LinqBuildError('JL0101',
        `on() options are { payload? }, got ${describeValue(options)}`);
    }
    closedTo(options, ON_MEMBERS, 'on()');
    if (options.payload !== undefined && !isSchemaBuilder(options.payload)) {
      throw new LinqBuildError('JL0101',
        'on() payload is a schema-pen builder that types the event\'s payload — the format '
        + `carries no payload schema, so nothing is emitted for it; got ${describeValue(options.payload)}`,
        '/payload');
    }
  }
  return transition(entry);
}

/**
 * Write a `jaren-fsm` 0.1 document (FLOW-FORMAT.md §2).
 *
 * `initial` is declared, never guessed: the format requires the member
 * and `null` is what a document that chooses no start state writes.
 * Every state id `initial` and a transition name must be declared —
 * `JL0102` naming it, before the compiler's `JF0004`/`JF0006`.
 *
 * @param {any} spec - `{ initial, states, transitions, context? }`
 * @returns {any} the deep-frozen `$fsm` 0.1 document
 * @throws {LinqBuildError} `JL0101` a value the pen cannot spell;
 *   `JL0102` a plain-string guard, or an undeclared state id
 * @example
 * const machine = defineFsm({
 *   initial: 'draft',
 *   states: ['draft', 'review', state('published', { final: true })],
 *   transitions: [on('draft', 'submit').to('review'), on('review', 'approve').to('published')],
 * });
 * compileFsm(machine).step('draft', 'submit').state;   // 'review'
 */
export function defineFsm(spec) {
  if (!isPlainObject(spec)) {
    throw new LinqBuildError('JL0101',
      `defineFsm() takes { initial, states, transitions, context? }, got ${describeValue(spec)}`);
  }
  closedTo(spec, FSM_MEMBERS, 'defineFsm()');
  if (spec.context !== undefined && !isSchemaBuilder(spec.context)) {
    throw new LinqBuildError('JL0101',
      'defineFsm() context is a schema-pen builder that types the host data a guard reads '
      + '(FLOW-FORMAT §3) — the format carries no context schema, so nothing is emitted for '
      + `it; got ${describeValue(spec.context)}`, '/context');
  }
  if (!Array.isArray(spec.states)) {
    throw new LinqBuildError('JL0101',
      `defineFsm() states is an array of ids and state() declarations, got ${describeValue(spec.states)}`,
      '/states');
  }

  /** @type {any[]} */
  const states = [];
  /** @type {Set<string>} */
  const declared = new Set();
  spec.states.forEach((entry, i) => {
    if (typeof entry === 'string') {
      declared.add(readId(entry, 'defineFsm() states'));
      states.push(entry);
      return;
    }
    if (!isPlainObject(entry) || entry[STATE] !== true) {
      throw new LinqBuildError('JL0101',
        `defineFsm() states[${i}] is an id or state(id, options?), got ${describeValue(entry)}`,
        `/states/${i}`);
    }
    declared.add(entry.id);
    states.push({ ...entry });
  });

  /**
   * @param {any} id
   * @param {string} what
   * @param {string} at
   */
  const declaredId = (id, what, at) => {
    if (!declared.has(id)) {
      throw new LinqBuildError('JL0102',
        `${what} names the state '${id}', which "states" does not declare — the declared `
        + `states are ${[...declared].map((s) => `'${s}'`).join(', ')}`, at);
    }
    return id;
  };

  if (spec.initial === undefined) {
    throw new LinqBuildError('JL0101',
      'defineFsm() needs an initial state — the format requires the member; pass null for a '
      + 'machine that chooses none (a session then starts with an explicit state)', '/initial');
  }
  if (spec.initial !== null) {
    declaredId(readId(spec.initial, 'defineFsm() initial'), 'defineFsm() initial', '/initial');
  }

  if (!Array.isArray(spec.transitions)) {
    throw new LinqBuildError('JL0101',
      `defineFsm() transitions is an array of on(…) declarations, got ${describeValue(spec.transitions)}`,
      '/transitions');
  }
  const transitions = spec.transitions.map((declaration, i) => {
    const at = `/transitions/${i}`;
    const entry = isPlainObject(declaration) ? declaration[TRANSITION] : undefined;
    if (entry === undefined) {
      throw new LinqBuildError('JL0101',
        `defineFsm() transitions[${i}] is on(from, event?).to(state), got `
        + `${describeValue(declaration)}`, at);
    }
    if (entry.to === undefined) {
      throw new LinqBuildError('JL0101',
        `defineFsm() transitions[${i}] never named its target — on('${entry.from}'`
        + `${entry.event === undefined ? '' : `, '${entry.event}'`}) needs .to(state)`, at);
    }
    const out = { from: declaredId(entry.from, `transition ${i}`, `${at}/from`) };
    if (entry.event !== undefined) out.event = entry.event;
    if (entry.guard !== undefined) out.guard = entry.guard;
    out.to = declaredId(entry.to, `transition ${i}`, `${at}/to`);
    if (entry.effects !== undefined) out.effects = entry.effects;
    return out;
  });

  return deepFreeze({ $fsm: FSM_VERSION, initial: spec.initial, states, transitions });
}
