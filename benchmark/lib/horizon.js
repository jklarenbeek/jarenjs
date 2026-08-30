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

import {
  createAgent, createToolbox, slotAddressesIn, createEnvironment, createProgramRunner,
} from '@jarenjs/ai';
import { compileJsonQuery } from '@jarenjs/json/query';
import { mulberry32 } from '@jarenjs/core/random';

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
  return retentionIn(transcriptText(messages), corpus);
}

/** The text a message array actually carries, as a model would read it. */
export function transcriptText(messages) {
  return messages.map((m) => String(m.content ?? '')).join('\n');
}

/**
 * The same count over any text, so the verbatim tier and the recoverable
 * tier are scored by one rule and a difference between them can only
 * come from what was reachable.
 * @param {string} text
 * @param {{ n: number, ids: string[], values: number[] }} corpus
 */
export function retentionIn(text, corpus) {
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
 * One archived slot as a reader of it sees it. A round slot holds the
 * exact wire messages, serialized — so its facts are one JSON level
 * deeper than the transcript's and a probe reading the raw string would
 * miss them for the same escaping reason the header warns about. The
 * index slot is plain text and passes straight through.
 * @param {any} content
 * @returns {string}
 */
function slotText(content) {
  try {
    const parsed = JSON.parse(String(content));
    if (Array.isArray(parsed)) return transcriptText(parsed);
  }
  catch {
    // the index listing is not JSON, and that is not an error
  }
  return String(content);
}

/**
 * Everything a request can still REACH: its own text, plus the content
 * of every slot address it names — transitively, because the synopsis
 * header names an index whose listing names the rounds. This is the
 * model-free reading of D4's promise: a fact that left the request is
 * only "moved" if something in the request still leads to it.
 *
 * One implementation, used by the benchmark's ledger tier and by the
 * package's own recoverability sweep, so the number published and the
 * number asserted cannot drift apart.
 * @param {any[]} messages - the request the client received
 * @param {{ readSlot: (name: string) => Promise<any> }} ledger
 * @returns {Promise<{ text: string, slots: string[] }>}
 */
export async function reachable(messages, ledger) {
  const parts = [transcriptText(messages)];
  /** @type {Set<string>} */
  const seen = new Set();
  const queue = slotAddressesIn(parts[0]);
  while (queue.length > 0) {
    const name = /** @type {string} */ (queue.shift());
    if (seen.has(name)) continue;
    seen.add(name);
    const content = await ledger.readSlot(name);
    if (content === undefined || content === null) continue;
    const text = slotText(content);
    parts.push(text);
    for (const next of slotAddressesIn(text)) if (!seen.has(next)) queue.push(next);
  }
  return { text: parts.join('\n'), slots: [...seen] };
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
  return pairSurvivedIn(messages.map((m) => String(m.content ?? '')).join('\n'), corpus);
}

/**
 * The same question asked of any text — a request, or the results a
 * program's map wrote into slots.
 *
 * One implementation, two callers, for the reason `retention`/
 * `retentionIn` are split the same way: the compaction tiers ask it of a
 * request and the program tier asks it of a reduce's input, and a second
 * copy would let "did the pair survive" mean two things in one table.
 * @param {string} text
 * @param {{ values: number[], pair: { a: number, b: number } }} corpus
 * @returns {boolean}
 */
export function pairSurvivedIn(text, corpus) {
  return text.includes(`"value":${corpus.values[corpus.pair.a]}`)
    && text.includes(`"value":${corpus.values[corpus.pair.b]}`);
}

/**
 * Drive the real `createAgent` through `rounds` tool calls at the given
 * history budget and report what reached the client.
 *
 * With a `ledger`, the same run is measured twice: what the request
 * carries VERBATIM (the same columns as the ledger-free tier, so the two
 * are comparable line for line) and what it can still REACH through the
 * addresses it names. Those are different quantities and both are
 * reported — a recoverable fact costs the model one `recall` call, which
 * a verbatim one does not.
 * @param {{ corpus: any, padding?: number, budget?: number,
 *   shape?: 'front'|'late', ledger?: any }} options
 *   - `budget` undefined runs the agent with no `historyBudget` at all
 *   (the uncapped control).
 * @returns {Promise<{ idPresent: number, valuePresent: number,
 *   messages: any[], messageCount: number, sent: number, full: number,
 *   compacted: boolean, pairSurvived: boolean,
 *   idRecoverable: number, valueRecoverable: number, slots: string[] }>}
 */
export async function probe({
  corpus, padding = DEFAULTS.padding, budget, shape = 'front', ledger,
}) {
  const client = recordingClient(corpus.n);
  const agent = createAgent({
    client,
    toolbox: recordToolbox(corpus, padding, shape),
    system: 'You gather records.',
    maxToolRounds: corpus.n + 1,
    historyBudget: budget,
    ledger,
  });
  const result = await agent.send([{ role: 'user', content: 'Gather every record, then answer.' }]);
  const last = client.requests[client.requests.length - 1];
  const verbatim = retention(last, corpus);
  const reached = ledger === undefined
    ? { text: null, slots: [] }
    : await reachable(last, ledger);
  const recoverable = reached.text === null ? verbatim : retentionIn(reached.text, corpus);
  return {
    ...verbatim,
    idRecoverable: recoverable.idPresent,
    valueRecoverable: recoverable.valuePresent,
    slots: reached.slots,
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

//#region the program tier

/**
 * The same corpus as a document, one record per line.
 *
 * Byte-for-byte the same records the tool returns, in the same payload
 * shape, so the program tier and the compaction tiers are measured over
 * one corpus and a difference between them is a difference in MECHANISM
 * — not in what each was given to work with.
 * @param {{ ids: string[], values: number[], n: number }} corpus
 * @param {number} [padding]
 * @param {'front'|'late'} [shape]
 * @returns {string}
 */
export function corpusText(corpus, padding = DEFAULTS.padding, shape = 'front') {
  const notes = 'x'.repeat(padding);
  const rows = [];
  for (let i = 0; i < corpus.n; i++) {
    rows.push(JSON.stringify(shape === 'front'
      ? { id: corpus.ids[i], value: corpus.values[i], notes }
      : { id: corpus.ids[i], notes, value: corpus.values[i] }));
  }
  return rows.join('\n');
}

/**
 * The closest pair, as a jaren-query document.
 *
 * This is the campaign's §4 decision made concrete, and it is worth
 * reading once. The quadratic question — a minimum over every pair —
 * is answered here by a PURE, SYNCHRONOUS, COMPILED query: a `$fold`
 * accumulator walking `$orderby`-sorted tuples, carrying the previous
 * record and the best gap so far. No operator in it calls a model, and
 * none of them could: the evaluator is synchronous by construction and
 * `@jarenjs/core`'s operators are pure functions. The model's work
 * happens in `map`, one piece at a time, and the relation over all of
 * them is arithmetic the engine already does.
 *
 * Sorting first is what turns O(n²) pairs into n−1 adjacent gaps — the
 * closest pair in a set of numbers is always adjacent once sorted — so
 * the reduce is linear in the number of records and the query stays
 * small enough for a weak model to have written it.
 */
export const CLOSEST_PAIR_QUERY = (() => {
  const gap = { $sub: ['$r.value', '$acc.prev.value'] };
  return {
    $let: {
      walk: {
        $fold: { acc: { prev: null, best: null } },
        $for: { r: '$[*].value' },
        $orderby: '$r.value',
        $return: {
          prev: '$r',
          best: {
            $if: [
              { '$is-null': '$acc.prev' },
              '$acc.best',
              {
                $if: [
                  { $or: [{ '$is-null': '$acc.best' }, { $lt: [gap, '$acc.best.gap'] }] },
                  { gap, a: '$acc.prev.id', b: '$r.id' },
                  '$acc.best',
                ],
              },
            ],
          },
        },
      },
    },
    // the accumulator carries a cursor as well as the answer; the answer
    // alone is what the slot holds, or the reply would name three ids
    $return: '$walk.best',
  };
})();

/**
 * The value the map found, in the SAME envelope a sub-call returns.
 *
 * The envelope is the point, and it is the one thing a program has to
 * get right to survive its own recursion. A map's element is
 * `{ slot, value }` whether that value came from a leaf model call or
 * from a whole child agent — but what is INSIDE it is whatever answered.
 * A reduce that emits a bare list works at depth 0 and returns nothing
 * at depth 1, because the child's answer is then a list where the leaf's
 * was `{ value: N }`.
 *
 * Emitting `{ value: … }` makes the reduce's output identical in shape
 * to its input's elements, so the same program composes at every depth.
 * This is the paper's "distinguishing between final answer and thought
 * is brittle" failure in its concrete form — and it is a property of the
 * PROGRAM, fixable in the program, rather than something the harness can
 * paper over.
 */
export const EXTRACTED_VALUES_QUERY = {
  value: { $max: { $for: { r: '$[*].value' }, $return: '$r.value' } },
};

/**
 * The pairwise program: visit every piece, then compute over what came
 * back. This is the plan a model is asked to author in the live tier,
 * and the plan the model-free tier runs to establish the ceiling.
 * @param {{ size?: number }} [options]
 */
export function pairwiseProgram(options = {}) {
  return {
    steps: [
      { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: options.size ?? 200 },
      {
        op: 'map',
        from: 'pieces',
        as: 'found',
        prompt: 'Return this record as {"id":…,"value":…} with the value as a number.',
      },
      { op: 'reduce', from: 'found', as: 'closest', query: CLOSEST_PAIR_QUERY },
      { op: 'answer', from: 'closest' },
    ],
  };
}

/**
 * The needle program: grep narrows to the one piece that mentions the
 * record, and exactly one sub-call reads it.
 *
 * The contrast with the pairwise program is the point. The same
 * environment answers a linear question for one model call and a
 * quadratic one for forty, because the program says which — where a
 * compacted transcript pays the same (lossy) price for both.
 * @param {{ ids: string[] }} corpus
 * @param {number} index
 * @param {{ size?: number }} [options]
 */
export function needleProgram(corpus, index, options = {}) {
  return {
    steps: [
      { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: options.size ?? 200 },
      { op: 'grep', from: 'pieces', as: 'hits', pattern: corpus.ids[index] },
      {
        op: 'map',
        from: 'hits',
        as: 'found',
        prompt: `Return the record ${corpus.ids[index]} as {"id":…,"value":…} with the value as a number.`,
      },
      { op: 'reduce', from: 'found', as: 'value', query: EXTRACTED_VALUES_QUERY },
      { op: 'answer', from: 'value' },
    ],
  };
}

/**
 * A model-free sub-call: it reads the piece it is given and returns the
 * record in it, deterministically.
 *
 * This is what makes the program tier's ceiling a CEILING — it measures
 * whether the mechanism puts the answer within reach, with the model's
 * competence held constant at perfect. The live tier then swaps this for
 * a real model and the gap between the two numbers is the model's, which
 * is the only way to attribute a miss to the harness or to the tier.
 * @param {{ delayMs?: number }} [options]
 */
export function extractingClient(options = {}) {
  const delayMs = options.delayMs ?? 0;
  const state = { calls: 0, peak: 0, inFlight: 0 };
  return {
    state,
    complete: async ({ messages, signal }) => {
      state.calls += 1;
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      state.inFlight -= 1;
      if (signal?.aborted === true) throw new Error('aborted');
      const piece = String(messages[messages.length - 1]?.content ?? '');
      const hit = /"id":"(REC\d+)"[^\n]*?"value":(\d+)/.exec(piece);
      return {
        message: {
          role: 'assistant',
          content: hit === null ? 'null' : JSON.stringify({ id: hit[1], value: Number(hit[2]) }),
        },
        finishReason: 'stop',
      };
    },
  };
}

/**
 * Run one program over the corpus held as an environment, and report
 * both what the RUN reached and what the ROOT carried.
 *
 * Those two numbers are the whole tier. The first says whether the
 * answer was determined at all (the ceiling, on the same scale
 * `ceilingFor` uses for every other row); the second says what it cost
 * the context — the program document, the step report and the answer,
 * which is everything a root turn would carry and is independent of the
 * corpus by construction.
 * @param {{ corpus: any, padding?: number, shape?: 'front'|'late',
 *   program: any, client?: any, sequential?: boolean,
 *   maxConcurrentSubcalls?: number, signal?: AbortSignal }} options
 */
export async function programProbe({
  corpus, padding = DEFAULTS.padding, shape = 'front', program,
  client, sequential = false, maxConcurrentSubcalls, signal,
}) {
  const environment = createEnvironment();
  await environment.put('corpus', corpusText(corpus, padding, shape),
    { kind: 'text', count: corpus.n });

  const runner = createProgramRunner({
    environment,
    client: client ?? extractingClient(),
    compileQuery: compileJsonQuery,
    maxSubcalls: corpus.n + 4,
    maxConcurrentSubcalls,
    sequential,
  });

  const started = Date.now();
  const result = await runner.run(program, { signal });
  const ms = Date.now() - started;

  // what the computation had in front of it: the map's results, read
  // from the slots they were written to — never from the request
  const slots = await environment.ledger.listSlots();
  // `program/<binding>/<index>` is a map's per-piece result; a single
  // `program/<binding>` is a step's own result and is not an input
  const mapped = slots.filter((s) => /^program\/[^/]+\/\d+$/.test(s.name));
  let reduceInput = '';
  for (const slot of mapped) reduceInput += String(await environment.ledger.readSlot(slot.name) ?? '');
  const reached = retentionIn(reduceInput, corpus);

  return {
    ...result,
    ms,
    valuesReached: reached.valuePresent,
    idsReached: reached.idPresent,
    // whether the closest pair itself reached the computation. This is
    // what makes a correct answer over an INCOMPLETE map legible: a run
    // that lost two sub-calls has not determined the relation, and if it
    // named the right pair anyway it is because the pair was not among
    // what it lost. Same column, same meaning, as the compaction rows.
    pairReached: pairSurvivedIn(reduceInput, corpus),
    // the root's whole share of this run: what it sent and what came
    // back. `answer.text` is included because it is the one payload the
    // root does receive, and hiding it would flatter the number.
    rootChars: JSON.stringify(program).length
      + JSON.stringify(result.steps ?? []).length
      + (result.answer?.text?.length ?? 0),
    answerText: result.answer?.text ?? '',
    corpusChars: (await environment.ledger.getSlot('corpus')).size,
    environment,
  };
}

//#endregion

//#region the recursion tier

/**
 * Run one question at one depth, model-free, and report what the tree
 * cost.
 *
 * The sub-calls are deterministic (`extractingClient`), so the cost is
 * the HARNESS's — how many calls a depth actually makes — rather than a
 * measurement of a provider's mood. That is the quantity the depth
 * default is chosen against.
 * @param {{ corpus: any, padding?: number, shape?: 'front'|'late',
 *   depth: number, question: string, program: any, factories: any,
 *   maxSubcalls?: number }} options
 */
export async function recursionProbe({
  corpus, padding = DEFAULTS.padding, shape = 'front', depth, question, program,
  factories, maxSubcalls = 500,
}) {
  const state = { calls: 0, tokens: 0 };
  const client = {
    endpoint: { provider: 'openrouter' },
    complete: async (request) => {
      state.calls += 1;
      state.tokens += 50;
      if (request.responseFormat !== undefined) {
        return { message: { content: JSON.stringify(program) }, usage: { total_tokens: 50 } };
      }
      const last = String(request.messages[request.messages.length - 1].content);
      const hit = /"id":"(REC\d+)"[^\n]*?"value":(\d+)/.exec(last);
      return {
        message: {
          content: hit === null ? 'null' : JSON.stringify({ id: hit[1], value: Number(hit[2]) }),
        },
        usage: { total_tokens: 50 },
      };
    },
  };

  const ledger = factories.createLedger();
  const environment = factories.createEnvironment({ ledger, compileQuery: factories.compileQuery });
  await environment.put('corpus', corpusText(corpus, padding, shape), { kind: 'text', count: corpus.n });

  const agent = factories.createLongHorizonAgent({
    client,
    environment,
    compileQuery: factories.compileQuery,
    createStructuredOutput: factories.createStructuredOutput,
    createProgramAuthor: factories.createProgramAuthor,
    createProgramRunner: factories.createProgramRunner,
    createEnvironment: factories.createEnvironment,
    depth,
    maxSubcalls,
  });

  const started = Date.now();
  const result = await agent.run(question);
  return {
    depth,
    ok: result.ok,
    calls: state.calls,
    tokens: state.tokens,
    ms: Date.now() - started,
    answer: result.answer?.text ?? '',
    trajectory: result.trajectory.length,
    depths: result.summary.depths,
    stopReason: result.stopReason,
  };
}

//#endregion
//#endregion
