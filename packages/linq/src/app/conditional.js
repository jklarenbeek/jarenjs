//@ts-check
/**
 * @file `when(cond, then, otherwise?)` — a conditional transition
 * (APP-FORMAT §3.2), the `{ "$if": [cond, then, else?] }` an action
 * returns when only some dispatches should change the state. A missing
 * `otherwise` is the empty sequence, which is the format's own no-op
 * transition: nothing changes, nothing renders, no subscriber fires —
 * the shape the task convention's stale-id guard is (TASKS.md).
 *
 * It lowers its branches as the capture in progress lowers its own
 * result — an action folds nothing, so a branch is spelled as the
 * constructors the format's examples carry — and lifts the operator
 * into that capture: a `$`-keyed plain object in a captured tree would
 * be the `$map` constructor escape, never an operator. A `when()` nests
 * as a branch of another.
 *
 * Not the schema pen's `when` (a JSON Schema `if`/`then`/`else`
 * builder); the name matches the flow pen's transition guard, which is
 * this same idea over a machine.
 */

import { isJsonObject } from '@jarenjs/core/object';
import { LinqBuildError } from '../errors.js';
import { captureFold, captureKind, inCapture, isExpression, liftExpression, toExpression } from '../expression.js';
import { describeValue } from '../json-boundary.js';
import { isTransition, readTransition } from './action.js';

/** The members a transition object carries (§3.2). */
const TRANSITION_MEMBERS = Object.freeze(['state', 'patch', 'effects']);

/** Every conditional `when()` lifted, so a branch can be told apart from
 * any other expression. @type {WeakSet<object>} */
const CONDITIONALS = new WeakSet();

/** What a `when()` is, for a refusal that met one where a value goes. */
const CONDITIONAL_IS = ' — a when() is a transition: an action returns it, or another when() takes it as a '
  + 'branch; write the when() around the transition instead, when(cond, transition({ … }))';

/**
 * The pointer of the first `when()` inside a value — the value itself, or
 * a member or element of the plain objects and arrays it is built of — or
 * `null`. An expression is not entered: what it holds is the capture's.
 * @param {any} value
 * @param {string} at - the pointer of `value`
 * @returns {string | null}
 */
function conditionalAt(value, at) {
  if (value === null || typeof value !== 'object') return null;
  if (isExpression(value)) return CONDITIONALS.has(value) ? at : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = conditionalAt(value[i], `${at}/${i}`);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isJsonObject(value)) return null;
  for (const key of Object.keys(value)) {
    const found = conditionalAt(value[key], `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Refuse a `when()` where a value goes: at dispatch it would replace that
 * value with the branch's transition object, so it is `JL0101` here.
 * @param {any} value
 * @param {string} subject - the place, as the message's subject:
 *   "transition() state is a value"
 * @param {string} at - the pointer of `value`
 */
export function refuseConditional(value, subject, at) {
  const found = conditionalAt(value, at);
  if (found !== null) throw new LinqBuildError('JL0101', `${subject}, got a when()${CONDITIONAL_IS}`, found);
}

/**
 * A branch: a transition, or a conditional `when()` answered. A transition
 * written as a plain object is held to `transition()`'s own rules, so a
 * patch or an effect list that would refuse there refuses here too —
 * never at dispatch, and only when that branch is taken.
 * @param {any} value
 * @param {string} which
 * @returns {any} the branch to lower
 */
function readBranch(value, which) {
  if (isExpression(value)) {
    if (CONDITIONALS.has(value)) return value;
    throw new LinqBuildError('JL0101',
      `when() ${which} is a transition — transition({ … }) — or another when(), got an expression `
      + 'that is neither', `/${which}`);
  }
  if (isTransition(value)) return value;
  if (!isJsonObject(value) || Object.keys(value).some((key) => !TRANSITION_MEMBERS.includes(key))) {
    throw new LinqBuildError('JL0101',
      `when() ${which} is a transition — transition({ state?, patch?, effects? }) — or another `
      + `when(), got ${describeValue(value)}`, `/${which}`);
  }
  try {
    return readTransition(value, `when() ${which}`);
  }
  catch (error) {
    if (!(error instanceof LinqBuildError)) throw error;
    throw new LinqBuildError(error.code, error.reason, `/${which}${error.docPath ?? ''}`);
  }
}

/**
 * A conditional transition: `then` when `cond` holds, `otherwise` (or
 * nothing at all — the no-op) when it does not.
 * @param {any} cond - a captured boolean expression, or a boolean
 * @param {any} then - a transition, or another `when()`
 * @param {any} [otherwise] - a transition, or another `when()`
 * @returns {any} the conditional, for the action capture to spell
 * @throws {LinqBuildError} `JL0101` a condition or a branch that is not
 *   one (another `when()` is a branch, never a condition); `JL0005` outside
 *   an action's capture (a subscription's, a JSLT body's or a chain's
 *   capture carries no transition)
 * @example
 * action((s: Expr<State>, x) => when(x.payload.id.eq(s.tasks.list.id),
 *   transition({ patch: [replace((st) => st.items, x.payload.result)] })));
 */
export function when(cond, then, otherwise = undefined) {
  if (captureKind() !== 'action') {
    throw new LinqBuildError('JL0005',
      'when() is a transition an action returns: write it inside an action\'s callback, '
      + `action((s, x) => when(…)) — ${inCapture() ? 'the capture in progress is not an action\'s'
        : 'no capture is in progress'}`);
  }
  if (typeof cond !== 'boolean' && !isExpression(cond)) {
    throw new LinqBuildError('JL0101',
      `when() takes a condition — a captured boolean expression or a boolean — got ${describeValue(cond)}`,
      '/cond');
  }
  refuseConditional(cond, 'when() takes a condition — a captured boolean expression or a boolean', '/cond');
  const yes = readBranch(then, 'then');
  const no = otherwise === undefined ? undefined : readBranch(otherwise, 'otherwise');
  const fold = captureFold();
  const operands = [toExpression(cond, fold), toExpression(yes, fold)];
  if (no !== undefined) operands.push(toExpression(no, fold));
  const conditional = liftExpression({ $if: operands });
  CONDITIONALS.add(conditional);
  return conditional;
}
