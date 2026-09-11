//@ts-check
/** Versioned saved formulas compile into the existing JSON Query closures. */
import { createBoundedCache } from '@jarenjs/core/cache';
import { semanticKey } from '@jarenjs/core/object';
import { compileJsonQuery } from '../query/index.js';
import { FormulaError, snapshot, credit } from './shared.js';

export { FormulaError };

/**
 * @typedef {object} FormulaOptions
 * @property {Record<string, {version:string, schema:any}>} [schemas]
 * @property {Record<string, {version:string, run:(...args:any[])=>any, trust:'pure', cost:number}>} [helpers]
 * @property {(schema:any, path:string)=>(value:any)=>boolean} [compileTypeTest]
 * @property {import('../query/index.js').JsonQueryLimits} [limits]
 * @property {number} [cacheSize]
 */

/** Validate a versioned profile; compilation checks the expression and capabilities. */
export function formulaDocument(value) {
  let doc;
  try { doc = snapshot(value); }
  catch (cause) { throw new FormulaError('JQ0013', 'profile must be JSON', value?.id ?? '', '', cause); }
  const fail = (reason, path) => { throw new FormulaError('JQ0013', reason, doc?.id ?? '', path); };
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) fail('profile must be an object', '');
  if (doc.$formula !== '1') fail('unsupported language version', '/$formula');
  for (const key of ['id', 'revision']) if (typeof doc[key] !== 'string' || !doc[key] || doc[key].length > 256) fail(`${key} must be nonempty and at most 256 characters`, `/${key}`);
  if (!Object.hasOwn(doc, 'expression')) fail('expression is required', '/expression');
  if (doc.resultMode !== undefined && !['value', 'outcome'].includes(doc.resultMode)) fail('unknown result mode', '/resultMode');
  if (doc.bindings !== undefined && (doc.bindings === null || typeof doc.bindings !== 'object' || Array.isArray(doc.bindings))) fail('bindings must be an object', '/bindings');
  if (Object.hasOwn(doc.bindings ?? {}, 'computed') || Object.hasOwn(doc.bindings ?? {}, 'context')) fail('computed/context are reserved bindings', '/bindings');
  if (doc.helpers !== undefined && !Array.isArray(doc.helpers)) fail('helpers must be an array', '/helpers');
  const names = new Set();
  for (const [i, ref] of (doc.helpers ?? []).entries()) {
    if (!ref || typeof ref.name !== 'string' || !ref.name || typeof ref.version !== 'string' || !ref.version || names.has(ref.name)) fail('unique helper name and version required', `/helpers/${i}`);
    names.add(ref.name);
  }
  return doc;
}

/** Extract conservative top-level field dependencies from the normalized Query AST. */
function fields(root) {
  const source = new Set();
  const computed = new Set();
  let all = false;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'var' && node.name === '$') all = true;
    if (node.kind === 'var' && node.name === 'computed') throw new FormulaError('JQ0015', 'computed references require a named target', '', node.docPath);
    if (node.kind === 'path' && (node.name === '$' || node.name === 'computed')) {
      const first = node.segments[0];
      const name = first && !first.descendant && first.selectors.length === 1 && first.selectors[0].kind === 'name' ? first.selectors[0].name : null;
      if (node.name === 'computed') {
        if (name === null) throw new FormulaError('JQ0015', 'computed references require a named target', '', node.docPath);
        computed.add(name);
      }
      else if (name === null || !node.singular) all = true;
      else source.add(name);
    }
    // Constants are data: strings and objects inside them are never dependencies.
    if (node.kind === 'literal') return;
    for (const value of Object.values(node)) if (value && typeof value === 'object') {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  visit(root);
  return snapshot({ source: [...source].sort(), computed: [...computed].sort(), all });
}

/** Validate an explicit outcome without interpreting ordinary object values. */
function outcome(value, doc) {
  const keys = { value: ['kind', 'value'], skip: ['kind'], explanation: ['kind', 'text', 'value'], error: ['kind', 'message'] };
  const valid = value && typeof value === 'object' && !Array.isArray(value) && (
    value.kind === 'value' && Object.hasOwn(value, 'value')
    || value.kind === 'skip'
    || value.kind === 'explanation' && typeof value.text === 'string'
    || value.kind === 'error' && typeof value.message === 'string');
  if (!valid || Object.keys(value).some((key) => !keys[value.kind].includes(key))) throw new FormulaError('JQ2014', 'invalid tagged outcome', doc.id, '/expression');
  return snapshot(value);
}

/**
 * A bounded compilation cache. Capability function identity and schema content join
 * the entire profile in its key; mutating a registry never silently reuses a closure.
 * @param {FormulaOptions} [options]
 */
export function createFormulaCompiler(options = {}) {
  const cache = createBoundedCache(credit(options.cacheSize, 128, 'cacheSize'));
  const identities = new WeakMap();
  let nextIdentity = 0;
  function identity(fn) {
    if (!identities.has(fn)) identities.set(fn, ++nextIdentity);
    return identities.get(fn);
  }
  function compile(value) {
    const doc = formulaDocument(value);
    const functions = Object.create(null);
    const capabilityKeys = [];
    for (const [i, ref] of (doc.helpers ?? []).entries()) {
      const helper = Object.hasOwn(options.helpers ?? {}, ref.name) ? options.helpers[ref.name] : null;
      if (!helper || helper.version !== ref.version || helper.trust !== 'pure' || typeof helper.run !== 'function'
        || !Number.isFinite(helper.cost) || helper.cost <= 0)
        throw new FormulaError('JQ0014', `missing/incompatible pure helper ${ref.name}@${ref.version}`, doc.id, `/helpers/${i}`);
      functions[ref.name] = helper.run;
      capabilityKeys.push([ref.name, ref.version, helper.cost, identity(helper.run)]);
    }
    const schemas = {};
    for (const key of ['inputSchema', 'resultSchema']) if (doc[key] !== undefined) {
      const ref = doc[key];
      const entry = ref && Object.hasOwn(options.schemas ?? {}, ref.id) ? options.schemas[ref.id] : null;
      if (!ref || typeof ref.version !== 'string' || !entry || entry.version !== ref.version || typeof options.compileTypeTest !== 'function')
        throw new FormulaError('JQ0014', 'missing/incompatible schema or type-test compiler', doc.id, `/${key}`);
      schemas[key] = snapshot(entry.schema);
    }
    const key = semanticKey([doc, capabilityKeys, schemas, options.compileTypeTest ? identity(options.compileTypeTest) : null, options.limits ?? {}]);
    const cached = cache.get(key);
    if (cached) return cached;
    const tests = {};
    for (const name of Object.keys(schemas)) {
      try {
        tests[name] = options.compileTypeTest(schemas[name], `/${name}`);
        if (typeof tests[name] !== 'function') throw new TypeError('expected a predicate');
      }
      catch (cause) { throw new FormulaError('JQ0014', 'schema rejected', doc.id, `/${name}`, cause); }
    }
    let query;
    try {
      query = compileJsonQuery(doc.expression, { functions, compileTypeTest: options.compileTypeTest,
        externals: [...Object.keys(doc.bindings ?? {}), 'computed', 'context'], analysis: true,
        limits: options.limits ?? { steps: 10000, depth: 64, resultItems: 10000, sequenceItems: 10000 } });
    }
    catch (cause) { throw new FormulaError(cause.code ?? 'JQ0013', cause.reason ?? cause.message, doc.id, `/expression${cause.docPath ?? ''}`, cause); }
    let dependencies;
    try { dependencies = fields(query.analysis.root); }
    catch (cause) { throw new FormulaError('JQ0015', cause.reason ?? cause.message, doc.id, `/expression${cause.docPath}`, cause); }
    const compiled = Object.freeze({ doc, key, dependencies, queryDependencies: query.dependencies,
      evaluate(input, context = {}, computed = {}) {
        try {
          const data = snapshot(input);
          if (tests.inputSchema && !tests.inputSchema(data)) throw new FormulaError('JQ2013', 'input schema failed', doc.id, '/inputSchema');
          const items = query.items(data, snapshot({ ...doc.bindings, context, computed }));
          if (items.length === 0) return snapshot({ kind: 'empty', values: [] });
          const result = items.length === 1 ? items[0] : items;
          const answer = doc.resultMode === 'outcome' ? outcome(result, doc) : snapshot({ kind: 'value', value: result });
          if (tests.resultSchema && Object.hasOwn(answer, 'value') && !tests.resultSchema(answer.value))
            throw new FormulaError('JQ2013', 'result schema failed', doc.id, '/resultSchema');
          return answer;
        }
        catch (cause) {
          if (cause instanceof FormulaError) throw cause;
          throw new FormulaError(cause.code ?? 'JQ2013', cause.reason ?? cause.message, doc.id, `/expression${cause.docPath ?? ''}`, cause);
        }
      },
    });
    cache.set(key, compiled);
    return compiled;
  }
  return { compile, clear: () => cache.clear(), size: () => cache.size() };
}

/** Compile one profile without retaining a cache. @param {any} doc @param {FormulaOptions} [options] */
export function compileFormula(doc, options = {}) {
  return createFormulaCompiler(options).compile(doc);
}
