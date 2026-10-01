//@ts-check
/** Explicit migration of saved sources; stored originals are never executed here. */
import { canonicalSha256, canonicalizeJson } from '../canonical.js';
import { formulaDocument, compileFormula } from './index.js';
import { snapshot, credit } from './shared.js';
import { translateFormulaBody } from './translate.js';

export { translateFormulaBody };

/**
 * Translate one enabled source into its native target, or the reasons it
 * cannot be. A translation that does not compile under the host's formula
 * options (`options.formula`) is not one: its compile error is the reason.
 * @param {any} source @param {{ translate?: any, formula?: any }} options
 */
function translate(source, options) {
  const t = translateFormulaBody(source.body, options.translate ?? {});
  if (t.state === 'untranslatable') return { state: t.state, reasons: t.reasons, differences: t.differences, native: null };
  /** @type {Record<string, any>} */
  const doc = { $formula: '1', id: source.id, revision: '1', expression: t.expression };
  if (t.resultMode === 'outcome') doc.resultMode = 'outcome';
  if (t.helpers?.length) doc.helpers = t.helpers;
  /** @param {unknown} error @param {string} what */
  const refused = (error, what) => ({ state: 'untranslatable', differences: t.differences, native: null,
    reasons: [{ kind: 'compile', at: { offset: 0, line: 1, column: 1 }, message: `${what}: ${/** @type {any} */ (error)?.message ?? String(error)}` }] });
  // a translation that is no formula document (a host's native helper written with a value JSON cannot hold)
  // is this source's reason, never the end of the migration
  let formula;
  try { formula = formulaDocument(doc); }
  catch (error) { return refused(error, 'the translation is not a formula document (a native helper the host maps holds a value JSON cannot)'); }
  if (options.formula !== undefined) {
    try { compileFormula(formula, options.formula); }
    catch (error) { return refused(error, "the translation does not compile under the host's formula options (a helper, a decimal format or a pack it names)"); }
  }
  return { state: t.state, reasons: [], differences: t.differences, native: { formula, schemas: {} } };
}

/**
 * Preserve every original and translate each enabled source: `translated`,
 * `translated-with-differences` (each difference named, with its position)
 * or `untranslatable` (each reason named, with its position). Repeating
 * identical input reports no changes, including after native edits. Source
 * edits produce a conflict carrying both versions rather than overwriting,
 * and the state the record had (`previousState`, `previousReason`), which it
 * returns to when its source is the recorded one again.
 * @param {any[]} sources
 * @param {any[]} [previous]
 * @param {{maxRecords?:number,maxSourceChars?:number,translate?:import('./translate.js').TranslateOptions,formula?:import('./index.js').FormulaOptions}} [options]
 *   `translate` names the body's argument, helpers and conventions; `formula`, when given, is what each
 *   translation must compile under
 */
export async function migrateFormulas(sources, previous = [], options = {}) {
  const maxRecords = credit(options.maxRecords, 10000, 'maxRecords');
  const maxSourceChars = credit(options.maxSourceChars, 65536, 'maxSourceChars');
  if (!Array.isArray(sources) || sources.length > maxRecords || !Array.isArray(previous) || previous.length > maxRecords)
    throw new TypeError('Migration record limit exceeded');
  const records = new Map();
  for (const record of snapshot(previous)) {
    if (!record || record.version !== 1 || typeof record.id !== 'string' || records.has(record.id)) throw new TypeError('Invalid prior migration identity');
    records.set(record.id, record);
  }
  const changes = [];
  const seen = new Set();
  for (const source of snapshot(sources)) {
    if (!source || typeof source.id !== 'string' || !source.id || typeof source.label !== 'string'
      || typeof source.body !== 'string' || source.body.length > maxSourceChars || typeof source.enabled !== 'boolean'
      || !Number.isSafeInteger(source.storageVersion) || seen.has(source.id)) throw new TypeError('Invalid saved source identity/body');
    seen.add(source.id);
    const sourceHash = await canonicalSha256(source);
    const prior = records.get(source.id);
    let record;
    // a conflict whose source is the recorded one again returns to the state it had before the edit
    if (prior?.state === 'conflict' && prior.sourceHash === sourceHash && prior.previousState !== undefined) {
      const { current: _current, currentHash: _currentHash, previousState, previousReason, ...kept } = prior;
      record = { ...kept, state: previousState, reason: previousReason };
    }
    else if (prior?.sourceHash === sourceHash || prior?.currentHash === sourceHash) continue;
    // an edit keeps the state the record had, which a later edit of the conflict leaves as it was
    else if (prior) {
      record = { ...prior, state: 'conflict', reason: 'source-edited', current: source, currentHash: sourceHash,
        ...(prior.state === 'conflict' ? {} : { previousState: prior.state, previousReason: prior.reason }) };
    }
    else if (!source.enabled) {
      record = { version: 1, id: source.id, original: source, sourceHash, state: 'disabled-preserved', reason: 'disabled',
        reasons: [], differences: [], native: null, nativeHash: null };
    }
    else {
      const t = translate(source, options);
      record = { version: 1, id: source.id, original: source, sourceHash, state: t.state,
        reason: t.state === 'untranslatable' ? t.reasons[0].kind : t.state === 'translated' ? 'translated' : 'differences',
        reasons: t.reasons, differences: t.differences,
        native: t.native, nativeHash: t.native ? await canonicalSha256(t.native) : null };
    }
    records.set(source.id, record); changes.push({ id: source.id, state: record.state });
  }
  if (records.size > maxRecords) throw new TypeError('Migration record limit exceeded');
  return snapshot({ records: [...records.values()], changes, changed: changes.length });
}

/**
 * Compare-and-restore proposal. Both source and native must still match the
 * migration baseline; a later edit is a conflict. Caller applies returned data.
 */
export async function rollbackFormula(record, currentSource, currentNative) {
  snapshot(record); snapshot(currentSource); snapshot(currentNative);
  if (record.version !== 1 || await canonicalSha256(currentSource) !== record.sourceHash)
    return snapshot({ state: 'conflict', reason: 'source-edited', changed: 0 });
  if (currentNative === null) return snapshot({ state: 'unchanged', changed: 0, source: currentSource, native: null });
  if (record.nativeHash === null || await canonicalSha256(currentNative) !== record.nativeHash)
    return snapshot({ state: 'conflict', reason: 'native-edited', changed: 0 });
  if (canonicalizeJson(currentSource) !== canonicalizeJson(record.original))
    return snapshot({ state: 'conflict', reason: 'original-mismatch', changed: 0 });
  return snapshot({ state: 'restored', changed: 1, source: record.original, native: null });
}

/**
 * Explicit manual rewrite with compare-and-set review identity. Original bytes and
 * prior native revisions remain in the exportable record; no legacy runner is called.
 * @param {any} record @param {any} native @param {any} review
 * @param {import('./index.js').FormulaOptions} [options]
 */
export async function resolveFormulaMigration(record, native, review, options = {}) {
  record = snapshot(record); native = snapshot(native); review = snapshot(review);
  if (review.sourceHash !== record.sourceHash || review.expectedNativeHash !== record.nativeHash || record.state === 'conflict')
    return snapshot({ state: 'conflict', reason: 'review-revision', changed: 0, record });
  if (typeof review.actor !== 'string' || !review.actor || typeof review.reason !== 'string' || !review.reason)
    throw new TypeError('Manual resolution requires reviewer and reason');
  if (native.formula?.id !== record.id) throw new TypeError('Manual resolution must preserve formula identity');
  compileFormula(native.formula, { ...options, schemas: native.schemas });
  const nativeHash = await canonicalSha256(native);
  if (nativeHash === record.nativeHash && record.state === 'resolved') return snapshot({ state: 'unchanged', changed: 0, record });
  const history = [...(record.history ?? []), { native: record.native, nativeHash: record.nativeHash, review }];
  return snapshot({ state: 'resolved', changed: 1, record: { ...record, state: 'resolved', reason: 'manual-review', native, nativeHash, history } });
}
