//@ts-check
//#region long-horizon corpus and ceiling probe
/**
 * The corpus and the model-free ceiling probe behind
 * `benchmark/long-horizon.js`. It lives in its own module because the
 * probe's self-tests (`test/ai/benchmark-probe.test.js`) drive exactly
 * this code: a benchmark whose measuring instrument is untested can
 * publish any number it likes, and this one publishes the number a whole
 * campaign is judged against.
 *
 * What is measured: whether the fact needed to answer is present in the
 * request the chat client receives, after `createAgent`'s `historyBudget`
 * compaction has done its work. That is model-free, deterministic, and an
 * UPPER BOUND on any model's accuracy — a fact absent from the context
 * cannot be answered from it, however good the model.
 *
 * Two probe bugs are avoided by construction, because both were hit while
 * taking the baseline and both read as findings rather than as faults:
 *
 *  - a tool result is a JSON **string** inside its message, so
 *    `JSON.stringify(messages)` double-escapes it and a probe searching
 *    for `"value":123` matches nothing — every row reads 0/N, including
 *    the uncapped control. `retention` reads `m.content` as plain text.
 *  - with the fact behind ~400 characters of padding, a proximity regex
 *    (`ID[^]{0,40}value:N`) also reads 0/N on the uncapped control. Values
 *    are globally unique, so a plain `includes` is sound and has no window
 *    to get wrong.
 *
 * The uncapped control reading N/N in BOTH payload shapes is the probe's
 * own self-test; it is asserted in `test/ai/`, not only here.
 */

import { createAgent, createToolbox } from '@jarenjs/ai';

/** The baseline's parameters. Changing one changes every published row. */
export const DEFAULTS = {
  rounds: 40,
  padding: 400,
  seed: 20260812,
  budgets: [40000, 20000, 10000, 6000, 4000, 2000],
};

/** The two payload shapes, and why both are published. */
export const SHAPES = {
  front: 'fact at the FRONT of the tool result (flattering — it fits the 60-char excerpt)',
  late: 'fact BEHIND the padding (realistic — a long result whose answer is not in the first 60 characters)',
};

/** The two task families, and how each one scales. */
export const TASKS = {
  needle: 'linear — one record\'s value is asked for',
  pairwise: 'quadratic — a relation over EVERY pair is asked for',
};

//#region corpus

/**
 * A small deterministic PRNG (mulberry32). A benchmark whose corpus
 * changes between runs cannot state a delta, so the seed is a parameter
 * and it is published beside the numbers.
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Record ids are fixed-width, so a record's size never depends on its index. */
export const recordId = (i) => `REC${String(i).padStart(4, '0')}`;

/**
 * The pair with the smallest absolute difference, when exactly one pair
 * achieves it. Returns null on a tie — the pairwise question would then
 * have two right answers, and a benchmark cannot score that.
 * @param {number[]} values
 * @returns {{ a: number, b: number, gap: number } | null}
 */
function closestPair(values) {
  const order = values.map((value, index) => ({ value, index }))
    .sort((x, y) => x.value - y.value);
  let best = null;
  let ties = 0;
  for (let i = 1; i < order.length; i++) {
    const gap = order[i].value - order[i - 1].value;
    if (best === null || gap < best.gap) {
      best = { a: order[i - 1].index, b: order[i].index, gap };
      ties = 1;
    }
    else if (gap === best.gap) ties++;
  }
  return best !== null && ties === 1 ? best : null;
}

/**
 * Generate the corpus: N records, each a unique id and a globally unique
 * value.
 *
 * Values are six-digit integers on purpose, and both halves of that
 * matter. **Unique**, so presence is testable with a plain `includes` and
 * no proximity window (the id and its value are separated by the padding
 * in the `late` shape). **Six digits**, so every record serializes to the
 * same number of bytes whatever the seed — the compaction cuts at
 * byte-counted round boundaries, and a corpus whose sizes moved with the
 * seed would make two runs incomparable.
 *
 * @param {{ n?: number, seed?: number }} [options]
 * @returns {{ n: number, seed: number, ids: string[], values: number[],
 *   pair: { a: number, b: number, gap: number } }}
 */
export function makeCorpus({ n = DEFAULTS.rounds, seed = DEFAULTS.seed } = {}) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const random = mulberry32(seed + attempt);
    /** @type {number[]} */
    const values = [];
    const seen = new Set();
    while (values.length < n) {
      const value = 100000 + Math.floor(random() * 900000);
      if (seen.has(value)) continue;
      seen.add(value);
      values.push(value);
    }
    // a tied closest pair means the pairwise question has two right
    // answers; step the seed rather than score an ambiguous task
    const pair = closestPair(values);
    if (pair !== null) {
      const ids = Array.from({ length: n }, (_, i) => recordId(i));
      return { n, seed: seed + attempt, ids, values, pair };
    }
  }
  throw new Error('no corpus with a unique closest pair — widen the value range');
}

/**
 * `count` record indices drawn uniformly without replacement. The needle
 * ceiling is the ceiling for "the value of a UNIFORMLY RANDOM record", so
 * a live tier measuring against it has to sample the same way. `salt`
 * makes each row's draw independent while keeping the whole run
 * reproducible from the seed.
 * @param {{ n: number, seed: number }} corpus
 * @param {number} count
 * @param {number} salt
 * @returns {number[]}
 */
export function needleTargets(corpus, count, salt) {
  const random = mulberry32(corpus.seed + salt * 7919);
  const pool = Array.from({ length: corpus.n }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

//#endregion

//#region the probe

/**
 * A client that answers with one tool call per round and then a final
 * message, recording every request it is handed. The last recorded
 * request is the context the model would have had to answer from.
 * @param {number} rounds
 */
export function recordingClient(rounds) {
  /** @type {any[][]} */
  const requests = [];
  let n = 0;
  return {
    requests,
    complete: async (request) => {
      requests.push(request.messages);
      if (n < rounds) {
        const call = {
          id: `c${n}`,
          name: 'fetch_record',
          arguments: JSON.stringify({ index: n }),
        };
        n++;
        return {
          message: { role: 'assistant', content: '', toolCalls: [call] },
          finishReason: 'tool_calls',
        };
      }
      return {
        message: { role: 'assistant', content: 'done', toolCalls: null },
        finishReason: 'stop',
      };
    },
  };
}

/**
 * The record tool. `shape` decides whether the fact sits at the FRONT of
 * the result or behind the padding: the synopsis excerpts the first 60
 * characters, so this is the difference between a flattering measurement
 * and an honest one, and both are published.
 * @param {{ ids: string[], values: number[] }} corpus
 * @param {number} padding
 * @param {'front'|'late'} shape
 */
export function recordToolbox(corpus, padding, shape) {
  const toolbox = createToolbox();
  const notes = 'x'.repeat(padding);
  toolbox.add({
    name: 'fetch_record',
    description: 'Fetch one record by index.',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
    },
    execute: ({ index }) => (shape === 'front'
      ? { id: corpus.ids[index], value: corpus.values[index], notes }
      : { id: corpus.ids[index], notes, value: corpus.values[index] }),
  });
  return toolbox;
}

/**
 * How many of the N facts survive verbatim in a request? Message
 * contents are read as plain text — a tool result is a JSON string
 * inside its message, and searching the stringified transcript instead
 * would find nothing at all (see the header).
 * @param {any[]} messages
 * @param {{ n: number, ids: string[], values: number[] }} corpus
 * @returns {{ idPresent: number, valuePresent: number }}
 */
export function retention(messages, corpus) {
  const text = messages.map((m) => String(m.content ?? '')).join('\n');
  let idPresent = 0;
  let valuePresent = 0;
  for (let i = 0; i < corpus.n; i++) {
    const hasId = text.includes(corpus.ids[i]);
    if (hasId) idPresent++;
    // the VALUE is what a question needs; an id in a 60-char excerpt
    // without its value answers nothing, and the gap between these two
    // columns IS the defect the campaign exists to close
    if (hasId && text.includes(`"value":${corpus.values[i]}`)) valuePresent++;
  }
  return { idPresent, valuePresent };
}

/**
 * Did the closest pair itself survive into this request? Model-free, and
 * it exists to explain a pairwise `actual` that lands ABOVE its own
 * ceiling: the pairwise ceiling asks whether the context DETERMINES the
 * answer, and a model can still name the right pair from a subset that
 * happens to contain it. That is luck of the corpus, not retrieval, and
 * this flag is what lets a reader tell the two apart.
 * @param {any[]} messages
 * @param {{ values: number[], pair: { a: number, b: number } }} corpus
 * @returns {boolean}
 */
export function pairSurvived(messages, corpus) {
  const text = messages.map((m) => String(m.content ?? '')).join('\n');
  return text.includes(`"value":${corpus.values[corpus.pair.a]}`)
    && text.includes(`"value":${corpus.values[corpus.pair.b]}`);
}

/**
 * Drive the real `createAgent` through `rounds` tool calls at the given
 * history budget and report what reached the client.
 * @param {{ corpus: any, padding?: number, budget?: number,
 *   shape?: 'front'|'late' }} options
 *   - `budget` undefined runs the agent with no `historyBudget` at all
 *   (the uncapped control).
 * @returns {Promise<{ idPresent: number, valuePresent: number,
 *   messages: any[], messageCount: number, sent: number, full: number,
 *   compacted: boolean, pairSurvived: boolean }>}
 */
export async function probe({ corpus, padding = DEFAULTS.padding, budget, shape = 'front' }) {
  const client = recordingClient(corpus.n);
  const agent = createAgent({
    client,
    toolbox: recordToolbox(corpus, padding, shape),
    system: 'You gather records.',
    maxToolRounds: corpus.n + 1,
    historyBudget: budget,
  });
  const result = await agent.send([{ role: 'user', content: 'Gather every record, then answer.' }]);
  const last = client.requests[client.requests.length - 1];
  return {
    ...retention(last, corpus),
    messages: last,
    messageCount: last.length,
    sent: JSON.stringify(last).length,
    full: JSON.stringify(result.messages).length,
    compacted: last.length < result.messages.length,
    pairSurvived: pairSurvived(last, corpus),
  };
}

//#endregion

//#region tasks — questions, ceilings, scoring

/**
 * The ceiling for one task, given what survived. Both are published;
 * reporting only the needle would hide the finding.
 *
 * **needle** is linear: the question asks for one record's value, so the
 * ceiling for a uniformly random target is the fraction of values present.
 * This one IS a hard upper bound on accuracy — a value that is not in the
 * context cannot be read out of it.
 *
 * **pairwise** is quadratic and all-or-nothing: the question is "which
 * two records have the closest values", a minimum over every pair. With
 * any one value missing the answer is not DETERMINED by what is visible —
 * an absent record could be closer to a visible one than the visible best
 * pair is to each other — so the ceiling is 1 only when every value
 * survived. This is the OOLONG-Pairs shape.
 *
 * Read the pairwise ceiling precisely: it is determinacy, not a hard
 * bound on the score. A model can still name the true closest pair from a
 * subset that happens to contain it, so a measured pairwise `actual` may
 * legitimately land ABOVE this ceiling — that is luck of the corpus, and
 * `pairSurvived` reports, model-free, exactly when it was available.
 * @param {'needle'|'pairwise'} task
 * @param {{ valuePresent: number, n: number }} counts
 * @returns {number} 0..1
 */
export function ceilingFor(task, { valuePresent, n }) {
  return task === 'needle'
    ? valuePresent / n
    : (valuePresent === n ? 1 : 0);
}

/**
 * The needle question for one target record.
 * @param {{ ids: string[] }} corpus
 * @param {number} index
 * @returns {string}
 */
export function needleQuestion(corpus, index) {
  return `Using only the records above, what is the value of record ${corpus.ids[index]}?`
    + ' Answer with that one number and nothing else.';
}

/**
 * The pairwise question — a relation over every pair.
 * @returns {string}
 */
export function pairwiseQuestion() {
  return 'Using only the records above, which TWO records have the closest values'
    + ' (the smallest absolute difference between their values)? Consider every pair.'
    + ' Answer with those two record ids and nothing else.';
}

/**
 * Score a needle answer. Correct when the reply names the target value
 * and no OTHER record\'s value: a reply that dumps the whole corpus has
 * not answered the question, and scoring it right would let a model earn
 * the point by refusing to choose.
 * @param {string} text
 * @param {{ values: number[] }} corpus
 * @param {number} index
 * @returns {boolean}
 */
export function scoreNeedle(text, corpus, index) {
  const reply = String(text ?? '');
  let named = 0;
  let hit = false;
  for (let i = 0; i < corpus.values.length; i++) {
    // digit boundaries: 123456 must not match inside 1234567
    if (!new RegExp(`(?<![0-9])${corpus.values[i]}(?![0-9])`).test(reply)) continue;
    named++;
    if (i === index) hit = true;
  }
  return hit && named === 1;
}

/**
 * Score a pairwise answer. Correct when the reply names exactly the two
 * ids of the closest pair — same rule as the needle, for the same reason.
 * @param {string} text
 * @param {{ ids: string[], pair: { a: number, b: number } }} corpus
 * @returns {boolean}
 */
export function scorePairwise(text, corpus) {
  const reply = String(text ?? '');
  const named = corpus.ids.filter((id) => reply.includes(id));
  return named.length === 2
    && named.includes(corpus.ids[corpus.pair.a])
    && named.includes(corpus.ids[corpus.pair.b]);
}

//#endregion
//#endregion
