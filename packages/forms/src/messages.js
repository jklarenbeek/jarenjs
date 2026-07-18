//@ts-check

/**
 * Forms message catalogs: structured field errors, rendered late.
 *
 * Every failure a form check produces is identified by a stable message
 * key (`msgid`, the `form/`-prefixed keyword or `x-form/assert`) plus raw
 * structured `params`; the human text comes from a catalog - a plain flat
 * object of closures (or template strings that compile into closures).
 * Forms keeps its second-person field voice ("This field is required"),
 * hence the separate `form/*` key space next to the validator's document
 * voice ("must have required property 'x'").
 *
 * The template compiler is a deliberate ~40-line duplicate of the one in
 * `@jarenjs/validate` (messages.js): forms never imports the validator
 * (see index.js doctrine), and the catalog contract - identical on both
 * sides - is what keeps one locale pack (`@jarenjs/locales`) servicing
 * both packages.
 */

//#region Message templates (duplicate of @jarenjs/validate, see above)

/**
 * Render one interpolated parameter: `String(v)` for primitives,
 * `JSON.stringify(v)` for objects and arrays.
 * @param {unknown} value - The parameter value
 * @returns {string} The rendered value
 */
function formatTemplateParam(value) {
  return (value !== null && typeof value === 'object')
    ? JSON.stringify(value)
    : String(value);
}

/**
 * Compile a message template into a render closure. Template syntax:
 * `{name}` substitutes the params member `name`; an unknown name leaves
 * the placeholder literally; `{{` escapes a literal `{`.
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

//#endregion

//#region English catalog

/**
 * Render a value the way the field checks always have: quoted strings,
 * JSON for everything else.
 * @param {unknown} value - The value to render
 * @returns {string}
 */
function formatValue(value) {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

/**
 * The built-in English forms catalog. Key set = exactly the `form/*` keys
 * `validateField` emits, plus `x-form/assert` (the rules default). The
 * strings are byte-identical to the historical inline template literals.
 * @type {Record<string, string | ((params: object, error?: object) => string)>}
 */
export const formsMessagesEn = {
  'form/required': 'This field is required',
  'form/type': (p) => `Must be ${(p.type === 'integer' || p.type === 'array' || p.type === 'object') ? 'an' : 'a'} ${p.type}`,
  'form/const': (p) => `Must be ${formatValue(p.constValue)}`,
  'form/enum': (p) => `Must be one of: ${p.enumValues?.map(formatValue).join(', ')}`,
  'form/minLength': (p) => `Must be at least ${p.limit} character${p.limit === 1 ? '' : 's'} (currently ${p.len})`,
  'form/maxLength': (p) => `Must be at most ${p.limit} character${p.limit === 1 ? '' : 's'} (currently ${p.len})`,
  'form/pattern': 'Must match pattern {pattern}',
  'form/format': 'Must be a valid {format}',
  'form/minimum': 'Must be at least {limit}',
  'form/maximum': 'Must be at most {limit}',
  'form/exclusiveMinimum': 'Must be greater than {limit}',
  'form/exclusiveMaximum': 'Must be less than {limit}',
  'form/multipleOf': 'Must be a multiple of {multipleOf}',
  'form/minItems': (p) => `Must have at least ${p.limit} item${p.limit === 1 ? '' : 's'}`,
  'form/maxItems': (p) => `Must have at most ${p.limit} item${p.limit === 1 ? '' : 's'}`,
  'form/uniqueItems': 'Items must be unique',
  'form/minProperties': 'Must have at least {limit} properties',
  'form/maxProperties': 'Must have at most {limit} properties',
  'x-form/assert': 'Invalid value',
};

/** The compiled built-in English catalog (module-level singleton). */
export const formsMessages = compileMessageCatalog(formsMessagesEn);

/**
 * Resolve a message key through a caller catalog with built-in English
 * fallback and render it.
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>|undefined} catalog - A compiled catalog, or undefined for English
 * @param {string} msgid - The message key
 * @param {object} params - The structured params
 * @returns {string} The rendered message
 */
export function renderFormsMessage(catalog, msgid, params) {
  let render = catalog !== undefined ? catalog[msgid] : undefined;
  if (render === undefined) render = formsMessages[msgid];
  if (render === undefined) return msgid;
  return render(params);
}

//#endregion
