//@ts-check
/**
 * The action language: compile it, then run it.
 *
 * HORIZON_06 put the corpus outside the context and gave the root a
 * digest instead. That fixed what the model *sees*; this file fixes what
 * it can *do*. The model authors a small program naming slots and
 * operations, the program is compiled before anything runs, and the
 * harness executes it — fanning model sub-calls out over the pieces in
 * parallel and writing every result back to a slot.
 *
 * Why this closes the pairwise question. A relation over every record
 * needs every record, and no summariser and no `recall` can put forty
 * rounds into a budget they were cut to fit. A program does not have to:
 * `map` visits all forty pieces, each sub-call reads one of them, and
 * `reduce` computes over the forty small results. The root never sees
 * any of it — it sees a plan going out and one slot's metadata coming
 * back — so the request stays the same size whether the corpus is ten
 * kilobytes or ten megabytes.
 *
 * Four rules hold without exception:
 *
 *  - **A program that does not compile never runs.** `run` compiles
 *    first and returns the compile errors; no step has executed and no
 *    slot has been written when it does. The errors are coded and
 *    `docPath`'d into the program document, which is the error class
 *    this package's field notes say small models actually repair.
 *  - **`map` is the only step that calls a model** — so `maxSubcalls`
 *    and `maxConcurrentSubcalls` are the whole cost model, and one place
 *    threads the `AbortSignal`.
 *  - **A sub-call failure is a result, not a crash.** It lands as
 *    `{ error }` in its own result slot and the map completes, exactly
 *    as the toolbox never throws for content-level problems. A map whose
 *    sub-calls all failed is a finished map with forty recorded errors.
 *  - **Nothing bulk comes back.** Every step reports metadata; the one
 *    place content returns to the caller is the final `answer` step, and
 *    it is capped.
 *
 * **The decision this file exists to record** (asked once per reader, so
 * it is answered here): why not register an async `$llm` operator into
 * the JSLT registry and let a stylesheet call a model inline? Because
 * `@jarenjs/core`'s operators are pure synchronous functions and the
 * query/JSLT evaluators are synchronous by construction. Making them
 * async to accommodate one caller would change an engine every other
 * package in the suite depends on — a `queryJson` that returned a
 * promise would break `@jarenjs/db`'s pushdown, `@jarenjs/md`'s
 * directives and `@jarenjs/app`'s state derivation, all to save this
 * package a `map` step. So the division is fixed: **the program selects
 * (pure, synchronous, compiled) and the harness awaits (async, bounded,
 * cancellable).** `map` is the seam between the two halves, and it is
 * the only one.
 */

import { CodedError } from '@jarenjs/core/errors';
import { excerpt } from '@jarenjs/core/chunk';
import { JarenValidator } from '@jarenjs/validate';

import { MAX_PROGRAM_CHARS, NAME_PATTERN, PROGRAM_SCHEMA, programSchema } from './schemas/program.js';
import { checkOutcome } from './check.js';
import { unfence } from './structured.js';

/** How much of one piece a sub-call is shown. The sub-call is the only
 * place content reaches a model at all, and it sees ONE piece — a cap
 * here is the difference between a bounded fan-out and the corpus
 * arriving in a different envelope. */
const SUBCALL_CHARS = 8000;

/** Sub-calls one run may make, whatever the corpus. A hard ceiling, not
 * a hint: depth × fan-out is multiplicative and a runaway map is a bill. */
const MAX_SUBCALLS = 64;

/** Sub-calls in flight at once. Four is the paper's limitation fixed —
 * it reports its own sub-calls are sequential and slow — and low enough
 * that a free-tier provider does not answer with 429s. */
const MAX_CONCURRENT = 4;

/** The characters a reduce may assemble from its map's results. The
 * reduction is small BY CONSTRUCTION (that is what a map is for), so
 * this cap is a tripwire on a program that mapped identity over a
 * corpus, not a working limit. */
const MAX_REDUCE_CHARS = 200000;

/** How much of the answer slot the final step returns unasked. */
const ANSWER_CHARS = 2000;

/** How much of a failed reply is kept beside its error. */
const RAW_EXCERPT = 200;

/** The namespace a run's own results live under, kept apart from the
 * corpus so a digest can tell working notes from the thing being worked
 * on — and so a re-run overwrites rather than accumulating. */
const RESULT_PREFIX = 'program/';

const NAME_RE = new RegExp(NAME_PATTERN);

/**
 * A program that will not compile.
 *
 * Thrown, unlike `refine.js`'s AI01xx records, because this is a
 * COMPILER and the suite's compilers throw coded errors with a
 * `docPath` — which is what makes the documented two-line gate adapter
 * (`try { compile(doc) } catch (e) { … }`) work here exactly as it does
 * for a query, a stylesheet or a flow machine. {@link programGate} is
 * that adapter, so a caller never writes it.
 *
 * The codes:
 *
 *   AI0200 — the document is not a program
 *   AI0201 — a step reads a name nothing produced
 *   AI0202 — a name is bound twice
 *   AI0203 — the last step is not `answer`, or there is more than one
 *   AI0204 — a `reduce` reads something that is not a `map`
 *   AI0205 — the program is longer than its cap
 *   AI0206 — a step needs the query seam and none is wired
 *   AI0207 — a step reading ONE slot was given a family of pieces
 *
 * A query that does not compile keeps the QUERY engine's own code
 * (`JQ0002`, …) and its pointer is rebased onto the program document,
 * so the model is told which step and which member — the same posture
 * `refine.js` takes with the patch engine's codes.
 */
export class ProgramError extends CodedError {
  /**
   * @param {string} code - 'AI0200' … 'AI0207'
   * @param {string} reason - the bare reason
   * @param {string} [docPath] - JSON Pointer into the program document
   */
  constructor(code, reason, docPath) {
    super('ProgramError', code, reason, docPath);
  }
}

/**
 * One error in the shape a repair prompt carries. A rebased query error
 * keeps its engine code and gains the step it came from.
 * @param {any} err
 * @returns {{ code: string, docPath: string, message: string }}
 */
function errorRecord(err) {
  return {
    code: err?.code ?? 'AI0200',
    docPath: err?.docPath ?? '',
    message: err?.reason ?? err?.message ?? String(err),
  };
}

//#region the compiler

/**
 * Compile a program document.
 *
 * Two stages, like every compiler in the suite: this one resolves names
 * and compiles the embedded queries once, and the runner executes the
 * result. Nothing here reads a slot's content and nothing here calls a
 * model, so a compile is cheap enough to run on every authored candidate
 * — which is exactly what makes it usable as a decoding gate.
 *
 * @param {any} doc - the program document
 * @param {{ compileQuery?: ((document: any) => (data: any) => any) | null,
 *   known?: Iterable<string> }} [options]
 *   - `compileQuery` is the D3 seam. Absent, a program using `select` or
 *     `reduce` is refused with AI0206 rather than half-compiled.
 *   - `known` is what the environment already holds. Given, a `from`
 *     that is neither a binding nor a known slot is AI0201 — the
 *     "transition to an undeclared state" check, which is the whole
 *     reason a compile gate catches what a schema cannot. Absent, only
 *     bindings are resolved: nothing else can be checked without an
 *     environment, and inventing an error would be worse than saying so.
 * @returns {{ steps: any[], answer: { from: string, chars: number },
 *   bindings: string[], chars: number }}
 * @throws {ProgramError}
 */
export function compileProgram(doc, options = {}) {
  const compileQuery = typeof options.compileQuery === 'function' ? options.compileQuery : null;
  const known = options.known === undefined ? null : new Set(options.known);

  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.steps))
    throw new ProgramError('AI0200', 'a program is an object with a steps array', '');
  if (doc.steps.length === 0)
    throw new ProgramError('AI0200', 'a program needs at least one step', '/steps');

  const text = JSON.stringify(doc);
  if (text.length > MAX_PROGRAM_CHARS) {
    throw new ProgramError('AI0205',
      `the program is ${text.length} characters, over the ${MAX_PROGRAM_CHARS} cap —`
      + ' a plan naming slots is small; one carrying content is not', '');
  }

  /** binding name → the step index that produced it and what kind it is */
  const bound = new Map();
  const steps = [];

  for (let i = 0; i < doc.steps.length; i++) {
    const raw = doc.steps[i];
    const at = `/steps/${i}`;
    const op = raw?.op;
    const from = raw?.from;

    if (typeof from !== 'string' || from === '')
      throw new ProgramError('AI0200', `step ${i} has no "from"`, `${at}/from`);

    // resolve the input: a binding first, then the environment
    const source = bound.get(from);
    if (source === undefined && known !== null && !known.has(from)) {
      // the names a model could plausibly have meant: this program's own
      // bindings, then the slots a digest would have shown it — never the
      // runner's `program/` scratch and never a derived chunk address,
      // both of which are noise in a repair prompt
      const names = [...bound.keys(),
        ...[...known].filter((n) => !n.startsWith(RESULT_PREFIX) && !n.includes('#'))]
        .slice(0, 8);
      throw new ProgramError('AI0201',
        `"${from}" is not a slot and no earlier step produced it`
        + (names.length === 0 ? '' : ` — available: ${names.join(', ')}`),
        `${at}/from`);
    }

    // `chunk` and `map` bind a FAMILY of pieces, and two steps read one
    // slot rather than a family: a select parses a document, an answer
    // reads a text. Catching it here is worth a code of its own —
    // "reduce it first" is a repair a model lands, where the runtime
    // error it would otherwise get ("no slot program/found/") points at
    // an address the model never wrote
    if ((op === 'answer' || op === 'select') && (source?.op === 'chunk' || source?.op === 'map')) {
      throw new ProgramError('AI0207',
        `${op} reads one slot and "${from}" is a ${source.op} — every piece of it. `
        + (source.op === 'map'
          ? 'Combine them with a reduce step and read that.'
          : 'Map over it, then reduce, and read that.'),
        `${at}/from`);
    }

    if (op === 'answer') {
      if (i !== doc.steps.length - 1)
        throw new ProgramError('AI0203', 'answer is the last step of a program', `${at}/op`);
      steps.push({ op, from, index: i });
      continue;
    }

    const as = raw?.as;
    if (typeof as !== 'string' || !NAME_RE.test(as))
      throw new ProgramError('AI0200', `step ${i} has no usable "as"`, `${at}/as`);
    if (bound.has(as))
      throw new ProgramError('AI0202', `"${as}" is already the name of step ${bound.get(as).index}`, `${at}/as`);

    /** @type {any} */
    const step = { op, from, as, index: i };

    if (op === 'reduce' && source?.op !== 'map') {
      throw new ProgramError('AI0204',
        `reduce combines a map's results; "${from}" is ${source === undefined ? 'a slot' : `a ${source.op}`}`,
        `${at}/from`);
    }

    if (op === 'select' || op === 'reduce') {
      if (compileQuery === null) {
        throw new ProgramError('AI0206',
          `${op} needs the compileQuery seam — inject compileJsonQuery from @jarenjs/json/query`,
          `${at}/query`);
      }
      try {
        // compiled once, here, and kept: the house two-stage rule, and
        // it is also what lets the gate reject a bad query before a
        // single slot has been touched
        step.run = compileQuery(raw.query);
      }
      catch (err) {
        const e = /** @type {any} */ (err);
        // the engine's own code and its pointer, rebased onto the step:
        // "which member of which step" is the difference between a
        // repair round that converges and one that flails
        throw new ProgramError(e?.code ?? 'AI0200',
          e?.reason ?? e?.message ?? 'the query does not compile',
          `${at}/query${e?.docPath ?? ''}`);
      }
      step.query = raw.query;
    }

    if (op === 'map') {
      if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '')
        throw new ProgramError('AI0200', 'a map needs a prompt', `${at}/prompt`);
      step.prompt = raw.prompt;
    }

    if (op === 'grep') {
      if (typeof raw.pattern !== 'string' || raw.pattern === '')
        throw new ProgramError('AI0200', 'a grep needs a pattern', `${at}/pattern`);
      step.pattern = raw.pattern;
      step.flags = raw.flags;
      step.limit = raw.limit;
    }

    if (op === 'chunk') {
      step.strategy = raw.strategy;
      step.size = raw.size;
    }

    bound.set(as, step);
    steps.push(step);
  }

  const last = steps[steps.length - 1];
  if (last.op !== 'answer')
    throw new ProgramError('AI0203', 'a program ends with an answer step', `/steps/${last.index}/op`);
  if (steps.filter((s) => s.op === 'answer').length > 1)
    throw new ProgramError('AI0203', 'a program has exactly one answer step', '/steps');

  return {
    steps,
    answer: {
      from: last.from,
      chars: Math.min(doc.steps[last.index].chars ?? ANSWER_CHARS, ANSWER_CHARS * 4),
    },
    bindings: [...bound.keys()],
    chars: text.length,
  };
}

/**
 * The compile gate, ready for `createStructuredOutput({ gate })`.
 *
 * One implementation of "does this program compile", used by the
 * authoring path and by the runner, so a program that authored cleanly
 * cannot fail differently when it runs.
 * @param {{ compileQuery?: any, known?: Iterable<string> }} [options]
 * @returns {(doc: any) => true | { valid: false, errors: any[] }}
 */
export function programGate(options = {}) {
  return (doc) => {
    try {
      compileProgram(doc, options);
      return true;
    }
    catch (err) {
      return { valid: false, errors: [errorRecord(err)] };
    }
  };
}

//#endregion

//#region the runner

/**
 * Run `worker` over `items`, never more than `limit` at once.
 *
 * The whole of §3's "fan-out is parallel" is this function: the paper
 * states its own sub-calls are sequential and that "RLMs without
 * asynchronous LM calls are slow", and doing the fan-out in the harness
 * instead of inside an evaluator is what makes concurrency available at
 * all. `limit` of 1 is the sequential mode the benchmark compares
 * against — one implementation, so the comparison is of scheduling and
 * nothing else.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function pool(items, limit, worker) {
  /** @type {any[]} */
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** The address a step's result is stored under, derived from its binding. */
const resultSlot = (as) => `${RESULT_PREFIX}${as}`;

/** The family a map's per-piece results live under. */
const mapFamily = (as) => `${RESULT_PREFIX}${as}/`;

/**
 * Create a runner over an environment.
 *
 * @param {{ environment: any,
 *   client?: { complete: (request: any) => Promise<any> },
 *   compileQuery?: any,
 *   model?: string,
 *   maxSubcalls?: number, maxConcurrentSubcalls?: number,
 *   subcallChars?: number, maxReduceChars?: number,
 *   sequential?: boolean }} options
 *   - `client` is only needed by `map`; a program without one is a
 *     perfectly good program (chunk / grep / select / stat / answer are
 *     model-free), and running a `map` without a client is a stated
 *     refusal rather than a crash.
 *   - `sequential` runs sub-calls one at a time. It exists so the
 *     benchmark can publish parallel against sequential wall-clock with
 *     the same code path on both sides.
 * @returns {{ run: (doc: any, hooks?: { signal?: AbortSignal }) => Promise<any> }}
 */
export function createProgramRunner(options) {
  const { environment } = options;
  if (environment === null || typeof environment !== 'object')
    throw new TypeError('createProgramRunner needs an environment');
  const client = options.client ?? null;
  const compileQuery = options.compileQuery ?? null;
  const maxSubcalls = options.maxSubcalls ?? MAX_SUBCALLS;
  const concurrency = options.sequential === true
    ? 1
    : Math.max(1, options.maxConcurrentSubcalls ?? MAX_CONCURRENT);
  const subcallChars = options.subcallChars ?? SUBCALL_CHARS;
  const maxReduceChars = options.maxReduceChars ?? MAX_REDUCE_CHARS;

  /**
   * The shape gate, compiled once.
   *
   * The runner validates the document as well as compiling it, so the
   * two ways a program arrives — authored under constrained decoding, or
   * hand-written by a caller — meet the same two gates in the same
   * order. Without this a hand-written program could carry a member the
   * grammar forbids (the D2 rule that no step inlines content is
   * `additionalProperties: false` on every step), and the restriction
   * would hold only for the path that happened to go through
   * `createStructuredOutput`.
   *
   * The seam-free schema on purpose: `query` is unconstrained here and
   * the compile gate judges it, so a runner needs no grammar registered
   * to check a shape (D3).
   */
  const shape = new JarenValidator({ skipErrors: false, collectErrors: true })
    .compile(PROGRAM_SCHEMA);

  /** Compile against what the environment actually holds right now —
   * which is what turns AI0201 from a shape check into a real one. */
  async function compileHere(doc) {
    const outcome = checkOutcome(shape(doc));
    if (!outcome.valid) {
      throw new ProgramError('AI0200',
        outcome.errors[0]?.message ?? 'the document is not a program',
        outcome.errors[0]?.instancePath ?? '');
    }
    const names = (await environment.ledger.listSlots()).map((s) => s.name);
    return compileProgram(doc, { compileQuery, known: names });
  }

  /**
   * The slots one binding stands for, in address order.
   *
   * Three cases, and the third is why `grep` is worth having: a chunk or
   * a map binding is a family; a grep binding is the set of slots it
   * MATCHED, so `map` over a grep visits the matching pieces and not the
   * match list. That is the narrowing the whole design is for — grep to
   * find which forty of four hundred pieces are relevant, then spend
   * sub-calls on those forty only. Anything else is one slot.
   * @param {any} target - `{ family }`, `{ matches }` or `{ slot }`
   * @returns {Promise<string[]>}
   */
  async function membersOf(target) {
    if (target.matches !== undefined) {
      const stored = await environment.ledger.readSlot(target.slot);
      /** @type {any} */
      let listing;
      try { listing = JSON.parse(String(stored ?? '{}')); }
      catch { return [target.slot]; }
      const names = [...new Set((listing.matches ?? []).map((m) => m.slot))];
      return /** @type {string[]} */ (names);
    }
    if (target.slot !== undefined) return [target.slot];
    const slots = await environment.ledger.listSlots();
    return slots
      .filter((s) => s.name.startsWith(target.family))
      .map((s) => s.name)
      .sort((a, b) => {
        // numeric on the trailing index, so piece 10 follows piece 9 and
        // a reduce sees its map's results in the corpus's own order
        const ai = Number(a.slice(a.lastIndexOf('/') + 1));
        const bi = Number(b.slice(b.lastIndexOf('/') + 1));
        return Number.isNaN(ai) || Number.isNaN(bi) ? a.localeCompare(b) : ai - bi;
      });
  }

  /**
   * One sub-call: the model sees ONE piece and answers with one JSON
   * value. Failures are recorded, never thrown — §3.
   * @param {string} name - the piece's slot
   * @param {string} prompt
   * @param {AbortSignal} [signal]
   */
  async function subcall(name, prompt, signal) {
    const piece = await environment.read(name, { chars: subcallChars });
    if (piece.error !== undefined) return { slot: name, error: piece.error };
    /** @type {any} */
    let reply;
    try {
      reply = await client.complete({
        // `stream` is deliberately NOT set. A sub-call has no UI to
        // stream to, so `stream: false` looks right — and it is the
        // exact request shape this package's own benchmark measured
        // hanging past a 300 s deadline on the cheap tier and answering
        // in seconds when streamed. Leaving it to the client's default
        // (streaming) costs nothing here, because `complete` returns the
        // accumulated message either way.
        signal,
        messages: [
          {
            role: 'system',
            content: 'You are given ONE piece of a larger corpus and a question about it.'
              + ' Answer with a single JSON value and nothing else — no prose, no code fences.'
              + ' If the piece does not contain what was asked for, answer with null.',
          },
          { role: 'user', content: `${prompt}\n\n--- piece ${name} ---\n${piece.text}` },
        ],
      });
    }
    catch (err) {
      if (signal?.aborted === true) throw err;
      return { slot: name, error: `the sub-call failed: ${/** @type {Error} */ (err).message}` };
    }
    const raw = String(reply?.message?.content ?? '');
    try {
      return { slot: name, value: JSON.parse(unfence(raw)) };
    }
    catch (err) {
      return {
        slot: name,
        error: `the reply is not JSON: ${/** @type {Error} */ (err).message}`,
        raw: excerpt(raw, RAW_EXCERPT),
      };
    }
  }

  /**
   * Execute a compiled program.
   * @param {any} doc
   * @param {{ signal?: AbortSignal }} [hooks]
   */
  async function run(doc, hooks = {}) {
    const signal = hooks.signal;
    const started = Date.now();

    /** @type {any} */
    let plan;
    try {
      plan = await compileHere(doc);
    }
    catch (err) {
      // NOTHING has run: the compile reads no slot and writes none, so a
      // rejected program leaves the environment exactly as it was
      return { ok: false, ran: 0, error: 'the program does not compile', errors: [errorRecord(err)] };
    }

    /** binding → `{ slot }` or `{ family, count }` */
    const bindings = new Map();
    /** @type {any[]} */
    const report = [];
    let subcalls = 0;
    let failed = 0;
    /** @type {string|null} */
    let stopped = null;

    /** Where a step's `from` points, as an address the environment knows. */
    const address = (from) => {
      const binding = bindings.get(from);
      if (binding === undefined) return { slot: from };
      return binding;
    };
    const addressOf = (from) => {
      const target = address(from);
      return target.slot ?? target.family;
    };

    /**
     * Run a step's compiled query over `data`, store the result, bind it.
     * `select` and `reduce` differ only in where their input comes from
     * — one slot's document, or a map's collected results — so the
     * running and the storing live here once.
     * @param {any} step
     * @param {any} data
     */
    async function store(step, data) {
      /** @type {any} */
      let value;
      try {
        value = step.run(data);
      }
      catch (err) {
        const e = /** @type {any} */ (err);
        return { error: `the query failed: ${e?.reason ?? e?.message ?? err}`, code: e?.code };
      }
      const written = await environment.put(resultSlot(step.as), JSON.stringify(value ?? null),
        { kind: 'selection', count: Array.isArray(value) ? value.length : undefined });
      if (written.error === undefined) bindings.set(step.as, { slot: resultSlot(step.as) });
      return written;
    }

    for (const step of plan.steps) {
      if (signal?.aborted === true) { stopped = 'aborted'; break; }
      const target = address(step.from);

      if (step.op === 'chunk') {
        const result = await environment.chunk(addressOf(step.from), {
          strategy: step.strategy, size: step.size,
        });
        if (result.error !== undefined) return failure(step, result);
        bindings.set(step.as, { family: result.family, count: result.count });
        report.push({ op: step.op, as: step.as, count: result.count, family: result.family });
        continue;
      }

      if (step.op === 'grep') {
        const result = await environment.grep(step.pattern, {
          in: addressOf(step.from), limit: step.limit, flags: step.flags,
        });
        if (result.error !== undefined) return failure(step, result);
        const stored = await environment.put(resultSlot(step.as), JSON.stringify(result),
          { kind: 'selection', count: result.total });
        // `matches` marks this binding as a SET OF ADDRESSES: reading it
        // gives the listing, mapping over it visits what it found
        bindings.set(step.as, { slot: resultSlot(step.as), matches: result.matches.length });
        report.push({
          op: step.op, as: step.as, total: result.total,
          slots: new Set(result.matches.map((m) => m.slot)).size, size: stored.size,
        });
        continue;
      }

      if (step.op === 'select') {
        // the query is the one this program COMPILED, run here rather
        // than handed back to `environment.select` as a document. Two
        // seams for one job is how a runner with a compiler wired ends
        // up refused by an environment without one — and the compiled
        // function is the better artifact anyway: compiled once at
        // compile time, not once per call site
        const name = addressOf(step.from);
        const raw = await environment.ledger.readSlot(name);
        if (raw === null || raw === undefined) return failure(step, { error: `no slot '${name}'` });
        /** @type {any} */
        let data;
        try { data = JSON.parse(String(raw)); }
        catch (err) {
          return failure(step,
            { error: `slot '${name}' is not JSON: ${/** @type {Error} */ (err).message}` });
        }
        const stored = await store(step, data);
        if (stored.error !== undefined) return failure(step, stored);
        report.push({ op: step.op, as: step.as, size: stored.size, count: stored.count });
        continue;
      }

      if (step.op === 'stat' || step.op === 'peek') {
        const result = step.op === 'stat'
          ? await environment.stat(addressOf(step.from))
          : await environment.peek(addressOf(step.from));
        if (result.error !== undefined) return failure(step, result);
        const stored = await environment.put(resultSlot(step.as), JSON.stringify(result),
          { kind: 'selection' });
        bindings.set(step.as, { slot: resultSlot(step.as) });
        report.push({ op: step.op, as: step.as, size: stored.size });
        continue;
      }

      if (step.op === 'map') {
        if (client === null) {
          return failure(step, { error: 'map needs a client — this runner was built without one' });
        }
        const members = await membersOf(target);
        const budgeted = members.slice(0, Math.max(0, maxSubcalls - subcalls));
        const skipped = members.length - budgeted.length;
        /** @type {any[]} */
        let results;
        try {
          results = await pool(budgeted, concurrency,
            (name) => subcall(name, step.prompt, signal));
        }
        catch (err) {
          // the only way out of the pool is an abort: a sub-call's own
          // failure is a value (§3), so a throw here is the run being
          // cancelled and the partial work is kept
          if (signal?.aborted !== true) throw err;
          stopped = 'aborted';
          break;
        }
        subcalls += budgeted.length;
        for (let i = 0; i < results.length; i++) {
          if (results[i].error !== undefined) failed++;
          await environment.put(`${mapFamily(step.as)}${i}`, JSON.stringify(results[i]),
            { kind: 'selection' });
        }
        bindings.set(step.as, { family: mapFamily(step.as), count: results.length });
        report.push({
          op: step.op,
          as: step.as,
          subcalls: budgeted.length,
          failed: results.filter((r) => r.error !== undefined).length,
          // never silently: a capped map that said nothing would read as
          // a map over everything
          ...(skipped > 0
            ? { skipped, note: `maxSubcalls ${maxSubcalls} reached — ${skipped} piece(s) not visited` }
            : {}),
          concurrency,
        });
        continue;
      }

      if (step.op === 'reduce') {
        const members = await membersOf(target);
        /** @type {any[]} */
        const collected = [];
        let chars = 0;
        for (const name of members) {
          const text = String(await environment.ledger.readSlot(name) ?? 'null');
          chars += text.length;
          if (chars > maxReduceChars) {
            return failure(step, {
              error: `the reduce input passed ${maxReduceChars} characters at ${name} —`
                + ' a map that returns its input is not a reduction; narrow the map prompt',
            });
          }
          try { collected.push(JSON.parse(text)); }
          catch { collected.push({ slot: name, error: 'the stored result is not JSON' }); }
        }
        const stored = await store(step, collected);
        if (stored.error !== undefined) return failure(step, stored);
        report.push({ op: step.op, as: step.as, over: members.length, size: stored.size });
        continue;
      }
    }

    /** @param {any} step @param {any} result */
    function failure(step, result) {
      return {
        ok: false,
        ran: report.length,
        steps: report,
        error: result.error,
        errors: [{ code: result.code ?? 'AI0200', docPath: `/steps/${step.index}`, message: result.error }],
        ms: Date.now() - started,
      };
    }

    const answered = stopped === null
      ? await environment.read(addressOf(plan.answer.from), { chars: plan.answer.chars })
      : { error: `the run was ${stopped}` };

    return {
      ok: stopped === null && answered.error === undefined,
      ...(stopped === null ? {} : { stopped }),
      steps: report,
      ran: report.length,
      subcalls,
      failed,
      concurrency,
      // the one place content comes back, and it is the step the program
      // asked for by name
      answer: answered.error === undefined
        ? { slot: answered.name, size: answered.size, text: answered.text }
        : null,
      ...(answered.error === undefined ? {} : { error: answered.error }),
      ms: Date.now() - started,
    };
  }

  // `run` only: a `compile` here would be a second, WEAKER compile than
  // the one `run` does (it could not resolve names against the
  // environment), and callers who want to check a document without
  // running it have `compileProgram` and `programGate` directly
  return { run };
}

//#endregion

//#region authoring

/**
 * The worked example. Field notes: prose describes the shape, an example
 * FIXES it — a small model told in words to plan over slots still tends
 * to emit one step that does everything.
 *
 * Its query is a real one and it COMPILES; `test/ai/program.test.js`
 * asserts that. An example carrying a query the engine rejects would be
 * teaching the failure it is meant to prevent, and the model would have
 * copied it before the gate ever saw it.
 */
const EXAMPLE = {
  steps: [
    { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: 2000 },
    { op: 'map', from: 'pieces', as: 'found', prompt: 'Return the record in this piece as {"id":…,"value":…}.' },
    { op: 'reduce', from: 'found', as: 'summary', query: { $for: { r: '$[*].value' }, $return: '$r.value' } },
    { op: 'answer', from: 'summary' },
  ],
};

/** The example, so a test can compile it. Exported for exactly that:
 * the prompt's correctness is a property worth a gate. */
export const PROGRAM_EXAMPLE = EXAMPLE;

/**
 * Author a program with a model, gated on the compiler.
 *
 * The root sees the environment's DIGEST and the question — never a
 * slot's content (D2) — so the authoring request is the same size for a
 * ten-kilobyte corpus and a ten-megabyte one. The schema constrains
 * decoding, the compile gate constrains meaning, and a rejected
 * candidate goes back with its code and its pointer.
 *
 * @param {{ client: any, environment: any, compileQuery?: any,
 *   createStructuredOutput: (options: any) => { generate: Function },
 *   querySchema?: any, maxRepairs?: number, system?: string }} options
 *   - `createStructuredOutput` is injected rather than imported so a
 *     caller can wrap it (a probe counting attempts, a cache); the
 *     package's own is the obvious argument.
 *   - `querySchema` is the published query grammar. Given, `select` and
 *     `reduce` are shape-constrained too and it is registered as a
 *     `$ref`; absent, the compile gate carries it alone (D3).
 * @returns {{ author: (question: string, hooks?: { signal?: AbortSignal }) => Promise<any> }}
 */
export function createProgramAuthor(options) {
  const { client, environment, createStructuredOutput: structured } = options;
  const compileQuery = options.compileQuery ?? null;
  const querySchema = options.querySchema ?? null;
  const schema = programSchema(querySchema === null ? {} : { queryRef: querySchema.$id });

  async function author(question, hooks = {}) {
    const digest = await environment.digest();
    const known = (await environment.ledger.listSlots()).map((s) => s.name);
    const generate = structured({
      client,
      schema,
      name: 'jaren_program',
      strict: false,
      ...(querySchema === null ? {} : { refs: [querySchema] }),
      gate: programGate({ compileQuery, known }),
      maxRepairs: options.maxRepairs ?? 2,
    });

    const result = await generate.generate([
      {
        role: 'system',
        content: options.system ?? 'You plan work over a corpus you cannot see.'
          + ' You are given only the NAMES and sizes of the slots that hold it.'
          + ' Write a program whose steps name those slots. Never paste content into a step.'
          + ' Use map to ask a question of every piece — it is the only step that reads text —'
          + ' and reduce to combine what the map found. Here is a program in the right shape:\n'
          + JSON.stringify(EXAMPLE),
      },
      {
        role: 'user',
        content: `The environment holds:\n${JSON.stringify(digest.slots)}\n`
          + `(${digest.total} slot(s), ${digest.size} characters in total)\n\n`
          + `Question: ${question}`,
      },
    ], { signal: hooks.signal });

    return result;
  }

  return { author };
}

//#endregion
