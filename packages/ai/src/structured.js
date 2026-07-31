//@ts-check
/**
 * Structured output: schema in, validated JSON value out — on every
 * provider tier.
 *
 * The helper sends one (non-streaming) chat request constrained by a
 * JSON Schema, using the strongest mechanism the provider speaks
 * (`response_format: json_schema` → JSON mode → schema embedded in a
 * system instruction), parses the reply, and validates it locally with
 * `@jarenjs/validate` — the same validator that guards the toolbox.
 * Local validation is never optional: provider structured-output
 * implementations enforce varying schema subsets, so the server is an
 * accelerator, not an authority. On failure the instancePath'd errors
 * go back to the model for a bounded number of repair rounds.
 */

import { JarenValidator } from '@jarenjs/validate';
import { checkOutcome } from './check.js';
import { PROVIDERS } from './providers.js';

/** Validation errors reported per failed generation: enough to repair. */
const MAX_ERRORS = 8;

/**
 * Normalize an injected check's errors into the compact records a
 * repair prompt carries. The default `JarenValidator` check reports
 * `{ instancePath, keyword, message }`; a compiler check (a Jaren
 * engine caught into an outcome) reports `{ code, docPath, message }`.
 * Both are the same idea — a location and a reason — so a compile error
 * keeps its `code` and its `docPath` here rather than being flattened
 * into a location-less message. `docPath` (the engine's pointer into
 * the offending document) wins over `instancePath` when both appear.
 * @param {any[]} raw
 */
function normalizeErrors(raw) {
  return raw.slice(0, MAX_ERRORS).map((e) => {
    /** @type {any} */
    const out = {
      instancePath: e.docPath ?? e.instancePath ?? '',
      keyword: e.code ?? e.keyword ?? '',
      message: e.message ?? 'invalid',
    };
    if (e.code !== undefined) out.code = e.code;
    if (e.docPath !== undefined) out.docPath = e.docPath;
    return out;
  });
}

/**
 * The system instruction for providers that cannot (fully) constrain
 * decoding: the schema travels in the prompt and the reply must be the
 * bare JSON value.
 * @param {any} schema
 */
function schemaInstruction(schema) {
  return [
    'Reply with a single JSON value that validates against this JSON Schema.',
    'Output ONLY the JSON — no prose, no code fences.',
    '',
    JSON.stringify(schema),
  ].join('\n');
}

/**
 * Strip an accidental markdown fence from a reply ("```json … ```") —
 * the classic prompt-embedded-schema failure mode.
 * @param {string} text
 */
function unfence(text) {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match === null ? trimmed : match[1];
}

/**
 * Create a structured-output generator over a chat client.
 *
 * @param {{ client: { endpoint: { provider: string }, complete: (request: any) => Promise<any> },
 *   schema: any,
 *   name?: string,
 *   strict?: boolean,
 *   validator?: (value: any) => any,
 *   maxRepairs?: number }} options
 *   - `validator` overrides the internally compiled check (any
 *     function returning a boolean or `{ valid, errors }`).
 *   - `maxRepairs` is how many failed rounds may go back to the model
 *     with the validation errors (default 1).
 * @returns {{ generate: (messages: any[], hooks?: { signal?: AbortSignal }) => Promise<
 *   { value: any, raw: string, attempts: number } |
 *   { errors: any[], raw: string, attempts: number }> }}
 */
export function createStructuredOutput(options) {
  const { client, schema } = options;
  if (schema === null || typeof schema !== 'object')
    throw new TypeError('createStructuredOutput needs a JSON Schema object');
  const name = options.name ?? 'result';
  const maxRepairs = options.maxRepairs ?? 1;
  const check = options.validator
    ?? new JarenValidator({ skipErrors: false, collectErrors: true }).compile(schema);
  const tier = PROVIDERS[client.endpoint.provider]?.structured ?? null;

  /**
   * @param {any[]} messages - wire-shape conversation to answer
   * @param {{ signal?: AbortSignal }} [hooks]
   */
  async function generate(messages, hooks = {}) {
    /** @type {any} */
    const request = { stream: false, signal: hooks.signal };
    let turn = [...messages];
    if (tier === 'json_schema') {
      request.responseFormat = { name, schema, strict: options.strict ?? true };
    }
    else {
      // JSON mode (or nothing): the schema travels in the prompt;
      // local validation makes the weaker tiers safe
      if (tier === 'json') request.responseFormat = { type: 'json' };
      turn = [{ role: 'system', content: schemaInstruction(schema) }, ...turn];
    }

    let raw = '';
    /** @type {any[]} */
    let errors = [];
    for (let attempt = 1; attempt <= 1 + maxRepairs; attempt++) {
      const result = await client.complete({ ...request, messages: turn });
      raw = result.message.content;
      /** @type {any} */
      let value;
      try {
        value = JSON.parse(unfence(raw));
      }
      catch (err) {
        errors = [{ instancePath: '', keyword: 'parse', message: `the reply is not JSON: ${/** @type {Error} */ (err).message}` }];
        turn = [...turn,
          { role: 'assistant', content: raw },
          { role: 'user', content: 'That reply was not parseable JSON. Reply again with ONLY the JSON value.' }];
        continue;
      }
      const outcome = checkOutcome(check(value));
      if (outcome.valid) return { value, raw, attempts: attempt };
      errors = normalizeErrors(outcome.errors);
      turn = [...turn,
        { role: 'assistant', content: raw },
        { role: 'user', content: `That JSON does not validate against the schema. Fix exactly these and reply with ONLY the corrected JSON value:\n${JSON.stringify(errors)}` }];
    }
    return { errors, raw, attempts: 1 + maxRepairs };
  }

  return { generate };
}
