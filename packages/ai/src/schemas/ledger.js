//@ts-check
/**
 * The ledger's four record schemas, as plain JSON Schema documents
 * compiled by `JarenValidator` when a ledger is constructed. A malformed
 * write is rejected at the boundary exactly the way a malformed tool call
 * is — the suite validating its own durable state with its own validator.
 *
 * They live in one module rather than four files because they are small,
 * they share a vocabulary (`at` is an RFC 3339 timestamp everywhere, ids
 * are non-empty strings everywhere), and one file is where a reader looks
 * for "what may a ledger hold".
 *
 * Why four kinds and not one bag: they differ in every dimension that
 * matters. Lifetime — a goal is superseded, a memory accumulates, a slot
 * is garbage. Retrieval — a goal is always in context, memories are
 * recalled by relevance, slots are addressed by name. Write rule — a
 * memory or skill may be proposed by a model (and must therefore carry
 * evidence), a slot is written by the harness and never proposed.
 */

/**
 * A timestamp property: RFC 3339, the suite's only date representation.
 *
 * Both keywords earn their place. `format` is the right metadata and a
 * host that injects a validator with `@jarenjs/formats` registered gets
 * real format checking from it — but `format` is annotation-only by
 * default, so on its own it would enforce NOTHING here, and this package
 * may not depend on `@jarenjs/formats` to find that out. The `pattern`
 * is the zero-dependency enforcement, and it is not pedantry: recency
 * ordering compares these strings lexicographically, so a junk `at`
 * would not be rejected, it would quietly sort wrong.
 *
 * The lexicographic comparison is exact only for a consistent offset.
 * The ledger's own clock emits `Z`; a host mixing offsets gets ordering
 * that is off by the difference, which is why the pattern documents the
 * offset rather than banning it.
 */
const AT = {
  type: 'string',
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$',
};

/** A non-empty identifier. */
const ID = { type: 'string', minLength: 1 };

/**
 * A stored embedding: a plain array of numbers, never a typed array. A
 * `Float32Array` does not survive the storage boundary — JSON serializes
 * it as a dense object — so the ledger's form is what JSON keeps. What
 * the schema cannot say (every component finite, the length equal to the
 * identity's `dims`) the ledger checks with `isVector` from
 * `@jarenjs/core/vector` in the same gate.
 */
const EMBEDDING = { type: 'array', items: { type: 'number' }, minItems: 1 };

/**
 * A vector's identity: which model produced it, at what width. Vectors
 * from two models are pairwise meaningless and compare into plausible
 * garbage, so an embedding never travels without this and ranked recall
 * refuses to mix two.
 */
const EMBEDDED_BY = {
  type: 'object',
  properties: {
    model: { type: 'string', minLength: 1 },
    dims: { type: 'integer', minimum: 1 },
  },
  required: ['model', 'dims'],
  additionalProperties: false,
};

/**
 * `embedding` and `embeddedBy` are both-or-neither, and nothing requires
 * them: an un-embedded record is exactly as valid as it ever was. The
 * schemas declare no `$schema`, so they compile under the validator's
 * draft-07 default, where "if this member is present, that one is
 * required" is spelled `dependencies` (the `dependentRequired` of
 * 2019-09 and later says the same thing).
 */
const EMBEDDING_PAIR = { embedding: ['embeddedBy'], embeddedBy: ['embedding'] };

/**
 * One active objective. Singular by construction: a second `setGoal`
 * supersedes this one and archives it, so "what am I doing" has exactly
 * one answer at any moment.
 *
 * `progress` is storage only in this order — an append-only record of
 * what happened, with the evidence for it. Nothing here interprets a
 * progress entry or decides when a goal is done.
 */
export const GOAL_SCHEMA = {
  $id: 'https://jarenjs.github.io/schemas/ai/ledger-goal.json',
  type: 'object',
  properties: {
    objective: { type: 'string', minLength: 1 },
    createdAt: AT,
    status: { enum: ['active', 'done', 'abandoned', 'superseded'] },
    progress: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          at: AT,
          note: { type: 'string', minLength: 1 },
          // an unevidenced progress note is a claim, not a record
          evidence: { type: 'string', minLength: 1 },
        },
        required: ['at', 'note', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['objective', 'createdAt', 'status', 'progress'],
  additionalProperties: false,
};

/**
 * A fact worth carrying past this context window.
 *
 * `evidence` is REQUIRED, and that is the load-bearing part: a memory
 * without evidence is not a memory, it is a guess, and a ledger full of
 * guesses is worse than an empty one. It is also what makes a
 * model-proposed refinement auditable — the reviewer of a patch can ask
 * "on what basis" and get an answer from the record itself.
 *
 * `embedding` + `embeddedBy` are optional and travel together: a memory
 * that carries them can be recalled by meaning through the embedder
 * seam; one that does not is recalled by tag and recency exactly as
 * before, and ranked recall reports it as skipped rather than scoring it.
 */
export const MEMORY_SCHEMA = {
  $id: 'https://jarenjs.github.io/schemas/ai/ledger-memory.json',
  type: 'object',
  properties: {
    id: ID,
    text: { type: 'string', minLength: 1 },
    evidence: { type: 'string', minLength: 1 },
    tags: { type: 'array', items: { type: 'string', minLength: 1 } },
    at: AT,
    // OPTIONAL, as a pair: the vector `recall({ near })` ranks by, and
    // the identity that makes it comparable
    embedding: EMBEDDING,
    embeddedBy: EMBEDDED_BY,
  },
  required: ['id', 'text', 'evidence', 'tags', 'at'],
  dependencies: EMBEDDING_PAIR,
  additionalProperties: false,
};

/**
 * A reusable recipe: when it applies, what to do, and which tools it
 * needs. Retrieved like a memory and composed into a system prompt by
 * whatever drives the agent — the ledger stores it and nothing more.
 */
export const SKILL_SCHEMA = {
  $id: 'https://jarenjs.github.io/schemas/ai/ledger-skill.json',
  type: 'object',
  properties: {
    id: ID,
    name: { type: 'string', minLength: 1 },
    when: { type: 'string', minLength: 1 },
    instructions: { type: 'string', minLength: 1 },
    tools: { type: 'array', items: { type: 'string', minLength: 1 } },
    at: AT,
    // the same optional pair as a memory; the text a skill is embedded
    // from is its name, when and instructions together
    embedding: EMBEDDING,
    embeddedBy: EMBEDDED_BY,
  },
  required: ['id', 'name', 'when', 'instructions', 'tools', 'at'],
  dependencies: EMBEDDING_PAIR,
  additionalProperties: false,
};

/**
 * An addressable blob's METADATA. The content lives under a separate
 * storage key and never travels with the metadata — that separation is
 * the whole point: a root request may carry `{ name, kind, size, excerpt }`
 * for a hundred slots without carrying one slot's content.
 */
export const SLOT_SCHEMA = {
  $id: 'https://jarenjs.github.io/schemas/ai/ledger-slot.json',
  type: 'object',
  properties: {
    name: ID,
    kind: { type: 'string', minLength: 1 },
    size: { type: 'integer', minimum: 0 },
    excerpt: { type: 'string' },
    at: AT,
    // OPTIONAL, and optional on purpose: `size` is what a slot costs and
    // is always known, while `count` is what it CONTAINS — lines,
    // records, pieces — which only the writer knows and only sometimes.
    // A root view listing a hundred slots is far more useful with "1 240
    // lines" beside a size, and a slot whose writer could not say is
    // better off saying nothing than guessing.
    count: { type: 'integer', minimum: 0 },
  },
  required: ['name', 'kind', 'size', 'excerpt', 'at'],
  additionalProperties: false,
};

/** Every ledger schema by kind — what `createLedger` compiles at construction. */
export const LEDGER_SCHEMAS = {
  goal: GOAL_SCHEMA,
  memory: MEMORY_SCHEMA,
  skill: SKILL_SCHEMA,
  slot: SLOT_SCHEMA,
};

/*
 * The record shapes, as named types beside the schemas that enforce them.
 *
 * These exist because a strictly-typed consumer (the first one was the
 * tangleai rebuild, 2026-08-24) otherwise hand-writes its own copy of
 * "what addMemory returns" and the copy drifts. The schema stays the
 * runtime contract; the typedef is the same statement made to the
 * compiler, and the two live in one file so a change to one is a diff
 * touching the other's neighbourhood.
 */

/**
 * One evidenced progress entry on the active goal.
 * @typedef {object} LedgerProgressEntry
 * @property {string} at RFC 3339
 * @property {string} note
 * @property {string} evidence
 */

/**
 * The active (or archived) objective — see {@link GOAL_SCHEMA}.
 * @typedef {object} LedgerGoal
 * @property {string} objective
 * @property {string} createdAt RFC 3339
 * @property {'active'|'done'|'abandoned'|'superseded'} status
 * @property {LedgerProgressEntry[]} progress
 */

/**
 * A vector's identity — see {@link EMBEDDED_BY}. What `recall({ near })`
 * compares against the query embedder's `{ model, dims }` before any
 * arithmetic happens.
 * @typedef {object} LedgerEmbeddedBy
 * @property {string} model
 * @property {number} dims
 */

/**
 * A stored memory — see {@link MEMORY_SCHEMA}.
 * @typedef {object} LedgerMemory
 * @property {string} id
 * @property {string} text
 * @property {string} evidence
 * @property {string[]} tags
 * @property {string} at RFC 3339
 * @property {number[]} [embedding] the vector `recall({ near })` ranks by — plain numbers, never a typed array
 * @property {LedgerEmbeddedBy} [embeddedBy] the vector's identity; present exactly when `embedding` is
 */

/**
 * A stored skill — see {@link SKILL_SCHEMA}.
 * @typedef {object} LedgerSkill
 * @property {string} id
 * @property {string} name
 * @property {string} when
 * @property {string} instructions
 * @property {string[]} tools
 * @property {string} at RFC 3339
 * @property {number[]} [embedding] the vector `recallSkills({ near })` ranks by
 * @property {LedgerEmbeddedBy} [embeddedBy] the vector's identity; present exactly when `embedding` is
 */

/**
 * A slot's metadata — see {@link SLOT_SCHEMA}. Never the content.
 * @typedef {object} LedgerSlot
 * @property {string} name
 * @property {string} kind
 * @property {number} size
 * @property {string} excerpt
 * @property {string} at RFC 3339
 * @property {number} [count]
 */

/**
 * The one rejection shape every schema-guarded write answers with —
 * produced by `invalidInput` in `check.js`, named here because this is
 * where a consumer of the ledger's API goes looking for "what comes
 * back when a write is refused".
 * @typedef {object} LedgerRejection
 * @property {string} error
 * @property {any[]} errors
 * @property {any} inputSchema
 */
