//@ts-check
/**
 * @file `action()`, `transition()`, `effect()` and `bind()` — the
 * transition half of an app document (APP-FORMAT §3–§5.1) and the event
 * binding that reaches it (§4).
 *
 * An action is ONE query document over the state, so everything inside
 * it — a patch value, an effect's props, a branch — is captured in the
 * same scope, in one pass: `transition()` and `effect()` therefore
 * assemble plain objects and leave the spelling to the capture that is
 * already running, rather than starting their own. That is also what
 * makes the format's own guarantee expressible: the increment in a
 * patch and the one in the effect's props are the SAME expression,
 * because both evaluate against the pre-transition state.
 *
 * A binding is built at RENDER time by the view stylesheet, so `bind()`
 * is the same kind of value in a JSLT body — a payload may embed the
 * matched node's own members, which is why the format needs no
 * payload-creator function.
 */

import { LinqBuildError } from '../errors.js';
import { effectDescriptor, readEffects } from '../effect.js';
import { describeValue } from '../json-boundary.js';
import { isSchemaBuilder } from '../schema/brand.js';
import { captureAction } from './capture.js';
import { readPatch } from './patch.js';

/** The action brand: how `defineApp` tells a captured action apart. */
export const ACTION = Symbol.for('@jarenjs/linq/app-action');

/** The members `action()` takes beside its callback — both TYPES only. */
const ACTION_MEMBERS = Object.freeze(['payload', 'event']);

/** The members a transition object carries, in §3.2's order of application. */
const TRANSITION_MEMBERS = Object.freeze(['state', 'patch', 'effects']);

/** The members §4 gives the object binding form. */
const BIND_MEMBERS = Object.freeze(['payload', 'event', 'preventDefault', 'stopPropagation']);

/**
 * The host-object-valued fields §3.1 excludes BY NAME. Every OTHER name
 * is allowed — the built-in allow-list and a host extractor registered
 * under any name it likes are both legal, and the pen cannot see the
 * host's registry — but an extractor registered under one of these
 * would shadow the exclusion the format exists to state, so the pen
 * refuses the request and names §5.4's own worked example instead.
 */
const EXCLUDED_FIELDS = new Set([
  'target', 'currentTarget', 'relatedTarget', 'srcElement', 'view',
  'files', 'dataTransfer', 'touches', 'targetTouches', 'changedTouches',
  'path', 'composedPath', 'clipboardData', 'submitter',
]);

/** @param {any} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A member set the pen knows, or `JL0101` naming the one it does not.
 * @param {any} spec
 * @param {readonly string[]} members
 * @param {string} what
 */
function closedTo(spec, members, what) {
  for (const key of Object.keys(spec)) {
    if (!members.includes(key)) {
      throw new LinqBuildError('JL0101',
        `${what} does not take '${key}' — it takes ${members.join(', ')}`, `/${key}`);
    }
  }
}

/**
 * A schema builder that TYPES something the document does not carry.
 * @param {any} value
 * @param {string} what - the member's own name, a NOUN: the message makes
 *   it the subject of a sentence, so a phrase here reads as nonsense
 * @param {string} types - what the builder types, for the clause after it
 * @param {string} at
 */
function typeOnly(value, what, types, at) {
  if (!isSchemaBuilder(value)) {
    throw new LinqBuildError('JL0101',
      `${what} is a schema-pen builder — it types ${types}, and the app format carries no `
      + `schema for it, so nothing is emitted for it; got ${describeValue(value)}`, at);
  }
}

/**
 * One effect invocation (§5.1): `{ run, with? }`. The props are a value
 * in the action's own scope — an expression, a literal, or a tree of
 * both — because the action capture spells the whole transition.
 * @param {string} run - the registered handler name (`options.effects[run]`)
 * @param {any} [props] - the handler's `with`
 * @returns {any} the effect declaration
 * @example
 * effect('http', { url: '/api/todos', done: 'todo/loaded' });
 * effect('contract', { op: 'catalog.load', input: x.payload });
 */
export function effect(run, props = undefined) {
  return effectDescriptor(run, props, (value) => value);
}

/**
 * A transition object (§3.2): the next state whole, an RFC 6902 patch
 * over it, and the effects that run after it settles — written in the
 * order the runtime applies them.
 *
 * Returning nothing from an action is the format's own no-op; a
 * transition with no member is that same empty object, and is allowed.
 *
 * @param {{ state?: any, patch?: readonly any[], effects?: readonly any[] }} spec
 * @returns {any} the transition, for the action capture to spell
 * @throws {LinqBuildError} `JL0101` a member the pen does not know, or a
 *   patch/effects list that is not one
 * @example
 * transition({ patch: [add((st) => st.todos, x.payload)] });
 * transition({ state: () => null, effects: [effect('save')] });
 */
export function transition(spec) {
  if (!isPlainObject(spec)) {
    throw new LinqBuildError('JL0101',
      `transition() takes { state?, patch?, effects? }, got ${describeValue(spec)}`);
  }
  closedTo(spec, TRANSITION_MEMBERS, 'transition()');
  const out = {};
  if (spec.state !== undefined) out.state = spec.state;
  if (spec.patch !== undefined) out.patch = readPatch(spec.patch);
  if (spec.effects !== undefined) out.effects = readEffects(spec.effects, 'transition() effects');
  return out;
}

/**
 * One action document (§3): a callback captured over the state, `$event`
 * and `$payload`, whose result is a transition.
 *
 * `payload` and `event` type what the dispatch carries — the format
 * holds no schema for either, so the pen emits nothing for them; what
 * they buy is the typed `x.payload` and the `$event` members an action
 * may read.
 *
 * @param {(state: any, externals: any) => any} fn - `(s, x) => transition(…)`
 * @param {{ payload?: any, event?: readonly string[] }} [options]
 * @returns {any} the action declaration
 * @throws {LinqBuildError} `JL0101` a member the pen does not know, or a
 *   `payload` that is not a builder; `JL0102` an `event` field §3.1
 *   excludes; `JL0104` a name §3.1 does not bind
 * @example
 * action((s, x) => transition({ patch: [add((st) => st.todos, x.payload)] }),
 *   { payload: s.object({ text: s.string() }) });
 */
export function action(fn, options = undefined) {
  if (typeof fn !== 'function') {
    throw new LinqBuildError('JL0101',
      `action() takes a callback (s, x) => transition(…), got ${describeValue(fn)}`);
  }
  if (options !== undefined) {
    if (!isPlainObject(options)) {
      throw new LinqBuildError('JL0101',
        `action() options are { payload?, event? }, got ${describeValue(options)}`);
    }
    closedTo(options, ACTION_MEMBERS, 'action()');
    if (options.payload !== undefined) {
      typeOnly(options.payload, 'action() payload', "the dispatch's $payload", '/payload');
    }
    if (options.event !== undefined) readEventFields(options.event, 'action()');
  }
  const document = captureAction('action()', fn);
  const out = { document };
  Object.defineProperty(out, ACTION, { value: true, enumerable: false });
  return Object.freeze(out);
}

/**
 * The `event` member of a binding (§4): an array of the extra `$event`
 * field names to resolve. A name §3.1 excludes by construction is
 * `JL0102`; every other name is allowed, because a host extractor
 * registered under it wins over the built-in list and the pen cannot
 * see the host's registry.
 * @param {any} fields
 * @param {string} what
 * @returns {string[]}
 */
function readEventFields(fields, what) {
  if (!Array.isArray(fields)) {
    throw new LinqBuildError('JL0101',
      `${what} event is an array of field names (APP-FORMAT §4), got ${describeValue(fields)}`,
      '/event');
  }
  return fields.map((name, i) => {
    if (typeof name !== 'string' || name === '') {
      throw new LinqBuildError('JL0101',
        `${what} event[${i}] is a field name, got ${describeValue(name)}`, `/event/${i}`);
    }
    if (EXCLUDED_FIELDS.has(name)) {
      throw new LinqBuildError('JL0102',
        `an event binding cannot request '${name}' — APP-FORMAT §3.1 excludes target, files, `
        + 'touch lists and every other host-object-valued field by construction, because '
        + '$event MUST survive JSON.stringify, the same invariant as state. Register an '
        + 'extractor under a name of its own (§5.4\'s worked example maps event.target.files '
        + "to opaque string tokens under 'fileTokens') and request that.", `/event/${i}`);
    }
    return name;
  });
}

/**
 * One event binding (§4): `{ action, with?, event?, preventDefault?,
 * stopPropagation? }`, in the member order the format writes them.
 *
 * A payload is data built at render time, so it may embed anything in
 * the stylesheet body's scope — the matched node's own members, `$path`,
 * `$root` — which is what replaces a payload-creator function.
 *
 * @template {string} Names
 * @param {Names} name - the action to dispatch
 * @param {{ payload?: any, event?: readonly string[], preventDefault?: boolean, stopPropagation?: boolean }} [options]
 * @returns {any} the binding, for the view's body capture to spell
 * @throws {LinqBuildError} `JL0101` an empty name, a member the pen does
 *   not know, or a non-boolean control; `JL0102` an `event` field §3.1 excludes
 * @example
 * bind('selectRow', { payload: { id: v.id }, event: ['shiftKey', 'ctrlKey'] });
 * bind('rowOpen', { stopPropagation: true });
 */
export function bind(name, options = undefined) {
  if (typeof name !== 'string' || name === '') {
    throw new LinqBuildError('JL0101',
      `bind() takes an action name as a non-empty string, got ${describeValue(name)}`,
      '/action');
  }
  const out = { action: name };
  if (options !== undefined) {
    if (!isPlainObject(options)) {
      throw new LinqBuildError('JL0101',
        'bind() options are { payload?, event?, preventDefault?, stopPropagation? }, got '
        + describeValue(options));
    }
    closedTo(options, BIND_MEMBERS, 'bind()');
    if (options.payload !== undefined) out.with = options.payload;
    if (options.event !== undefined) out.event = readEventFields(options.event, 'bind()');
    for (const control of ['preventDefault', 'stopPropagation']) {
      if (options[control] === undefined) continue;
      if (typeof options[control] !== 'boolean') {
        throw new LinqBuildError('JL0101',
          `bind() ${control} is a boolean — it is allowed only on the object binding form `
          + `and defaults to false (APP-FORMAT §4), got ${describeValue(options[control])}`,
          `/${control}`);
      }
      out[control] = options[control];
    }
  }
  return out;
}
