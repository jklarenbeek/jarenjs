//@ts-check
/** Bounded row/target outcomes and computed-field dependency scheduling. */
import { createBoundedCache } from '@jarenjs/core/cache';
import { setObjectMember, semanticKey } from '@jarenjs/core/object';
import { canonicalizeJson } from '../canonical.js';
import { createFormulaCompiler } from './index.js';
import { FormulaError, snapshot, credit } from './shared.js';

/** Copy a bounded diagnostic; arbitrary host rejection values never escape into JSON. */
function diagnostic(error, targetId, maxChars) {
  let message = 'formula evaluation failed';
  let code = 'JQ2013';
  let docPath = '';
  try {
    if (typeof error?.message === 'string') message = error.message;
    if (typeof error?.code === 'string') code = error.code;
    if (typeof error?.docPath === 'string') docPath = error.docPath;
  }
  catch { /* Host exceptions may have hostile accessors. */ }
  return { targetId, code: code.slice(0, 16), message: message.slice(0, maxChars), docPath: docPath.slice(0, maxChars) };
}

/**
 * Compile enabled targets once and refuse computed cycles before admitting rows.
 * A target is `{id, enabled?, formula}`; `$computed.name` reads a prior VALUE.
 * @param {any[]} targets
 * @param {import('./index.js').FormulaOptions & {maxRows?:number,maxCells?:number,maxErrors?:number,maxMessageChars?:number,memoSize?:number}} [options]
 */
export function compileFormulaBatch(targets, options = {}) {
  const maxRows = credit(options.maxRows, 10000, 'maxRows');
  const maxCells = credit(options.maxCells, 100000, 'maxCells');
  const maxErrors = credit(options.maxErrors, 100, 'maxErrors');
  const maxChars = credit(options.maxMessageChars, 256, 'maxMessageChars');
  const memo = createBoundedCache(credit(options.memoSize, 10000, 'memoSize'));
  const compiler = createFormulaCompiler(options);
  const list = snapshot(targets);
  if (!Array.isArray(list) || list.length > maxCells) throw new FormulaError('JQ0015', 'invalid target list', '', '/targets');
  const nodes = new Map();
  for (const [i, target] of list.entries()) {
    if (!target || typeof target.id !== 'string' || !target.id || target.id.length > 256 || nodes.has(target.id)
      || target.enabled !== undefined && typeof target.enabled !== 'boolean')
      throw new FormulaError('JQ0015', 'unique target identity and boolean enabled required', '', `/targets/${i}`);
    const node = { target, compiled: null, error: null };
    if (target.enabled !== false) {
      try { node.compiled = compiler.compile(target.formula); }
      catch (error) { node.error = diagnostic(error, target.id, maxChars); }
    }
    nodes.set(target.id, node);
  }
  const order = [], visiting = new Set(), visited = new Set();
  for (const root of nodes.values()) {
    const stack = [{ node: root, index: 0 }];
    while (stack.length) {
      const frame = stack.at(-1), id = frame.node.target.id;
      if (visited.has(id)) { stack.pop(); continue; }
      visiting.add(id);
      const dependencies = frame.node.compiled?.dependencies.computed ?? [];
      if (frame.index < dependencies.length) {
        const dependency = dependencies[frame.index++];
        if (visiting.has(dependency)) throw new FormulaError('JQ0015', 'computed dependency cycle', dependency, '/targets');
        if (!nodes.has(dependency)) throw new FormulaError('JQ0015', 'unknown computed target', dependency, '/targets');
        if (!visited.has(dependency)) stack.push({ node: nodes.get(dependency), index: 0 });
      }
      else { visiting.delete(id); visited.add(id); order.push(frame.node); stack.pop(); }
    }
  }
  return Object.freeze({ targets: list,
    /** Evaluate a bounded page; stable IDs permit memo reuse across page eviction. */
    evaluate(rows, { context = {}, revision = '', key = 'id' } = {}) {
      if (!Array.isArray(rows) || rows.length > maxRows || rows.length * list.length > maxCells)
        throw new FormulaError('JQ2009', 'batch row/cell limit exceeded', '', '');
      const frozenContext = snapshot(context);
      const counts = { rows: rows.length, cells: 0, evaluated: 0, cached: 0, value: 0, empty: 0, skip: 0, explanation: 0, error: 0, disabled: 0 };
      const errors = [];
      const results = [];
      const rowIds = new Set();
      for (const row of rows) {
        const rowId = row?.[key];
        if ((typeof rowId !== 'string' && typeof rowId !== 'number') || typeof rowId === 'string' && rowId.length > 256 || !Number.isFinite(typeof rowId === 'number' ? rowId : 0)
          || rowIds.has(canonicalizeJson(rowId))) throw new FormulaError('JQ2013', 'unique stable row IDs required', '', '');
        rowIds.add(canonicalizeJson(rowId));
        let inputError = null;
        try { canonicalizeJson(row); }
        catch (cause) { inputError = cause; }
        const computed = Object.create(null);
        const outcomes = Object.create(null);
        for (const node of order) {
          const { target, compiled } = node;
          let answer;
          let error = target.enabled === false ? null : node.error ?? (inputError ? diagnostic(inputError, target.id, maxChars) : null);
          if (target.enabled === false) answer = { kind: 'disabled' };
          else if (!error) {
            const dependencies = compiled.dependencies;
            if (dependencies.computed.some((id) => !Object.hasOwn(computed, id)))
              error = { code: 'JQ2013', targetId: target.id, message: 'computed dependency has no value', docPath: '/expression' };
            else try {
              const source = dependencies.all || compiled.doc.inputSchema ? row : dependencies.source.map((name) => Object.hasOwn(row, name) ? [name, row[name]] : [name]);
              const inputs = dependencies.computed.map((id) => [id, computed[id]]);
              const cacheKey = canonicalizeJson([rowId, target.id]);
              const inputKey = semanticKey([compiled.key, source, inputs, frozenContext, revision]);
              const prior = memo.get(cacheKey);
              if (prior?.inputKey === inputKey) { answer = prior.answer; counts.cached++; }
              else {
                counts.evaluated++;
                answer = compiled.evaluate(row, frozenContext, computed);
                if (answer.kind !== 'error') memo.set(cacheKey, { inputKey, answer });
              }
              if (answer.kind === 'error') { error = diagnostic(answer, target.id, maxChars); answer = null; }
            }
            catch (cause) { error = diagnostic(cause, target.id, maxChars); }
          }
          if (error) {
            const index = errors.length < maxErrors ? errors.length : null;
            if (index !== null) errors.push({ ...error, rowId });
            answer = { kind: 'error', code: error.code, diagnostic: index };
          }
          setObjectMember(outcomes, target.id, answer);
          if (Object.hasOwn(answer, 'value')) setObjectMember(computed, target.id, answer.value);
          counts[answer.kind]++; counts.cells++;
        }
        results.push({ id: rowId, outcomes });
      }
      return snapshot({ results, counts, errors, omittedErrors: counts.error - errors.length });
    },
    clear() { memo.clear(); },
  });
}
