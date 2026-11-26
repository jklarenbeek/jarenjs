//@ts-check
import { setObjectMember } from './object.js';

/**
 * Human-message templating: the shared half of every message catalog in
 * the suite.
 *
 * A catalog is a plain flat object keyed by a stable message id, whose
 * entries are either render closures or template strings. Compiling one
 * turns every template string into a closure, so the consumer only ever
 * calls `catalog[msgid](params)` — the two-stage house rule applied to
 * messages: parse the template once, render many times.
 *
 * This lives in `@jarenjs/core` so that packages which must not depend on
 * each other can still speak the identical catalog contract. That is what
 * lets one locale pack service both the validator's document voice ("must
 * have required property 'x'") and the form layer's field voice ("This
 * field is required") without either package importing the other.
 */

/**
 * Whether a value is a BigInt or a `BigInt` object (which `JSON.stringify`
 * would unwrap to a BigInt and refuse).
 * @param {unknown} value
 * @returns {value is bigint | BigInt}
 */
const isBigInt = (value) => typeof value === 'bigint' || value instanceof BigInt;

/**
 * `JSON.stringify` replacer for a value a message quotes: a BigInt (a
 * schema or a field built in JavaScript may hold one), which JSON cannot
 * spell, is written as its digits, and so is a `BigInt` object.
 * @param {string} _key
 * @param {unknown} value
 * @returns {unknown}
 */
function bigintDigits(_key, value) {
  return isBigInt(value) ? value.toString() : value;
}

/**
 * The JSON of a value a message quotes, a BigInt or a `BigInt` object as
 * its digits. A value JSON cannot write — a
 * circular reference, a value nested past the host's stack, a value whose
 * own `toJSON` or getter throws — is written as its tag (`[object Object]`,
 * `[object Array]`), so a message renders whatever a schema or an
 * instance holds.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function jsonText(value) {
  try {
    return isBigInt(value) ? value.toString() : JSON.stringify(value, bigintDigits);
  }
  catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Render one interpolated parameter: `String(v)` for primitives,
 * `JSON.stringify(v)` for objects and arrays, a BigInt (or a `BigInt`
 * object) at any depth as its digits.
 *
 * @param {unknown} value - The parameter value
 * @returns {string} The rendered value
 */
export function formatTemplateParam(value) {
  return (value !== null && typeof value === 'object')
    ? /** @type {string} */ (jsonText(value))
    : String(value);
}

/**
 * Render a JSON value for quotation inside a message: strings keep their
 * quotes so an empty or space-padded value is visible, everything else is
 * JSON, a BigInt at any depth as its digits (`10n` renders `10`).
 *
 * @param {unknown} value - The value to render
 * @returns {string}
 */
export function formatMessageValue(value) {
  if (typeof value === 'string') return `"${value}"`;
  return String(jsonText(value));
}

/**
 * Compile a message template into a render closure. Template syntax:
 * `{name}` substitutes the params member `name`; an unknown name leaves
 * the placeholder literally (so a catalog typo shows up in the output
 * instead of rendering as `undefined`); `{{` escapes a literal `{`.
 *
 * @param {string} template - The template text
 * @returns {((params: object, error?: object) => string) & { readonly parameters: readonly string[] }} The compiled render closure and its unique placeholder names
 */
export function compileMessageTemplate(template) {
  /** @type {string[]} literal parts between placeholders */
  const parts = [];
  /** @type {string[]} placeholder names, one per gap between parts */
  const names = [];
  let literal = '';
  for (let i = 0; i < template.length; ++i) {
    if (template.charCodeAt(i) === 0x7b /* { */) {
      if (template.charCodeAt(i + 1) === 0x7b) {
        literal += '{';
        i += 1;
        continue;
      }
      const end = template.indexOf('}', i + 1);
      if (end === -1) {
        literal += template.slice(i);
        break;
      }
      parts.push(literal);
      literal = '';
      names.push(template.slice(i + 1, end));
      i = end;
      continue;
    }
    literal += template[i];
  }
  parts.push(literal);

  const render = names.length === 0
    ? function renderLiteralTemplate() { return parts[0]; }
    : function renderMessageTemplate(params) {
      let out = parts[0];
      for (let i = 0; i < names.length; ++i) {
        const name = names[i];
        out += (params != null && name in params)
          ? formatTemplateParam(params[name])
          : `{${name}}`;
        out += parts[i + 1];
      }
      return out;
    };
  // Metadata comes from the parser that renders the message; consumers must
  // never parse placeholders with a second, subtly different grammar.
  return Object.defineProperty(render, 'parameters', {
    value: Object.freeze([...new Set(names)]), enumerable: true,
  });
}

/**
 * Compile a catalog-like object into a functions-only frozen catalog.
 * Entries may be render closures (kept as-is) or template strings
 * (compiled through {@link compileMessageTemplate}).
 *
 * @param {Record<string, string | ((params: object, error?: object) => string)>} catalogLike - The catalog to compile
 * @returns {Readonly<Record<string, (params: object, error?: object) => string>>} The compiled catalog
 */
export function compileMessageCatalog(catalogLike) {
  /** @type {Record<string, (params: object, error?: object) => string>} */
  const compiled = {};
  const keys = Object.keys(catalogLike);
  for (let i = 0; i < keys.length; ++i) {
    const entry = catalogLike[keys[i]];
    setObjectMember(compiled, keys[i], typeof entry === 'function'
      ? entry
      : compileMessageTemplate(String(entry)));
  }
  return Object.freeze(compiled);
}

/**
 * The English of the form chrome: the accessible names of a rendered
 * form's array add/remove buttons and the JSON editor's hint, under the
 * `form/...` ids every locale pack translates. The one home of these
 * words: `@jarenjs/forms` holds them in its catalog and `@jarenjs/app`'s
 * form view defaults to them, and neither package depends on the other.
 * @type {Readonly<{ 'form/addItem': string, 'form/removeItem': string, 'form/jsonPlaceholder': string }>}
 */
export const formChromeMessagesEn = /*#__PURE__*/ Object.freeze({
  'form/addItem': 'Add item',
  'form/removeItem': 'Remove item',
  'form/jsonPlaceholder': 'Enter a JSON value',
});

/**
 * The localized chrome strings a form renderer needs: the accessible
 * names of the array add/remove buttons and the JSON editor's hint, each
 * the catalog's entry for its id, called with no parameters, or its
 * {@link formChromeMessagesEn} English when the catalog lacks the id or
 * none is given.
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} [catalog] - A compiled catalog, or undefined for English
 * @returns {{addItem: string, removeItem: string, jsonPlaceholder: string}}
 * @example
 * formChromeLabels(); // { addItem: 'Add item', removeItem: 'Remove item', jsonPlaceholder: 'Enter a JSON value' }
 */
export function formChromeLabels(catalog = undefined) {
  /** @param {'form/addItem' | 'form/removeItem' | 'form/jsonPlaceholder'} id */
  const text = (id) => (catalog !== undefined && Object.hasOwn(catalog, id) ? catalog[id]({}) : formChromeMessagesEn[id]);
  return { addItem: text('form/addItem'), removeItem: text('form/removeItem'), jsonPlaceholder: text('form/jsonPlaceholder') };
}
