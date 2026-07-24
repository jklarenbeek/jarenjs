//@ts-check
/**
 * The toolbox: a registry of tools an AI may call, each declared with
 * a JSON Schema `inputSchema` that Jaren itself compiles and enforces
 * before the tool runs — the suite guarding its own tools. One
 * registry serves every surface that wants to drive the host app:
 *
 *  - an embedded agent loop (`toFunctionTools()` produces the OpenAI
 *    function-calling definitions, `execute()` dispatches a call);
 *  - a browser-hosted agent over WebMCP (`registerModelContext()`
 *    publishes the same tools on `navigator.modelContext`).
 *
 * `execute` never throws for content-level problems: an unknown tool,
 * invalid input or a throwing tool comes back as `{ error }` — a
 * result the calling model can read and recover from.
 */

import { JarenValidator } from '@jarenjs/validate';

/** Validation errors reported back to the model per rejected call. */
const MAX_INPUT_ERRORS = 8;

/**
 * Normalize a compiled check's outcome: the default validator collects
 * errors (`{ valid, errors }`), an injected one may answer a bare
 * boolean.
 * @param {(input: any) => any} check
 * @param {any} input
 * @returns {{ valid: boolean, errors: any[] }}
 */
function checkOutcome(check, input) {
  const outcome = check(input);
  return typeof outcome === 'object' && outcome !== null
    ? { valid: outcome.valid === true, errors: outcome.errors ?? [] }
    : { valid: outcome === true, errors: [] };
}

/** Whether a property schema asks for structure (object or array). */
function wantsStructure(schema) {
  const type = schema?.type;
  return type === 'object' || type === 'array'
    || (Array.isArray(type) && (type.includes('object') || type.includes('array')));
}

/**
 * The top-level properties that wanted structure but arrived as
 * strings — after coercion failed, these are what went wrong.
 * @param {any} inputSchema
 * @param {any} input
 * @returns {string[]}
 */
function stringStructureKeys(inputSchema, input) {
  const properties = inputSchema?.properties;
  if (properties == null || input === null || typeof input !== 'object') return [];
  return Object.entries(properties)
    .filter(([key, schema]) => wantsStructure(schema) && typeof input[key] === 'string')
    .map(([key]) => key);
}

/**
 * A copy of `input` with string-valued top-level properties parsed as
 * JSON wherever the schema wants an object or array — or `null` when
 * nothing was coercible.
 * @param {any} inputSchema
 * @param {any} input
 * @returns {any | null}
 */
function coerceStringArguments(inputSchema, input) {
  const properties = inputSchema?.properties;
  if (properties == null || input === null || typeof input !== 'object') return null;
  let coerced = null;
  for (const [key, schema] of Object.entries(properties)) {
    if (!wantsStructure(schema) || typeof input[key] !== 'string') continue;
    try {
      const parsed = JSON.parse(input[key]);
      if (parsed !== null && typeof parsed === 'object') {
        if (coerced === null) coerced = { ...input };
        coerced[key] = parsed;
      }
    }
    catch {
      // not JSON text: keep the original so validation reports it
    }
  }
  return coerced;
}

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {any} inputSchema - JSON Schema for the arguments object
 * @property {(input: any) => any} execute - may return a value or a promise
 */

/**
 * @param {{ validator?: any }} [options] - a shared JarenValidator, if
 *   the host already has one
 * @returns {{
 *   add: (def: ToolDef) => void,
 *   list: () => { name: string, description: string, inputSchema: any }[],
 *   toFunctionTools: () => any[],
 *   execute: (name: string, args: any) => any,
 * }}
 */
export function createToolbox(options = {}) {
  const jaren = options.validator ?? new JarenValidator({ skipErrors: false, collectErrors: true });
  /** @type {Map<string, ToolDef & { check: (input: any) => any }>} */
  const tools = new Map();

  /** @param {ToolDef} def */
  function add(def) {
    tools.set(def.name, { ...def, check: jaren.compile(def.inputSchema) });
  }

  function list() {
    return [...tools.values()].map(({ name, description, inputSchema }) =>
      ({ name, description, inputSchema }));
  }

  function toFunctionTools() {
    return [...tools.values()].map(({ name, description, inputSchema }) => ({
      type: 'function',
      function: { name, description, parameters: inputSchema },
    }));
  }

  /**
   * Dispatch one call. Synchronous tools answer synchronously (WebMCP
   * hosts call `execute` directly); a promise-returning tool resolves
   * to its value with rejections folded into `{ error }`.
   * @param {string} name
   * @param {any} args
   */
  function execute(name, args) {
    const tool = tools.get(name);
    if (tool === undefined) return { error: `unknown tool '${name}'` };
    let input = args ?? {};
    let outcome = checkOutcome(tool.check, input);
    if (!outcome.valid) {
      // models routinely JSON-encode nested arguments; when a property
      // wanted structure but arrived as parseable JSON text, validate
      // the parsed value instead — valid or not, its errors point into
      // the structure the model meant to send
      const coerced = coerceStringArguments(tool.inputSchema, input);
      if (coerced !== null) {
        input = coerced;
        outcome = checkOutcome(tool.check, coerced);
      }
    }
    if (!outcome.valid) {
      const stringly = stringStructureKeys(tool.inputSchema, input);
      return {
        error: `invalid input for ${name}`,
        errors: outcome.errors.slice(0, MAX_INPUT_ERRORS).map((e) => ({
          instancePath: e.instancePath ?? '',
          keyword: e.keyword ?? '',
          message: e.message ?? 'invalid',
        })),
        ...(stringly.length === 0 ? {} : {
          hint: `${stringly.map((k) => `'${k}'`).join(', ')} arrived as a JSON-encoded string that does not parse — pass a real JSON value, not quoted JSON text`,
        }),
        inputSchema: tool.inputSchema,
      };
    }
    try {
      const value = tool.execute(input);
      return typeof value?.then === 'function'
        ? value.then((resolved) => resolved, (/** @type {any} */ err) =>
          ({ error: err?.message ?? String(err) }))
        : value;
    }
    catch (err) {
      return { error: /** @type {any} */ (err)?.message ?? String(err) };
    }
  }

  return { add, list, toFunctionTools, execute };
}

/**
 * Publish a toolbox on a WebMCP `navigator.modelContext` surface, so a
 * browser-hosted agent can call the same schema-guarded tools an
 * embedded agent uses. Progressive enhancement: with no context
 * present (or an unusable one) this registers nothing and reports
 * `false`.
 * @param {ReturnType<typeof createToolbox>} toolbox
 * @param {any} [modelContext] - defaults to `navigator.modelContext`
 * @param {(err: Error) => void} [onError]
 * @returns {boolean} whether the tools were registered
 */
export function registerModelContext(toolbox, modelContext, onError) {
  const context = modelContext
    ?? (typeof navigator !== 'undefined' ? /** @type {any} */ (navigator).modelContext : undefined);
  if (context === undefined || context === null) return false;

  const tools = toolbox.list().map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
    execute: (/** @type {any} */ args) => toolbox.execute(name, args),
  }));

  try {
    if (typeof context.provideContext === 'function') {
      context.provideContext({ tools });
    }
    else if (typeof context.registerTool === 'function') {
      for (const tool of tools) context.registerTool(tool);
    }
    else {
      return false;
    }
    return true;
  }
  catch (err) {
    onError?.(/** @type {Error} */ (err));
    return false;
  }
}
