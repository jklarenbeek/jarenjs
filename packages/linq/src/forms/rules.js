//@ts-check
/**
 * @file The `x-form` vocabulary as one builder method: `withForm(Base)`,
 * a mixin applied to every schema-pen class at module scope, so
 * `./forms` is a set of NEW classes (never a patched prototype) on which
 * any member can carry a cross-field rule.
 *
 * `form({ visible, enabled, assert, computed, message })` writes the one
 * `x-form` annotation the forms README's layer 2 specifies. The three
 * predicates and `computed` are CALLBACKS captured over the rule
 * context, never paths typed as strings: `$` is the whole form document
 * (cross-field is the point), and `value`/`pointer` are the two
 * externals `compileFormRules` binds per evaluation — so the callback
 * receives one context object spelling all three, `c.root`, `c.value`
 * and `c.pointer`, and any other name is `JL0104` here rather than a
 * compile error from forms naming the same two.
 *
 * What the pen refuses is what the reader would refuse and the builder
 * can already see: a member `x-form` does not define, and `preview` —
 * which is not an authored member at all but the format registry's own
 * hint (`getFormatInfo(format).preview`), so spelling it here would
 * write a keyword nothing reads.
 */

import { LinqBuildError } from '../errors.js';
import { captureQuery } from '../capture-root.js';
import { describeValue, requireJson } from '../json-boundary.js';

/** The keyword every rule method writes. */
export const KEYWORD = 'x-form';

/** The members `x-form` defines, in the order the README's table lists them. */
const RULE_MEMBERS = Object.freeze(['visible', 'enabled', 'assert', 'computed', 'message']);

/** The members captured as queries over the rule context. */
const QUERY_MEMBERS = Object.freeze(['visible', 'enabled', 'assert', 'computed']);

/** The two externals `compileFormRules` binds, beside the document at `$`. */
const EXTERNALS = Object.freeze(['value', 'pointer']);

/** Where an unbound name could have come from, appended to `JL0104`. */
const ADVICE = () => ' — the document being edited is the context\'s root (c.root), the '
  + 'field\'s own value c.value and its pointer c.pointer';

/**
 * The rule context: one object over the capture's document root and its
 * two externals. `root` is the value proxy (`$`), so `c.root.company`
 * writes `"$.company"`; anything the evaluator does not bind falls
 * through to the externals proxy, which refuses it by name.
 * @param {any} doc - the `$` proxy
 * @param {any} externals - the externals proxy (`value`, `pointer`)
 * @returns {any}
 */
function contextProxy(doc, externals) {
  return new Proxy(Object.freeze({}), {
    get(_target, prop) {
      if (prop === 'root') return doc;
      if (typeof prop === 'symbol') return undefined;
      return externals[prop];
    },
  });
}

/**
 * One query-valued rule member: a callback captured over the context, or
 * a query document written by hand, copied.
 * @param {string} member - `visible`, `enabled`, `assert` or `computed`
 * @param {any} value
 * @returns {any} the query document (plain JSON)
 */
function ruleMember(member, value) {
  if (typeof value !== 'function') {
    return JSON.parse(JSON.stringify(requireJson(value, `form() ${member}`)));
  }
  return captureQuery(`form() ${member}`, EXTERNALS,
    (doc, externals) => value(contextProxy(doc, externals)),
    { advice: ADVICE, fold: false });
}

/**
 * The `message` member: a plain string (an inline template) or a
 * MessageSpec object, verbatim.
 * @param {any} value
 * @returns {any}
 */
function readMessage(value) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LinqBuildError('JL0101',
      'form() message is an inline string or a MessageSpec { $msgid?, message?, params? }, '
      + `got ${describeValue(value)}`, '/message');
  }
  if (value.$msgid === undefined && value.message === undefined) {
    throw new LinqBuildError('JL0101',
      "form() message as a MessageSpec needs '$msgid' and/or 'message'", '/message');
  }
  return JSON.parse(JSON.stringify(requireJson(value, 'form() message')));
}

/**
 * The mixin: a subclass of `Base` carrying `form()`.
 * @template {new (state: any) => any} B
 * @param {B} Base - a schema-pen builder class
 * @returns {B} a new class, `Base` plus the vocabulary
 */
export function withForm(Base) {
  return class extends Base {
    /**
     * One `x-form` annotation (the forms README, layer 2): cross-field
     * visibility, enablement, a preemptive assertion, a derived value
     * and the message an assertion failure renders. A rule is an
     * ANNOTATION — it never changes what the schema validates, so
     * `additionalProperties` and every other keyword stay exactly what
     * the schema pen wrote.
     *
     * @param {{ visible?: any, enabled?: any, assert?: any, computed?: any, message?: any }} spec
     * @returns {this}
     * @throws {LinqBuildError} `JL0101` a member `x-form` does not define,
     *   or a message that is neither a string nor a MessageSpec;
     *   `JL0102` `preview`, which the format registry derives from the
     *   field's own `format`; `JL0104` a name the rule context does not bind
     * @example
     * s.string().form({ visible: (c) => c.root.company.ne('') });
     * s.number().form({ computed: (c) => c.root.lines.all().amount.sum() });
     */
    form(spec) {
      if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new LinqBuildError('JL0101',
          'form() takes { visible?, enabled?, assert?, computed?, message? }, got '
          + describeValue(spec));
      }
      for (const key of Object.keys(spec)) {
        if (key === 'preview') {
          throw new LinqBuildError('JL0102',
            "form() cannot write 'preview' — a field's preview hint is DERIVED from its "
            + 'format by the registry (getFormatInfo(format).preview), never authored, and '
            + 'buildFormModel reads it from there; spell the format instead, and a host '
            + 'that understands the hint draws it beside the control', '/preview');
        }
        if (!RULE_MEMBERS.includes(key)) {
          throw new LinqBuildError('JL0101',
            `form() does not take '${key}' — x-form defines ${RULE_MEMBERS.join(', ')}`,
            `/${key}`);
        }
      }
      const current = this.annotation(KEYWORD) ?? {};
      const rules = { ...current };
      for (const member of QUERY_MEMBERS) {
        if (spec[member] !== undefined) rules[member] = ruleMember(member, spec[member]);
      }
      if (spec.message !== undefined) rules.message = readMessage(spec.message);
      // the README's own member order, whatever order the caller wrote
      const ordered = {};
      for (const member of RULE_MEMBERS) {
        if (rules[member] !== undefined) ordered[member] = rules[member];
      }
      return this.annotate(KEYWORD, Object.freeze(ordered));
    }

    /** As in the schema pen, but `x-form` is owned here. @param {Record<string, any>} annotations */
    meta(annotations) {
      if (annotations !== null && typeof annotations === 'object' && KEYWORD in annotations) {
        throw new LinqBuildError('JL0104',
          `meta() cannot write '${KEYWORD}' — the forms pen owns that keyword; spell it `
          + 'through form()');
      }
      return super.meta(annotations);
    }
  };
}
