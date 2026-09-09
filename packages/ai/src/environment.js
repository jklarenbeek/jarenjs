//@ts-check
/**
 * The environment: a corpus the agent works ON rather than reads.
 *
 * Everything before this file tried to make a long context fit. The
 * ledger stopped compaction destroying what it cut, and that moved the
 * needle question from 2.5% to fully recoverable — but a question over
 * *everything at once* stayed unanswerable, because the answer was never
 * about how well the transcript was summarised. It was about the corpus
 * being in the transcript at all.
 *
 * So it is not. Content lives in named slots; the root model sees a
 * **digest** — name, kind, size, count, one line of excerpt — and works
 * by naming slots in operations. Five of them, and they are the ones the
 * RLM paper reports its models discovering for themselves:
 *
 *   peek    metadata plus a head excerpt — the default view of anything
 *   chunk   split a slot into addressable pieces, deterministically
 *   grep    scan for a pattern, answer with ADDRESSES and match lines
 *   select  run a query over a structured slot, store the result
 *   stat    counts, sizes, shape — answers that need no model at all
 *
 * Three rules hold without exception, and the tests assert each one:
 *
 *  - **No operation returns bulk content** (D2). Every result is capped
 *    by construction — excerpts, match counts, listed slots — so a
 *    result is the same size whether the slot holds 10 kB or 10 MB. The
 *    one call that returns content is `read`, which requires an explicit
 *    character budget, and it exists for a sub-call payload or a user
 *    asking, not for the root's convenience.
 *  - **The root view is constant-size.** The digest lists at most
 *    `digestSlots` slots and says how many it did not list. That cap is
 *    what makes the claim true rather than clever: a corpus three orders
 *    of magnitude larger produces the same-size root request, and the
 *    model narrows with `grep` and `stat` instead of with a longer list.
 *  - **Addressing is derived, never stored.** A chunk's name is a pure
 *    function of its parent, the strategy and its index, so chunking the
 *    same slot twice writes the same slots instead of a second copy.
 *
 * Storage and the query compiler are injected (D3) — the same seams the
 * ledger takes, because this IS the ledger's slot kind with operations
 * over it rather than a second store.
 */

import { chunkText, excerpt, truncate } from '@jarenjs/core/chunk';
import { setObjectMember } from '@jarenjs/core/object';

import { createLedger } from './ledger.js';

/** How much of a slot one excerpt shows. */
const EXCERPT_CHARS = 160;

/** Slots one digest lists before it starts counting instead. */
const DIGEST_SLOTS = 12;

/** Matches one `grep` reports before it starts counting instead. */
const MATCH_LIMIT = 20;

/** Characters of context one match line carries. */
const MATCH_CHARS = 120;

/** Chunk metadata entries one `chunk` result lists. */
const CHUNK_PREVIEW = 8;

/** The default piece size, in characters. */
const CHUNK_SIZE = 4000;

/** Validate a finite host budget before it can become a slice endpoint. */
function budgetOption(value, fallback, name, minimum = 0) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum)
    throw new TypeError(`${name} must be a ${minimum ? 'positive' : 'non-negative'} safe integer`);
  return result;
}

/** The kind a chunk slot is written under, so a digest can group them. */
export const CHUNK_KIND = 'chunk';

/**
 * The address of one chunk: parent, strategy, size, index. Derived, so
 * the same split always names the same slots — that is what makes
 * re-chunking idempotent rather than duplicating, and it is why nothing
 * here keeps a mapping from a parent to its pieces.
 * @param {string} parent
 * @param {string} strategy
 * @param {number} size
 * @param {number} index
 * @returns {string}
 */
export function chunkSlotName(parent, strategy, size, index) {
  return `${parent}#${strategy}:${size}/${index}`;
}

/** The prefix every chunk of one split shares — a family, addressable as one. */
export function chunkFamily(parent, strategy, size) {
  return `${parent}#${strategy}:${size}/`;
}

/**
 * The same slot store, confined to a prefix.
 *
 * **The scope is invisible from inside.** Names go in prefixed and come
 * out stripped, so a child sees a clean namespace — its corpus is
 * `corpus`, not `child/1/0/corpus` — and authors exactly the program it
 * would author at the root. That is not a convenience: a child that had
 * to know its own address would need it in the prompt, and a model that
 * knows its address is a model that can type a sibling's.
 *
 * Isolation follows from the same rule. A child naming
 * `child/1/1/mine` gets `child/1/0/child/1/1/mine`, which does not
 * exist — the sibling is unreachable rather than merely discouraged, and
 * no check has to remember to run.
 *
 * Everything that is not slot addressing (goals, memories, snapshots)
 * passes through untouched: the ledger is shared on purpose, because a
 * tree that could not record what it learned would defeat Phase A.
 * @param {any} ledger
 * @param {string} scope
 */
function scopedLedger(ledger, scope) {
  /** A name on the way IN: always beneath the scope. */
  const within = (name) => scope + String(name ?? '');

  /** A slot on the way OUT: named as the scope's occupant sees it. */
  const relative = (slot) => (slot !== null && typeof slot === 'object'
    && typeof slot.name === 'string' && slot.name.startsWith(scope)
    ? { ...slot, name: slot.name.slice(scope.length) }
    : slot);

  return {
    ...ledger,
    scope,
    putSlot: async (name, content, meta) =>
      relative(await ledger.putSlot(within(name), content, meta)),
    getSlot: async (name) => relative(await ledger.getSlot(within(name))),
    readSlot: async (name) => relative(await ledger.readSlot(within(name))),
    deleteSlot: (name) => ledger.deleteSlot(within(name)),
    putArchive: typeof ledger.putArchive !== 'function' ? undefined : (entries, protection = {}) =>
      ledger.putArchive(entries.map((entry) => ({ ...entry, name: within(entry.name) })),
        { ...protection, protectedNames: (protection.protectedNames ?? []).map(within) }),
    clearArchives: () => ledger.clearArchives(scope),
    retentionReport: async () => {
      const report = await ledger.retentionReport?.();
      return !report ? null : { ...report,
        evicted: report.evicted.filter((entry) => entry.name.startsWith(scope)).map(relative),
        written: report.written.filter((name) => name.startsWith(scope)).map((name) => name.slice(scope.length)) };
    },
    listSlots: async () => (await ledger.listSlots())
      .filter((slot) => slot.name.startsWith(scope))
      .map(relative),
  };
}

/**
 * A regular expression from a model-supplied pattern, or null.
 *
 * The pattern is a string and the flags are constrained: a model that
 * asked for `g` would change `exec`'s statefulness under us, and one
 * that asked for something unknown would throw. Invalid patterns answer
 * `{ error }` like every other content-level problem in this package —
 * a bad regex is something to correct, not a crash.
 * @param {string} pattern
 * @param {string} flags
 */
function compilePattern(pattern, flags) {
  try {
    return { value: new RegExp(pattern, flags.replace(/[^im]/g, '')) };
  }
  catch (err) {
    return { error: `not a usable pattern: ${/** @type {Error} */ (err).message}` };
  }
}

/**
 * Create an environment over a slot store.
 *
 * @param {{ ledger?: any,
 *   storage?: { get: (key: string) => Promise<any>,
 *     set: (key: string, value: any) => Promise<void>,
 *     delete: (key: string) => Promise<void>,
 *     keys: (prefix?: string) => Promise<string[]> },
 *   compileQuery?: (document: any) => (data: any) => any,
 *   excerptChars?: number, digestSlots?: number, matchLimit?: number,
 *   chunkSize?: number, now?: () => string }} [options]
 *   - `ledger` shares an existing ledger — the normal case, because the
 *     agent's archived rounds and the corpus then live in one store and
 *     one `recall` reaches both. Given `storage` instead, a ledger is
 *     built over it; given neither, everything runs in memory.
 *   - `compileQuery` is the `select` seam (`compileJsonQuery` from
 *     `@jarenjs/json/query`). Absent, `select` declines with a stated
 *     reason and every other operation is unaffected.
 * @returns {any}
 */
export function createEnvironment(options = {}) {
  const base = options.ledger ?? createLedger({
    storage: options.storage, now: options.now,
  });
  // a scoped environment is the SAME store seen through a prefix, not a
  // second store: a child of a recursive run must not be able to read or
  // overwrite a sibling's slots, and confining it here means every
  // operation inherits the confinement rather than each one remembering
  const ledger = typeof options.scope === 'string' && options.scope !== ''
    ? scopedLedger(base, options.scope)
    : base;
  const compileQuery = typeof options.compileQuery === 'function' ? options.compileQuery : null;
  const excerptChars = budgetOption(options.excerptChars, EXCERPT_CHARS, 'excerptChars');
  const digestSlots = budgetOption(options.digestSlots, DIGEST_SLOTS, 'digestSlots');
  const matchLimit = budgetOption(options.matchLimit, MATCH_LIMIT, 'matchLimit');
  const defaultChunkSize = budgetOption(options.chunkSize, CHUNK_SIZE, 'chunkSize', 1);

  /** Compiled selections, keyed by their document — `select` on a
   * hundred chunks compiles one query, not a hundred. */
  const queries = new Map();

  /** The metadata shape everything here answers with. Never content. */
  const view = (slot) => (slot === null || slot === undefined ? null : {
    name: slot.name,
    kind: slot.kind,
    size: slot.size,
    ...(slot.count === undefined ? {} : { count: slot.count }),
    excerpt: excerpt(slot.excerpt, excerptChars),
  });

  /** Every slot under a prefix, newest first (metadata only). */
  async function slotsUnder(prefix) {
    const all = await ledger.listSlots();
    return prefix === '' || prefix === undefined
      ? all
      : all.filter((slot) => slot.name === prefix || slot.name.startsWith(prefix));
  }

  /**
   * Put content in the environment. The one entry point that takes bulk
   * content, and it takes it from the HOST — a corpus arrives from a
   * file, a fetch or a paste, never from a model.
   * @param {string} name
   * @param {string} content
   * @param {{ kind?: string, count?: number }} [meta]
   */
  async function put(name, content, meta = {}) {
    const stored = await ledger.putSlot(name, content, {
      kind: meta.kind ?? 'text',
      count: meta.count,
    });
    return stored?.error === undefined ? view(stored) : stored;
  }

  /**
   * Write a corpus that arrives in pieces, one piece at a time.
   *
   * This is the path that keeps a 10 MB corpus out of memory: each piece
   * is written and dropped, and nothing here ever holds the whole. It is
   * also how a caller who already has natural units (files, records,
   * pages) keeps them as the chunk boundaries instead of re-cutting
   * them.
   * @param {string} name - the family name; pieces are named under it
   * @param {AsyncIterable<string> | Iterable<string>} pieces
   * @param {{ kind?: string, strategy?: string, size?: number }} [meta]
   */
  async function ingest(name, pieces, meta = {}) {
    const strategy = meta.strategy ?? 'given';
    const size = meta.size ?? 0;
    let index = 0;
    let bytes = 0;
    for await (const piece of pieces) {
      const text = String(piece);
      const written = await ledger.putSlot(chunkSlotName(name, strategy, size, index),
        text, { kind: meta.kind ?? CHUNK_KIND });
      if (written?.error !== undefined) return written;
      bytes += text.length;
      index += 1;
    }
    await removeStalePieces(chunkFamily(name, strategy, size), index);
    return { name, family: chunkFamily(name, strategy, size), count: index, size: bytes };
  }

  /** A replacement owns indexed family members, never a host's named siblings. */
  async function removeStalePieces(family, count) {
    for (const old of await ledger.listSlots()) {
      if (old.name.startsWith(family) && /^\d+$/.test(old.name.slice(family.length))
        && Number(old.name.slice(family.length)) >= count) await ledger.deleteSlot(old.name);
    }
  }

  /**
   * Metadata plus a head excerpt — the root's default view of anything.
   * @param {string} name
   * @param {{ chars?: number }} [options_]
   */
  async function peek(name, options_ = {}) {
    const chars = Math.min(budgetOption(options_.chars, excerptChars, 'chars'), excerptChars * 4);
    const slot = await ledger.getSlot(name);
    if (slot === null) return unknown(name);
    const content = await ledger.readSlot(name);
    return {
      ...view(slot),
      // a HEAD excerpt, not the stored one-line summary: `peek` is the
      // call a reader makes to decide whether this is the right slot,
      // and the first lines are what answers that
      head: truncate(String(content ?? '').slice(0, chars), chars, '…'),
    };
  }

  /**
   * Split a slot into addressable pieces. Deterministic in its
   * addressing and idempotent in its storage: the same slot split the
   * same way names the same pieces and overwrites them with identical
   * bytes.
   * @param {string} name
   * @param {{ strategy?: 'size'|'line'|'separator', size?: number,
   *   overlap?: number, separator?: string, preview?: number }} [options_]
   */
  async function chunk(name, options_ = {}) {
    const preview = Math.min(budgetOption(options_.preview, CHUNK_PREVIEW, 'preview'), CHUNK_PREVIEW);
    const slot = await ledger.getSlot(name);
    if (slot === null) return unknown(name);
    const content = await ledger.readSlot(name);
    const strategy = options_.strategy ?? 'size';
    const size = budgetOption(options_.size, defaultChunkSize, 'size', 1);
    const pieces = chunkText(String(content ?? ''), { ...options_, strategy, size });

    for (const piece of pieces) {
      const written = await ledger.putSlot(chunkSlotName(name, strategy, size, piece.index),
        piece.text, { kind: CHUNK_KIND });
      if (written?.error !== undefined) return written;
    }
    // A shorter replacement must not leave old pieces reachable by grep/map.
    await removeStalePieces(chunkFamily(name, strategy, size), pieces.length);
    return {
      source: name,
      strategy,
      size,
      count: pieces.length,
      family: chunkFamily(name, strategy, size),
      // capped like everything else: a 10 MB corpus splits into hundreds
      // of pieces and listing them all would put the corpus back in the
      // request in another shape
      chunks: pieces.slice(0, preview).map((piece) => ({
        name: chunkSlotName(name, strategy, size, piece.index),
        size: piece.text.length,
        excerpt: excerpt(piece.text, excerptChars),
      })),
      omitted: Math.max(0, pieces.length - preview),
    };
  }

  /**
   * Scan for a pattern and answer with addresses.
   *
   * This is how the root narrows without reading: it learns WHICH slot
   * holds what it is looking for and one line of context per hit, and
   * then decides whether to spend a `read` on it. Slots are scanned one
   * at a time and released, so grepping a corpus never holds more than
   * one piece of it.
   * @param {string} pattern - a regular expression source
   * @param {{ in?: string, limit?: number, chars?: number, flags?: string }} [options_]
   */
  async function grep(pattern, options_ = {}) {
    const compiled = compilePattern(String(pattern ?? ''), options_.flags ?? 'i');
    if (compiled.error !== undefined) return { error: compiled.error, pattern };
    const regex = compiled.value;
    const scope = options_.in ?? '';
    const limit = Math.min(budgetOption(options_.limit, matchLimit, 'limit'), matchLimit);
    const chars = Math.min(budgetOption(options_.chars, MATCH_CHARS, 'chars'), MATCH_CHARS);

    const slots = await slotsUnder(scope);
    /** @type {any[]} */
    const matches = [];
    let total = 0;
    let scanned = 0;
    for (const slot of [...slots].sort((a, b) => a.name.localeCompare(b.name))) {
      const content = String(await ledger.readSlot(slot.name) ?? '');
      scanned += 1;
      // walked with offsets rather than `split`, because an address that
      // says WHERE is worth more than one that says which: a match on a
      // 500-character tool result gives a window around the hit and the
      // offset to read the rest from, so narrowing costs one read of a
      // few hundred characters instead of a read of the whole slot
      let at = 0;
      while (at <= content.length) {
        const nextBreak = content.indexOf('\n', at);
        const end = nextBreak === -1 ? content.length : nextBreak;
        const line = content.slice(at, end);
        const hit = regex.exec(line);
        if (hit !== null) {
          total += 1;
          if (matches.length < limit) {
            matches.push({
              slot: slot.name,
              offset: at,
              line: around(line, hit.index, hit[0].length, chars),
            });
          }
        }
        if (nextBreak === -1) break;
        at = nextBreak + 1;
      }
    }
    return {
      pattern,
      in: scope === '' ? '(everything)' : scope,
      scanned,
      total,
      matches,
      omitted: Math.max(0, total - matches.length),
    };
  }

  /**
   * Run a query document over a structured slot and store the result as
   * a new slot. The seam is `@jarenjs/json`'s query compiler; with it
   * empty this declines with a stated reason rather than pretending —
   * the same posture the ledger's retrieval takes, for the same reason.
   * @param {string} name
   * @param {any} query - a jaren-query document
   * @param {{ as?: string }} [options_]
   */
  async function select(name, query, options_ = {}) {
    if (compileQuery === null) {
      return { error: 'select needs the compileQuery seam — inject compileJsonQuery from '
        + '@jarenjs/json/query, or narrow with grep and read a chunk instead' };
    }
    const slot = await ledger.getSlot(name);
    if (slot === null) return unknown(name);
    const raw = await ledger.readSlot(name);
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(String(raw ?? 'null'));
    }
    catch (err) {
      return { error: `slot '${name}' is not JSON: ${/** @type {Error} */ (err).message}` };
    }

    const key = JSON.stringify(query);
    let compiled = queries.get(key);
    if (compiled === undefined) {
      try {
        compiled = { run: compileQuery(query), index: queries.size };
      }
      catch (err) {
        const e = /** @type {any} */ (err);
        return { error: `the query does not compile: ${e?.reason ?? e?.message ?? err}`,
          code: e?.code, docPath: e?.docPath };
      }
      queries.set(key, compiled);
    }

    /** @type {any} */
    let result;
    try {
      result = compiled.run(data);
    }
    catch (err) {
      const e = /** @type {any} */ (err);
      return { error: `the query failed on '${name}': ${e?.reason ?? e?.message ?? err}` };
    }
    const text = JSON.stringify(result ?? null);
    const target = options_.as ?? `${name}#select/${compiled.index}`;
    const written = await ledger.putSlot(target, text, {
      kind: 'selection',
      count: Array.isArray(result) ? result.length : undefined,
    });
    return written?.error === undefined ? view(written) : written;
  }

  /**
   * Counts, sizes and shape — the answers that need no model.
   *
   * Given one slot's name it reports that slot; given a prefix it
   * aggregates the family, which is how "how big is this corpus, in how
   * many pieces" is answered without touching content.
   * @param {string} [nameOrPrefix]
   */
  async function stat(nameOrPrefix = '') {
    const one = nameOrPrefix === '' ? null : await ledger.getSlot(nameOrPrefix);
    if (one !== null) {
      const content = String(await ledger.readSlot(nameOrPrefix) ?? '');
      return {
        ...view(one),
        lines: content === '' ? 0 : content.split('\n').length,
        json: looksJson(content),
      };
    }
    const slots = await slotsUnder(nameOrPrefix);
    if (slots.length === 0) return unknown(nameOrPrefix);
    /** @type {Record<string, number>} */
    const kinds = {};
    let size = 0;
    let largest = slots[0];
    for (const slot of slots) {
      setObjectMember(kinds, slot.kind, (Object.hasOwn(kinds, slot.kind) ? kinds[slot.kind] : 0) + 1);
      size += slot.size;
      if (slot.size > largest.size) largest = slot;
    }
    return {
      prefix: nameOrPrefix === '' ? '(everything)' : nameOrPrefix,
      slots: slots.length,
      size,
      kinds,
      largest: { name: largest.name, size: largest.size },
    };
  }

  /**
   * The root's whole view of the environment: capped, and honest about
   * the cap.
   *
   * This is the object a request carries, and its size is bounded by
   * construction — `digestSlots` entries, each with a capped excerpt.
   * `omitted` is not a nicety: a digest that quietly listed the first
   * twelve of four hundred slots would let a model conclude the corpus
   * is twelve slots long, which is a worse failure than a truncated list.
   * @param {{ limit?: number, prefix?: string }} [options_]
   */
  async function digest(options_ = {}) {
    const slots = await slotsUnder(options_.prefix ?? '');
    const limit = Math.min(budgetOption(options_.limit, digestSlots, 'limit'), digestSlots);
    const listed = slots.slice(0, limit);
    let size = 0;
    for (const slot of slots) size += slot.size;
    return {
      slots: listed.map(view),
      listed: listed.length,
      total: slots.length,
      omitted: Math.max(0, slots.length - listed.length),
      size,
      hint: 'Nothing here carries content. Name a slot in peek/stat/grep/select/chunk,'
        + ' or read(name, { chars }) when you need the text itself.',
    };
  }

  /**
   * The one call that returns content, and it makes the caller say how
   * much. Kept deliberately awkward: everything else in this module
   * exists so that a root turn does not need this, and a design where
   * reading is as easy as peeking is a design that ends up back in the
   * transcript.
   * @param {string} name
   * @param {{ chars: number, offset?: number }} options_
   */
  async function read(name, options_) {
    const chars = Math.floor(options_?.chars ?? 0);
    if (!Number.isSafeInteger(chars) || !(chars > 0)) {
      return { error: 'read needs an explicit character budget: read(name, { chars })' };
    }
    const slot = await ledger.getSlot(name);
    if (slot === null) return unknown(name);
    const offset = Math.max(0, Math.floor(options_.offset ?? 0));
    const content = String(await ledger.readSlot(name) ?? '');
    const text = content.slice(offset, offset + chars);
    return {
      name,
      offset,
      size: slot.size,
      returned: text.length,
      more: offset + text.length < content.length,
      text,
    };
  }

  /** Remove a slot, or a whole chunk family. Answers how many went. */
  async function forget(prefix) {
    const slots = await slotsUnder(prefix);
    for (const slot of slots) await ledger.deleteSlot(slot.name);
    return { prefix, removed: slots.length };
  }

  const unknown = async (name) => {
    const content = await ledger.readSlot(name);
    return content?.status === 'evicted'
      ? { error: `slot '${name}' was evicted`, ...content }
      : { error: `no slot '${name}'`, hint: 'call digest() for what the environment holds' };
  };

  return {
    ledger, put, ingest, peek, chunk, grep, select, stat, digest, read, forget,
  };
}

/**
 * A window of a line CENTRED ON THE MATCH, with a marker on whichever
 * side was cut.
 *
 * The obvious implementation shows the head of the matching line, and it
 * is wrong in exactly the case that matters: a tool result is one long
 * line and the fact worth finding is usually not in its first hundred
 * characters. A grep that reported "this line matched" while showing
 * none of the match is a grep that makes a model call `read` on every
 * hit — which is the transcript coming back in another shape.
 * @param {string} line
 * @param {number} at - the match's offset in the line
 * @param {number} length - the match's own length
 * @param {number} chars - the window
 */
function around(line, at, length, chars) {
  if (line.length <= chars) return excerpt(line, chars);
  // a third of the window ahead of the match, so the match and what
  // follows it — usually the value — both survive
  const start = Math.max(0, Math.min(at - Math.floor(chars / 3), line.length - chars));
  const window = line.slice(start, start + chars);
  const head = start > 0 ? '…' : '';
  const tail = start + chars < line.length ? '…' : '';
  // the match itself must be inside the window even when it is longer
  // than the window: then the window starts at the match
  return length > chars
    ? `${head}${excerpt(line.slice(at, at + chars), chars)}…`
    : `${head}${window.replace(/\s+/g, ' ').trim()}${tail}`;
}

/** Whether a text is plausibly a JSON document — cheap, first character. */
function looksJson(text) {
  const head = text.trimStart()[0];
  return head === '{' || head === '[';
}

/**
 * The environment as a toolbox definition list: the five operations plus
 * `read`, ready for `createToolbox().add(...)`.
 *
 * They are defined here rather than in the agent for the reason `recall`
 * is: a tool a model calls and an operation a harness calls have to be
 * the same thing, or the tested path and the shipped path drift.
 *
 * Every schema is deliberately small — one required string, optional
 * numbers — because the tier this package targets gets a tool call right
 * in proportion to how few decisions it has to make.
 * @param {any} environment - from {@link createEnvironment}
 * @returns {any[]} tool definitions
 */
export function environmentTools(environment) {
  const slotArg = { type: 'string', minLength: 1, description: 'A slot name from digest or grep.' };
  return [
    {
      name: 'env_digest',
      description: 'List what the environment holds: name, kind, size and one line of each slot.'
        + ' Carries no content. Start here.',
      inputSchema: {
        type: 'object',
        properties: { prefix: { type: 'string', description: 'Only slots whose name starts with this.' } },
        additionalProperties: false,
      },
      execute: ({ prefix }) => environment.digest({ prefix }),
    },
    {
      name: 'env_peek',
      description: 'One slot: its metadata and the first characters of it.',
      inputSchema: {
        type: 'object',
        properties: { slot: slotArg, chars: { type: 'integer', minimum: 1 } },
        required: ['slot'],
        additionalProperties: false,
      },
      execute: ({ slot, chars }) => environment.peek(slot, { chars }),
    },
    {
      name: 'env_grep',
      description: 'Search the environment for a regular expression. Answers with the ADDRESSES'
        + ' that matched, a window around each hit and the offset it is at — never the whole'
        + ' slot. Pass a match\'s slot and offset to env_read to see the rest of it.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', minLength: 1 },
          in: { type: 'string', description: 'Restrict to slots whose name starts with this.' },
          limit: { type: 'integer', minimum: 1 },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      execute: ({ pattern, in: scope, limit }) => environment.grep(pattern, { in: scope, limit }),
    },
    {
      name: 'env_chunk',
      description: 'Split a slot into addressable pieces so they can be worked on one at a time.',
      inputSchema: {
        type: 'object',
        properties: {
          slot: slotArg,
          strategy: { enum: ['size', 'line', 'separator'] },
          size: { type: 'integer', minimum: 1 },
        },
        required: ['slot'],
        additionalProperties: false,
      },
      execute: ({ slot, strategy, size }) => environment.chunk(slot, { strategy, size }),
    },
    {
      name: 'env_stat',
      description: 'Counts and sizes for one slot or a whole family of them. Needs no reading.',
      inputSchema: {
        type: 'object',
        properties: { slot: { type: 'string' } },
        additionalProperties: false,
      },
      execute: ({ slot }) => environment.stat(slot ?? ''),
    },
    {
      name: 'env_read',
      description: 'Return the text of a slot. Say how many characters you need; narrow with'
        + ' grep first when the slot is large.',
      inputSchema: {
        type: 'object',
        properties: {
          slot: slotArg,
          chars: { type: 'integer', minimum: 1, maximum: 8000 },
          offset: { type: 'integer', minimum: 0 },
        },
        required: ['slot', 'chars'],
        additionalProperties: false,
      },
      execute: ({ slot, chars, offset }) => environment.read(slot, { chars, offset }),
    },
  ];
}
