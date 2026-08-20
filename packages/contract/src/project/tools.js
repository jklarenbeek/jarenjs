//@ts-check
/**
 * @file `contractTools`: the public, invokable operations of a contract as
 * tool definitions for `@jarenjs/ai`'s toolbox — `{ name, description,
 * inputSchema, execute }`, a plain object the toolbox and a WebMCP host
 * read, so this package never imports the ai package (the generated-
 * document rule). `execute` calls the client's `invoke` and answers the
 * outcome JSON, so a model sees the same `{ ok, value | error, meta }`
 * an app does; the toolbox validates the arguments against `inputSchema`
 * before `execute` runs, and `invoke` validates them again against the
 * same schema (the contract's own validator) before anything is sent.
 */

import { isJsonObject } from '@jarenjs/core/object';

import { ContractHostError } from '../errors.js';
import { retainedOperations } from '../public.js';
import { bundleSameDocument } from '../bundle.js';

/**
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 */

/**
 * A tool definition as `@jarenjs/ai`'s `createToolbox().add` takes it —
 * the same shape WebMCP's `registerTool` reads.
 * @typedef {Object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {any} inputSchema - the operation's input schema, self-contained
 * @property {(args: any) => any} execute - `client.invoke(op, args)`, resolving the outcome
 */

/**
 * A client as the tools read it — any binding's client. The members are
 * `any` so a client whose `invoke` narrows its own context type (the http
 * client's `InvokeContext`) still assigns.
 * @typedef {{ invoke: (op: string, input: any, ctx?: any) => any }} ToolClient
 */

/**
 * @typedef {Object} ContractToolsOptions
 * @property {readonly string[]} [ops] - the operations to expose (default:
 *   every public, non-opaque operation); an opaque or unknown id is refused
 * @property {(id: string) => string} [name] - the tool name of an
 *   operation (default: the id with `.` → `_`); must satisfy OpenAI's
 *   `^[a-zA-Z0-9_-]{1,64}$` and be distinct per operation
 */

/** OpenAI's function-name constraint, which WebMCP tool names satisfy too. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * The default tool name of an operation: its id with `.` → `_` (`a.b` →
 * `a_b`; injective, since an id carries no `_`).
 * @param {string} id
 * @returns {string}
 */
function defaultName(id) {
  return id.replaceAll('.', '_');
}

/**
 * The input schema of a tool: the operation's input with the `$defs` it
 * reaches inlined (self-contained), or a closed empty object for an
 * operation without input.
 * @param {CompiledOperation} op
 * @param {Contract} contract
 * @returns {any}
 */
function toolInputSchema(op, contract) {
  if (op.input === null) return { type: 'object', properties: {}, additionalProperties: false };
  return bundleSameDocument(op.input.schema, contract.doc);
}

/**
 * Tool definitions for the public, invokable operations of a contract.
 * @param {Contract} contract
 * @param {ToolClient} client - a client opened on the same contract (`openHttpClient`, or any binding's)
 * @param {ContractToolsOptions} [options]
 * @returns {ToolDefinition[]} in document order
 * @throws {ContractHostError} `JC1008` — not a compiled contract, a client
 *   without `invoke`, `ops` naming an unknown or opaque operation, a tool
 *   name outside `^[a-zA-Z0-9_-]{1,64}$`, or two operations mapping to one name
 * @example
 * const toolbox = createToolbox();                    // @jarenjs/ai
 * for (const tool of contractTools(contract, client)) toolbox.add(tool);
 * await toolbox.execute('product_save', { id: 1, revision: 2, product: { … } }); // → an outcome
 */
export function contractTools(contract, client, options = {}) {
  if (!isJsonObject(options)) throw new ContractHostError('JC1008', 'contractTools: options must be an object');
  const ops = retainedOperations(contract, options.ops, 'contractTools');
  if (client === null || typeof client !== 'object' || typeof client.invoke !== 'function') {
    throw new ContractHostError('JC1008', 'contractTools: client must be a contract client (an object with invoke)');
  }
  const nameOf = options.name === undefined ? defaultName : options.name;
  if (typeof nameOf !== 'function') throw new ContractHostError('JC1008', 'contractTools: options.name must be a function (id) => string');
  /** @type {ToolDefinition[]} */
  const tools = [];
  /** @type {Map<string, string>} */
  const taken = new Map();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.http.opaque) {
      // an explicit ops entry named it; the default set never includes one
      if (options.ops !== undefined) {
        throw new ContractHostError('JC1008', `contractTools: '${op.id}' is an opaque operation (media ${op.http.media}) — a tool carries JSON; reach it through client.url`);
      }
      continue;
    }
    const name = nameOf(op.id);
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
      throw new ContractHostError('JC1008', `contractTools: the tool name of '${op.id}' must match ^[a-zA-Z0-9_-]{1,64}$ (got ${typeof name === 'string' ? `'${name}'` : typeof name})`);
    }
    const other = taken.get(name);
    if (other !== undefined) {
      throw new ContractHostError('JC1008', `contractTools: operations '${other}' and '${op.id}' both map to the tool name '${name}'`);
    }
    taken.set(name, op.id);
    const id = op.id;
    const hasInput = op.input !== null;
    tools.push({
      name,
      description: op.doc !== null ? op.doc : `${op.kind} operation ${id} (${op.http.method} ${op.http.path})`,
      inputSchema: toolInputSchema(op, contract),
      execute: (args) => client.invoke(id, hasInput ? args : null),
    });
  }
  return tools;
}
