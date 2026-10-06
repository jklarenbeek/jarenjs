//@ts-check
/** Versioned saved formulas compile into the existing JSON Query closures. */
import { createBoundedCache } from '@jarenjs/core/cache';
import { semanticKey } from '@jarenjs/core/object';
import { compileJsonQuery } from '../query/index.js';
import { validateDateNames, validateDecimalFormats } from '../query/normalize.js';
import { canonicalizeJson } from '../canonical.js';
import { FormulaError, causeMessage, formulaMessage, snapshot, credit, FORMULA_OPTIONS, checkFormulaOptions } from './shared.js';

export { FormulaError };
export { formulaMessagesEn } from './messages.js';

/**
 * @typedef {object} FormulaOptions
 * @property {Record<string, {version:string, schema:any}>} [schemas]
 * @property {Record<string, {version:string, run:(...args:any[])=>any, trust:'pure', cost:number}>} [helpers]
 * @property {(schema:any, path:string)=>(value:any)=>boolean} [compileTypeTest]
 * @property {import('../query/index.js').JsonQueryLimits} [limits]
 * @property {number} [cacheSize]
 * @property {Pick<import('../jslt/registry.js').JsltRegistry, 'packs' | 'forPacks'>} [packs]
 *   The operator packs a profile may list (`packs: [{name, version}]`): a
 *   `createJsltRegistry()` registry from `@jarenjs/json/jslt`.
 * @property {import('@jarenjs/core/dates').DateNames} [dateNames] - The month
 *   and weekday names `$date-format` spells (`compileDateLocale(pack).names`
 *   from `@jarenjs/locales`).
 * @property {Record<string, object>} [decimalFormats] - The decimal formats
 *   `$format-number` and `$quantity` name (`compileNumberLocale(pack).decimalFormat`).
 */

/** Validate a versioned profile; compilation checks the expression and capabilities. */
export function formulaDocument(value) {
  let doc;
  try { doc = snapshot(value); }
  catch (cause) { throw new FormulaError('JQ0013', formulaMessage('query/formula/profile-json'), value?.id ?? '', '', cause); }
  const fail = (/** @type {string} */ messageId, /** @type {string} */ path, params = {}) => {
    throw new FormulaError('JQ0013', formulaMessage(messageId, params), doc?.id ?? '', path);
  };
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) fail('query/formula/profile-object', '');
  if (doc.$formula !== '1') fail('query/formula/profile-version', '/$formula');
  for (const key of ['id', 'revision']) if (typeof doc[key] !== 'string' || !doc[key] || doc[key].length > 256) fail('query/formula/profile-identity', `/${key}`, { member: key });
  if (!Object.hasOwn(doc, 'expression')) fail('query/formula/profile-expression', '/expression');
  if (doc.resultMode !== undefined && !['value', 'outcome'].includes(doc.resultMode)) fail('query/formula/profile-result-mode', '/resultMode');
  if (doc.bindings !== undefined && (doc.bindings === null || typeof doc.bindings !== 'object' || Array.isArray(doc.bindings))) fail('query/formula/profile-bindings', '/bindings');
  if (Object.hasOwn(doc.bindings ?? {}, 'computed') || Object.hasOwn(doc.bindings ?? {}, 'context')) fail('query/formula/profile-reserved', '/bindings');
  if (doc.helpers !== undefined && !Array.isArray(doc.helpers)) fail('query/formula/profile-helpers', '/helpers');
  const names = new Set();
  for (const [i, ref] of (doc.helpers ?? []).entries()) {
    if (!ref || typeof ref.name !== 'string' || !ref.name || typeof ref.version !== 'string' || !ref.version || names.has(ref.name)) fail('query/formula/profile-helper', `/helpers/${i}`);
    names.add(ref.name);
  }
  if (doc.packs !== undefined && !Array.isArray(doc.packs)) fail('query/formula/profile-packs', '/packs');
  const packs = new Set();
  for (const [i, ref] of (doc.packs ?? []).entries()) {
    if (!ref || typeof ref.name !== 'string' || !ref.name || typeof ref.version !== 'string' || !ref.version || packs.has(ref.name)) fail('query/formula/profile-pack', `/packs/${i}`);
    packs.add(ref.name);
  }
  return doc;
}

/** Extract conservative top-level field dependencies from the normalized Query AST. @param {any} root @param {string} formulaId */
function fields(root, formulaId) {
  const unnamed = (/** @type {any} */ node) => new FormulaError('JQ0015', formulaMessage('query/formula/computed-unnamed'), formulaId, `/expression${node.docPath}`);
  const source = new Set();
  const computed = new Set();
  let all = false;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'var' && node.name === '$') all = true;
    if (node.kind === 'var' && node.name === 'computed') throw unnamed(node);
    if (node.kind === 'path' && (node.name === '$' || node.name === 'computed')) {
      const first = node.segments[0];
      const name = first && !first.descendant && first.selectors.length === 1 && first.selectors[0].kind === 'name' ? first.selectors[0].name : null;
      if (node.name === 'computed') {
        if (name === null) throw unnamed(node);
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
  if (!valid || Object.keys(value).some((key) => !keys[value.kind].includes(key))) throw new FormulaError('JQ2014', formulaMessage('query/formula/outcome-invalid'), doc.id, '/expression');
  return snapshot(value);
}

/**
 * A bounded compilation cache. Capability function identity and schema content join
 * the entire profile in its key; mutating a registry never silently reuses a closure.
 * @param {FormulaOptions} [options]
 */
export function createFormulaCompiler(options = {}) {
  checkFormulaOptions(options, FORMULA_OPTIONS, 'formula');
  // the host's locale data and pack registry are checked once, here: a
  // malformed one is the host's TypeError, never every document's error
  if (options.dateNames !== undefined) validateDateNames(options.dateNames);
  if (options.decimalFormats !== undefined) validateDecimalFormats(options.decimalFormats);
  if (options.packs !== undefined && (typeof options.packs?.packs !== 'function' || typeof options.packs?.forPacks !== 'function'))
    throw new TypeError('options.packs must be an operator pack registry - createJsltRegistry() with its packs - not a list of packs');
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
        throw new FormulaError('JQ0014', formulaMessage('query/formula/helper-missing', { name: ref.name, version: ref.version }), doc.id, `/helpers/${i}`);
      functions[ref.name] = helper.run;
      capabilityKeys.push([ref.name, ref.version, helper.cost, identity(helper.run)]);
    }
    // operator packs: each listed pack, at its version, from the host's registry
    const packNames = [];
    for (const [i, ref] of (doc.packs ?? []).entries()) {
      const supplied = options.packs?.packs?.().find((known) => known.name === ref.name) ?? null;
      if (!supplied || supplied.version !== ref.version)
        throw new FormulaError('JQ0014', formulaMessage('query/formula/pack-missing', { name: ref.name, version: ref.version }), doc.id, `/packs/${i}`);
      packNames.push(ref.name);
      capabilityKeys.push(['pack', ref.name, ref.version, identity(options.packs)]);
    }
    const packOptions = packNames.length === 0 ? { extensions: undefined, functions: {} } : options.packs.forPacks(packNames);
    // a helper named like a function of a listed pack would shadow one or the other: refused, not resolved
    for (const [i, ref] of (doc.helpers ?? []).entries()) {
      if (Object.hasOwn(packOptions.functions ?? {}, ref.name))
        throw new FormulaError('JQ0014', formulaMessage('query/formula/helper-shadows', { name: ref.name }), doc.id, `/helpers/${i}`);
    }
    const schemas = {};
    for (const key of ['inputSchema', 'resultSchema']) if (doc[key] !== undefined) {
      const ref = doc[key];
      const entry = ref && Object.hasOwn(options.schemas ?? {}, ref.id) ? options.schemas[ref.id] : null;
      if (!ref || typeof ref.version !== 'string' || !entry || entry.version !== ref.version || typeof options.compileTypeTest !== 'function')
        throw new FormulaError('JQ0014', formulaMessage('query/formula/schema-missing'), doc.id, `/${key}`);
      schemas[key] = snapshot(entry.schema);
    }
    const key = semanticKey([doc, capabilityKeys, schemas, options.compileTypeTest ? identity(options.compileTypeTest) : null, options.limits ?? {},
      options.dateNames ?? null, options.decimalFormats ?? null]);
    const cached = cache.get(key);
    if (cached) return cached;
    const tests = {};
    for (const name of Object.keys(schemas)) {
      try {
        tests[name] = options.compileTypeTest(schemas[name], `/${name}`);
        if (typeof tests[name] !== 'function') throw new TypeError('expected a predicate');
      }
      catch (cause) { throw new FormulaError('JQ0014', formulaMessage('query/formula/schema-rejected'), doc.id, `/${name}`, cause); }
    }
    let query;
    try {
      query = compileJsonQuery(doc.expression, { functions: { ...packOptions.functions, ...functions },
        extensions: packOptions.extensions, compileTypeTest: options.compileTypeTest,
        dateNames: options.dateNames, decimalFormats: options.decimalFormats,
        externals: [...Object.keys(doc.bindings ?? {}), 'computed', 'context'], analysis: true,
        limits: options.limits ?? { steps: 10000, depth: 64, resultItems: 10000, sequenceItems: 10000 } });
    }
    catch (cause) { throw new FormulaError(cause.code ?? 'JQ0013', causeMessage(cause), doc.id, `/expression${cause.docPath ?? ''}`, cause); }
    const dependencies = fields(query.analysis.root, doc.id);
    const compiled = Object.freeze({ doc, key, dependencies, queryDependencies: query.dependencies,
      evaluate(input, context = {}, computed = {}) {
        try {
          const data = snapshot(input);
          if (tests.inputSchema && !tests.inputSchema(data)) throw new FormulaError('JQ2013', formulaMessage('query/formula/input-schema'), doc.id, '/inputSchema');
          const items = query.items(data, snapshot({ ...doc.bindings, context, computed }));
          if (items.length === 0) return snapshot({ kind: 'empty', values: [] });
          const result = items.length === 1 ? items[0] : items;
          const answer = doc.resultMode === 'outcome' ? outcome(result, doc) : snapshot({ kind: 'value', value: result });
          if (tests.resultSchema && Object.hasOwn(answer, 'value') && !tests.resultSchema(answer.value))
            throw new FormulaError('JQ2013', formulaMessage('query/formula/result-schema'), doc.id, '/resultSchema');
          return answer;
        }
        catch (cause) {
          if (cause instanceof FormulaError) throw cause;
          throw new FormulaError(cause.code ?? 'JQ2013', causeMessage(cause), doc.id, `/expression${cause.docPath ?? ''}`, cause);
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

/**
 * Per-row agreement of a compiled formula with the outputs a host's own
 * trusted runner produced: the parity check a migrated source is accepted
 * by. The library never runs the original; `expected[i]` is the host's
 * outcome for `rows[i]`, in the formula's outcome shape (`{kind:'value',
 * value}`, `{kind:'empty', values:[]}`, `{kind:'skip'}`, `{kind:'explanation',
 * text, value?}` or `{kind:'error'}`). Outcomes compare as canonical JSON;
 * two errors agree whatever their messages, since a JavaScript TypeError and
 * a query refusal word the same failure differently. An expected outcome
 * that is not JSON (`NaN`, `Infinity`) is refused before any row runs: a
 * `JQ2013` FormulaError whose `docPath` (`/i/…`) names the row.
 * @param {{ evaluate: (row: any, context?: any) => any }} formula - a compiled formula
 * @param {any[]} rows
 * @param {any[]} expected
 * @param {{ context?: any, maxRows?: number, maxMismatches?: number }} [options]
 * @returns {{ rows: number, agree: number, differ: number, mismatches: { index: number, expected: any, actual: any }[], omittedMismatches: number }}
 */
export function checkFormulaParity(formula, rows, expected, options = {}) {
  checkFormulaOptions(options, ['context', 'maxRows', 'maxMismatches'], 'parity');
  const maxRows = credit(options.maxRows, 10000, 'maxRows');
  const maxMismatches = credit(options.maxMismatches, 20, 'maxMismatches');
  if (!formula || typeof formula.evaluate !== 'function') throw new TypeError('checkFormulaParity needs a compiled formula');
  if (!Array.isArray(rows) || !Array.isArray(expected) || rows.length !== expected.length)
    throw new TypeError('rows and expected outputs must be arrays of one length');
  if (rows.length > maxRows) throw new TypeError('parity row limit exceeded');
  const shape = (/** @type {any} */ outcome) => (outcome?.kind === 'error' ? '{"kind":"error"}' : canonicalizeJson(outcome));
  // every expected outcome is JSON before any row runs: one that is not is the host's error, named by its row
  const wanted = expected.map((outcome, index) => {
    try { return shape(outcome); }
    catch (cause) {
      throw new FormulaError('JQ2013', formulaMessage('query/formula/parity-expected', { index }), /** @type {any} */ (formula).doc?.id ?? '',
        `/${index}${/** @type {any} */ (cause)?.dataPath ?? ''}`, cause);
    }
  });
  let agree = 0;
  const mismatches = [];
  let omitted = 0;
  for (const [index, row] of rows.entries()) {
    let actual;
    try { actual = formula.evaluate(row, options.context ?? {}); }
    catch (error) { actual = { kind: 'error', code: /** @type {any} */ (error)?.code ?? null }; }
    if (shape(actual) === wanted[index]) { agree++; continue; }
    if (mismatches.length < maxMismatches) mismatches.push({ index, expected: expected[index], actual });
    else omitted++;
  }
  return snapshot({ rows: rows.length, agree, differ: rows.length - agree, mismatches, omittedMismatches: omitted });
}
