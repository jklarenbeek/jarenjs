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
  },
  required: ['id', 'text', 'evidence', 'tags', 'at'],
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
  },
  required: ['id', 'name', 'when', 'instructions', 'tools', 'at'],
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
