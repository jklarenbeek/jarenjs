//@ts-check
/** Lexical declarations bind a host capability once; regex $search is independent. */
import { isJsonValue } from '@jarenjs/core/object';
import { JsonQueryCompileError, JsonQueryRuntimeError } from './errors.js';

/** Resolve an explicit provider and compile its immutable request declaration.
 * @param {any} providers @param {any} args @param {string} path @param {any} helpers
 * @param {any} scope @param {any} context @returns {any} */
export function normalizeLexical(providers, args, path, helpers, scope, context) {
  if (!Array.isArray(args) || args.length !== 3 || typeof args[0] !== 'string'
    || !args[2] || typeof args[2] !== 'object' || Array.isArray(args[2]) || !isJsonValue(args[2]))
    throw new JsonQueryCompileError('JQ0003', '$lexical needs [provider, text expression, literal request]', path);
  const provider = providers && Object.hasOwn(providers, args[0]) ? providers[args[0]] : null;
  if (typeof provider?.compile !== 'function')
    throw new JsonQueryCompileError('JQ0012', `lexical provider '${args[0]}' is not registered`, path);
  const spec = helpers.makeRaw(args[2], `${path}/2`);
  let run;
  try { run = provider.compile(spec.value); }
  catch (cause) { throw new JsonQueryCompileError('JQ0012', 'lexical provider rejected the request', path, { cause }); }
  if (typeof run !== 'function') throw new JsonQueryCompileError('JQ0012', 'lexical provider did not compile a request', path);
  return { args: Object.freeze([helpers.normalizeExpr(args[1], `${path}/1`, scope, context), spec]),
    entry: { compile: (gets) => (frame) => {
      const text = gets[0](frame);
      if (typeof text !== 'string') throw new JsonQueryRuntimeError('JQ2001', 'lexical text must be one string', path);
      let result;
      try { result = run(text); }
      catch (cause) { throw new JsonQueryRuntimeError('JQ2012', 'lexical provider threw', path, { cause }); }
      if (!result || !isJsonValue(result) || !['complete', 'budget-exhausted', 'invalidated', 'error', 'rebuild-required'].includes(result.state)
        || !Array.isArray(result.hits) || result.hits.some((hit) => typeof hit?.id !== 'string' || !Number.isFinite(hit.score))
        || new Set(result.hits.map((hit) => hit.id)).size !== result.hits.length
        || (result.state === 'complete' ? !Number.isSafeInteger(result.total) || result.total < result.hits.length
          : result.total !== null || result.hits.length !== 0))
        throw new JsonQueryRuntimeError('JQ2012', 'lexical provider returned an invalid or incomplete result', path);
      return result;
    } } };
}
