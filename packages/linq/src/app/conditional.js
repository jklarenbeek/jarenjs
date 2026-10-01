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
 *   one; `JL0005` outside an action's capture (a subscription's, a JSLT
 *   body's or a chain's capture carries no transition)
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
  const yes = readBranch(then, 'then');
  const no = otherwise === undefined ? undefined : readBranch(otherwise, 'otherwise');
  const fold = captureFold();
  const operands = [toExpression(cond, fold), toExpression(yes, fold)];
  if (no !== undefined) operands.push(toExpression(no, fold));
  const conditional = liftExpression({ $if: operands });
  CONDITIONALS.add(conditional);
  return conditional;
}
