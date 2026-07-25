//@ts-check

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
 * Render one interpolated parameter: `String(v)` for primitives,
 * `JSON.stringify(v)` for objects and arrays.
 *
 * @param {unknown} value - The parameter value
 * @returns {string} The rendered value
 */
export function formatTemplateParam(value) {
  return (value !== null && typeof value === 'object')
    ? JSON.stringify(value)
    : String(value);
}

/**
 * Render a JSON value for quotation inside a message: strings keep their
 * quotes so an empty or space-padded value is visible, everything else is
 * JSON.
 *
 * @param {unknown} value - The value to render
 * @returns {string}
 */
export function formatMessageValue(value) {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

/**
 * Compile a message template into a render closure. Template syntax:
 * `{name}` substitutes the params member `name`; an unknown name leaves
 * the placeholder literally (so a catalog typo shows up in the output
 * instead of rendering as `undefined`); `{{` escapes a literal `{`.
 *
 * @param {string} template - The template text
 * @returns {(params: object, error?: object) => string} The compiled render closure
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

  if (names.length === 0) {
    const text = parts[0];
    return function renderLiteralTemplate() { return text; };
  }

  return function renderMessageTemplate(params) {
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
    compiled[keys[i]] = typeof entry === 'function'
      ? entry
      : compileMessageTemplate(String(entry));
  }
  return Object.freeze(compiled);
}
