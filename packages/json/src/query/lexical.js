//@ts-check
/** Lexical declarations bind a host capability once; regex $search is independent. */
import { isJsonValue } from '@jarenjs/core/object';
import { queryCompileError, queryRuntimeError } from './messages.js';

/** Resolve an explicit provider and compile its immutable request declaration.
 * @param {any} providers @param {any} args @param {string} path @param {any} helpers
 * @param {any} scope @param {any} context @returns {any} */
export function normalizeLexical(providers, args, path, helpers, scope, context) {
  if (!Array.isArray(args) || args.length !== 3 || typeof args[0] !== 'string'
    || !args[2] || typeof args[2] !== 'object' || Array.isArray(args[2]) || !isJsonValue(args[2]))
    throw queryCompileError('JQ0003', 'query/lexical-arguments', {}, path);
  const provider = providers && Object.hasOwn(providers, args[0]) ? providers[args[0]] : null;
  if (typeof provider?.compile !== 'function')
    throw queryCompileError('JQ0012', 'query/lexical-unregistered', { name: args[0] }, path);
  const spec = helpers.makeRaw(args[2], `${path}/2`);
  let run;
  try { run = provider.compile(spec.value); }
  catch (cause) { throw queryCompileError('JQ0012', 'query/lexical-rejected', {}, path, { cause }); }
  if (typeof run !== 'function') throw queryCompileError('JQ0012', 'query/lexical-no-request', {}, path);
  return { args: Object.freeze([helpers.normalizeExpr(args[1], `${path}/1`, scope, context), spec]),
    entry: { compile: (gets) => (frame) => {
      const text = gets[0](frame);
      if (typeof text !== 'string') throw queryRuntimeError('JQ2001', 'query/lexical-text', {}, path);
      let result;
      try { result = run(text); }
      catch (cause) { throw queryRuntimeError('JQ2012', 'query/lexical-threw', {}, path, { cause }); }
      if (!result || !isJsonValue(result) || !['complete', 'budget-exhausted', 'invalidated', 'error', 'rebuild-required'].includes(result.state)
        || !Array.isArray(result.hits) || result.hits.some((hit) => typeof hit?.id !== 'string' || !Number.isFinite(hit.score))
        || new Set(result.hits.map((hit) => hit.id)).size !== result.hits.length
        || (result.state === 'complete' ? !Number.isSafeInteger(result.total) || result.total < result.hits.length
          : result.total !== null || result.hits.length !== 0))
        throw queryRuntimeError('JQ2012', 'query/lexical-result', {}, path);
      return result;
    } } };
}
