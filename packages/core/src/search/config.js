//@ts-check
/** Versioned lexical semantics. Host decoding happens before this boundary. */
import { deepFreeze } from '../object.js';

/** @typedef {{version: number, fields: string[], profile?: string, prefix?: boolean,
 * fuzzy?: number, combineWith?: string, boost?: Record<string, number>,
 * normalization?: string, limits?: Partial<typeof SEARCH_LIMITS>}} LexicalDefinition */

/** Finite logical allocation and work credits, independent of output truncation. */
export const SEARCH_LIMITS = Object.freeze({
  maxDocuments: 100000, maxSourceBytes: 64 * 1024 * 1024,
  maxIndexBytes: 256 * 1024 * 1024, maxTemporaryBytes: 512 * 1024 * 1024,
  maxTokens: 4000000, maxPostings: 4000000, maxVocabulary: 300000,
  maxFieldBytes: 65536, maxTokenLength: 128, maxQueryBytes: 4096,
  maxExpansions: 16384, maxCandidates: 100000, maxResults: 1000,
  maxWork: 100000000, maxBatchWork: 100000,
});

/** @param {LexicalDefinition} input */
export function lexicalConfig(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.fields) || !input.fields.length
    || input.fields.length > 64 || input.fields.some((f) => typeof f !== 'string' || !f || f.length > 256)
    || new Set(input.fields).size !== input.fields.length) throw new TypeError('Invalid lexical definition');
  const allowed = ['version', 'fields', 'profile', 'prefix', 'fuzzy', 'combineWith', 'boost', 'normalization', 'limits'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError('Unknown lexical option');
  const config = { version: 1, fields: [...input.fields], profile: input.profile ?? 'minisearch-7.2.0-cold',
    prefix: input.prefix ?? true, fuzzy: input.fuzzy ?? 0.15, combineWith: input.combineWith ?? 'AND',
    boost: { ...input.boost }, normalization: input.normalization ?? 'host-text/1',
    limits: { ...SEARCH_LIMITS, ...input.limits } };
  if (!['minisearch-7.2.0-cold', 'lexical-key/1'].includes(config.profile)
    || typeof config.prefix !== 'boolean' || !Number.isFinite(config.fuzzy) || config.fuzzy < 0 || config.fuzzy > 1
    || !['AND', 'OR'].includes(config.combineWith) || typeof config.normalization !== 'string' || !config.normalization)
    throw new TypeError('Unsupported lexical semantics');
  for (const [field, boost] of Object.entries(config.boost))
    if (!config.fields.includes(field) || !Number.isFinite(boost) || boost <= 0 || boost > 1000)
      throw new TypeError('Invalid lexical field boost');
  for (const [key, value] of Object.entries(config.limits))
    if (!Object.hasOwn(SEARCH_LIMITS, key) || !Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`Invalid lexical credit: ${key}`);
  return deepFreeze(config);
}

/** Token boundaries intentionally preserve the oracle's tab and accent behavior.
 * @param {string} value @returns {string[]} */
export function lexicalTokens(value) { return value.split(/[\n\r\p{Z}\p{P}]+/u); }

/** Banded Levenshtein in UTF-16 units, matching the named compatibility profile.
 * @param {string} a @param {string} b @param {number} limit @param {() => void} step
 * @param {Uint16Array} previous @param {Uint16Array} current */
export function lexicalDistance(a, b, limit, step, previous, current) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current.fill(limit + 1, 0, b.length + 1); current[0] = i;
    let best = limit + 1;
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      step();
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      current[j] = value; best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}
