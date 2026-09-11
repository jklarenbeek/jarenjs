//@ts-check
/** Explicit, subset-limited migration; stored originals are never executed here. */
import { isNameStartCode, isNameCharCode, isWhitespaceCode } from '@jarenjs/core/scan';
import { canonicalSha256, canonicalizeJson } from '../canonical.js';
import { formulaDocument, compileFormula } from './index.js';
import { snapshot, credit } from './shared.js';

/** The measured conversion grammar: return null; or return row.name * row.name;. */
function convert(body, id) {
  let pos = 0;
  const space = () => { while (isWhitespaceCode(body.charCodeAt(pos))) pos++; };
  const token = (text) => { space(); if (!body.startsWith(text, pos)) return false; pos += text.length; return true; };
  const field = () => {
    if (!token('row.')) return null;
    const start = pos;
    if (!isNameStartCode(body.charCodeAt(pos)) || body.charCodeAt(pos) >= 0x80) return null;
    pos++;
    while (isNameCharCode(body.charCodeAt(pos)) && body.charCodeAt(pos) < 0x80) pos++;
    return body.slice(start, pos);
  };
  if (!token('return') || !isWhitespaceCode(body.charCodeAt(pos))) return null;
  // JavaScript inserts a semicolon after return followed by a line terminator.
  let afterReturn = pos;
  while (isWhitespaceCode(body.charCodeAt(afterReturn))) {
    if (body.charCodeAt(afterReturn) === 10 || body.charCodeAt(afterReturn) === 13) return null;
    afterReturn++;
  }
  const start = pos;
  if (token('null') && token(';')) {
    space();
    if (pos === body.length) return { formula: formulaDocument({ $formula: '1', id, revision: '1', expression: null }), schemas: {} };
  }
  pos = start;
  const left = field();
  if (left === null || !token('*')) return null;
  const right = field();
  if (right === null || !token(';')) return null;
  space(); if (pos !== body.length) return null;
  const names = [...new Set([left, right])];
  const schema = { type: 'object', required: names, properties: Object.fromEntries(names.map((name) => [name, { type: 'number' }])) };
  return { formula: formulaDocument({ $formula: '1', id, revision: '1', expression: { $mul: [`$[${JSON.stringify(left)}]`, `$[${JSON.stringify(right)}]`] },
    inputSchema: { id: 'numeric-input', version: '1' } }), schemas: { 'numeric-input': { version: '1', schema } } };
}

function refusal(body) {
  if (/\breturn[\t ]*[\r\n]/.test(body)) return 'return-line-break';
  if (/\bIntl\b/.test(body)) return 'intl-formatting';
  if (/\bthrow\b/.test(body)) return 'throw-statement';
  if (/\bhelpers\b/.test(body)) return 'application-helper';
  if (/\bexplanation\b/.test(body)) return 'result-policy';
  if (/\b(const|let|var|if|for|while|function)\b/.test(body)) return 'statements';
  if (body.includes('?.')) return 'optional-chaining';
  return 'unsupported-syntax';
}

/**
 * Preserve every original, produce native documents or specific review states.
 * Repeating identical input reports no changes, including after native edits.
 * Source edits produce a conflict carrying both versions rather than overwriting.
 * @param {any[]} sources
 * @param {any[]} [previous]
 * @param {{maxRecords?:number,maxSourceChars?:number}} [options]
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
    if (prior?.sourceHash === sourceHash || prior?.currentHash === sourceHash) continue;
    let record;
    if (prior) record = { ...prior, state: 'conflict', reason: 'source-edited', current: source, currentHash: sourceHash };
    else {
      const native = source.enabled ? convert(source.body, source.id) : null;
      record = { version: 1, id: source.id, original: source, sourceHash,
        state: !source.enabled ? 'disabled-preserved' : native ? 'converted' : 'review-required',
        reason: !source.enabled ? 'disabled' : native ? 'numeric-fields-or-null' : refusal(source.body),
        native, nativeHash: native ? await canonicalSha256(native) : null };
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
