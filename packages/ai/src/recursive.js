//@ts-check
/**
 * The long-horizon entry point: a job, not a conversation.
 *
 * `createAgent` is a bounded tool loop — you talk to it. This is the
 * other shape: you hand it a corpus and a question, and it authors a
 * program over an environment, fans model calls out across the pieces,
 * and may let any of those calls be **another agent over its own slice**
 * — depth-capped, budget-shared, and traced at every level.
 *
 * Four things about recursion are load-bearing, and each one exists
 * because the RLM paper reports the failure it prevents:
 *
 *  - **Depth defaults to 1 and caps at 3.** The paper runs depths 0–3
 *    and finds most of its gain at depth 1, with depth 3 helping only on
 *    information-dense tasks. Depth multiplies cost on every task where
 *    it does not help, so the default is the depth that usually pays and
 *    the cap is asserted rather than documented — a program asking for
 *    more is clamped, and the clamp is recorded in the trajectory rather
 *    than applied silently.
 *  - **Budgets are shared by the whole tree, not per call.** Depth times
 *    fan-out is multiplicative: depth 3 fanning 20 ways at each level is
 *    8000 leaf calls. A per-call budget cannot bound that. One account is
 *    threaded through every depth, charged by every model call, and when
 *    it runs out the tree stops with a named reason and **leaves its
 *    partial work in slots** — which is why Phase A came first: a
 *    budget-stopped run is resumable because its work is durable.
 *  - **A child cannot reach a sibling.** Each child gets an environment
 *    scoped to a prefix of its own. Isolation is what makes one failing
 *    branch containable instead of a corruption of the shared corpus.
 *  - **A child's failure is a value.** A child whose program will not
 *    compile returns `{ error, depth, slot }` to its parent, recorded and
 *    addressable. The paper reports syntax errors propagating silently
 *    through recursion; here the parent's map completes with a recorded
 *    failure in the child's own result slot, exactly as a failed leaf
 *    sub-call does.
 *
 * **What is not here, stated rather than implied:** guardrails for
 * recursive LM systems are under-explored, and this package does not
 * pretend otherwise. Three bounds exist and they are the only three —
 * the depth cap, the shared budget and the abort signal. There is no
 * general proof of a child's factual correctness or loop detection beyond
 * depth. Recursive envelopes are compile/runtime checked; hosts may also
 * opt into checked root reuse and per-call route limits.
 */

import { excerpt } from '@jarenjs/core/chunk';
import { recursiveItems } from './program-shape.js';
import { createProgramSession } from './program-session.js';
import { readProgramAnswer } from './program-result.js';

/** The deepest a tree may go, whatever it asks for. */
export const MAX_DEPTH = 3;

/** The conservative default; local depth measurements have not justified raising it. */
export const DEFAULT_DEPTH = 1;

/** How much of a child's answer its parent's trajectory keeps. */
const TRACE_EXCERPT = 200;

/**
 * The dimensions a tree is bounded by. The same three the agent loop
 * uses, in the same order, because a caller who has budgeted one should
 * not have to learn a second vocabulary for the other.
 */
export const BUDGET_DIMENSIONS = /** @type {const} */ (['turns', 'tokens', 'ms']);

/** Characters per token when a provider reports no usage — the agent
 * loop's ratio, stated there and unchanged here. */
const TOKEN_CHARS = 4;

/**
 * One account, charged by every model call at every depth.
 *
 * This is the whole of "budgets are global, not per-call". It is a
 * mutable object on purpose: a snapshot passed down would let each
 * branch spend the full budget independently, which is precisely the
 * runaway the cap exists to prevent.
 *
 * @param {{ turns?: number, tokens?: number, ms?: number,
 *   spent?: { turns?: number, tokens?: number, ms?: number } }} [budget]
 * @param {() => number} [clock]
 * **Turns are reserved, tokens are settled**, and the split is what makes
 * a concurrent fan-out bounded. A budget checked before a call and
 * charged after it can be beaten by concurrency: four sub-calls launched
 * together all see the same unspent budget and all spend it. Taking the
 * turn at the moment the call is launched closes that for the dimension
 * that can be known in advance. Tokens cannot be — nobody knows what a
 * reply will cost until it arrives — so a token budget may overshoot by
 * at most `maxConcurrentSubcalls - 1` calls' worth. That is stated here
 * rather than hidden, because a caller sizing a budget needs it.
 *
 * @returns {{ reserve: () => void, settle: (usage: any, text?: string) => void,
 *   stop: () => string | null, spent: () => { turns: number, tokens: number, ms: number },
 *   remaining: () => Record<string, number | null> }}
 */
export function createBudgetAccount(budget = {}, clock = Date.now) {
  const started = clock();
  const spent = {
    turns: budget.spent?.turns ?? 0,
    tokens: budget.spent?.tokens ?? 0,
    ms: budget.spent?.ms ?? 0,
  };
  const elapsed = () => spent.ms + (clock() - started);

  return {
    /** A call is about to be made. Taken now, not after, so concurrent
     * launches cannot each see the same unspent turn. */
    reserve() {
      spent.turns += 1;
    },
    /**
     * A call came back. The provider's own usage wins; the character
     * estimate is the fallback and it is only computed when a token
     * budget exists to spend it against.
     * @param {any} usage - the provider's usage block, if any
     * @param {string} [text] - what was sent and returned, for the estimate
     */
    settle(usage, text) {
      const reported = typeof usage?.total_tokens === 'number' && usage.total_tokens > 0
        ? usage.total_tokens
        : (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
      if (reported > 0) spent.tokens += reported;
      else if (typeof budget.tokens === 'number' && text !== undefined) {
        spent.tokens += Math.ceil(text.length / TOKEN_CHARS);
      }
    },
    /** The dimension that is spent, or null. Checked BEFORE a call. */
    stop() {
      const now = { turns: spent.turns, tokens: spent.tokens, ms: elapsed() };
      for (const dimension of BUDGET_DIMENSIONS) {
        const limit = budget[dimension];
        if (typeof limit === 'number' && now[dimension] >= limit) return `budget-${dimension}`;
      }
      return null;
    },
    spent: () => ({ turns: spent.turns, tokens: spent.tokens, ms: elapsed() }),
    remaining: () => Object.fromEntries(BUDGET_DIMENSIONS.map((name) => [name,
      typeof budget[name] === 'number'
        ? Math.max(0, budget[name] - (name === 'ms' ? elapsed() : spent[name]))
        : null])),
  };
}

/**
 * The record of what a run actually did.
 *
 * A long autonomous run is only reviewable if it says what it did, and
 * "what it did" is not a log line — it is the program it authored, the
 * calls it made and the slots it wrote, at every depth. Kept as plain
 * data so a host can persist it, render it, or diff two runs.
 *
 * @returns {{ add: (entry: any) => any, entries: () => any[],
 *   summary: () => { steps: number, calls: number, slots: number, depths: number[] } }}
 */
export function createTrajectory() {
  /** @type {any[]} */
  const entries = [];
  return {
    /**
     * Record one thing that happened. Returns the entry so a caller can
     * hold it — never the array, which would let a caller mutate history.
     * @param {any} entry
     */
    add(entry) {
      const record = { seq: entries.length, ...entry };
      if (typeof record.answer === 'string') record.answer = excerpt(record.answer, TRACE_EXCERPT);
      entries.push(record);
      return record;
    },
    entries: () => entries.slice(),
    summary: () => ({
      steps: entries.filter((e) => e.kind === 'program').length,
      calls: entries.filter((e) => e.kind === 'subcall' || e.kind === 'author').length,
      slots: entries.filter((e) => e.slot !== undefined).length,
      depths: [...new Set(entries.map((e) => e.depth ?? 0))].sort((a, b) => a - b),
    }),
  };
}

/**
 * Clamp a requested depth to what this package will actually run.
 *
 * Returns the depth AND whether it was clamped, because a run that
 * quietly did less than it was asked to is indistinguishable from one
 * that failed to find anything — the caller has to be able to tell.
 * @param {number | undefined} requested
 * @returns {{ depth: number, clamped: boolean }}
 */
export function resolveDepth(requested) {
  if (requested === undefined || requested === null) return { depth: DEFAULT_DEPTH, clamped: false };
  const asked = Math.floor(Number(requested));
  if (!Number.isFinite(asked) || asked < 0) return { depth: DEFAULT_DEPTH, clamped: true };
  return { depth: Math.min(asked, MAX_DEPTH), clamped: asked > MAX_DEPTH };
}

/** The slot prefix a child at `depth` working on `index` owns. Derived,
 * like every other address in this package, so nothing has to store a
 * mapping from a child to its workspace. */
export const childScope = (depth, index) => `child/${depth}/${index}/`;

/**
 * The long-horizon entry point: hand it a question and an environment,
 * get back an answer and the trajectory that produced it.
 *
 * This is the Phase B counterpart to `createAgent`, and the docs say
 * plainly which to reach for: `createAgent` is a bounded tool loop for a
 * CONVERSATION, this is for a JOB — something with a corpus, a question
 * over all of it, and no user waiting to answer a follow-up.
 *
 * @param {{ client: any, environment: any, compileQuery?: any,
 *   analyzeQuery?: any, annotateTypes?: any, reuse?: any,
 *   selectModel?: any, limits?: any, onRoute?: any,
 *   createStructuredOutput: (options: any) => { generate: Function },
 *   createProgramAuthor: (options: any) => { author: Function },
 *   createProgramRunner: (options: any) => { run: Function },
 *   createEnvironment: (options: any) => any,
 *   querySchema?: any, budget?: any, depth?: number,
 *   maxConcurrentSubcalls?: number, maxSubcalls?: number,
 *   subcallChars?: number, maxAnswerChars?: number, clock?: () => number }} options
 *   The three factories and `createEnvironment` are injected for the
 *   same reason everything heavy in this package is: it keeps this
 *   module free of a cycle with `program.js` and lets a probe wrap any
 *   of them to count what a run actually did.
 * @returns {{ run: (question: string, hooks?: { signal?: AbortSignal }) => Promise<any> }}
 */
export function createLongHorizonAgent(options) {
  const {
    client, environment, createProgramAuthor: authorFactory,
    createProgramRunner: runnerFactory, createEnvironment: environmentFactory,
  } = options;
  const { depth: maxDepth, clamped } = resolveDepth(options.depth);
  let account = createBudgetAccount(options.budget ?? {}, options.clock);
  let trajectory = createTrajectory();
  const subcallChars = options.subcallChars ?? 8000;
  const maxAnswerChars = options.maxAnswerChars ?? 200000;
  if (!Number.isSafeInteger(maxAnswerChars) || maxAnswerChars < 1)
    throw new RangeError('maxAnswerChars must be a positive safe integer');


  /**
   * One level: author a program over `env`, run it, answer.
   * @param {number} depth
   * @param {any} env
   * @param {string} question
   * @param {AbortSignal} [signal]
   */
  async function level(depth, env, question, signal) {
    const stop = account.stop();
    if (stop !== null) return { ok: false, depth, stopped: stop, answer: null };

    // every authoring call is charged where it HAPPENS, not once per
    // level: structured generation may spend up to `1 + maxRepairs`
    // calls on one document, and an account that counted the level
    // instead of the calls would let a repair loop run free — the exact
    // shape of overspend a shared budget exists to stop. The provider's
    // usage is captured here too, which the generator's return value
    // does not carry.

    const author = authorFactory({
      client, account, selectModel: options.selectModel, limits: options.limits,
      depth, onRoute: (event) => { trajectory.add({ kind: 'route', depth, ...event }); options.onRoute?.(event); },
      environment: env,
      compileQuery: options.compileQuery,
      createStructuredOutput: options.createStructuredOutput,
      querySchema: options.querySchema,
      recursive: true, analyzeQuery: options.analyzeQuery, annotateTypes: options.annotateTypes,
    });

    const runner = runnerFactory({
      environment: env,
      client,
      compileQuery: options.compileQuery,
      recursive: true, analyzeQuery: options.analyzeQuery, annotateTypes: options.annotateTypes,
      account, selectModel: options.selectModel, limits: options.limits,
      depth, onRoute: (event) => { trajectory.add({ kind: 'route', depth, ...event }); options.onRoute?.(event); },
      maxSubcalls: options.maxSubcalls,
      maxConcurrentSubcalls: options.maxConcurrentSubcalls,
      // the recursion point, and the only one: below the cap a piece is
      // worth a whole child agent; at the cap it is worth one model call
      subcall: depth >= maxDepth ? undefined : (name, prompt, sig, index) =>
        child(depth + 1, env, name, prompt, sig, index),
    });

    let result;
    try {
      result = await createProgramSession({ ...options, environment: env, author, runner,
        recursive: true, reuse: depth === 0 ? options.reuse : undefined }).run(question, { signal });
    }
    catch (error) {
      trajectory.add({ kind: 'author', depth, ok: false });
      return { ok: false, depth, stopped: account.stop(), error: /** @type {Error} */ (error).message, answer: null };
    }
    trajectory.add({ kind: result.reuse?.reused ? 'reuse' : 'author', depth,
      ok: result.program !== undefined, attempts: result.reuse?.authorCalls ?? 0, errors: result.errors ?? [] });
    trajectory.add({
      kind: 'program', depth, ok: result.ok, steps: result.steps ?? [],
      subcalls: result.subcalls ?? 0, failed: result.failed ?? 0,
      slot: result.answer?.slot, answer: result.answer?.text,
      ...(result.stopped === undefined ? {} : { stopped: result.stopped }),
    });
    return { ...result, depth };
  }

  /**
   * One child: its own scoped workspace, seeded with the one piece it
   * was given, and its own program over it.
   * @param {number} depth
   * @param {any} parentEnv
   * @param {string} name - the parent's slot this child works on
   * @param {string} prompt
   * @param {AbortSignal} [signal]
   * @param {number} [index]
   */
  async function child(depth, parentEnv, name, prompt, signal, index = 0) {
    const piece = await parentEnv.read(name, { chars: subcallChars });
    if (piece.error !== undefined) return { slot: name, error: piece.error, depth };

    const scope = childScope(depth, index);
    const env = environmentFactory({
      ledger: parentEnv.ledger,
      scope,
      compileQuery: options.compileQuery,
    });
    await env.put('corpus', piece.text, { kind: 'text' });

    const result = await level(depth, env, prompt, signal);
    trajectory.add({ kind: 'subcall', depth, slot: `${scope}corpus`, ok: result.ok === true });

    if (result.ok !== true) {
      // the failure travels UP with its depth and its address, so a
      // parent's map records which branch failed and where to look
      return { slot: name, depth, address: scope,
        error: result.error ?? `child stopped: ${result.stopped ?? 'unknown'}` };
    }
    // only the child's ANSWER crosses the boundary — never its corpus,
    // never its slots (D2, at every level and not just the root)
    const complete = await readProgramAnswer(env, result.answer, { maxChars: maxAnswerChars });
    if (!complete.ok) return { slot: name, depth, address: scope, error: complete.error };
    try {
      const items = recursiveItems(JSON.parse(complete.answer.text));
      if (items === null) return { slot: name, depth, error: 'AI0209: child answer violates recursive shape' };
      return items.length === 1
        ? { ...items[0], slot: name, depth, address: scope }
        : { slot: name, depth, address: scope, items };
    }
    catch {
      return { slot: name, depth, address: scope, error: 'AI0209: child answer is not complete JSON' };
    }
  }

  let pending = Promise.resolve();
  return {
    run(question, hooks = {}) {
      const next = pending.then(async () => {
        account = createBudgetAccount(options.budget ?? {}, options.clock);
        trajectory = createTrajectory();
        if (clamped) {
          trajectory.add({
            kind: 'note', depth: 0,
            note: `depth ${options.depth} was asked for; ${maxDepth} is the cap this package runs`,
          });
        }
        const result = await level(0, environment, question, hooks.signal);
        const stopped = account.stop();
        return {
          ok: result.ok === true,
          answer: result.answer ?? null,
          depth: maxDepth,
          depthClamped: clamped,
          stopReason: result.stopped ?? stopped ?? null,
          spent: account.spent(),
          remaining: account.remaining(),
          trajectory: trajectory.entries(),
          summary: trajectory.summary(),
          ...(result.error === undefined ? {} : { error: result.error }),
          ...(result.errors === undefined ? {} : { errors: result.errors }),
        };
      });
      pending = next.then(() => {}, () => {});
      return next;
    },
  };
}
