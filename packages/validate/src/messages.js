//@ts-check

/**
 * Structured error messages & i18n for the validator.
 *
 * The validation hot path never touches this module: message rendering
 * happens only in collect mode, only over the already-failed set, at
 * conversion time (`convertInternalErrors`) or afterwards
 * (`localizeErrors`). Every failure is identified by a stable message key
 * (`msgid`) plus raw structured `params`; human text is produced by a
 * locale catalog - a plain flat object of closures (or template strings
 * that compile into closures). The built-in English catalog lives here;
 * non-English packs live in `@jarenjs/locales`.
 *
 * The normative spec is `packages/validate/docs/ERROR-MESSAGES.md`:
 * the MessageSpec grammar, the message-key registry, the resolution
 * precedence chain and the `errorMessage` matching semantics.
 */

//#region Message templates

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
 * Compile a message template into a render closure - the two-stage house
 * rule applied to messages. Template syntax: `{name}` substitutes the
 * params member `name`; an unknown name leaves the placeholder literally
 * (debuggability); `{{` escapes a literal `{`.
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
 * The built-in English catalog: one entry per message key the validator
 * produces, rendering the exact strings of the historical `#convertErrors`
 * if/else chain. Keywords without an entry (`const`, `enum`,
 * `dependentRequired`, ...) fall back to the generic
 * `validation failed for keyword '<keyword>'` - as before.
 * @type {Record<string, string | ((params: object, error?: object) => string)>}
 */
export const messagesEn = {
  type: (p) => p.types
    ? `must be one of the following types: ${p.types.join(', ')}`
    : `must be ${p.type === 'integer' ? 'an' : 'a'} ${p.type}`,
  required: (p) => p.missingProperty
    ? `must have required property '${p.missingProperty}'`
    : 'must have required properties',
  minimum: 'must be {comparison} {limit}',
  maximum: 'must be {comparison} {limit}',
  exclusiveMinimum: 'must be {comparison} {limit}',
  exclusiveMaximum: 'must be {comparison} {limit}',
  multipleOf: 'must be multiple of {multipleOf}',
  minLength: 'must NOT have fewer than {limit} characters',
  maxLength: 'must NOT have more than {limit} characters',
  pattern: 'must match pattern "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `must NOT have additional property '${p.additionalProperty}'`
    : 'must NOT have additional properties',
  minProperties: 'must NOT have fewer than {limit} properties',
  maxProperties: 'must NOT have more than {limit} properties',
  minItems: 'must NOT have fewer than {limit} items',
  maxItems: 'must NOT have more than {limit} items',
  uniqueItems: 'must NOT have duplicate items',
  contains: 'must contain at least one valid item',
  items: 'array items are invalid',
  allOf: 'must match all of the subschemas',
  anyOf: 'must match a subschema in anyOf',
  oneOf: 'must match exactly one subschema in oneOf',
  not: 'must NOT match the subschema',
  format: 'must match format "{format}"',
  if: 'must match "if" schema',
  then: 'must match "then" schema',
  else: 'must match "else" schema',
  'false schema': 'boolean schema false is always invalid',
  $query: (p) => p.code
    ? `'$query' assertion raised ${p.code} at '${p.docPath}'`
    : "must satisfy the '$query' assertion",
  // Query runtime codes reachable through '$query' (JQ2001-class operator
  // errors and the JQ2003 multi-item EBV); an uncovered JQ2xxx code falls
  // back to the '$query' entry above, which renders the same string.
  JQ2001: (p) => `'$query' assertion raised ${p.code} at '${p.docPath}'`,
  JQ2003: (p) => `'$query' assertion raised ${p.code} at '${p.docPath}'`,
};

/** The compiled built-in English catalog (module-level singleton). */
const EN = compileMessageCatalog(messagesEn);

//#endregion

//#region Public error record & rendering

/**
 * JSON Schema Validation Error
 * Represents a validation error according to the JSON Schema specification.
 * @see https://json-schema.org/draft/2020-12/json-schema-core.html#output
 */
export class ValidationError {
  /**
   * @param {object} options - Error options
   * @param {string} options.keyword - The keyword that failed validation
   * @param {string} options.instancePath - JSON Pointer to the data location
   * @param {string} options.schemaPath - JSON Pointer to the schema location
   * @param {object} options.params - Keyword-specific parameters
   * @param {string} [options.msgid] - Stable message key resolving this error in a catalog
   * @param {string} [options.message] - Human-readable error message
   */
  constructor(options) {
    this.keyword = options.keyword;
    this.instancePath = options.instancePath || '';
    this.schemaPath = options.schemaPath || '';
    this.params = options.params || {};
    this.msgid = options.msgid || options.keyword;
    this.message = options.message || '';
  }

  /**
   * Convert error to a plain object
   * @returns {object} Plain object representation
   */
  toJSON() {
    return {
      keyword: this.keyword,
      instancePath: this.instancePath,
      schemaPath: this.schemaPath,
      params: this.params,
      msgid: this.msgid,
      message: this.message,
    };
  }
}

/**
 * Mark an error's message as inline schema-authored text (a MessageSpec
 * without `$msgid`): single-language by definition, never re-rendered by
 * `localizeErrors`. Non-enumerable so it stays out of serialization.
 * @param {ValidationError} error - The error to mark
 */
function markInlineMessage(error) {
  Object.defineProperty(error, 'inlineMessage', {
    value: true,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Render the message of an error through a catalog - the tail of the
 * resolution precedence chain (no `errorMessage` registry involvement):
 * catalog[msgid], built-in English[msgid], catalog[keyword],
 * built-in English[keyword], then the generic fallback text.
 * @param {ValidationError | {keyword: string, msgid?: string, params?: object}} error - The error to render
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} [catalog] - A compiled catalog (see {@link compileMessageCatalog})
 * @returns {string} The rendered message
 */
export function renderErrorMessage(error, catalog = undefined) {
  const msgid = error.msgid || error.keyword;
  const params = error.params || {};
  let render = catalog !== undefined ? catalog[msgid] : undefined;
  if (render === undefined) render = EN[msgid];
  if (render === undefined && catalog !== undefined) render = catalog[error.keyword];
  if (render === undefined) render = EN[error.keyword];
  if (render === undefined) return `validation failed for keyword '${error.keyword}'`;
  return render(params, error);
}

/**
 * Re-render the `message` of every error from its `msgid` + `params`
 * through the given catalog, with built-in English fallback. This is the
 * whole post-hoc i18n story:
 * `localizeErrors(validate(data).errors, compileMessageCatalog(nl))`.
 *
 * Inline schema-authored messages (a MessageSpec without `$msgid`) are
 * single-language by definition and are NOT re-rendered - that is why
 * `$msgid` exists. An error whose `msgid` resolves in no catalog keeps
 * its current message (e.g. the spec's inline fallback text).
 * @param {ValidationError[]} errors - Errors from a collect-mode validation
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} catalog - A compiled catalog (see {@link compileMessageCatalog})
 * @returns {ValidationError[]} The same array, messages re-rendered
 */
export function localizeErrors(errors, catalog) {
  for (let i = 0; i < errors.length; ++i) {
    const error = errors[i];
    // @ts-ignore - marker property, non-enumerable
    if (error.inlineMessage === true) continue;
    const msgid = error.msgid || error.keyword;
    const params = error.params || {};
    let render = catalog !== undefined ? catalog[msgid] : undefined;
    if (render === undefined) render = EN[msgid];
    if (render === undefined && catalog !== undefined) render = catalog[error.keyword];
    if (render === undefined) render = EN[error.keyword];
    if (render !== undefined) {
      error.message = render(params, error);
    }
    else if (error.message === '') {
      error.message = `validation failed for keyword '${error.keyword}'`;
    }
    // else: keep the existing message (an unresolvable custom msgid whose
    // text came from the spec's inline fallback).
  }
  return errors;
}

//#endregion

//#region 'errorMessage' spec compilation (schema compile time)

/**
 * A compiled MessageSpec leaf.
 * @typedef {object} CompiledMessageSpec
 * @property {string|null} msgid - Catalog key to resolve at render time
 * @property {((params: object, error?: object) => string)|null} render - Compiled inline template
 * @property {object|null} params - Author params, merged OVER the error's params
 */

/**
 * Is this value a MessageSpec (string form, or object form carrying
 * `$msgid`/`message`) rather than a keyword map?
 * @param {unknown} value - The value to test
 * @returns {boolean}
 */
function isMessageSpecValue(value) {
  if (typeof value === 'string') return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof (/** @type {any} */ (value).$msgid) === 'string'
    || typeof (/** @type {any} */ (value).message) === 'string';
}

/**
 * Compile one MessageSpec value; throws on a malformed spec, carrying the
 * schema path (the query-keyword compile-time throw idiom).
 * @param {unknown} spec - The MessageSpec value
 * @param {string} path - The schema path, for error messages
 * @returns {CompiledMessageSpec} The compiled spec
 */
function compileMessageSpec(spec, path) {
  if (typeof spec === 'string')
    return { msgid: null, render: compileMessageTemplate(spec), params: null };

  if (spec === null || typeof spec !== 'object' || Array.isArray(spec))
    throw new Error(`invalid 'errorMessage' spec at '${path}': a MessageSpec must be a string or an object with '$msgid' and/or 'message'`);

  const obj = /** @type {any} */ (spec);
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i];
    if (key !== '$msgid' && key !== 'message' && key !== 'params')
      throw new Error(`invalid 'errorMessage' spec at '${path}': unknown MessageSpec member '${key}'`);
  }
  if (obj.$msgid !== undefined && typeof obj.$msgid !== 'string')
    throw new Error(`invalid 'errorMessage' spec at '${path}': '$msgid' must be a string`);
  if (obj.message !== undefined && typeof obj.message !== 'string')
    throw new Error(`invalid 'errorMessage' spec at '${path}': 'message' must be a string`);
  if (obj.$msgid === undefined && obj.message === undefined)
    throw new Error(`invalid 'errorMessage' spec at '${path}': a MessageSpec object needs '$msgid' and/or 'message'`);
  if (obj.params !== undefined && (obj.params === null || typeof obj.params !== 'object' || Array.isArray(obj.params)))
    throw new Error(`invalid 'errorMessage' spec at '${path}': 'params' must be an object`);

  return {
    msgid: obj.$msgid !== undefined ? obj.$msgid : null,
    render: obj.message !== undefined ? compileMessageTemplate(obj.message) : null,
    params: obj.params !== undefined ? obj.params : null,
  };
}

/**
 * A compiled 'errorMessage' node registered on the ValidationRoot.
 * @typedef {object} CompiledErrorMessageNode
 * @property {CompiledMessageSpec|null} all - String-form spec: covers this node AND its subtree
 * @property {Map<string, CompiledMessageSpec | {perKey: Map<string, CompiledMessageSpec>, fallback: CompiledMessageSpec|null}>|null} keywords - Map-form per-keyword specs (this node only)
 * @property {CompiledMessageSpec|null} catchAll - The '_' entry (this node only)
 */

/**
 * Compile the value of an 'errorMessage' keyword into a registry node.
 * Grammar (validated here, at schema compile time):
 * - MessageSpec (string / `$msgid` object): covers the whole subtree;
 * - map form: per-keyword MessageSpecs for this node, where `required`
 *   also accepts a per-missing-property map, `$query` a per-runtime-code
 *   map (with `default` for the EBV-false failure), and `_` is the
 *   node-level catch-all.
 * @param {unknown} errorMessage - The keyword's value
 * @param {string} path - The schema path, for compile error messages
 * @returns {CompiledErrorMessageNode} The compiled node
 */
export function compileErrorMessageSpec(errorMessage, path) {
  if (isMessageSpecValue(errorMessage))
    return { all: compileMessageSpec(errorMessage, path), keywords: null, catchAll: null };

  if (errorMessage === null || typeof errorMessage !== 'object' || Array.isArray(errorMessage))
    throw new Error(`invalid 'errorMessage' at '${path}': must be a MessageSpec or a keyword map`);

  /** @type {CompiledErrorMessageNode} */
  const node = { all: null, keywords: null, catchAll: null };
  const obj = /** @type {Record<string, unknown>} */ (errorMessage);
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i];
    const value = obj[key];
    if (key === '_') {
      node.catchAll = compileMessageSpec(value, `${path}/errorMessage/_`);
      continue;
    }
    if (node.keywords === null) node.keywords = new Map();
    const keyPath = `${path}/errorMessage/${key}`;
    if ((key === 'required' || key === '$query') && !isMessageSpecValue(value)) {
      // Per-key form: required -> per missing property, $query -> per
      // runtime code with 'default' for the plain EBV-false failure.
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`invalid 'errorMessage' spec at '${keyPath}': must be a MessageSpec or a map of MessageSpecs`);
      const perKey = new Map();
      /** @type {CompiledMessageSpec|null} */
      let fallback = null;
      const subKeys = Object.keys(value);
      for (let j = 0; j < subKeys.length; ++j) {
        const subKey = subKeys[j];
        const compiled = compileMessageSpec(/** @type {any} */ (value)[subKey], `${keyPath}/${subKey}`);
        if (key === '$query' && subKey === 'default') fallback = compiled;
        else perKey.set(subKey, compiled);
      }
      node.keywords.set(key, { perKey, fallback });
      continue;
    }
    node.keywords.set(key, compileMessageSpec(value, keyPath));
  }
  return node;
}

//#endregion

//#region Internal error conversion (report time)

/**
 * Find the MessageSpec governing an error: nearest registered ancestor of
 * the error's schema path wins (longest prefix, segment-aware); within one
 * node, keyword-map entry beats '_' beats the string form; map-form
 * entries apply only to errors AT the node, the string form covers the
 * subtree. No match at the nearest node falls through to farther ancestors.
 * @param {Map<string, CompiledErrorMessageNode>} registry - The root's errorMessage registry
 * @param {string} errorPath - The error's schema path
 * @param {string} keyword - The failed keyword
 * @param {object} params - The extracted error params
 * @returns {CompiledMessageSpec|null} The governing spec, or null
 */
function resolveErrorMessageSpec(registry, errorPath, keyword, params) {
  /** @type {Array<{path: string, node: CompiledErrorMessageNode}>} */
  const candidates = [];
  for (const [path, node] of registry) {
    if (path === errorPath
      || (errorPath.startsWith(path) && errorPath.charCodeAt(path.length) === 0x2f /* / */)) {
      candidates.push({ path, node });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.path.length - a.path.length);

  for (let i = 0; i < candidates.length; ++i) {
    const { path, node } = candidates[i];
    if (path === errorPath) {
      if (node.keywords !== null) {
        const entry = node.keywords.get(keyword);
        if (entry !== undefined) {
          if ('perKey' in entry) {
            const matchKey = keyword === 'required' ? params.missingProperty : params.code;
            if (matchKey !== undefined && entry.perKey.has(matchKey))
              return entry.perKey.get(matchKey);
            if (keyword === '$query' && params.code === undefined && entry.fallback !== null)
              return entry.fallback;
            // no per-key match: fall through to '_' / string form
          }
          else {
            return entry;
          }
        }
      }
      if (node.catchAll !== null) return node.catchAll;
    }
    if (node.all !== null) return node.all;
  }
  return null;
}

/**
 * Convert internal validation errors to the public ValidationError format.
 * Params extraction is table-driven off the failed keyword; message text
 * goes through the errorMessage registry (if any) and the built-in
 * English catalog. With `options.messages === false` no message is
 * rendered at all (`message: ''`, params and msgid still set).
 * @param {Array<{object: any, key: string|string[], expected: any, dataKey: any, value: any, rest: any[]}>} internalErrors - The root's internal error records
 * @returns {ValidationError[]} The public errors
 */
export function convertInternalErrors(internalErrors) {
  return internalErrors.map(err => {
    const keyword = Array.isArray(err.key) ? err.key[err.key.length - 1] : err.key;

    // Build params based on error type
    const params = {};
    if (keyword === 'required') {
      params.missingProperty = err.dataKey;
    } else if (keyword === 'type') {
      if (Array.isArray(err.expected)) {
        params.types = err.expected;
      } else {
        params.type = err.expected;
      }
    } else if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minProperties', 'maxProperties', 'minItems', 'maxItems'].includes(keyword)) {
      params.limit = err.expected;
      if (keyword === 'minimum' || keyword === 'maximum') {
        params.comparison = keyword === 'minimum' ? '>=' : '<=';
      } else if (keyword === 'exclusiveMinimum' || keyword === 'exclusiveMaximum') {
        params.comparison = keyword === 'exclusiveMinimum' ? '>' : '<';
      }
    } else if (keyword === 'multipleOf') {
      params.multipleOf = err.expected;
    } else if (keyword === 'pattern') {
      params.pattern = err.expected?.source || err.expected;
    } else if (keyword === 'additionalProperties') {
      params.additionalProperty = err.dataKey;
    } else if (keyword === 'format') {
      params.format = err.expected || err.value;
    } else if (keyword === '$query') {
      // A '$query' runtime failure passes the JQ2xxx code and the query
      // document pointer as extra meta arguments after the data path;
      // a plain EBV-false failure passes neither.
      if (err.rest != null && err.rest.length > 1) {
        params.code = err.rest[1];
        params.docPath = err.rest[2];
      }
    }

    // Validators pass the instance data path as the first meta argument to
    // the error handler (the handler-contract invariant); the charCode
    // guard is a safety net that yields '' - never a wrong path.
    const meta0 = err.rest?.[0];
    const instancePath = (typeof meta0 === 'string' && (meta0 === '' || meta0.charCodeAt(0) === 0x2f))
      ? meta0
      : '';

    const schemaPath = err.object?.path || '';
    const root = err.object?.root;

    // Nearest-ancestor 'errorMessage' spec, if the schema registered any.
    const registry = root?.errorMessages ?? null;
    const spec = registry !== null
      ? resolveErrorMessageSpec(registry, schemaPath, keyword, params)
      : null;
    if (spec !== null && spec.params !== null) {
      // Author params merge OVER the error's params - into the error
      // record itself, so localizeErrors re-renders with them too.
      Object.assign(params, spec.params);
    }

    const msgid = (spec !== null && spec.msgid !== null)
      ? spec.msgid
      : (params.code !== undefined ? params.code : keyword);

    const renderMessages = root?.options?.messages !== false;
    let message = '';
    let inline = false;
    if (renderMessages) {
      if (spec !== null) {
        if (spec.msgid !== null) {
          const render = EN[spec.msgid];
          if (render !== undefined) {
            message = render(params);
          } else if (spec.render !== null) {
            message = spec.render(params);
          } else {
            message = renderErrorMessage({ keyword, msgid, params });
          }
        } else {
          message = /** @type {(params: object) => string} */ (spec.render)(params);
          inline = true;
        }
      } else {
        message = renderErrorMessage({ keyword, msgid, params });
      }
    }

    const error = new ValidationError({
      keyword,
      instancePath,
      schemaPath,
      params,
      msgid,
      message,
    });
    if (inline) markInlineMessage(error);
    return error;
  });
}

//#endregion
