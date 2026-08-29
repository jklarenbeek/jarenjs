//@ts-check
/**
 * @file `body()` — a JSLT rule body captured through the chain's own
 * recording proxy over the shared root capture: `fn(value, x)` with
 * `value` rooted at `$` (the matched value) and `x` the externals —
 * `root` and `path`, which the engine binds on every dispatch
 * (JSLT-FORMAT §8.2), plus the parameters the body declares (§8.1); an
 * undeclared name is `JL0104` at build time, where the fix can be
 * named. `apply()` spells the one body-local operator (§6) and `op()`
 * any registered one (§13): both lift a hand-spelled operator into the
 * capture, and the engine's compiler stays the only judge of what it
 * means. A returned literal is spelled as the format's own constructor
 * (`{ "level": "unknown" }`), never folded into `$const` as the chain
 * spells a constant; a string starting `$` is escaped `$$`. The one
 * rule the pen checks itself is the `[]` idiom of §6.3 —
 * an `apply` as a bare object member is refused HERE because the
 * engine would only refuse it at run time, on the second child.
 */

import { liftExpression, toExpression } from '../expression.js';
import { captureQuery } from '../capture-root.js';
import { describeValue } from '../json-boundary.js';
import { LinqBuildError } from '../errors.js';
import { deepFreeze } from '@jarenjs/core/object';

/** The two names the engine binds on every dispatch (§8.2). */
const RESERVED = ['root', 'path'];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The `{ $apply: … }` NODES `apply()` built, by identity. The node, not
 * the proxy over it: a proxy is consumed the moment its value is lowered
 * (into a member, an operand, an argument), while the node it carries is
 * the very object that lands in the emitted document. */
const APPLY_NODES = new WeakSet();
/** How many `body()` captures are in progress (captures nest). */
let bodies = 0;

/**
 * The declared parameter names, or `JL0101`/`JL0104` naming the problem.
 * @param {any} options
 * @returns {string[]}
 */
function readExternals(options) {
  if (options === undefined) return [];
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new LinqBuildError('JL0101',
      `body() options are { externals?: string[] }, got ${describeValue(options)}`);
  }
  for (const key of Object.keys(options)) {
    if (key !== 'externals') throw new LinqBuildError('JL0101', `body() does not take '${key}'`);
  }
  const list = options.externals;
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new LinqBuildError('JL0101',
      `body() externals is an array of parameter names, got ${describeValue(list)}`);
  }
  /** @type {string[]} */
  const names = [];
  for (const name of list) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new LinqBuildError('JL0101',
        `body() externals are identifiers ('rate'), got ${describeValue(name)}`);
    }
    if (RESERVED.includes(name)) {
      throw new LinqBuildError('JL0104',
        `'${name}' is engine-bound on every dispatch (JSLT-FORMAT §8.2) — it needs no `
        + 'declaration and is always present on the externals argument');
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * `an object member takes exactly one value` — the `[]` idiom's refusal.
 * @param {string} key @param {string} at
 */
function bareApply(key, at) {
  return new LinqBuildError('JL0102',
    `an object member takes exactly one value — '${key}' holds an apply(), which yields `
    + 'a SEQUENCE and fails at run time on the second child (JQ2001); wrap the apply in '
    + `[] (JSLT-FORMAT §6.3: ${key}: [apply(…)])`, at);
}

/**
 * The `[]` idiom (§6.3): an object member holds exactly one value, and
 * an `$apply` yields a sequence — so an `apply()` in a member position
 * is refused. Inside an array constructor it is the idiom itself (the
 * brackets splice the sequence); as an operator's operand it is an
 * ordinary expression (`apply(…).count()`); at the top of the body it is
 * the body's own sequence.
 *
 * The walk runs over the CAPTURED DOCUMENT rather than over the value
 * the callback returned, because a callback may hand an `apply()` to an
 * operator (`op('$if', [f, { children: apply(…) }, null])`) and the
 * object literal is lowered before the callback ever returns — the
 * marker is gone, and only the node it left in the document is still
 * there to find. The document is plain JSON at this point and the nodes
 * are the same objects `apply()` built, so identity is the whole test.
 *
 * Member position is read the way `toExpression` writes it, three lines
 * earlier: a map CONSTRUCTOR has no `$`-prefixed key (a data object that
 * does is spelled `$map`, as pairs), and everything else with one is an
 * operator or FLWOR phrase whose operands are expressions.
 * @param {any} node - a node of the captured document
 * @param {string} at - its JSON pointer, for `docPath`
 */
function refuseBareApply(node, at) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) refuseBareApply(node[i], `${at}/${i}`);
    return;
  }
  const keys = Object.keys(node);
  if (!keys.some((k) => k.charCodeAt(0) === 0x24)) {
    for (const key of keys) {
      if (APPLY_NODES.has(node[key])) throw bareApply(key, `${at}/${key}`);
      refuseBareApply(node[key], `${at}/${key}`);
    }
    return;
  }
  // `$map` is the one phrase whose operands ARE members: it spells a data
  // object with `$`-prefixed keys as [key, value] pairs (`toExpression`).
  if (keys.length === 1 && keys[0] === '$map' && Array.isArray(node.$map)) {
    node.$map.forEach((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        refuseBareApply(pair, `${at}/$map/${i}`);
        return;
      }
      if (APPLY_NODES.has(pair[1])) {
        throw bareApply(typeof pair[0] === 'string' ? pair[0] : String(i), `${at}/$map/${i}/1`);
      }
      refuseBareApply(pair[1], `${at}/$map/${i}/1`);
    });
    return;
  }
  for (const key of keys) refuseBareApply(node[key], `${at}/${key}`);
}

/**
 * `{ $apply: selector }` or `{ $apply: [selector, mode] }` — the
 * apply-templates operator (§6), inside a `body()` callback. The
 * selector is an expression (`v.chapters.all()`), a JSONPath string
 * taken verbatim (`'$.chapters[*]'`), or plain data (`[1, 2]` embeds as
 * `$const`); the mode is a literal string naming the target mode (a
 * mode is not an expression, §6.2). The result is an expression: it
 * composes as one (`apply(…).count()`), and as an array element it is
 * the `[]` idiom — as a bare object member it is refused (`JL0102`).
 * @param {any} selector
 * @param {string} [mode]
 * @returns {any} an expression over the `$apply` document
 */
export function apply(selector, mode = undefined) {
  if (bodies === 0) {
    throw new LinqBuildError('JL0102',
      'apply() spells $apply, which exists only inside a rule body (JSLT-FORMAT §6.1) — '
      + 'call it inside body()');
  }
  if (selector === undefined) {
    throw new LinqBuildError('JL0101',
      "apply() takes a selector: a path (v.chapters.all(), '$.chapters[*]') or an expression");
  }
  const doc = typeof selector === 'string' ? selector : toExpression(selector);
  let node;
  if (mode === undefined) node = { $apply: doc };
  else {
    if (typeof mode !== 'string') {
      throw new LinqBuildError('JL0101',
        `apply() takes the target mode as a literal string (a mode is not an expression, `
        + `JSLT-FORMAT §6.2), got ${describeValue(mode)}`);
    }
    node = { $apply: [doc, mode] };
  }
  APPLY_NODES.add(node);
  return liftExpression(node);
}

/**
 * `{ [name]: operands }` — a registered operator (§13), spelled without
 * judging it: the pen writes the name it is given and the engine's
 * compiler decides (`JQ0002` for a name no registry answers). Works in
 * any capture in progress — a body, or a chain callback over an
 * in-memory source compiled with the same registry.
 * @param {string} name - the operator name, `$`-prefixed (`'$npv'`)
 * @param {any} [operands] - one operand, or an array of them
 * @returns {any} an expression over the operator document
 */
export function op(name, operands = []) {
  if (typeof name !== 'string' || name.length < 2 || name.charCodeAt(0) !== 0x24) {
    throw new LinqBuildError('JL0101',
      `op() takes an operator name starting with '$' ('$npv'), got ${describeValue(name)}`);
  }
  const value = Array.isArray(operands) ? operands.map(toExpression) : toExpression(operands);
  return liftExpression({ [name]: value });
}

/**
 * Capture one rule body: `fn(value, x)` over the matched value at `$`,
 * with `x.root`, `x.path` and every declared parameter; the result is
 * the body's query document, plain and deep-frozen.
 * @param {(value: any, externals: any) => any} fn
 * @param {{ externals?: readonly string[] }} [options]
 * @returns {any} the body document (plain JSON)
 */
export function body(fn, options = undefined) {
  if (typeof fn !== 'function') {
    throw new LinqBuildError('JL0101',
      `body() takes a callback (value, x) => …, got ${describeValue(fn)}`);
  }
  const declared = readExternals(options);
  const advice = (/** @type {string} */ name) =>
    ` — a stylesheet parameter is declared first: body(fn, { externals: ['${name}'] })`;
  bodies++;
  try {
    const doc = captureQuery('body()', RESERVED.concat(declared), fn, { advice, fold: false });
    refuseBareApply(doc, '');
    // a body spells a literal as the format's own constructor (never a
    // folded `$const`); the tree may still share a caller's array or
    // object, so it is copied before it is frozen
    return deepFreeze(JSON.parse(JSON.stringify(doc)));
  }
  finally {
    bodies--;
  }
}
