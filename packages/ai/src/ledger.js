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
 * And one more, added when recall by meaning arrived:
 *
 *  - **Meaning is a seam, not a dependency.** A record may carry an
 *    `embedding` with its identity (`embeddedBy: { model, dims }`);
 *    `recall({ near })` ranks by cosine similarity through an injected
 *    embedder — `createEmbeddingClient(...)`, `createHashEmbedder()`, or
 *    any host `{ embed, model, dims }` — and without one it REFUSES,
 *    naming the seam, exactly as a `where` predicate refuses without
 *    `compileQuery`. It refuses a mixture of identities rather than
 *    ranking the matching subset (a silent subset is a silent wrong
 *    answer), it reports how many records it skipped for carrying no
 *    vector rather than scoring them, and a write never acquires the
 *    seam's network dependency unless `embedOnWrite` asks for it;
 *    `embedMissing()` is the explicit sweep that closes the gap. Every
 *    dot and cosine comes from `@jarenjs/core/vector`; none is computed
 *    here. A storage adapter that can rank the records itself may say so
 *    with an optional fifth method (`rank`, see
 *    {@link createMemoryStorage}'s contract); the ledger then asks it
 *    instead of sweeping, holds it to the same identity refusal and skip
 *    report, and names which one ran in `via`.
 *
 * Its consumers today: the agent's compaction archive, the environment's
 * slots, refinement's patchable state, and the website assistant's
 * durable memory — all on this one implementation.
 */

import { JarenValidator } from '@jarenjs/validate';
import { excerpt } from '@jarenjs/core/chunk';
import { isVector, cosineSimilarity } from '@jarenjs/core/vector';

import { checkOutcome, invalidInput } from './check.js';
import { AiError } from './errors.js';
import { createMemoryStorage } from './storage/memory.js';
import { LEDGER_SCHEMAS } from './schemas/ledger.js';

/** @typedef {import('./schemas/ledger.js').LedgerGoal} LedgerGoal */
/** @typedef {import('./schemas/ledger.js').LedgerMemory} LedgerMemory */
/** @typedef {import('./schemas/ledger.js').LedgerSkill} LedgerSkill */
/** @typedef {import('./schemas/ledger.js').LedgerSlot} LedgerSlot */
/** @typedef {import('./schemas/ledger.js').LedgerRejection} LedgerRejection */
/** @typedef {import('./schemas/ledger.js').LedgerEmbeddedBy} LedgerEmbeddedBy */
/** @typedef {import('./embed.js').Embedder} Embedder */

/**
 * What `recall({ near })` answers: the memories that carry a comparable
 * vector, ranked by cosine similarity (descending; ties by recency, then
 * id), one score per memory in the same order, and the count of records
 * that passed the filter but carry no vector and were therefore skipped
 * — reported, never scored.
 * @typedef {object} LedgerRankedMemories
 * @property {LedgerMemory[]} memories
 * @property {number[]} scores
 * @property {number} skipped
 * @property {'sweep' | 'adapter'} via - which path answered: the ledger's
 *   own read-and-rank, or the adapter's `rank` capability
 */

/**
 * What `recallSkills({ near })` answers — see {@link LedgerRankedMemories}.
 * @typedef {object} LedgerRankedSkills
 * @property {LedgerSkill[]} skills
 * @property {number[]} scores
 * @property {number} skipped
 * @property {'sweep' | 'adapter'} via - see {@link LedgerRankedMemories}
 */

/**
 * The query both recalls take. `near` is the string to rank by meaning
 * against, and needs the embedder seam; `minScore` filters the ranked
 * result (cosine, in [-1, 1]); `tags` and `where` narrow the candidates
 * first, exactly as they do without `near`.
 * @typedef {object} LedgerQuery
 * @property {string[]} [tags]
 * @property {any} [where]
 * @property {number} [limit]
 * @property {string} [near]
 * @property {number} [minScore]
 */

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
  return [...records].sort(recencyOrder);
}

/**
 * The comparator behind {@link byRecency}: newer first, then id — the
 * same rule ranked recall falls back to between two equal scores.
 * @param {any} a
 * @param {any} b
 */
function recencyOrder(a, b) {
  return a.at === b.at
    ? String(a.id ?? a.name).localeCompare(String(b.id ?? b.name))
    : String(b.at).localeCompare(String(a.at));
}

/**
 * The text a skill is embedded from: its name, when it applies and what
 * to do, one per line — what "near" means for a skill. A memory is
 * embedded from its `text` alone.
 * @param {{ name: string, when: string, instructions: string }} skill
 */
const skillText = (skill) => `${skill.name}\n${skill.when}\n${skill.instructions}`;

/**
 * Whether two vector identities are the same model at the same width.
 * @param {LedgerEmbeddedBy | undefined} a
 * @param {LedgerEmbeddedBy} b
 */
const sameIdentity = (a, b) => a !== undefined && a.model === b.model && a.dims === b.dims;

/**
 * An identity as a refusal names it.
 * @param {LedgerEmbeddedBy} identity
 */
const describeIdentity = (identity) => `${identity.model} (${identity.dims} dims)`;

/** The seam refusal, shared by every entry point that needs the embedder. */
const SEAM_REFUSAL = 'needs the embedder seam — inject createEmbeddingClient(...) or any { embed, model, dims }';

/** How many texts one `embedMissing` batch hands the seam. */
const EMBED_BATCH = 64;

/**
 * Create a ledger.
 *
 * @param {{ storage?: { get: (key: string) => Promise<any>,
 *     set: (key: string, value: any) => Promise<void>,
 *     delete: (key: string) => Promise<void>,
 *     keys: (prefix?: string) => Promise<string[]>,
 *     rank?: (request: { prefix: string, vector: number[], model: string, dims: number,
 *       limit?: number, minScore?: number }) => Promise<{ hits: { key: string, score: number }[],
 *       skipped: number, identities: LedgerEmbeddedBy[] }> },
 *   compileQuery?: (document: any) => (data: any) => any,
 *   embedder?: Embedder,
 *   embedOnWrite?: boolean,
 *   validator?: any,
 *   now?: () => string }} [options]
 *   - `storage` defaults to an in-memory adapter, so a ledger works with
 *     nothing wired. Anything durable is the host's to inject. Its four
 *     methods are the contract; an adapter that can rank vectors itself
 *     declares an optional fifth (`rank`) and `recall({ near })` asks it
 *     instead of reading every record.
 *   - `compileQuery` is the retrieval seam — `compileJsonQuery` from
 *     `@jarenjs/json/query`, or absent. With it, `recall` filters with a
 *     real query document; without it, retrieval degrades to tag match
 *     and recency, and a caller-supplied predicate is refused rather
 *     than silently ignored.
 *   - `embedder` is the meaning seam — `createEmbeddingClient(...)`,
 *     `createHashEmbedder()`, or any host `{ embed, model, dims }` whose
 *     `embed` returns a Promise and rejects rather than throws. With it,
 *     `recall({ near })` ranks and `embedMissing()` sweeps; without it,
 *     both refuse naming the seam. Every stored vector is compared
 *     against the embedder's `{ model, dims }` before any arithmetic.
 *   - `embedOnWrite` (default `false`) embeds a memory or skill that
 *     arrives without a vector inside its own write. Off by default on
 *     purpose: a write must not silently acquire a network dependency.
 *     On, a seam failure stores the record un-embedded and reports it on
 *     the returned record (`embedError`) — never a dropped write.
 *   - `now` returns an RFC 3339 timestamp (injected for deterministic
 *     tests, exactly as the rest of the suite injects its environment).
 */
export function createLedger(options = {}) {
  const storage = options.storage ?? createMemoryStorage();
  const compileQuery = typeof options.compileQuery === 'function' ? options.compileQuery : null;
  /** @type {Embedder | null} */
  const embedder = options.embedder ?? null;
  if (embedder !== null) {
    if (typeof embedder !== 'object' || typeof embedder.embed !== 'function')
      throw new AiError('AI0001', 'embedder: expected the seam — { embed(texts) → Promise<Float32Array[]>, model, dims }');
    if (typeof embedder.model !== 'string' || embedder.model === '')
      throw new AiError('AI0001', 'embedder: needs a model name — it is half of every vector\'s identity');
  }
  const embedOnWrite = options.embedOnWrite === true;
  if (embedOnWrite && embedder === null)
    throw new AiError('AI0001', `embedOnWrite ${SEAM_REFUSAL}`);
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
    if (!outcome.valid) return invalidInput(kind, outcome, LEDGER_SCHEMAS[kind]);
    // the schema has said the pair is present together and shaped; what
    // it cannot say is that the vector IS what its identity declares —
    // `isVector` is the suite's one definition of that
    if (record.embedding !== undefined && !isVector(record.embedding, record.embeddedBy.dims)) {
      return invalidInput(kind, { errors: [{
        instancePath: '/embedding',
        keyword: 'embeddedBy',
        message: `must be exactly ${record.embeddedBy.dims} finite numbers, as embeddedBy.dims declares`,
      }] }, LEDGER_SCHEMAS[kind]);
    }
    return null;
  }

  /**
   * Embed texts through the seam, holding a host embedder to the
   * contract the shipped ones keep — one finite vector per input, all of
   * one width — and answering `{ vectors, identity }` or `{ error }`,
   * never a throw. The call sits inside the `try` so that a host `embed`
   * that throws synchronously lands in the same catch as one that
   * rejects. `identity.dims` is the embedder's settled width, or the
   * width this reply settled it at.
   * @param {string[]} texts
   * @returns {Promise<{ vectors: Float32Array[], identity: LedgerEmbeddedBy, error?: undefined }
   *   | { error: string, vectors?: undefined, identity?: undefined }>}
   */
  async function embedThrough(texts) {
    if (embedder === null) return { error: SEAM_REFUSAL };
    try {
      const vectors = await embedder.embed(texts);
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        return { error: `the embedder answered ${Array.isArray(vectors) ? vectors.length : 'no'}`
          + ` vectors for ${texts.length} inputs` };
      }
      const dims = embedder.dims ?? vectors[0].length;
      for (let i = 0; i < vectors.length; i++) {
        if (!isVector(vectors[i], dims))
          return { error: `the embedder answered something other than ${dims} finite numbers for input ${i}` };
      }
      return { vectors, identity: { model: embedder.model, dims } };
    }
    catch (err) {
      return { error: /** @type {any} */ (err)?.message ?? String(err) };
    }
  }

  /**
   * The stored form of one seam vector on a record: plain numbers, with
   * the identity beside them.
   * @template {object} T
   * @param {T} record
   * @param {Float32Array} vector
   * @param {LedgerEmbeddedBy} identity
   * @returns {T & { embedding: number[], embeddedBy: LedgerEmbeddedBy }}
   */
  const withEmbedding = (record, vector, identity) =>
    ({ ...record, embedding: Array.from(vector), embeddedBy: { ...identity } });

  /**
   * The `embedOnWrite` step: a record arriving without a vector is
   * embedded inside its own write. A seam failure is reported on the
   * RESULT, not the record — the record is stored un-embedded and the
   * write succeeds, because one bad network call must not lose a memory;
   * `embedMissing()` closes the gap later.
   * @template {{ embedding?: number[] }} T
   * @param {T} record
   * @param {string} text
   * @returns {Promise<{ record: T, embedError?: string }>}
   */
  async function embedOnWriteStep(record, text) {
    if (!embedOnWrite || record.embedding !== undefined) return { record };
    const answer = await embedThrough([text]);
    if (answer.error !== undefined)
      return { record, embedError: `the embedder seam failed — ${answer.error}; stored un-embedded` };
    return { record: withEmbedding(record, answer.vectors[0], answer.identity) };
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
   *   tags?: string[], at?: string, embedding?: number[],
   *   embeddedBy?: LedgerEmbeddedBy }} input
   *   `embedding` + `embeddedBy` travel together (plain numbers, never a
   *   typed array); the vector must be exactly `embeddedBy.dims` finite
   *   numbers or the write is rejected
   * @returns {Promise<(LedgerMemory & { embedError?: string }) | LedgerRejection>}
   *   the record as stored (defaults filled, undefined members
   *   stripped), or the rejection saying why nothing was. `embedError`
   *   appears only under `embedOnWrite` when the seam failed: the record
   *   is stored WITHOUT a vector and the member is not part of it
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
      const { record, embedError } = await embedOnWriteStep(memory, memory.text);
      await storage.set(`${KEYS.memory}${record.id}`, record);
      return embedError === undefined ? record : { ...record, embedError };
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
   *   instructions: string, tools?: string[], at?: string,
   *   embedding?: number[], embeddedBy?: LedgerEmbeddedBy }} input
   * @returns {Promise<(LedgerSkill & { embedError?: string }) | LedgerRejection>}
   *   as `addMemory`; under `embedOnWrite` the skill is embedded from its
   *   name, when and instructions
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
      const { record, embedError } = await embedOnWriteStep(skill, skillText(skill));
      await storage.set(`${KEYS.skill}${record.id}`, record);
      return embedError === undefined ? record : { ...record, embedError };
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
   * @param {LedgerQuery} query
   */
  function retrieve(records, query = {}) {
    const filtered = filter(records, query.tags, query.where);
    if (filtered.error !== undefined) return filtered;
    const ordered = byRecency(filtered.value);
    return typeof query.limit === 'number' ? ordered.slice(0, query.limit) : ordered;
  }

  /**
   * The mixture refusal, in one place, so the sweep and an adapter that
   * ranks for us word it identically and in the same order.
   * @param {string} name
   * @param {Map<string, LedgerEmbeddedBy>} found - every identity seen, in the order seen
   * @param {LedgerEmbeddedBy} identity - the query embedder's
   * @returns {{ error: string } | null}
   */
  function refuseMixture(name, found, identity) {
    if ([...found.values()].every((stored) => sameIdentity(stored, identity))) return null;
    return { error: `${name}: near cannot rank across embedders — the ledger holds vectors from`
      + ` ${[...found.keys()].join(', ')} and the query embedder is ${describeIdentity(identity)};`
      + ' rank through the embedder that wrote them, or re-embed every record with one embedder' };
  }

  /**
   * The last two steps both ranked paths share: the kernels score every
   * record the path selected, `minScore` filters and `limit` caps.
   *
   * The score is always `cosineSimilarity` over the record as stored —
   * never a number an adapter handed back — so the two paths cannot
   * report different similarities for the same record. Equal scores
   * fall back to recency, then id.
   * @param {any[]} records
   * @param {any} probe
   * @param {LedgerQuery} query
   * @param {'memories' | 'skills'} member
   * @param {number} skipped
   * @param {'sweep' | 'adapter'} via
   */
  function rankedResult(records, probe, query, member, skipped, via) {
    const ranked = records
      .map((record) => ({ record, score: cosineSimilarity(probe, record.embedding) }))
      .sort((a, b) => (b.score - a.score) || recencyOrder(a.record, b.record));
    const kept = typeof query.minScore === 'number'
      ? ranked.filter((entry) => entry.score >= /** @type {number} */ (query.minScore))
      : ranked;
    const capped = typeof query.limit === 'number' ? kept.slice(0, query.limit) : kept;
    return {
      [member]: capped.map((entry) => entry.record),
      scores: capped.map((entry) => entry.score),
      skipped,
      via,
    };
  }

  /**
   * Retrieve by meaning: the records that pass the tag/where filter AND
   * carry a vector, ranked by cosine similarity to the embedded query.
   *
   * The refusals come before the arithmetic, in this order: `near` must
   * be a non-empty string; the seam must be wired (the `compileQuery`
   * precedent — an absent capability refuses, it never degrades); the
   * filter must compile; the seam must answer; and every candidate's
   * identity must equal the query embedder's. A mixture — two models in
   * the ledger, or a ledger embedded by one model and queried through
   * another — is refused naming every identity found, because ranking
   * the matching subset would be a silent wrong answer. Records without
   * a vector are not scored (a fabricated score poisons a ranking) and
   * not hidden (a silent drop poisons trust): they are counted in
   * `skipped`.
   *
   * TWO paths reach that answer and both report which one ran. By
   * default the ledger reads every record under the prefix and ranks
   * them here. An adapter that declares `rank` is asked instead — it
   * knows how to narrow to the k best without handing over the whole
   * ledger — and is held to exactly the same contract: it reports the
   * distinct identities it holds so the mixture refusal is the ledger's,
   * it reports what it skipped, and the kernels re-score what it
   * returns. An adapter whose own ranking is approximate makes recall
   * approximate: the ledger can re-score what it is handed, never
   * recover a record the adapter did not return.
   *
   * `tags` and `where` narrow candidates the adapter knows nothing
   * about, so a query carrying either takes the sweep.
   *
   * Ranking is `cosineSimilarity` from the kernels, descending; equal
   * scores fall back to recency, then id, so the order is deterministic.
   * `minScore` filters the ranked list; `limit` caps what survives.
   * @param {LedgerQuery} query
   * @param {'recall' | 'recallSkills'} name - the entry point, for the refusal text
   * @param {'memories' | 'skills'} member - the result member the ranked records go under
   * @param {string} prefix - the key space the records live under
   * @returns {Promise<{ error: string }
   *   | { [member: string]: any, scores: number[], skipped: number, via: 'sweep' | 'adapter' }>}
   */
  async function rankNear(query, name, member, prefix) {
    const { near } = query;
    if (typeof near !== 'string' || near === '')
      return { error: `${name}: near must be a non-empty string — the text to rank by meaning against` };
    if (embedder === null) return { error: `${name}: near ${SEAM_REFUSAL}` };

    const narrowed = query.tags !== undefined || query.where !== undefined;
    const delegated = typeof storage.rank === 'function' && !narrowed;
    // the sweep reads first so that a `where` without the compileQuery
    // seam still refuses before the embedder is called; the adapter path
    // has no filter to compile
    const filtered = delegated ? null : filter(await readAll(prefix), query.tags, query.where);
    if (filtered !== null && filtered.error !== undefined) return filtered;

    const answer = await embedThrough([near]);
    if (answer.error !== undefined) return { error: `${name}: the embedder seam failed — ${answer.error}` };
    const probe = answer.vectors[0];
    const identity = answer.identity;

    if (delegated) {
      const hits = await /** @type {any} */ (storage).rank({
        prefix, vector: Array.from(probe), model: identity.model, dims: identity.dims,
        limit: query.limit, minScore: query.minScore,
      });
      if (hits === null || typeof hits !== 'object' || !Array.isArray(hits.hits)
        || !Array.isArray(hits.identities) || typeof hits.skipped !== 'number') {
        return { error: `${name}: the storage adapter's rank answered something other than`
          + ' { hits, skipped, identities } — a capability that cannot be trusted to report what it'
          + ' skipped is worse than one that is absent' };
      }
      /** @type {Map<string, LedgerEmbeddedBy>} */
      const found = new Map();
      for (const stored of hits.identities) found.set(describeIdentity(stored), stored);
      const refused = refuseMixture(name, found, identity);
      if (refused !== null) return refused;
      const records = await Promise.all(hits.hits.map((/** @type {any} */ hit) => storage.get(hit.key)));
      // a key the adapter ranked and a read that no longer finds it is a
      // record deleted in between, not a record without a vector
      return rankedResult(records.filter((record) => record?.embedding !== undefined),
        probe, query, member, hits.skipped, 'adapter');
    }

    // the identity check, before any math: every candidate's identity
    // must be the query's, or nothing is ranked
    /** @type {any[]} */
    const candidates = [];
    /** @type {Map<string, LedgerEmbeddedBy>} */
    const found = new Map();
    let skipped = 0;
    for (const record of /** @type {any} */ (filtered).value) {
      if (record.embedding === undefined) {
        skipped += 1;
        continue;
      }
      found.set(describeIdentity(record.embeddedBy), record.embeddedBy);
      candidates.push(record);
    }
    const refused = refuseMixture(name, found, identity);
    if (refused !== null) return refused;
    return rankedResult(candidates, probe, query, member, skipped, 'sweep');
  }

  /**
   * Memories relevant to a query. Without `near`: tag match, then
   * recency — an array, newest first. With `near`: ranked by meaning
   * through the embedder seam — `{ memories, scores, skipped, via }` — or
   * the refusal that says why not.
   * @param {LedgerQuery} [query]
   * @returns {Promise<LedgerMemory[] | LedgerRankedMemories | { error: string }>}
   *   the `{ error }` is a query problem — no seam for a `where` or a
   *   `near`, a predicate that does not compile, a seam that failed, or
   *   a mixture of vector identities — content, not a crash
   */
  async function recall(query = {}) {
    return query.near === undefined
      ? retrieve(await readAll(KEYS.memory), query)
      : /** @type {any} */ (rankNear(query, 'recall', 'memories', KEYS.memory));
  }

  /**
   * Skills relevant to a query — what a host composes into a system
   * prompt. The same two paths as `recall`; a skill's meaning is its
   * name, when and instructions together.
   * @param {LedgerQuery} [query]
   * @returns {Promise<LedgerSkill[] | LedgerRankedSkills | { error: string }>}
   */
  async function recallSkills(query = {}) {
    return query.near === undefined
      ? retrieve(await readAll(KEYS.skill), query)
      : /** @type {any} */ (rankNear(query, 'recallSkills', 'skills', KEYS.skill));
  }

  /**
   * The explicit sweep: embed every memory and skill that carries no
   * vector, through the seam, in batches, inside the write chain — so no
   * other write moves a record under it. Memories first, then skills,
   * each in key order; `limit` caps how many records this run embeds,
   * `batch` how many texts one seam call carries.
   *
   * Honest about what it did not do. A second run over a swept ledger
   * embeds zero and makes no seam call (the two-run check). A failing
   * batch ends the run: the records embedded before it are written, the
   * failed batch and everything after it stay un-embedded and are
   * counted in `remaining`, and the error is surfaced once — never a
   * throw that loses the batch, and never a per-record retry against a
   * provider that just refused (the seam's own retry policy has already
   * run). A ledger that already holds vectors under another identity is
   * refused up front rather than turned into a mixture `recall({ near })`
   * would then refuse.
   * @param {{ limit?: number, batch?: number }} [options]
   * @returns {Promise<{ embedded: number, remaining: number, error?: string }>}
   */
  function embedMissing(options = {}) {
    return enqueue(async () => {
      const batch = typeof options.batch === 'number' && options.batch > 0 ? Math.floor(options.batch) : EMBED_BATCH;
      /** @type {Array<{ key: string, record: any, text: string }>} */
      const pending = [];
      /** @type {Map<string, LedgerEmbeddedBy>} */
      const held = new Map();
      for (const memory of await readAll(KEYS.memory)) {
        if (memory.embedding === undefined) pending.push({ key: `${KEYS.memory}${memory.id}`, record: memory, text: memory.text });
        else held.set(describeIdentity(memory.embeddedBy), memory.embeddedBy);
      }
      for (const skill of await readAll(KEYS.skill)) {
        if (skill.embedding === undefined) pending.push({ key: `${KEYS.skill}${skill.id}`, record: skill, text: skillText(skill) });
        else held.set(describeIdentity(skill.embeddedBy), skill.embeddedBy);
      }
      const total = pending.length;
      if (embedder === null) return { embedded: 0, remaining: total, error: `embedMissing: ${SEAM_REFUSAL}` };

      /** The mixture refusal, once the embedder's width is known. */
      const mixture = (/** @type {LedgerEmbeddedBy} */ identity) => {
        const foreign = [...held.keys()].filter((key) => !sameIdentity(held.get(key), identity));
        return foreign.length === 0 ? null
          : { embedded: 0, remaining: total, error: 'embedMissing: would mix vector identities — the ledger'
            + ` already holds vectors from ${foreign.join(', ')} and the embedder is ${describeIdentity(identity)};`
            + ' sweep with the embedder that wrote them, or re-add those records without a vector first' };
      };
      if (embedder.dims !== undefined) {
        const refused = mixture({ model: embedder.model, dims: embedder.dims });
        if (refused !== null) return refused;
      }

      const todo = typeof options.limit === 'number' ? pending.slice(0, Math.max(0, Math.floor(options.limit))) : pending;
      let embedded = 0;
      for (let i = 0; i < todo.length; i += batch) {
        const slice = todo.slice(i, i + batch);
        const answer = await embedThrough(slice.map((entry) => entry.text));
        if (answer.error !== undefined)
          return { embedded, remaining: total - embedded, error: `embedMissing: the embedder seam failed — ${answer.error}` };
        if (i === 0) {
          // a wire client settles its width on its first reply; the
          // check that could not run up front runs here, before a write
          const refused = mixture(answer.identity);
          if (refused !== null) return refused;
        }
        for (let j = 0; j < slice.length; j++) {
          await storage.set(slice[j].key, withEmbedding(slice[j].record, answer.vectors[j], answer.identity));
          embedded += 1;
        }
      }
      return { embedded, remaining: total - embedded };
    });
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
    recall, recallSkills, embedMissing,
    putSlot, getSlot, readSlot, listSlots, deleteSlot,
    snapshot, rollback,
  };
}
