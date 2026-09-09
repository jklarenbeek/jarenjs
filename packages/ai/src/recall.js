//@ts-check
/**
 * `recall` — the address scheme compaction writes, and the tool that
 * reads it back.
 *
 * Compaction used to be a one-way door: a dropped tool round left the
 * request as a 60-character excerpt and the rest of it was gone. The
 * excerpt is now a *preview* of something that still exists, and this
 * module owns both halves of that promise — the address a synopsis line
 * carries, and the tool a model calls to follow it. They live together
 * because they are one contract: a name written by `agent.js` and read
 * by a model has to be produced and parsed in exactly one place, or the
 * two drift and a request ends up naming an address nothing answers.
 *
 * Three decisions:
 *
 *  - **The name is content-addressed.** A round's slot name is derived
 *    from the round's own bytes, so compacting the same history twice
 *    writes the same slot instead of a second copy — idempotence falls
 *    out of the naming rather than being bolted on with a counter. The
 *    character length rides beside the 32-bit fingerprint. These can
 *    collide, so compaction compares exact bytes and refuses a conflicting
 *    address before dropping anything from the transcript.
 *  - **Recall is a tool, not a mechanism.** Nothing re-expands a dropped
 *    round automatically. Automatic re-expansion is a guess about which
 *    round matters, and a wrong guess spends the budget it was trying to
 *    save; the model already knows what it is looking for. It also keeps
 *    the machinery inspectable — a recall appears in `steps` like any
 *    other call.
 *  - **It never throws.** An unknown address answers `{ error }` with the
 *    index address to try instead, exactly as every other tool in this
 *    package answers a content-level problem.
 */

import { hashContent } from '@jarenjs/core/string';

/** The tool's name. A host that registers its own `recall` keeps it. */
export const RECALL_TOOL_NAME = 'recall';

/** Address prefixes: one archived round, and the index that lists them. */
const ROUND_PREFIX = 'r-';
const INDEX_PREFIX = 'rx-';

/**
 * The slot name for one archived round. Content-addressed: same bytes,
 * same name, so a re-compaction overwrites rather than duplicates.
 * @param {string} text - the round's serialized wire messages
 * @returns {string}
 */
export function roundSlotName(text) {
  return `${ROUND_PREFIX}${hashContent(text)}-${text.length}`;
}

/**
 * The slot name for the index of one archived set. Content-addressed the
 * same way, over the listing itself — so a request that dropped the same
 * rounds names the same index.
 * @param {string} text - the index listing
 * @returns {string}
 */
export function indexSlotName(text) {
  return `${INDEX_PREFIX}${hashContent(text)}-${text.length}`;
}

/**
 * One address, written the one way it is ever written — the call a model
 * would make to follow it. Everything that names a slot in prose goes
 * through here, so `slotAddressesIn` has a single syntax to read and a
 * reader following an address is never following a second convention.
 * @param {string} name
 * @returns {string}
 */
export function slotRef(name) {
  return `recall("${name}")`;
}

/**
 * The address as it appears in a synopsis line. Short on purpose: it is
 * paid for out of the same character budget the rounds were cut to fit.
 * @param {string} name
 * @param {number} size - the archived round's size in characters
 * @returns {string}
 */
export function slotAddress(name, size) {
  return `[${slotRef(name)} · ${size}B]`;
}

/**
 * Every slot address named in a piece of text, in order, without
 * duplicates. The one reader of the address syntax — a probe, a test or
 * a host auditing what a request can still reach uses this rather than
 * writing the pattern a second time.
 * @param {string} text
 * @returns {string[]}
 */
export function slotAddressesIn(text) {
  /** @type {string[]} */
  const names = [];
  for (const match of String(text ?? '').matchAll(/recall\("([^"\s]+)"\)/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * The `recall` tool definition, bound to a ledger.
 *
 * Registered by `createAgent` when it is given a ledger, and exported so
 * a host can add it to its own toolbox — the same tool either way, since
 * a second implementation is exactly how the address a synopsis promises
 * and the address a tool answers would come to differ.
 *
 * The result is deliberately plain `{ slot, size, content }`: the agent
 * loop truncates every tool result to `maxToolResultChars` on the way
 * into the transcript, so a slot bigger than that is cut there, once, by
 * the same rule as any other oversized result.
 *
 * @param {{ readSlot: (name: string) => Promise<any> }} ledger
 * @param {{ index?: string }} [options] - `index` is the address of the
 *   listing to point at when a name is unknown; it travels in the
 *   rejection because a model that mistyped an address needs the place
 *   the real ones are written down, not just a refusal.
 * @returns {{ name: string, description: string, inputSchema: any,
 *   execute: (input: any) => Promise<any> }}
 */
export function createRecallTool(ledger, options = {}) {
  return {
    name: RECALL_TOOL_NAME,
    description: 'Fetch an archived conversation round in full by its address. Earlier rounds'
      + ' that did not fit the history budget were archived, not deleted: each synopsis line'
      + ' carries its address as recall("name"), and the index address listed in the synopsis'
      + ' header returns every address there is.',
    inputSchema: {
      type: 'object',
      properties: {
        slot: {
          type: 'string',
          minLength: 1,
          description: 'The address from a synopsis line, e.g. the name inside recall("…").',
        },
      },
      required: ['slot'],
      additionalProperties: false,
    },
    execute: async ({ slot }) => {
      const content = await ledger.readSlot(slot);
      if (content?.status === 'evicted') return { error: `slot '${slot}' was evicted`, ...content };
      if (content === undefined || content === null) {
        return {
          error: `unknown slot '${slot}'`,
          ...(options.index === undefined ? {} : { index: options.index }),
          hint: options.index === undefined
            ? 'use an address exactly as it appears inside recall("…") in the synopsis'
            : `${slotRef(options.index)} lists every address that exists`,
        };
      }
      return { slot, size: String(content).length, content };
    },
  };
}
