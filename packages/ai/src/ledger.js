//@ts-check
/**
 * The ledger: schema-validated, durable, addressable state that outlives
 * a context window.
 *
 * An agent today is bounded by one transcript — everything it learned is
 * gone when the tab closes, and everything it gathered is gone when the
 * history budget bites. The ledger is the other half: a goal it is
 * working towards, memories it has earned, skills it can reuse, and
 * slots holding content too big to carry. Four kinds, one small
 * interface, over an injected storage adapter.
 *
 * Three decisions shape the whole file:
 *
 *  - **Storage is injected, never imported.** The adapter is four async
 *    methods (`get`/`set`/`delete`/`keys`); a host backs it with
 *    `@jarenjs/db` over OPFS, with `localStorage`, or with nothing. This
 *    package keeps exactly two dependencies, so it still loads in a
 *    static page — `createLedger()` with no arguments works, in memory.
 *    One writer at a time: a ledger serializes its own mutations through
 *    one queue, so concurrent calls in one process cannot interleave;
 *    two processes — or two ledgers — writing one adapter at once are
 *    outside the contract, because the adapter is four methods, not a
 *    transaction.
 *  - **Nothing enters without passing its schema**, compiled by
 *    `JarenValidator` here at construction. A rejected write answers the
 *    same `{ error, errors, inputSchema }` the toolbox answers with (one
 *    implementation, in `check.js`) and never throws: a model that wrote
 *    a bad memory can read why and fix it.
 *  - **Every mutation is reversible.** `snapshot()` before, `rollback()`
 *    after — which is what will make model-proposed refinements safe to
 *    accept later, because a bad one can be undone without a human
 *    reading the diff.
 *
 * Its consumers today: the agent's compaction archive, the environment's
 * slots, refinement's patchable state, and the website assistant's
 * durable memory — all on this one implementation.
 */

import { JarenValidator } from '@jarenjs/validate';

import { checkOutcome, invalidInput } from './check.js';
import { createMemoryStorage } from './storage/memory.js';
import { LEDGER_SCHEMAS } from './schemas/ledger.js';
import { excerpt } from '@jarenjs/core/chunk';

/** @typedef {import('./schemas/ledger.js').LedgerGoal} LedgerGoal */
/** @typedef {import('./schemas/ledger.js').LedgerMemory} LedgerMemory */
/** @typedef {import('./schemas/ledger.js').LedgerSkill} LedgerSkill */
/** @typedef {import('./schemas/ledger.js').LedgerSlot} LedgerSlot */
/** @typedef {import('./schemas/ledger.js').LedgerRejection} LedgerRejection */

/** The key space. State and snapshots are separate prefixes on purpose:
 * a rollback wipes state and must not take the other snapshots with it. */
const STATE = 'ai/state/';
const SNAP = 'ai/snap/';
const KEYS = {
  goal: `${STATE}goal/active`,
  goalArchive: `${STATE}goal/archive/`,
  memory: `${STATE}memory/`,
  skill: `${STATE}skill/`,
  slot: `${STATE}slot/`,
  slotContent: `${STATE}slot-content/`,
};

/** Slot metadata carries a short excerpt so a root request can list a
 * hundred slots without carrying one slot's content. */
const SLOT_EXCERPT_CHARS = 120;

/** A zero-padded sequence, so `keys()` sorts lexicographically into order. */
const seq = (n) => String(n).padStart(6, '0');

/**
 * The next sequence number under a prefix: one past the highest that
 * still exists, read from the trailing digits of every key. Never the
 * count — a count shrinks when a record is deleted, and a sequence that
 * shrinks hands a new record the address of a live one. A caller-named
 * key that happens to end in digits merely advances the sequence, which
 * costs nothing: uniqueness needs only that no existing key ends in the
 * number minted.
 * @param {string[]} keys - every key under the prefix
 * @returns {number}
 */
function nextSequence(keys) {
  let highest = -1;
  for (const key of keys) {
    const match = /(\d+)$/.exec(key);
    if (match !== null) {
      const n = Number(match[1]);
      if (n > highest) highest = n;
    }
  }
  return highest + 1;
}

/**
 * A record with its `undefined` members removed.
 *
 * This is not tidying, it is correctness: a record built as
 * `{ evidence: input?.evidence }` from an input that has no `evidence`
 * carries the KEY with an undefined value, `required` sees the key as
 * present, and the write validates — then `JSON.stringify` drops it on
 * the way to storage and an unevidenced memory is durable. Stripping
 * first makes what is validated exactly what would be stored.
 * @param {Record<string, any>} record
 * @returns {any} the stripped record — `any` so each write site's declared
 *   return type (the record typedef) is the statement that binds, not an
 *   inference from this generic helper
 */
function defined(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Newest first, ties broken by id so two records written in the same
 * millisecond still come back in a stable order. A retrieval whose order
 * wobbled between calls would make everything downstream of it
 * unreproducible.
 * @param {any[]} records
 */
function byRecency(records) {
  return [...records].sort((a, b) => (a.at === b.at
    ? String(a.id ?? a.name).localeCompare(String(b.id ?? b.name))
    : String(b.at).localeCompare(String(a.at))));
}

/**
 * Create a ledger.
 *
 * @param {{ storage?: { get: (key: string) => Promise<any>,
 *     set: (key: string, value: any) => Promise<void>,
 *     delete: (key: string) => Promise<void>,
 *     keys: (prefix?: string) => Promise<string[]> },
 *   compileQuery?: (document: any) => (data: any) => any,
 *   validator?: any,
 *   now?: () => string }} [options]
 *   - `storage` defaults to an in-memory adapter, so a ledger works with
 *     nothing wired. Anything durable is the host's to inject.
 *   - `compileQuery` is the retrieval seam — `compileJsonQuery` from
 *     `@jarenjs/json/query`, or absent. With it, `recall` filters with a
 *     real query document; without it, retrieval degrades to tag match
 *     and recency, and a caller-supplied predicate is refused rather
 *     than silently ignored.
 *   - `now` returns an RFC 3339 timestamp (injected for deterministic
 *     tests, exactly as the rest of the suite injects its environment).
 */
export function createLedger(options = {}) {
  const storage = options.storage ?? createMemoryStorage();
  const compileQuery = typeof options.compileQuery === 'function' ? options.compileQuery : null;
  const now = options.now ?? (() => new Date().toISOString());
  // `unknownFormats: 'ignore'` is the library default; it is passed
  // EXPLICITLY because this project's convention for a schema it ships is
  // the opposite one (`'error'`, so a format nobody registered fails the
  // build instead of checking nothing), and this is the deliberate
  // exception. It has to be: the schemas declare `format: 'date-time'`
  // because that is what the values ARE, but the package may not depend
  // on `@jarenjs/formats` (D3), so no compiler for it can ever be
  // registered here. The enforcement is the `pattern` beside the format,
  // which needs nothing injected; a host passing its own
  // formats-registered `validator` gets the stricter check on top.
  const jaren = options.validator
    ?? new JarenValidator({
      skipErrors: false, collectErrors: true, unknownFormats: 'ignore',
    });

  /** Every kind's compiled check, built once. */
  const checks = Object.fromEntries(Object.entries(LEDGER_SCHEMAS)
    .map(([kind, schema]) => [kind, jaren.compile(schema)]));

  /** Compiled retrieval queries, keyed by their document. Recall runs on
   * every turn of a long conversation; compiling the same predicate each
   * time would be the kind of waste that only shows up under load. */
  const queryCache = new Map();

  /** The tail of the write queue: the promise every mutation waits on. */
  let queue = Promise.resolve();

  /**
   * Run one mutating operation after every one queued before it has
   * settled. Every write is a read-modify-write — mint an id from what
   * exists, then store; read the goal, then replace it — and two of them
   * interleaved read the same "what exists" and collide. One queue per
   * ledger makes a `Promise.all` of writes behave as the sequence it
   * reads as. A rejected operation does not stall the queue: the next
   * one runs regardless, and only its own caller sees the rejection.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const result = queue.then(task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Validate a complete record against its kind, or produce the standard
   * rejection. The record is built by the caller (defaults already
   * filled) so that what is validated is exactly what would be stored.
   *
   * Exported as well as used internally, because a caller that wants to
   * know whether a record WOULD be storable before storing it — a
   * model-proposed refinement, which has to reject an unevidenced memory
   * without writing one — must ask the same question the write asks,
   * against the same compiled schema. A second copy of these checks is
   * how "the ledger rejects it" and "the gate rejects it" would come to
   * mean different things.
   * @param {'goal'|'memory'|'skill'|'slot'} kind
   * @param {any} record
   * @returns {null | { error: string, errors: any[], inputSchema: any }}
   *   null when the record is storable.
   */
  function validate(kind, record) {
    const outcome = checkOutcome(checks[kind](record));
    return outcome.valid ? null : invalidInput(kind, outcome, LEDGER_SCHEMAS[kind]);
  }

  /** Read every value under a prefix, in key order. */
  async function readAll(prefix) {
    const keys = await storage.keys(prefix);
    return Promise.all(keys.map((key) => storage.get(key)));
  }

  /**
   * An id for a record the caller did not name. Derived from the
   * timestamp and one past the highest sequence of that kind still
   * stored, so it is unique within a ledger and reproducible under an
   * injected clock. Called only from inside the write queue: the mint
   * and the store that follows it are one step, so no second writer can
   * read the same highest in between.
   */
  async function mintId(kind, prefix) {
    return `${kind}-${now()}-${seq(nextSequence(await storage.keys(prefix)))}`;
  }

  //#region goal

  /**
   * Set the active objective. Singular by construction: an existing goal
   * is marked `superseded` and moved to the archive rather than
   * overwritten, so the history of what this agent was asked to do
   * survives the change.
   * @param {{ objective: string, createdAt?: string, status?: string,
   *   progress?: any[] }} input
   * @returns {Promise<LedgerGoal | LedgerRejection>} the stored goal, or a rejection
   */
  function setGoal(input) {
    return enqueue(async () => {
      const goal = defined({
        objective: input?.objective,
        createdAt: input?.createdAt ?? now(),
        status: input?.status ?? 'active',
        progress: input?.progress ?? [],
      });
      const rejected = validate('goal', goal);
      if (rejected !== null) return rejected;

      const previous = await storage.get(KEYS.goal);
      if (previous !== undefined) {
        const archived = await storage.keys(KEYS.goalArchive);
        await storage.set(`${KEYS.goalArchive}${seq(nextSequence(archived))}`,
          { ...previous, status: 'superseded' });
      }
      await storage.set(KEYS.goal, goal);
      return goal;
    });
  }

  /**
   * The active objective, or null.
   * @returns {Promise<LedgerGoal | null>}
   */
  async function getGoal() {
    return (await storage.get(KEYS.goal)) ?? null;
  }

  /**
   * Every superseded goal, oldest first.
   * @returns {Promise<LedgerGoal[]>}
   */
  async function listArchivedGoals() {
    return readAll(KEYS.goalArchive);
  }

  /**
   * Append one evidenced progress entry to the active goal. Storage
   * only: nothing here reads a note, scores it, or decides that a goal
   * is finished — that judgement belongs to whatever drives the agent.
   * @param {{ note: string, evidence: string, at?: string }} entry
   * @returns {Promise<LedgerGoal | LedgerRejection | { error: string }>}
   *   the goal with the entry appended; the bare `{ error }` is "no
   *   active goal", which is a state problem, not a validation one
   */
  function recordProgress(entry) {
    return enqueue(async () => {
      const goal = await storage.get(KEYS.goal);
      if (goal === undefined) return { error: 'no active goal — call setGoal first' };
      const next = {
        ...goal,
        progress: [...goal.progress, defined({
          at: entry?.at ?? now(),
          note: entry?.note,
          evidence: entry?.evidence,
        })],
      };
      const rejected = validate('goal', next);
      if (rejected !== null) return rejected;
      await storage.set(KEYS.goal, next);
      return next;
    });
  }

  /**
   * Change the active goal's status without superseding it — how a run
   * records that its objective finished or was abandoned.
   * @param {'active'|'done'|'abandoned'|'superseded'} status
   * @returns {Promise<LedgerGoal | LedgerRejection | { error: string }>}
   */
  function setGoalStatus(status) {
    return enqueue(async () => {
      const goal = await storage.get(KEYS.goal);
      if (goal === undefined) return { error: 'no active goal — call setGoal first' };
      const next = { ...goal, status };
      const rejected = validate('goal', next);
      if (rejected !== null) return rejected;
      await storage.set(KEYS.goal, next);
      return next;
    });
  }

  //#endregion

  //#region memories and skills

  /**
   * Store a fact worth carrying. `evidence` is required by the schema,
   * and the rejection says so: a memory without it is a guess, and a
   * ledger of guesses is worse than an empty one.
   *
   * The record is EVERY member of the input plus the generated defaults,
   * validated whole — so a member the schema does not know is refused
   * with the same `additionalProperties` answer `validate()` gives,
   * never silently dropped. A write that quietly stored less than it
   * was handed would let "it was accepted" and "it is there" diverge.
   * @param {{ id?: string, text: string, evidence: string,
   *   tags?: string[], at?: string }} input
   * @returns {Promise<LedgerMemory | LedgerRejection>} the record as
   *   stored (defaults filled, undefined members stripped), or the
   *   rejection saying why nothing was
   */
  function addMemory(input) {
    return enqueue(async () => {
      const memory = defined({
        ...input,
        id: input?.id ?? await mintId('memory', KEYS.memory),
        tags: input?.tags ?? [],
        at: input?.at ?? now(),
      });
      const rejected = validate('memory', memory);
      if (rejected !== null) return rejected;
      await storage.set(`${KEYS.memory}${memory.id}`, memory);
      return memory;
    });
  }

  /**
   * One memory by id, or null.
   * @param {string} id
   * @returns {Promise<LedgerMemory | null>}
   */
  async function getMemory(id) {
    return (await storage.get(`${KEYS.memory}${id}`)) ?? null;
  }

  /**
   * Every memory, newest first.
   * @returns {Promise<LedgerMemory[]>}
   */
  async function listMemories() {
    return byRecency(await readAll(KEYS.memory));
  }

  /**
   * Remove a memory. Answers whether one was there.
   * @param {string} id
   */
  function deleteMemory(id) {
    return enqueue(async () => {
      const key = `${KEYS.memory}${id}`;
      const existed = (await storage.get(key)) !== undefined;
      await storage.delete(key);
      return existed;
    });
  }

  /**
   * Store a reusable recipe. Built and validated exactly as a memory is:
   * every input member, defaults filled, the whole record checked.
   * @param {{ id?: string, name: string, when: string,
   *   instructions: string, tools?: string[], at?: string }} input
   * @returns {Promise<LedgerSkill | LedgerRejection>}
   */
  function addSkill(input) {
    return enqueue(async () => {
      const skill = defined({
        ...input,
        id: input?.id ?? await mintId('skill', KEYS.skill),
        tools: input?.tools ?? [],
        at: input?.at ?? now(),
      });
      const rejected = validate('skill', skill);
      if (rejected !== null) return rejected;
      await storage.set(`${KEYS.skill}${skill.id}`, skill);
      return skill;
    });
  }

  /**
   * One skill by id, or null.
   * @param {string} id
   * @returns {Promise<LedgerSkill | null>}
   */
  async function getSkill(id) {
    return (await storage.get(`${KEYS.skill}${id}`)) ?? null;
  }

  /**
   * Every skill, newest first.
   * @returns {Promise<LedgerSkill[]>}
   */
  async function listSkills() {
    return byRecency(await readAll(KEYS.skill));
  }

  /**
   * Remove a skill. Answers whether one was there.
   * @param {string} id
   */
  function deleteSkill(id) {
    return enqueue(async () => {
      const key = `${KEYS.skill}${id}`;
      const existed = (await storage.get(key)) !== undefined;
      await storage.delete(key);
      return existed;
    });
  }

  //#endregion

  //#region retrieval

  /**
   * The tag predicate as a query document. Jaren's comparison operators
   * are existentially lifted over sequences, so `$eq` between the record's
   * tag sequence and the requested one is exactly "the two overlap" —
   * one operator, no loop, and the same meaning as the fallback's
   * `some`/`includes`.
   * @param {string[]} tags
   */
  const tagPredicate = (tags) => ({ $eq: ['$it.tags[*]', { $seq: tags }] });

  /** Compile once per distinct query document. */
  function compiled(document) {
    const key = JSON.stringify(document);
    let run = queryCache.get(key);
    if (run === undefined) {
      run = compileQuery(document);
      queryCache.set(key, run);
    }
    return run;
  }

  /**
   * Filter a record set. With the query seam wired this is a real jaren
   * query — one document, which a host that also wired `@jarenjs/db`
   * could push down to SQL unchanged. With the seam empty it is tag
   * match, and a caller predicate is REFUSED rather than ignored:
   * silently dropping a filter would answer the wrong question with a
   * straight face.
   */
  function filter(records, tags, where) {
    const parts = [];
    if (tags !== undefined && tags.length > 0) parts.push(tagPredicate(tags));
    if (where !== undefined && where !== null) parts.push(where);

    if (compileQuery === null) {
      if (where !== undefined && where !== null) {
        return { error: 'recall: a `where` predicate needs the compileQuery seam — '
          + 'inject compileJsonQuery from @jarenjs/json/query, or filter by tags only' };
      }
      if (parts.length === 0) return { value: records };
      return { value: records.filter((record) =>
        (record.tags ?? []).some((tag) => tags.includes(tag))) };
    }

    if (parts.length === 0) return { value: records };
    const predicate = parts.length === 1 ? parts[0] : { $and: parts };
    try {
      const run = compiled([{ $for: { it: '$[*]' }, $where: predicate, $return: '$it' }]);
      return { value: run(records) };
    }
    catch (err) {
      // a caller's predicate that does not compile is content, not a
      // crash — same posture as a tool call the model got wrong
      return { error: `recall: ${/** @type {any} */ (err)?.reason ?? /** @type {any} */ (err)?.message ?? err}` };
    }
  }

  /**
   * Retrieve by relevance: tag match, then recency, plus any predicate
   * the seam can evaluate.
   * @param {any[]} records
   * @param {{ tags?: string[], where?: any, limit?: number }} query
   */
  function retrieve(records, query = {}) {
    const filtered = filter(records, query.tags, query.where);
    if (filtered.error !== undefined) return filtered;
    const ordered = byRecency(filtered.value);
    return typeof query.limit === 'number' ? ordered.slice(0, query.limit) : ordered;
  }

  /**
   * Memories relevant to a query, newest first.
   * @param {{ tags?: string[], where?: any, limit?: number }} [query]
   * @returns {Promise<LedgerMemory[] | { error: string }>} the `{ error }`
   *   is a predicate problem (no seam, or one that does not compile) —
   *   content, not a crash
   */
  async function recall(query = {}) {
    return retrieve(await readAll(KEYS.memory), query);
  }

  /**
   * Skills relevant to a query, newest first — what a host composes into
   * a system prompt.
   * @param {{ tags?: string[], where?: any, limit?: number }} [query]
   * @returns {Promise<LedgerSkill[] | { error: string }>}
   */
  async function recallSkills(query = {}) {
    return retrieve(await readAll(KEYS.skill), query);
  }

  //#endregion

  //#region slots

  /**
   * Write an addressable blob. The metadata and the content go to
   * separate keys, and only the metadata is ever handed around: that
   * separation is the point of a slot, and it is what will let a request
   * name a hundred of them without carrying any of their content.
   * @param {string} name
   * @param {string} content
   * @param {{ kind?: string, at?: string, count?: number }} [meta]
   *   `count` is what the content HOLDS (lines, records, pieces) where
   *   the writer knows it; absent where it does not, rather than guessed.
   * @returns {Promise<LedgerSlot | LedgerRejection>}
   */
  function putSlot(name, content, meta = {}) {
    return enqueue(async () => {
      const text = typeof content === 'string' ? content : JSON.stringify(content ?? null);
      const slot = defined({
        name,
        kind: meta.kind ?? 'text',
        size: text.length,
        excerpt: excerpt(text, SLOT_EXCERPT_CHARS),
        at: meta.at ?? now(),
        count: meta.count,
      });
      const rejected = validate('slot', slot);
      if (rejected !== null) return rejected;
      await storage.set(`${KEYS.slotContent}${name}`, text);
      await storage.set(`${KEYS.slot}${name}`, slot);
      return slot;
    });
  }

  /**
   * A slot's metadata — never its content.
   * @param {string} name
   * @returns {Promise<LedgerSlot | null>}
   */
  async function getSlot(name) {
    return (await storage.get(`${KEYS.slot}${name}`)) ?? null;
  }

  /**
   * A slot's content, or undefined. The one call that returns the bytes.
   * @param {string} name
   * @returns {Promise<string | undefined>}
   */
  async function readSlot(name) {
    return storage.get(`${KEYS.slotContent}${name}`);
  }

  /**
   * Every slot's metadata, newest first.
   * @returns {Promise<LedgerSlot[]>}
   */
  async function listSlots() {
    return byRecency(await readAll(KEYS.slot));
  }

  /**
   * Remove a slot and its content. Answers whether one was there.
   * @param {string} name
   */
  function deleteSlot(name) {
    return enqueue(async () => {
      const key = `${KEYS.slot}${name}`;
      const existed = (await storage.get(key)) !== undefined;
      await storage.delete(key);
      await storage.delete(`${KEYS.slotContent}${name}`);
      return existed;
    });
  }

  //#endregion

  //#region snapshots

  /**
   * Record the whole state under a token. Cheap — a ledger is small JSON
   * — and it is what makes an automatic write safe to accept: a bad one
   * is undone by its token, with no human reading a diff. The token
   * continues the sequence already in storage, exactly as an id does: a
   * second ledger over the same adapter — the next process over a
   * durable one — mints the next token, never the first one's again.
   * @returns {Promise<string>} an opaque token for `rollback`
   */
  function snapshot() {
    return enqueue(async () => {
      const keys = await storage.keys(STATE);
      const entries = await Promise.all(keys.map(async (key) => [key, await storage.get(key)]));
      const token = `snap-${seq(nextSequence(await storage.keys(SNAP)))}`;
      await storage.set(`${SNAP}${token}`, entries);
      return token;
    });
  }

  /**
   * Restore the state a token recorded. Every current state key is
   * removed first, so a rollback is a restore and not a merge — a record
   * created after the snapshot is gone afterwards, which is the only
   * reading of "rollback" that can be relied on.
   * @param {string} token
   * @returns {Promise<true | { error: string }>}
   */
  function rollback(token) {
    return enqueue(async () => {
      const entries = await storage.get(`${SNAP}${token}`);
      if (entries === undefined) return { error: `unknown snapshot '${token}'` };
      for (const key of await storage.keys(STATE)) await storage.delete(key);
      for (const [key, value] of entries) await storage.set(key, value);
      return true;
    });
  }

  //#endregion

  return {
    validate,
    setGoal, getGoal, listArchivedGoals, recordProgress, setGoalStatus,
    addMemory, getMemory, listMemories, deleteMemory,
    addSkill, getSkill, listSkills, deleteSkill,
    recall, recallSkills,
    putSlot, getSlot, readSlot, listSlots, deleteSlot,
    snapshot, rollback,
  };
}
