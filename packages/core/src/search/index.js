//@ts-check
/** Resident postings and rank statistics, published atomically by source generation. */
import { lexicalConfig, lexicalTokens, lexicalDistance } from './config.js';
import { utf8ByteLength as textBytes, hashContent } from '../string.js';
import { lexicalVocabulary } from './vocabulary.js';
export { SEARCH_LIMITS } from './config.js';

/** @typedef {import('./config.js').LexicalDefinition} LexicalDefinition */
/** @typedef {{generation?:number, sourceRevision?:string}} LexicalIdentity */
/** @typedef {{id:string, score:number}} LexicalHit */

/** Compile a versioned definition once. Each create() owns an isolated resident index.
 * @param {LexicalDefinition} definition */
export function compileLexical(definition) {
  const config = lexicalConfig(definition);
  const identity = JSON.stringify(config);
  return Object.freeze({ config, identity, create: () => createIndex(config, identity) });
}

function createIndex(config, identity) {
  const limits = config.limits, fields = config.fields;
  const empty = () => ({ docs: new Map(), postings: new Map(), lengths: fields.map(() => 0),
    sourceBytes: 0, tokens: 0, postingCount: 0, bytes: 0, dictionaryBytes: 0, forward: [], reverse: [], nextOrder: 0 });
  let state = empty(), generation = 0, sourceRevision = '', disposed = false, ticket = 0, stagingOverhead = 0;
  const exhausted = (reason) => { throw new RangeError(reason); };
  const guard = (value, max, reason) => { if (value > max) exhausted(reason); };
  const outcome = (status, reason, extra = {}) => ({ state: status, ...(reason ? { reason } : {}),
    generation, sourceRevision, identity, ...extra });
  const stats = () => ({ documents: state.docs.size, vocabulary: state.postings.size,
    postings: state.postingCount, tokens: state.tokens, sourceBytes: state.sourceBytes,
    indexBytes: state.bytes, tombstones: 0, fieldLengths: [...state.lengths], generation, sourceRevision, disposed });

  function prepare(row, order) {
    if (!row || typeof row.id !== 'string' || !row.id) throw new TypeError('Lexical IDs must be nonempty strings');
    guard(row.id.length * 2, limits.maxFieldBytes, 'field-bytes');
    const values = new Array(fields.length), terms = new Array(fields.length), lengths = new Array(fields.length);
    let sourceBytes = textBytes(row.id), tokens = 0, postings = 0, bytes = 128 + row.id.length * 2, work = 1;
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
      const field = fields[fieldIndex];
      const value = Object.hasOwn(row, field) ? row[field] ?? '' : '';
      if (typeof value !== 'string') throw new TypeError('Lexical fields must be strings');
      guard(value.length, limits.maxFieldBytes, 'field-bytes');
      const size = textBytes(value); guard(size, limits.maxFieldBytes, 'field-bytes');
      // Token arrays, sets, strings and maps are reserved before tokenization.
      guard(bytes + value.length * 256, limits.maxTemporaryBytes - state.bytes, 'temporary-bytes');
      guard(work + value.length, limits.maxBatchWork, 'batch-work');
      const raw = lexicalTokens(value), counts = new Map();
      lengths[fieldIndex] = new Set(raw).size;
      for (const token of raw) {
        const term = token.toLowerCase();
        guard(term.length, limits.maxTokenLength, 'token-length');
        if (term) { counts.set(term, (counts.get(term) ?? 0) + 1); tokens++; }
      }
      for (const term of counts.keys()) bytes += 160 + term.length * 2;
      sourceBytes += size; bytes += 48 + value.length * 2; work += value.length + raw.length;
      postings += counts.size; values[fieldIndex] = value;
      const pairs = new Array(counts.size * 2); let offset = 0;
      for (const [term, frequency] of counts) { pairs[offset++] = term; pairs[offset++] = frequency; }
      terms[fieldIndex] = pairs;
    }
    guard(work, limits.maxBatchWork, 'batch-work');
    return { id: row.id, values, terms, lengths, sourceBytes, tokens, postings, bytes, order, work };
  }

  function* stage(rows, remove, replace, request, myTicket) {
    if (disposed) return outcome('error', 'disposed');
    const wanted = request.generation ?? generation + 1;
    const revision = request.sourceRevision ?? sourceRevision;
    if (!Number.isSafeInteger(wanted) || wanted < 0 || typeof revision !== 'string') return outcome('error', 'invalid-identity');
    if (wanted < generation) return outcome('invalidated', 'stale-generation');
    if (stagingOverhead + state.bytes + (replace ? 0 : state.docs.size * 48 + state.postings.size * 48) > limits.maxTemporaryBytes)
      return outcome('budget-exhausted', 'temporary-bytes');
    const next = replace ? empty() : { ...state, bytes: state.bytes - state.dictionaryBytes,
      docs: new Map(state.docs), postings: new Map(state.postings), lengths: [...state.lengths] };
    const copied = new Set(), seen = new Set();
    let work = 0, changes = replace ? state.docs.size : 0, temporary = stagingOverhead + state.bytes + next.docs.size * 48 + next.postings.size * 48;
    const writable = (term) => {
      if (!copied.has(term)) {
        const old = next.postings.get(term);
        const cost = old ? [...old.values()].reduce((n, entries) => n + entries.size * 48 + 64, 64) : 64;
        guard(temporary + cost, limits.maxTemporaryBytes, 'temporary-bytes'); temporary += cost;
        next.postings.set(term, old ? new Map([...old].map(([field, entries]) => [field, new Map(entries)])) : new Map());
        copied.add(term);
      }
      return next.postings.get(term);
    };
    const subtract = (old, remove = true) => {
      if (remove) next.docs.delete(old.id); next.bytes -= old.bytes; next.sourceBytes -= old.sourceBytes;
      next.tokens -= old.tokens; next.postingCount -= old.postings;
      for (let field = 0; field < fields.length; field++) {
        next.lengths[field] -= old.lengths[field];
        for (let i = 0; i < old.terms[field].length; i += 2) {
          const term = old.terms[field][i];
          const posting = writable(term), entries = posting.get(field);
          entries.delete(old.id); if (!entries.size) posting.delete(field);
          if (!posting.size) { next.postings.delete(term); copied.delete(term); }
        }
      }
    };
    try {
      guard(temporary, limits.maxTemporaryBytes, 'temporary-bytes');
      for (const id of remove) {
        if (typeof id !== 'string') throw new TypeError('Invalid lexical removal ID');
        const old = next.docs.get(id);
        if (old) { subtract(old); changes++; work += old.work; }
        guard(++work, limits.maxWork, 'work'); yield work;
      }
      for (const row of rows) {
        guard(seen.size + 1, limits.maxDocuments, 'documents');
        if (seen.has(row?.id)) throw new TypeError('Duplicate lexical ID');
        seen.add(row?.id);
        const old = next.docs.get(row?.id);
        const doc = prepare(row, old?.order ?? next.nextOrder);
        work += doc.work; guard(work, limits.maxWork, 'work');
        if (old && doc.values.every((v, i) => v === old.values[i])) { yield work; continue; }
        guard(temporary + doc.bytes * 2, limits.maxTemporaryBytes, 'temporary-bytes'); temporary += doc.bytes * 2;
        if (old) subtract(old, false); else next.nextOrder++;
        guard(next.docs.size + (old ? 0 : 1), limits.maxDocuments, 'documents');
        guard(next.sourceBytes + doc.sourceBytes, limits.maxSourceBytes, 'source-bytes');
        guard(next.tokens + doc.tokens, limits.maxTokens, 'tokens');
        guard(next.postingCount + doc.postings, limits.maxPostings, 'postings');
        guard(next.bytes + doc.bytes, limits.maxIndexBytes, 'index-bytes');
        next.docs.set(doc.id, doc); next.bytes += doc.bytes; next.sourceBytes += doc.sourceBytes;
        next.tokens += doc.tokens; next.postingCount += doc.postings;
        for (let field = 0; field < fields.length; field++) {
          next.lengths[field] += doc.lengths[field];
          for (let i = 0; i < doc.terms[field].length; i += 2) {
            const term = doc.terms[field][i], frequency = doc.terms[field][i + 1];
            if (!next.postings.has(term)) guard(next.postings.size + 1, limits.maxVocabulary, 'vocabulary');
            const posting = writable(term);
            if (!posting.has(field)) posting.set(field, new Map());
            posting.get(field).set(doc.id, frequency);
          }
        }
        changes++; yield work;
      }
      for (const term of copied) if (!next.postings.get(term)?.size) next.postings.delete(term);
      if (disposed || myTicket !== ticket) return outcome(disposed ? 'error' : 'invalidated', disposed ? 'disposed' : 'superseded');
      if (replace && state.docs.size === next.docs.size) {
        let same = true;
        const oldIds = state.docs.keys();
        for (const [id, doc] of next.docs) {
          const old = state.docs.get(id);
          if (!old || oldIds.next().value !== id || !doc.values.every((v, i) => v === old.values[i])) { same = false; break; }
        }
        if (same) changes = 0;
      }
      if (!changes && revision === sourceRevision) return outcome('complete', null, { changes: 0, work, peakBytes: temporary });
      if (wanted === generation) return outcome('invalidated', 'conflicting-generation');
      next.dictionaryBytes = next.postings.size * 16;
      guard(next.bytes + next.dictionaryBytes, limits.maxIndexBytes, 'index-bytes'); next.bytes += next.dictionaryBytes;
      guard(temporary + next.postings.size * 384, limits.maxTemporaryBytes, 'temporary-bytes');
      temporary += next.postings.size * 384;
      const words = new Set();
      for (const doc of next.docs.values()) {
        for (const terms of doc.terms) for (let i = 0; i < terms.length; i += 2) words.add(terms[i]);
        work += doc.postings; guard(work, limits.maxWork, 'work'); yield work;
      }
      const vocabulary = lexicalVocabulary(words, () => { guard(++work, limits.maxWork, 'work'); });
      let ordered = vocabulary.next();
      while (!ordered.done) { yield work; ordered = vocabulary.next(); }
      next.forward = ordered.value.forward; next.reverse = ordered.value.reverse;
      if (!replace) for (const word of copied) {
        const posting = next.postings.get(word); if (!posting) continue;
        for (const [field, entries] of posting) {
          let comparisons = 0;
          const sorted = [...entries].sort((a, b) => {
            guard(++comparisons, limits.maxBatchWork, 'batch-work'); guard(++work, limits.maxWork, 'work');
            return next.docs.get(a[0]).order - next.docs.get(b[0]).order;
          });
          posting.set(field, new Map(sorted)); yield work;
        }
      }
      if (disposed || myTicket !== ticket) return outcome(disposed ? 'error' : 'invalidated', disposed ? 'disposed' : 'superseded');
      state = next; generation = wanted; sourceRevision = revision;
      return outcome('complete', null, { changes, work, peakBytes: temporary });
    }
    catch (error) { return outcome(error instanceof RangeError ? 'budget-exhausted' : 'error', error.message); }
  }

  function mutate(rows, remove, replace, request = {}) {
    const steps = stage(rows, remove, replace, request, ++ticket);
    let result = steps.next(); while (!result.done) result = steps.next();
    return result.value;
  }

  async function mutateAsync(rows, remove, replace, request) {
      if (typeof request?.yield !== 'function') throw new TypeError('A cooperative yield capability is required');
      const mine = ++ticket, steps = stage(rows, remove, replace, request, mine);
      let previous = 0;
      try {
        for (;;) {
          if (request.signal?.aborted) return outcome('error', 'cancelled');
          if (disposed || mine !== ticket) return outcome(disposed ? 'error' : 'invalidated', disposed ? 'disposed' : 'superseded');
          const result = steps.next(); if (result.done) return result.value;
          if (result.value - previous >= limits.maxBatchWork / 2) {
            previous = result.value; request.onProgress?.({ work: previous, generation: request.generation }); await request.yield();
          }
        }
      }
      finally { steps.return(undefined); }
  }

  /** @param {string} text @param {any} [options] */
  function search(text, options = {}) {
    const queriedState = state;
    const used = { work: 0, expansions: 0, candidates: 0 };
    const fail = (kind, reason) => outcome(kind, reason, { hits: [], total: null, hasMore: false, used });
    if (disposed) return fail('error', 'disposed');
    if (options.sourceRevision !== undefined && options.sourceRevision !== sourceRevision) return fail('invalidated', 'source-stale');
    const limit = options.limit ?? limits.maxResults;
    if (typeof text !== 'string' || !Number.isSafeInteger(limit) || limit < 0 || limit > limits.maxResults) return fail('error', 'invalid-query');
    if (text.length > limits.maxQueryBytes || textBytes(text) > limits.maxQueryBytes) return fail('budget-exhausted', 'query-bytes');
    const credits = { work: limits.maxWork, expansions: limits.maxExpansions, candidates: limits.maxCandidates, ...options.credits };
    for (const [key, value] of Object.entries(credits))
      if (!['work', 'expansions', 'candidates'].includes(key) || !Number.isSafeInteger(value) || value < 0
        || value > ({ work: limits.maxWork, expansions: limits.maxExpansions, candidates: limits.maxCandidates })[key]) return fail('error', 'invalid-credits');
    const step = () => { if (used.work >= credits.work) exhausted('work'); used.work++; };
    const terms = lexicalTokens(text).map((t) => t.toLowerCase()).filter(Boolean);
    const quality = new Set(terms).size;
    let combined = null;
    try {
      for (const term of terms) {
        guard(term.length, limits.maxTokenLength, 'token-length');
        const matches = new Map();
        const rank = (word, weight) => {
          if (used.expansions >= credits.expansions) exhausted('expansions'); used.expansions++;
          const posting = state.postings.get(word);
          for (let field = 0; field < fields.length; field++) {
            const entries = posting.get(field); if (!entries) continue;
            const idf = Math.log(1 + (state.docs.size - entries.size + 0.5) / (entries.size + 0.5));
            const average = state.lengths[field] / state.docs.size;
            for (const [id, frequency] of entries) {
              step(); const doc = state.docs.get(id);
              const score = weight * (Object.hasOwn(config.boost, fields[field]) ? config.boost[fields[field]] : 1) * idf
                * (0.5 + frequency * 2.2 / (frequency + 1.2 * (0.3 + 0.7 * doc.lengths[field] / average)));
              if (!matches.has(id)) {
                guard(matches.size + 1, credits.candidates, 'candidates');
                guard(state.bytes + (matches.size + 1 + (combined?.size ?? 0)) * 192, limits.maxTemporaryBytes, 'temporary-bytes');
                used.candidates = Math.max(used.candidates, matches.size + 1);
              }
              matches.set(id, (matches.get(id) ?? 0) + score);
            }
          }
        };
        step();
        if (state.postings.has(term)) rank(term, 1);
        const distance = Math.min(6, Math.round(term.length * config.fuzzy));
        const previous = new Uint16Array(term.length + distance + 1), current = new Uint16Array(term.length + distance + 1);
        // Exact terms precede expansions; prefix matches own their fuzzy overlap.
        if (config.prefix) for (const word of state.reverse) {
          step(); if (word === term) continue;
          if (word.startsWith(term)) rank(word, 0.375 * word.length / (word.length + 0.3 * (word.length - term.length)));
        }
        if (distance) for (const word of state.forward) {
          step(); if (word === term || (config.prefix && word.startsWith(term))) continue;
          const d = lexicalDistance(term, word, distance, step, previous, current);
          if (d <= distance) rank(word, 0.45 * word.length / (word.length + d));
        }
        if (combined === null) combined = matches;
        else if (config.combineWith === 'AND') {
          for (const [id, score] of matches) { step();
            if (combined.has(id)) matches.set(id, score + combined.get(id)); else matches.delete(id); }
          combined = matches;
        }
        else for (const [id, score] of matches) { step();
          guard(combined.has(id) ? combined.size : combined.size + 1, credits.candidates, 'candidates');
          combined.set(id, (combined.get(id) ?? 0) + score); }
      }
      const hits = [];
      for (const [id, score] of combined ?? []) { step();
        const hit = { id, score: score * quality };
        if (!options.filter || options.filter(hit)) { options.onMatch?.(hit); hits.push(hit); }
      }
      const tie = (a, b) => config.profile === 'lexical-key/1' ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        : 0;
      hits.sort((a, b) => { step(); return (options.compare ? options.compare(a, b) : b.score - a.score) || tie(a, b); });
      let start = 0;
      if (options.after != null) {
        const after = options.after;
        if (after.identity !== identity || after.sourceRevision !== sourceRevision || after.text !== text || after.query !== (options.query ?? ''))
          return fail('invalidated', 'continuation-changed');
        const position = hits.findIndex((hit) => hit.id === after.id && hit.score === after.score);
        if (position < 0) return fail('invalidated', 'continuation-changed');
        start = position + 1;
      }
      const page = hits.slice(start, start + limit), hasMore = start + page.length < hits.length;
      const continuation = hasMore && page.length ? { ...page.at(-1), identity, sourceRevision, text, query: options.query ?? '' } : null;
      if (disposed || state !== queriedState) return fail(disposed ? 'error' : 'invalidated', disposed ? 'disposed' : 'source-changed');
      return outcome('complete', null, { hits: page, total: hits.length, hasMore, continuation, used });
    }
    catch (error) { return fail(error instanceof RangeError ? 'budget-exhausted' : 'error', error.message); }
  }

  return {
    config, identity, stats, search,
    /** Serialize a complete derived snapshot. The checksum detects corruption, not forgery.
     * @returns {string} */
    snapshot() {
      if (disposed) throw new Error('disposed');
      guard(state.bytes + state.sourceBytes * 12 + state.docs.size * 256, limits.maxTemporaryBytes, 'temporary-bytes');
      const payload = JSON.stringify({ format: 'jaren-lexical/1', complete: true, identity, generation, sourceRevision,
        documents: [...state.docs.values()].map((doc) => [doc.id, doc.values, doc.order]), nextOrder: state.nextOrder });
      return JSON.stringify({ checksum: hashContent(payload), payload });
    },
    /** Validate format, configuration and authoritative source before atomic publication.
     * Recovery always rebuilds postings through the same bounded engine.
     * @param {string} serialized @param {LexicalIdentity & {sourceRevision:string}} request */
    restore(serialized, request) {
      if (disposed) return outcome('error', 'disposed');
      const refuse = (reason) => outcome('rebuild-required', reason);
      if (typeof serialized !== 'string') return refuse('corrupt-snapshot');
      if (serialized.length * 16 + state.bytes > limits.maxTemporaryBytes) return refuse('snapshot-bytes');
      let data;
      try {
        const envelope = JSON.parse(serialized);
        if (typeof envelope.payload !== 'string' || hashContent(envelope.payload) !== envelope.checksum) return refuse('corrupt-snapshot');
        data = JSON.parse(envelope.payload);
      }
      catch { return refuse('corrupt-snapshot'); }
      if (data?.format !== 'jaren-lexical/1' || data.complete !== true) return refuse('snapshot-format');
      if (data.identity !== identity) return refuse('config-mismatch');
      if (typeof request?.sourceRevision !== 'string' || data.sourceRevision !== request.sourceRevision) return refuse('source-stale');
      if (!Number.isSafeInteger(data.generation) || data.generation < 0 || !Array.isArray(data.documents)
        || data.documents.length > limits.maxDocuments || !Number.isSafeInteger(data.nextOrder) || data.nextOrder < 0)
        return refuse('corrupt-snapshot');
      let prior = -1;
      const rows = [];
      for (const doc of data.documents) {
        if (!Array.isArray(doc) || doc.length !== 3 || !Array.isArray(doc[1]) || doc[1].length !== fields.length
          || !Number.isSafeInteger(doc[2]) || doc[2] <= prior || doc[2] >= data.nextOrder) return refuse('corrupt-snapshot');
        prior = doc[2]; rows.push(Object.fromEntries([['id', doc[0]], ...fields.map((field, i) => [field, doc[1][i]])]));
      }
      let result;
      stagingOverhead = serialized.length * 16;
      try { result = mutate(rows, [], true, { generation: request.generation ?? Math.max(generation + 1, data.generation),
        sourceRevision: request.sourceRevision }); }
      finally { stagingOverhead = 0; }
      if (result.state !== 'complete') return result.state === 'invalidated' ? result : refuse(result.reason);
      for (const doc of data.documents) state.docs.get(doc[0]).order = doc[2];
      state.nextOrder = data.nextOrder;
      return result;
    },
    /** Atomically build from authoritative text rows. @param {Iterable<any>} rows @param {LexicalIdentity} [request] */
    rebuild: (rows, request) => mutate(rows, [], true, request),
    /** Replace/remove by stable ID; unchanged text is a no-op. @param {{put?:Iterable<any>, remove?:Iterable<string>}} changes @param {LexicalIdentity} [request] */
    update: (changes, request) => mutate(changes.put ?? [], changes.remove ?? [], false, request),
    /** Clear all postings without retaining tombstones. @param {LexicalIdentity} [request] */
    clear: (request) => mutate([], [], true, request),
    /** Cooperative atomic build. The host yields to its event loop and owns cancellation.
     * @param {Iterable<any>} rows @param {LexicalIdentity & {yield:()=>Promise<void>, signal?:AbortSignal, onProgress?:(value:any)=>void}} request */
    rebuildAsync: (rows, request) => mutateAsync(rows, [], true, request),
    /** Cooperative atomic replacement/removal using the same staging engine.
     * @param {{put?:Iterable<any>, remove?:Iterable<string>}} changes
     * @param {LexicalIdentity & {yield:()=>Promise<void>, signal?:AbortSignal, onProgress?:(value:any)=>void}} request */
    updateAsync: (changes, request) => mutateAsync(changes.put ?? [], changes.remove ?? [], false, request),
    /** Idempotently free every resident reference and fence staged work. */
    dispose() { disposed = true; ticket++; state = empty(); },
  };
}
