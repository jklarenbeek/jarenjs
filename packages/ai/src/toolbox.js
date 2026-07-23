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
  const jaren = options.validator ?? new JarenValidator();
  /** @type {Map<string, ToolDef & { check: (input: any) => boolean }>} */
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
    const input = args ?? {};
    if (!tool.check(input))
      return { error: `invalid input for ${name}`, inputSchema: tool.inputSchema };
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
