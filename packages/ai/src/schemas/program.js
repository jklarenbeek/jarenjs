//@ts-check
/**
 * The action language: what a model may say about the environment.
 *
 * The RLM paper's root model writes Python and an interpreter runs it.
 * This package has no interpreter and will never have one — `eval` and
 * `new Function` are forbidden by the house rules and a browser tab is
 * the wrong place for a sandbox — so the model authors a **document**
 * instead, and the document is put through the same two gates every
 * generated Jaren program goes through: a schema that constrains
 * decoding (the shape) and a compiler that runs before anything else
 * does (the semantics).
 *
 * Read the two rules that shaped every line of this file:
 *
 *  - **A step names slots; it never carries content** (D2). Every member
 *    below is an operation name, a binding name, a slot reference, a
 *    bounded instruction or a query document. There is no member a
 *    corpus can be poured into, and none can be added later without
 *    failing `test/ai/program.test.js` — the schema is walked and every
 *    string member must declare a `maxLength`. That is what makes "the
 *    program is constant-size whatever the corpus" a property of the
 *    grammar rather than a promise about how it will be used.
 *  - **`map` is the only step that calls a model.** One construct, one
 *    concurrency bound, one place to count spend. A grammar with
 *    sub-calls sprinkled through it cannot be bounded, and a runner over
 *    such a grammar cannot state what a program will cost before it runs
 *    it.
 *
 * Three shape decisions exist for the weak tier specifically (D8), and
 * each one trades expressiveness for a decision the model does not have
 * to make:
 *
 *  - **Every step reads `from` and writes `as`.** Not `slot`/`in`/`over`
 *    per operation: one input member and one output member across the
 *    whole language, so the model picks the *operation* and never the
 *    spelling of its argument.
 *  - **Bindings are program-local names, not addresses.** The program
 *    says `as: "pieces"`; the runner resolves that to whatever the
 *    environment's derived addressing produced (HORIZON_06 owns
 *    addresses; a model that could write one could name a slot that
 *    cannot exist).
 *  - **`query` is left open unless a grammar is injected.** The seam is
 *    D3: with `@jarenjs/json`'s query grammar passed as a `ref` the
 *    shape is constrained too; without it the schema accepts any JSON
 *    value here and the compile gate is what refuses a bad one. A schema
 *    that hard-`$ref`'d a grammar this package may not import would make
 *    the whole language unusable with the seam empty.
 */

/** Steps one program may have. A plan longer than this is a program
 * that should have been two runs; it is also past the length a small
 * model keeps coherent. */
export const MAX_STEPS = 12;

/** The whole document's character cap, enforced by the compiler. This
 * is the constant in "constant-size root request": the program is one
 * more thing the root carries, and it must not grow with the corpus. */
export const MAX_PROGRAM_CHARS = 4000;

/** A binding name: short, lowercase, unmistakable in an error message. */
export const NAME_PATTERN = '^[a-z][a-z0-9_]{0,31}$';

/** How long a slot reference may be — an address, never a payload. */
const SLOT_REF_MAX = 200;

/** How long a sub-call instruction may be. An instruction, not content:
 * the content is the slot the sub-call is run over. */
const PROMPT_MAX = 1000;

/** How long a grep pattern may be. */
const PATTERN_MAX = 200;

/** The operations a program may name, in the order a plan uses them. */
export const PROGRAM_OPS = ['chunk', 'grep', 'select', 'stat', 'peek', 'map', 'reduce', 'answer'];

/** The one input member. See the file header for why it is not per-op. */
const FROM = {
  type: 'string',
  minLength: 1,
  maxLength: SLOT_REF_MAX,
  description: 'What this step reads: a name from an earlier step\'s "as", or a slot from the digest.',
};

/** The one output member: the name later steps use to read this one.
 * `maxLength` as well as the pattern, which already bounds it: the D2
 * walk in `test/ai/program.test.js` checks that every string member
 * declares a cap, and a check that has to interpret a regex to decide
 * whether one is bounded is a weaker check than one that reads a
 * number. */
const AS = {
  type: 'string',
  pattern: NAME_PATTERN,
  maxLength: 32,
  description: 'A short name for this step\'s result, used as "from" by a later step.',
};

/**
 * One step's schema.
 * @param {string} op
 * @param {string} description
 * @param {Record<string, any>} extra - members beyond `from`/`as`
 * @param {string[]} [required] - beyond `from`, `as`
 */
function step(op, description, extra = {}, required = []) {
  return {
    title: op,
    description,
    type: 'object',
    properties: {
      op: { const: op },
      from: FROM,
      as: AS,
      ...extra,
    },
    required: ['op', 'from', 'as', ...required],
    additionalProperties: false,
  };
}

/**
 * The program schema.
 *
 * `queryRef` is the `$id` of an injected query grammar
 * (`@jarenjs/json/schemas/jaren-query.schema.json`, or its LLM-profile
 * twin — the twin is the better choice for constrained decoding, which
 * is what it was derived for). Given one, `select` and `reduce` are
 * shape-constrained as well as compile-gated, and the caller must pass
 * the same grammar to `createStructuredOutput` as a `ref` so the
 * validator can resolve it. Given none, `query` accepts any JSON value
 * and the compile gate carries the whole weight.
 *
 * @param {{ queryRef?: string, maxSteps?: number }} [options]
 * @returns {any} a JSON Schema document
 */
export function programSchema(options = {}) {
  const query = options.queryRef === undefined
    ? { description: 'A jaren-query document.' }
    : { $ref: options.queryRef, description: 'A jaren-query document.' };
  const maxSteps = options.maxSteps ?? MAX_STEPS;

  return {
    $id: 'https://jarenjs.github.io/schemas/ai/program.json',
    title: 'Environment program',
    description: 'A plan over slots in the agent\'s environment. Steps name slots and never'
      + ' carry their content; the last step is always "answer".',
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: maxSteps,
        items: {
          // anyOf, not oneOf: the branches are disjoint by their `op`
          // const, and oneOf is the keyword provider implementations
          // most often refuse (the same reason schemas/patch.js gives).
          anyOf: [
            step('chunk', 'Split a slot into addressable pieces.', {
              strategy: { enum: ['size', 'line', 'separator'], description: 'How to cut. Default size.' },
              size: { type: 'integer', minimum: 200, maximum: 100000, description: 'Piece size in characters.' },
            }),
            step('grep', 'Scan for a pattern and record which slots matched.', {
              pattern: { type: 'string', minLength: 1, maxLength: PATTERN_MAX, description: 'A regular expression.' },
              flags: { enum: ['i', 'm', 'im', ''], description: 'Regex flags. Default i.' },
              limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum matches recorded.' },
            }, ['pattern']),
            step('select', 'Run a query over a JSON slot and store the result.', { query }, ['query']),
            step('stat', 'Counts, sizes and shape of a slot or a family.'),
            step('peek', 'Metadata and a head excerpt of one slot.'),
            step('map', 'Ask the model once per piece. The ONLY step that calls a model.', {
              prompt: {
                type: 'string',
                minLength: 1,
                maxLength: PROMPT_MAX,
                description: 'What to ask about each piece. Ask for a JSON value; the piece is'
                  + ' supplied automatically, so do not paste any content here.',
              },
            }, ['prompt']),
            step('reduce', 'Combine a map\'s results with a query, into one slot.', { query }, ['query']),
            {
              title: 'answer',
              description: 'The last step: the slot the answer is read from.',
              type: 'object',
              properties: {
                op: { const: 'answer' },
                from: FROM,
                chars: { type: 'integer', minimum: 1, maximum: 8000, description: 'How much of it to read.' },
              },
              required: ['op', 'from'],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ['steps'],
    additionalProperties: false,
  };
}

/** The program schema with the query seam empty — what a caller with no
 * grammar injected authors against. */
export const PROGRAM_SCHEMA = programSchema();
