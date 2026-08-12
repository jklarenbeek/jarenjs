//@ts-check
/**
 * The refinement patch: a deliberately small subset of RFC 6902.
 *
 * A model that has finished a run is asked what it learned. The unsafe
 * answer is a rewritten prompt or a restated set of memories — a
 * rewrite is unreviewable, unbounded, and a model asked to restate what
 * it remembers will drift it. The safe answer is a PATCH: small enough
 * to read, addressed enough to audit, and reversible with a snapshot.
 *
 * Three restrictions, and each one exists because the alternative fails
 * on the tier this package targets:
 *
 *  - **`path` is a pattern, not a free string.** It matches exactly the
 *    supplemental subtree — append or replace a memory, append or
 *    replace a skill, append one progress entry — and nothing else. The
 *    base system prompt is not merely undocumented as a target, it is
 *    unaddressable: it is not in the document a refinement is applied
 *    to, and no path that could reach it matches this pattern. That is
 *    D5 asserted rather than described.
 *  - **`op` is three verbs.** `move`, `copy` and `test` are legal RFC
 *    6902 and useless here; every one of them is another shape a small
 *    model can get subtly wrong, and none of them expresses anything
 *    `add`/`replace`/`remove` cannot.
 *  - **The number of operations is capped.** A refinement is meant to be
 *    a few evidence-backed updates. A patch of forty operations is a
 *    rewrite wearing a patch's clothes, and it is also the shape that
 *    makes a repair round useless — the model cannot tell which of forty
 *    operations the error came from.
 *
 * `value` carries no `id` and no `at` on purpose. Identity and time are
 * the ledger's to mint: a model that could choose an id could overwrite
 * a record it never read, and a model that could choose a timestamp
 * could put a memory in front of one that came later — the recency
 * ordering everything downstream depends on is not the model's to set.
 */

/**
 * Where a refinement may write. Anchored, and read as: append or address
 * one memory, append or address one skill, append one progress entry.
 *
 * `-` is RFC 6902's "end of array" and is how an append is written.
 * There is deliberately no way to address INSIDE a record (`/memories/0/text`):
 * a memory is revised by replacing it whole, with fresh evidence, so
 * that every stored record was validated as a whole exactly once.
 */
export const REFINEMENT_PATH_PATTERN =
  '^(/memories/(-|[0-9]+)|/skills/(-|[0-9]+)|/goal/progress/-)$';

/** The default cap on operations per refinement. */
export const DEFAULT_MAX_OPS = 6;

/**
 * A proposed memory. `evidence` is required here AND by the ledger's own
 * schema — the same requirement twice, on purpose: this copy is what
 * constrains decoding (a model generating against it tends to write the
 * evidence rather than be corrected into it), and the ledger's copy is
 * what makes the rule true even for a patch that never went near a
 * model. It is the mechanism that stops a refinement laundering a
 * hallucination into durable state.
 */
export const MEMORY_PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, description: 'The fact worth carrying, in one sentence.' },
    evidence: {
      type: 'string',
      minLength: 1,
      description: 'What in the run establishes it — a tool result, a quoted line, a slot address.'
        + ' Not a justification: a citation.',
    },
    tags: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: ['text', 'evidence'],
  additionalProperties: false,
};

/** A proposed skill: when it applies, what to do, which tools it needs. */
export const SKILL_PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    when: { type: 'string', minLength: 1, description: 'The situation this recipe applies to.' },
    instructions: { type: 'string', minLength: 1, description: 'The steps, concretely.' },
    tools: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: ['name', 'when', 'instructions'],
  additionalProperties: false,
};

/** A proposed progress entry against the active goal. */
export const PROGRESS_PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    note: { type: 'string', minLength: 1, description: 'What was done or established.' },
    evidence: { type: 'string', minLength: 1, description: 'What in the run establishes it.' },
  },
  required: ['note', 'evidence'],
  additionalProperties: false,
};

/**
 * The refinement patch schema, capped at `maxOps` operations.
 *
 * `value` is `anyOf` the three proposal shapes rather than one open
 * object: on a provider that constrains decoding, that is the difference
 * between a model emitting a memory and a model emitting a shape nobody
 * can store. `anyOf` and not `oneOf` — the shapes are disjoint by their
 * required members, and `oneOf` is the keyword provider implementations
 * most often refuse.
 *
 * A `remove` carries no `value`, so `value` is optional. That is also
 * why a generated refinement is asked for with `strict: false`: OpenAI's
 * strict `json_schema` mode requires every declared property to be
 * required, which would force a `value` onto a `remove`. An `add`
 * missing its `value` is caught one stage later by the patch engine,
 * with a pointer — the error class this package's field notes say small
 * models repair well.
 *
 * @param {{ maxOps?: number }} [options]
 * @returns {any} a JSON Schema document
 */
export function refinementPatchSchema(options = {}) {
  const maxOps = options.maxOps ?? DEFAULT_MAX_OPS;
  return {
    $id: 'https://jarenjs.github.io/schemas/ai/refinement-patch.json',
    title: 'Refinement patch',
    description: 'An RFC 6902 JSON Patch over the agent\'s supplemental state.'
      + ' It may only append or replace memories and skills, and append progress entries.',
    // no `minItems`: the EMPTY patch is a legal, and often the correct,
    // answer. A schema that demanded at least one operation would be
    // asking a model that learned nothing to invent something — which is
    // precisely the failure `evidence` exists to prevent, arriving
    // through the front door instead.
    type: 'array',
    maxItems: maxOps,
    items: {
      type: 'object',
      properties: {
        op: { enum: ['add', 'replace', 'remove'] },
        path: {
          type: 'string',
          pattern: REFINEMENT_PATH_PATTERN,
          description: 'One of /memories/-, /memories/{index}, /skills/-, /skills/{index}'
            + ' or /goal/progress/- . Nothing else is addressable.',
        },
        value: {
          anyOf: [MEMORY_PROPOSAL_SCHEMA, SKILL_PROPOSAL_SCHEMA, PROGRESS_PROPOSAL_SCHEMA],
          description: 'The record to store. Omitted for remove.',
        },
      },
      required: ['op', 'path'],
      additionalProperties: false,
    },
  };
}

/** The schema at the default cap — what `createRefiner` uses unasked. */
export const REFINEMENT_PATCH_SCHEMA = refinementPatchSchema();
