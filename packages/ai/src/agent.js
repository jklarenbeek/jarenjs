//@ts-check
/**
 * The agent loop: a bounded, deterministic tool-call round-trip over a
 * chat client and a toolbox. The model proposes tool calls; the loop
 * executes them through the schema-guarded toolbox, appends the
 * results, and asks again — up to `maxToolRounds` times, then it stops
 * and says so instead of spinning. Weak local models are first-class
 * citizens here: malformed tool arguments and failing tools become
 * readable `{ error }` results the model can correct, never crashes.
 *
 * `send` never mutates the history it is given; it returns the full
 * new transcript (wire-shape messages) so the host can persist it and
 * send it back next turn.
 *
 * Given a `ledger`, compaction stops destroying: every round that
 * leaves the request is written to an addressable slot first, the
 * synopsis carries the addresses, and a `recall` tool fetches one back.
 * Without a ledger the old path runs unchanged, synchronously, byte for
 * byte — the new behaviour is opt-in and named.
 *
 * A ledger also gives the loop an OBJECTIVE and a BUDGET. The active
 * goal and its progress are composed into the system prompt of every
 * request — unconditionally, because it is the thing being worked on —
 * while memories and skills are retrieved only when asked for. The
 * composition happens in the REQUEST and never in the transcript: the
 * history the host persists stays the immutable base prompt plus the
 * conversation, so a resumed session composes today's goal rather than
 * accumulating yesterday's.
 */

import { goalPrompt } from './retention.js';
import { AiError } from './errors.js';
import { createToolbox } from './toolbox.js';
import {
  slotAddressesIn, RECALL_TOOL_NAME, createRecallTool, roundSlotName, indexSlotName, slotAddress, slotRef,
} from './recall.js';
import { environmentTools } from './environment.js';
import { excerpt, truncate, sizeOf } from '@jarenjs/core/chunk';

/**
 * @typedef {Object} AgentHooks
 * @property {(text: string) => void} [onDelta] - streamed reply text
 * @property {(text: string) => void} [onReasoning] - streamed thinking
 * @property {(call: { name: string, arguments: string }) => void} [onToolCall]
 * @property {(step: { name: string, result: any }) => void} [onToolResult]
 * @property {AbortSignal} [signal]
 */

/**
 * @param {{ client: { complete: (request: any) => Promise<any> },
 *   toolbox?: { toFunctionTools: () => any[], execute: (name: string, args: any) => any } | null,
 *   system?: string, maxToolRounds?: number, maxToolResultChars?: number,
 *   historyBudget?: number, ledger?: any,
 *   budget?: { turns?: number, tokens?: number, ms?: number,
 *     spent?: { turns?: number, tokens?: number, ms?: number } },
 *   retrieval?: { memories?: { tags?: string[], where?: any, limit?: number },
 *     skills?: { tags?: string[], where?: any, limit?: number } },
 *   now?: () => number,
 *   environment?: any, transcript?: { slot?: string, window?: number },
 *   compaction?: (droppedRounds: any[][], addresses?: any[]) => string }} options
 *   - `historyBudget` caps the request history in CHARACTERS (tokens
 *   are provider-private; characters are deterministic). When a
 *   request would exceed it, the middle of the conversation is
 *   replaced by one synopsis message; the system prompt, the first
 *   user message and the largest tail that fits always survive, and
 *   cuts happen only at tool-round boundaries so `tool_calls`/`tool`
 *   pairing stays wire-legal. `compaction` replaces the built-in
 *   synopsis writer (it receives the dropped rounds, each an array of
 *   wire messages, and — with a ledger — the address of each). The
 *   returned transcript is always the FULL, uncompacted history.
 *   - `ledger` (anything with `putSlot`/`getSlot`/`readSlot`, normally
 *   `createLedger()`) makes compaction RECOVERABLE: each dropped round
 *   is archived to a content-addressed slot before the synopsis is
 *   written, every synopsis line carries its address, and a `recall`
 *   tool is registered so the model can fetch one back. Nothing leaves
 *   the request without a copy that can be named. With no ledger the
 *   original lossy path runs unchanged. A ledger also supplies the
 *   active goal composed into every request, and the memories and
 *   skills `retrieval` asks for.
 *   - `budget` is a hard stop, not a warning: `turns` (one turn is one
 *   MODEL CALL — the unit that costs money and the unit a resumed
 *   session keeps counting), `tokens` and `ms` each end the run with a
 *   named `stopReason` (`budget-turns`, `budget-tokens`, `budget-ms`)
 *   and a message saying what remains. Each is optional; `spent` seeds
 *   the counters so a budget survives a reload. The `ms` clock starts at
 *   the first model call and is wall-clock from there.
 *   - `retrieval` composes ledger memories and skills into the system
 *   prompt of every request, with the ledger's own `recall` query shape.
 *   Absent, nothing is retrieved — the goal is unconditional, but what
 *   else is worth carrying is the host's call.
 *   - `now` returns milliseconds (`Date.now` by default), injected so a
 *   time budget is testable.
 *   - `environment` (from `createEnvironment`) registers the corpus
 *   operations as tools — `env_digest`, `env_peek`, `env_grep`,
 *   `env_chunk`, `env_stat`, `env_read` — beside the host's, skipping any
 *   name the host already registered. Content never enters a request
 *   unasked: every one of them answers with metadata and addresses
 *   except `env_read`, which makes the model state a character budget.
 *   - `transcript` (needs `environment`) makes the CONVERSATION one of
 *   those slots: it is written whole before every call and the request
 *   keeps `window` round units plus the address of the rest. That is the
 *   alternative to `historyBudget` rather than a tuning of it — there is
 *   no budget to exceed when the history is addressed instead of resent.
 *   Both together is legal and redundant; neither changes the other's
 *   behaviour.
 * @returns {{ send: (history: any[], hooks?: AgentHooks) => Promise<{
 *   message: any, messages: any[], steps: any[], stopReason: string }>,
 *   resume: (history?: any[], hooks?: AgentHooks) => Promise<{
 *   message: any, messages: any[], steps: any[], stopReason: string }>,
 *   spend: () => { turns: number, tokens: number, ms: number } }}
 */
export function createAgent(options) {
  const client = options.client;
  const toolbox = options.toolbox ?? null;
  const system = options.system ?? '';
  const maxToolRounds = options.maxToolRounds ?? 5;
  const maxToolResultChars = options.maxToolResultChars ?? 8000;
  const historyBudget = options.historyBudget;
  const ledger = options.ledger ?? null;
  const budget = options.budget ?? null;
  const retrieval = options.retrieval ?? null;
  const clock = options.now ?? (() => Date.now());
  const environment = options.environment ?? null;
  // the transcript-as-slot path is opt-in even with an environment
  // present: an environment is a corpus to work on, and deciding that
  // the CONVERSATION is one of its slots is a separate choice
  const transcript = environment === null || options.transcript === undefined
    ? null
    : {
      slot: options.transcript.slot ?? 'transcript',
      window: Math.max(1, options.transcript.window ?? TRANSCRIPT_WINDOW),
    };
  // kept separately from the effective writer: the ledger path treats a
  // HOST writer differently from the built-in one (see `compactToLedger`)
  const hostCompaction = options.compaction ?? null;
  const compaction = hostCompaction ?? synopsize;

  if (ledger !== null && typeof ledger.putSlot !== 'function') {
    throw new AiError('AI0001',
      'ledger: expected an object with putSlot/getSlot/readSlot (createLedger())');
  }
  // one recall tool per agent, and only with a ledger — a toolbox is
  // built here rather than in the loop so its schema compiles once
  const recallBox = ledger === null ? null : recallToolbox(ledger);
  // the environment's operations, as tools, compiled once for the same
  // reason. The model reaches the corpus through exactly the calls a
  // harness makes — one implementation, in `environment.js`.
  const envBox = environment === null ? null : toolboxOf(environmentTools(environment));

  // what this agent has spent, across every `send` it has served. The
  // counters live on the agent and not on a call, because a budget that
  // reset each turn would bound nothing a long-horizon run cares about.
  const spent = {
    turns: budget?.spent?.turns ?? 0,
    tokens: budget?.spent?.tokens ?? 0,
    ms: budget?.spent?.ms ?? 0,
  };
  /** Wall-clock start of the first model call, or null before it. */
  let startedAt = null;
  const elapsed = () => spent.ms + (startedAt === null ? 0 : clock() - startedAt);

  /** What this agent has spent so far — the seed for a resumed budget. */
  const spend = () => ({ turns: spent.turns, tokens: spent.tokens, ms: elapsed() });

  /**
   * The budget dimension that is spent, or null. Checked BEFORE every
   * model call, so an exhausted budget refuses rather than overruns —
   * `maxToolRounds`'s posture, applied to the three quantities a run is
   * actually bounded by.
   * @returns {{ reason: string, content: string } | null}
   */
  function budgetStop() {
    if (budget === null) return null;
    const spentNow = spend();
    for (const dimension of BUDGET_DIMENSIONS) {
      const limit = budget[dimension];
      if (typeof limit === 'number' && spentNow[dimension] >= limit) {
        return {
          reason: `budget-${dimension}`,
          content: budgetMessage(dimension, budget, spentNow),
        };
      }
    }
    return null;
  }

  /**
   * The system prompt for this turn: the immutable base, then the active
   * goal and its progress, then whatever `retrieval` asks for. Read once
   * per `send` rather than once per round — a goal does not change
   * mid-turn, and re-reading it per round would put a storage round-trip
   * in the tool loop for nothing.
   *
   * Returns null when there is nothing to compose, and the caller then
   * sends the history untouched, by the same reference: an agent with no
   * ledger, or a ledger with no goal and no retrieval, must be
   * byte-identical to one built before any of this existed.
   * @param {string} base
   * @returns {Promise<string | null>}
   */
  async function composeSystem(base) {
    if (ledger === null) return null;
    /** @type {string[]} */
    const sections = [];
    if (typeof ledger.getGoal === 'function') {
      const goal = await ledger.getGoal();
      if (goal !== null && goal !== undefined && goal.status === 'active') {
        if (typeof ledger.composeGoal === 'function') {
          const composed = await ledger.composeGoal();
          if (composed.error) throw new AiError('AI0001', composed.error);
          sections.push(composed.text);
        }
        else sections.push(goalPrompt(goal));
      }
    }
    if (retrieval !== null) {
      if (retrieval.memories !== undefined && typeof ledger.recall === 'function') {
        sections.push(...listSection('What you have learned so far',
          await retrieved(ledger.recall(retrieval.memories), 'memories'), memoryLine));
      }
      if (retrieval.skills !== undefined && typeof ledger.recallSkills === 'function') {
        sections.push(...listSection('Skills you can reuse',
          await retrieved(ledger.recallSkills(retrieval.skills), 'skills'), skillLine));
      }
    }
    if (sections.length === 0) return null;
    return [base, ...sections].filter((part) => part !== '').join('\n\n');
  }

  /**
   * One tool call, to `recall` or to the host's toolbox. `recall` is
   * dispatched here rather than being added to the host's registry
   * because the host's toolbox belongs to the host: an agent may not
   * quietly grow it a tool that outlives the agent.
   * @param {string} name
   * @param {any} args
   * @param {boolean} recalling - whether this agent listed `recall`
   */
  async function dispatch(name, args, listed) {
    if (listed.recalling && name === RECALL_TOOL_NAME) return recallBox.box.execute(name, args);
    if (listed.env.has(name)) return envBox.execute(name, args);
    if (toolbox === null) return { error: 'no tools are available' };
    return toolbox.execute(name, args);
  }

  /**
   * @param {any[]} history
   * @param {AgentHooks} [hooks]
   */
  async function send(history, hooks = {}) {
    const messages = system !== '' && history[0]?.role !== 'system'
      ? [{ role: 'system', content: system }, ...history]
      : [...history];
    const hostTools = toolbox !== null ? toolbox.toFunctionTools() : [];
    // a host that registered its own `recall` keeps it: two definitions
    // of one function name is not a wire-legal request
    const recalling = recallBox !== null
      && !hostTools.some((tool) => tool?.function?.name === RECALL_TOOL_NAME);
    const named = new Set(hostTools.map((tool) => tool?.function?.name));
    // same rule as `recall`: a host that registered its own tool of that
    // name keeps it, because two definitions of one function name is not
    // a wire-legal request. What this agent LISTED is what it dispatches.
    const envTools = envBox === null
      ? []
      : envBox.toFunctionTools().filter((tool) => !named.has(tool?.function?.name));
    const listed = {
      recalling,
      env: new Set(envTools.map((tool) => tool.function.name)),
    };
    const tools = [
      ...hostTools,
      ...(recalling ? recallBox.box.toFunctionTools() : []),
      ...envTools,
    ];
    /** @type {any[]} */
    const steps = [];
    // the goal and the retrieved state, composed onto whatever base
    // prompt this conversation carries — into the REQUEST, never into
    // `messages`, so the transcript the host persists never accumulates
    // a goal it would compose a second time next turn
    const composed = await composeSystem(
      messages[0]?.role === 'system' ? messages[0].content : system);

    for (let round = 0; ; round++) {
      const stop = budgetStop();
      if (stop !== null) {
        const message = { role: 'assistant', content: stop.content };
        messages.push(message);
        return { message, messages, steps, stopReason: stop.reason };
      }

      const request = composeRequest(messages, composed);
      // the transcript as a slot: the conversation is written to the
      // environment and the request keeps a window of it plus the
      // address of the whole. This runs BEFORE any character budget,
      // because a request that already carries two rounds has nothing
      // left for compaction to cut.
      const windowed = transcript === null
        ? request
        : await windowThroughEnvironment(request, transcript, environment);
      const sent = historyBudget === undefined
        ? windowed
        : ledger === null
          ? compactMessages(windowed, historyBudget, compaction)
          : await compactToLedger(windowed, historyBudget, hostCompaction,
            ledger, recallBox.options);
      if (startedAt === null) startedAt = clock();
      const completion = await client.complete({
        messages: sent,
        tools: tools.length > 0 ? tools : undefined,
        onDelta: hooks.onDelta,
        onReasoning: hooks.onReasoning,
        signal: hooks.signal,
      });
      spent.turns += 1;
      // reported usage is always counted (it is free and it is the truth);
      // the character estimate is only paid for when a token budget
      // depends on it
      spent.tokens += tokensOf(sent, completion, budget?.tokens !== undefined);
      const reply = completion.message;

      if (reply.toolCalls === null || reply.toolCalls === undefined
        || reply.toolCalls.length === 0) {
        // reasoning rides on the RETURNED message only — the wire
        // transcript stays clean for the next request
        const transcript = { role: 'assistant', content: reply.content };
        messages.push(transcript);
        const message = reply.reasoning === undefined
          ? transcript
          : { ...transcript, reasoning: reply.reasoning };
        return { message, messages, steps, stopReason: completion.finishReason ?? 'stop' };
      }

      if (round >= maxToolRounds) {
        const message = {
          role: 'assistant',
          content: reply.content !== ''
            ? reply.content
            : `Stopped after ${maxToolRounds} tool rounds without a final answer — the tool work so far has been applied; send another message to continue.`,
        };
        messages.push(message);
        return { message, messages, steps, stopReason: 'tool-limit' };
      }

      messages.push({
        role: 'assistant',
        content: reply.content,
        tool_calls: reply.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const call of reply.toolCalls) {
        hooks.onToolCall?.({ name: call.name, arguments: call.arguments });
        const parsed = parseArguments(call.arguments);
        const result = parsed.error !== undefined
          ? parsed
          : await dispatch(call.name, parsed.value, listed);
        hooks.onToolResult?.({ name: call.name, result });
        steps.push({ name: call.name, arguments: call.arguments, result });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: truncate(JSON.stringify(result ?? null), maxToolResultChars),
        });
      }
    }
  }

  /**
   * Continue the active objective without a new instruction from the
   * user — the closed-tab case, and the primitive a host schedules on
   * top of. It is a normal `send` whose only user turn says "carry on":
   * everything that makes carrying on possible (the objective, what has
   * been tried, what was learned) is already composed into the prompt,
   * so a resumed agent is not told where it got to, it reads it.
   *
   * Scheduling — a timer, a service worker, a cron — is deliberately not
   * here; see the README. This package injects its environment rather
   * than owning it, and a heartbeat is environment.
   * @param {any[]} [history] - the persisted transcript, if there is one
   * @param {AgentHooks} [hooks]
   */
  async function resume(history = [], hooks = {}) {
    const goal = ledger !== null && typeof ledger.getGoal === 'function'
      ? await ledger.getGoal()
      : null;
    if (goal === null || goal === undefined || goal.status !== 'active') {
      throw new AiError('AI0001',
        'resume() needs an active goal — call ledger.setGoal() first');
    }
    return send([...history, { role: 'user', content: RESUME_TURN }], hooks);
  }

  return { send, resume, spend };
}

/** The user turn `resume` sends. */
const RESUME_TURN = 'Continue working on the objective in your instructions. The progress'
  + ' recorded there is what has already been done — do not repeat it. Take the next step,'
  + ' and say what you did.';

/**
 * @param {string} text - the model's argument string
 * @returns {{ value?: any, error?: string }}
 */
function parseArguments(text) {
  if (text === '' || text === undefined || text === null) return { value: {} };
  try {
    return { value: JSON.parse(text) };
  }
  catch (err) {
    return { error: `tool arguments are not valid JSON: ${/** @type {Error} */ (err).message}` };
  }
}

//#region the objective in the prompt

/** How much of one progress note, memory or skill a prompt line shows. */
const PROMPT_LINE_CHARS = 300;

/**
 * The request's messages, with the composed system prompt in front of
 * them. The transcript is not touched: composition belongs to a request
 * the way compaction does, and for the same reason — what the host
 * persists has to be the conversation, not this turn's rendering of the
 * ledger.
 *
 * With nothing composed the SAME array comes back, by reference, so an
 * agent without a ledger sends exactly the object it always sent.
 * @param {any[]} messages
 * @param {string | null} composed
 * @returns {any[]}
 */
function composeRequest(messages, composed) {
  if (composed === null) return messages;
  if (messages[0]?.role === 'system') {
    return [{ ...messages[0], content: composed }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: composed }, ...messages];
}

/** One retrieved memory, as a prompt line. */
const memoryLine = (memory) => `- ${excerpt(memory.text, PROMPT_LINE_CHARS)}`
  + `${(memory.tags ?? []).length > 0 ? ` [${memory.tags.join(', ')}]` : ''}`
  + ` (evidence: ${excerpt(typeof memory.evidence === 'string' ? memory.evidence : JSON.stringify(memory.evidence), PROMPT_LINE_CHARS)})`;

/** One retrieved skill, as a prompt line. */
const skillLine = (skill) => `- ${skill.name} — when ${excerpt(skill.when, PROMPT_LINE_CHARS)}:`
  + ` ${excerpt(skill.instructions, PROMPT_LINE_CHARS)}`
  + `${(skill.tools ?? []).length > 0 ? ` (tools: ${skill.tools.join(', ')})` : ''}`;

/**
 * A retrieved section, or nothing at all when the retrieval came back
 * empty — an empty heading in a prompt is a fact about the harness, not
 * about the work.
 * @param {string} title
 * @param {any[]} records
 * @param {(record: any) => string} line
 * @returns {string[]}
 */
function listSection(title, records, line) {
  if (records.length === 0) return [];
  return [[`## ${title}`, ...records.map(line)].join('\n')];
}

/**
 * A retrieval's records, or a loud failure. The ledger answers a
 * `where` predicate it cannot evaluate with `{ error }` rather than
 * ignoring it (a filter silently dropped answers the wrong question),
 * and a prompt built from the wrong question is worse than a run that
 * refuses to start.
 * @param {Promise<any>} pending
 * @param {string} what
 * @returns {Promise<any[]>}
 */
async function retrieved(pending, what) {
  const records = await pending;
  if (Array.isArray(records)) return records;
  // a ranked recall (`{ near }`) answers `{ memories | skills, scores,
  // skipped }`; the records go into the prompt exactly as an array would
  if (Array.isArray(records?.[what])) return records[what];
  throw new AiError('AI0001',
    `retrieval of ${what} failed: ${records?.error ?? 'the ledger returned no records'}`);
}

//#endregion

//#region the transcript as a slot

/** Round units kept in the request when the transcript is a slot. */
const TRANSCRIPT_WINDOW = 2;

/**
 * A toolbox holding one set of definitions, compiled once.
 * @param {any[]} definitions
 */
function toolboxOf(definitions) {
  const box = createToolbox();
  for (const definition of definitions) box.add(definition);
  return box;
}

/**
 * The conversation as text a `grep` can answer from: one header line per
 * message, then its content. Line-oriented on purpose — `grep` reports
 * the line that matched, so a tool result written as one JSON line comes
 * back as one legible hit with its address beside it.
 * @param {any[]} messages
 * @returns {string}
 */
export function transcriptText(messages) {
  return messages.map((message, index) => {
    const head = `[${index}] ${message.role}`;
    if (Array.isArray(message.tool_calls)) {
      return message.tool_calls
        .map((call) => `${head} → ${call.function?.name}(${call.function?.arguments})`)
        .join('\n');
    }
    if (message.role === 'tool') return `${head} ${message.name}: ${message.content}`;
    return `${head}: ${message.content}`;
  }).join('\n');
}

/**
 * Write the whole conversation to its slot and keep a window of it in
 * the request, with the address of the rest.
 *
 * This is the alternative to a history budget rather than a tuning of
 * one. A budget answers "what do I cut to fit?"; this answers "why is
 * the conversation in the request at all?" — it is stored, it is
 * addressable, and the model reaches the part it needs with the same
 * `env_grep`/`env_read` it uses on any other corpus. The request stops
 * growing with the conversation: pins, one pointer, N rounds.
 *
 * The window is counted in ROUND UNITS, so an assistant message and the
 * tool replies it belongs to are never split — the same wire-legality
 * rule compaction obeys.
 * @param {any[]} messages
 * @param {{ slot: string, window: number }} transcript
 * @param {any} environment
 * @returns {Promise<any[]>}
 */
async function windowThroughEnvironment(messages, transcript, environment) {
  const written = await environment.put(transcript.slot, transcriptText(messages),
    { kind: 'transcript', count: messages.length });

  /** @type {any[]} */
  const pinnedSystem = [];
  let rest = messages;
  if (messages[0]?.role === 'system') {
    pinnedSystem.push(messages[0]);
    rest = messages.slice(1);
  }
  const units = roundUnits(rest);
  const firstUser = units.findIndex((unit) => unit[0].role === 'user');
  const cut = Math.max(firstUser + 1, units.length - transcript.window);
  if (cut <= firstUser + 1) return messages;

  const pointer = {
    role: 'assistant',
    content: `[The whole conversation is in the environment as slot "${transcript.slot}"`
      + ` (${messages.length} messages, ${written?.size ?? 0} characters). Nothing was dropped:`
      + ` env_grep finds the round you need and env_read returns it. This request carries the`
      + ` last ${units.length - cut} round(s).]`,
  };
  return [
    ...pinnedSystem,
    ...(firstUser >= 0 ? units[firstUser] : []),
    pointer,
    ...units.slice(cut).flat(),
  ];
}

//#endregion

//#region budgets

/** The dimensions a run is bounded by, in the order they are checked. */
const BUDGET_DIMENSIONS = /** @type {const} */ (['turns', 'tokens', 'ms']);

/**
 * Characters per token when a provider reports no usage. Crude and
 * deliberately stated rather than hidden: a budget that silently did not
 * apply because the provider was quiet would be worse than no budget.
 * Four is the usual English-text ratio and it is the same order of
 * magnitude on JSON, which is what a tool transcript mostly is.
 */
const TOKEN_CHARS = 4;

/**
 * What one exchange cost. The provider's own `usage` wins whenever it
 * reported any (`client.js` normalizes it onto the completion); the
 * character estimate is the fallback, and it counts the request that was
 * actually sent plus the reply that came back.
 * @param {any[]} sent - the messages this call carried
 * @param {any} completion
 * @param {boolean} estimate - whether the fallback is worth computing
 * @returns {number}
 */
function tokensOf(sent, completion, estimate) {
  const usage = completion?.usage;
  const reported = typeof usage?.total_tokens === 'number' && usage.total_tokens > 0
    ? usage.total_tokens
    : (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
  if (reported > 0) return reported;
  if (!estimate) return 0;
  let chars = String(completion?.message?.content ?? '').length;
  for (const message of sent) chars += sizeOf(message);
  return Math.ceil(chars / TOKEN_CHARS);
}

/**
 * The message a spent budget stops with. It names the dimension that
 * ran out and what is left of the others, because "stopped" without a
 * quantity is indistinguishable from a crash to whoever reads the
 * transcript next — including the model, on a resumed turn.
 * @param {string} dimension
 * @param {any} budget
 * @param {{ turns: number, tokens: number, ms: number }} spent
 * @returns {string}
 */
function budgetMessage(dimension, budget, spent) {
  const remaining = BUDGET_DIMENSIONS.map((name) => (typeof budget[name] === 'number'
    ? `${name}: ${Math.max(0, budget[name] - spent[name])} of ${budget[name]} left`
    : `${name}: no limit`));
  return `Stopped: the ${dimension} budget is spent (${spent[dimension]} of ${budget[dimension]}).`
    + ` Remaining — ${remaining.join(', ')}. The work so far has been applied and recorded;`
    + ' raise the budget or start a new run to continue.';
}

//#endregion

//#region history compaction

/** The characters one round unit costs a request. `sizeOf` is the
 * suite's one size rule (`@jarenjs/core/chunk`); a second local copy of
 * "how big is this" is how two budgets in one repository come to
 * disagree about the same message. */
function unitSize(unit) {
  let total = 0;
  for (const message of unit) total += sizeOf(message);
  return total;
}

/**
 * Group wire messages into indivisible round units: an assistant
 * message carrying `tool_calls` travels with its `tool` replies (the
 * pairing OpenAI requires); everything else is a unit of one. The
 * leading system message is NOT a unit — the caller pins it.
 * @param {any[]} messages
 * @returns {any[][]}
 */
function roundUnits(messages) {
  /** @type {any[][]} */
  const units = [];
  for (let i = 0; i < messages.length; ) {
    const message = messages[i];
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const unit = [message];
      i++;
      while (i < messages.length && messages[i].role === 'tool') {
        unit.push(messages[i]);
        i++;
      }
      units.push(unit);
    }
    else {
      units.push([message]);
      i++;
    }
  }
  return units;
}

/**
 * The lines one dropped round contributes to a synopsis: one per tool
 * call (name, argument excerpt, result excerpt), or one for a plain
 * turn. Both writers share it, so the addressed synopsis says exactly
 * what the plain one says plus the address.
 * @param {any[]} unit
 * @returns {string[]}
 */
function unitLines(unit) {
  const head = unit[0];
  if (head.role === 'assistant' && Array.isArray(head.tool_calls)) {
    return head.tool_calls.map((call) => {
      const reply = unit.find((m) => m.role === 'tool' && m.tool_call_id === call.id);
      return `- called ${call.function?.name}(${excerpt(call.function?.arguments, 60)}) → ${excerpt(reply?.content, 60)}`;
    });
  }
  return [`- ${head.role}: ${excerpt(head.content, 60)}`];
}

/**
 * The built-in deterministic synopsis of dropped rounds: one line per
 * tool call (name, argument excerpt, result excerpt) or plain turn. No
 * second model call — a single-model local host runs unassisted.
 *
 * With no ledger this is the whole story and the excerpt is the only
 * copy — which is what `ledger` exists to fix; see `synopsizeAddressed`.
 * @param {any[][]} dropped
 * @returns {string}
 */
function synopsize(dropped) {
  const lines = ['[Earlier context was compacted to fit the history budget. What happened:]'];
  for (const unit of dropped) lines.push(...unitLines(unit));
  return lines.join('\n');
}

/** The allowance the ledger-free path holds back for the synopsis. */
const SYNOPSIS_RESERVE = 600;

/** The smallest synopsis the excess truncation will leave behind. */
const SYNOPSIS_FLOOR = 180;

/**
 * The largest share of the budget an addressed synopsis may claim: one
 * part in `SYNOPSIS_SHARE`, or `SYNOPSIS_RESERVE`, whichever is bigger.
 *
 * Without a cap the derived allowance is self-defeating at exactly the
 * budgets this order exists to improve. Forty archived rounds address
 * out to some 5 000 characters; at a 6 000-character budget the synopsis
 * would take the whole request and the recent tail — the context the
 * model is actually working in — would be squeezed to one round.
 * Measured at budget 6 000 on the benchmark's realistic payload shape,
 * uncapped kept 1 of 40 record values verbatim in a request of 5
 * messages; capped keeps 6, in a request of 15. Both recover 40 of 40,
 * because a
 * synopsis truncated past its per-round addresses still carries the
 * index address in its header. Paying a second `recall` hop for the
 * oldest rounds is the cheaper half of that trade.
 */
const SYNOPSIS_SHARE = 4;

/**
 * How many times the tail selection is re-run to settle its own
 * allowance. The allowance depends on how many rounds are dropped and
 * how many are dropped depends on the allowance; each pass can only
 * raise both, so the sequence climbs and settles — usually on the second
 * pass. A run that had not settled by the last one simply keeps the
 * largest allowance it reached, which is the safe end of the wobble.
 */
const RESERVE_PASSES = 4;

/**
 * Choose what survives: pin the system prompt and the first user
 * message, keep the largest round-aligned tail that fits, and report
 * the rounds in between as dropped. Returns null when nothing needs to
 * go — under budget, or with no droppable middle.
 *
 * `reserveFor` is the seam between the two callers: a flat number for
 * the ledger-free path (unchanged since it was written), and for the
 * ledger path the addressed synopsis's own size — which it can compute
 * exactly, because it is about to write it — under a cap.
 * @param {any[]} messages
 * @param {number} budget
 * @param {(dropped: any[][]) => number} reserveFor
 * @returns {{ pins: any[], dropped: any[][], tail: any[], kept: number } | null}
 */
function planCompaction(messages, budget, reserveFor) {
  let total = 0;
  for (const message of messages) total += sizeOf(message);
  if (total <= budget) return null;

  /** @type {any[]} */
  const pinnedSystem = [];
  let rest = messages;
  if (messages[0]?.role === 'system') {
    pinnedSystem.push(messages[0]);
    rest = messages.slice(1);
  }
  const units = roundUnits(rest);
  const firstUser = units.findIndex((unit) => unit[0].role === 'user');
  const pinned = pinnedSystem.reduce((n, m) => n + sizeOf(m), 0)
    + (firstUser >= 0 ? unitSize(units[firstUser]) : 0);

  // budget the pins plus room for the synopsis itself, then take tail
  // units (newest first) while they fit — always at least the last one
  const select = (reserve) => {
    let used = pinned + reserve;
    let cut = units.length;
    for (let k = units.length - 1; k > firstUser; k--) {
      const size = unitSize(units[k]);
      if (cut < units.length && used + size > budget) break;
      used += size;
      cut = k;
    }
    return cut;
  };

  let cut = select(reserveFor([]));
  for (let pass = 0; pass < RESERVE_PASSES; pass++) {
    const next = select(reserveFor(units.slice(firstUser + 1, cut)));
    if (next === cut) break;
    cut = next;
  }

  const dropped = units.slice(firstUser + 1, cut);
  if (dropped.length === 0) return null;
  const tail = units.slice(cut).flat();
  return {
    pins: [...pinnedSystem, ...(firstUser >= 0 ? units[firstUser] : [])],
    dropped,
    tail,
    kept: pinned + tail.reduce((n, m) => n + sizeOf(m), 0),
  };
}

/**
 * The compacted request: the pins, one synopsis message, the tail. The
 * synopsis takes exactly the room the plan reserved — whatever the
 * writer produced is truncated to the remaining allowance, so the budget
 * holds deterministically however long a writer runs on.
 * @param {{ pins: any[], tail: any[], kept: number }} plan
 * @param {string} content
 * @param {number} budget
 * @param {number} floor - the smallest synopsis worth keeping; the
 *   ledger path raises it so its header, which carries the index
 *   address, can never be the part that gets cut
 * @returns {any[]}
 */
function assemble(plan, content, budget, floor) {
  const synopsis = { role: 'assistant', content };
  const excess = plan.kept + sizeOf(synopsis) - budget;
  if (excess > 0) {
    synopsis.content = truncate(synopsis.content,
      Math.max(floor, synopsis.content.length - excess));
  }
  return [...plan.pins, synopsis, ...plan.tail];
}

/**
 * Fit the history into `budget` characters, destructively: the dropped
 * middle becomes one synopsis whose 60-character excerpts are the only
 * surviving trace of what those rounds found. Under budget the array
 * passes through untouched (same reference).
 * @param {any[]} messages
 * @param {number} budget
 * @param {(droppedRounds: any[][]) => string} compaction
 * @returns {any[]}
 */
function compactMessages(messages, budget, compaction) {
  const plan = planCompaction(messages, budget, () => SYNOPSIS_RESERVE);
  if (plan === null) return messages;
  return assemble(plan, compaction(plan.dropped), budget, SYNOPSIS_FLOOR);
}

//#endregion

//#region compaction that moves

/**
 * What one dropped round is worth archiving as: its exact bytes, and the
 * content-addressed name they hash to. Pure — nothing is written here,
 * because the tail selection needs the exact synopsis size before it can
 * decide what to drop, and the synopsis needs the addresses.
 * @param {any[][]} dropped
 * @returns {{ entries: any[], index: any }}
 */
function planArchive(dropped) {
  const entries = dropped.map((unit) => {
    const text = JSON.stringify(unit);
    return { name: roundSlotName(text), size: text.length, text, kind: 'agent-round' };
  });
  // the listing writes addresses in the SAME `recall("…")` form the
  // synopsis lines use: one address syntax, so following the index needs
  // no second reading rule — from a model or from anything auditing what
  // a request can still reach
  const lines = [`${entries.length} archived round(s) — recall(name) returns one in full.`];
  entries.forEach((entry, i) => lines.push(
    `${slotAddress(entry.name, entry.size)} ${unitLines(dropped[i])[0]?.slice(2) ?? ''}`));
  const text = lines.join('\n');
  return {
    entries,
    index: { name: indexSlotName(text), size: text.length, text, kind: 'agent-round-index' },
  };
}

/**
 * The addressed synopsis. Every line carries the address of the round it
 * previews, and the header carries the address of the index that lists
 * them all — which is the part that survives truncation, so a request
 * whose synopsis was cut short still names a way back to every round it
 * cut.
 * @param {any[][]} dropped
 * @param {{ entries: any[], index: any }} archive
 * @param {((droppedRounds: any[][], addresses: any[]) => string) | null} hostWriter
 * @returns {string}
 */
function synopsizeAddressed(dropped, archive, hostWriter) {
  const header = `[Earlier context was compacted. ${dropped.length} round(s) are ARCHIVED, `
    + `not lost: ${slotRef(archive.index.name)} lists every address; recall(name) returns`
    + ' one in full. What happened:]';
  if (hostWriter !== null) {
    return `${header}\n${hostWriter(dropped, archive.entries.map(
      ({ name, size, kind }) => ({ name, size, kind })))}`;
  }
  const lines = [header];
  dropped.forEach((unit, i) => {
    const own = unitLines(unit);
    const address = slotAddress(archive.entries[i].name, archive.entries[i].size);
    // a round the plain writer has nothing to say about still gets its
    // address — the whole promise is that no round leaves unaddressed,
    // and `unitLines` says nothing about an assistant turn that carries
    // an EMPTY `tool_calls` array (which the loop never writes, but a
    // host's persisted history can)
    if (own.length === 0) {
      lines.push(`- ${address}`);
    }
    else {
      own[own.length - 1] += ` ${address}`;
      lines.push(...own);
    }
  });
  return lines.join('\n');
}

/**
 * Write the archive. A slot whose name and size are already there holds
 * the same bytes by construction (the name IS the hash of those bytes
 * paired with their length), so re-compacting a history rewrites
 * nothing — idempotence falls out of the addressing rather than out of a
 * de-duplication pass.
 *
 * A store that refuses a write is fatal and says so: the whole point of
 * this path is that nothing leaves the request without a copy, and
 * carrying on would drop the round anyway while claiming an address for
 * it that answers nothing.
 * @param {any} ledger
 * @param {{ entries: any[], index: any }} archive
 */
async function writeArchive(ledger, archive, referenceText, protectedNames) {
  if (typeof ledger.putArchive === 'function') {
    const written = await ledger.putArchive([...archive.entries, archive.index], { referenceText, protectedNames });
    if (written?.error) throw new AiError('AI0001', `compaction could not archive rounds: ${written.error}`);
    return;
  }
  for (const entry of [...archive.entries, archive.index]) {
    const existing = await ledger.getSlot(entry.name);
    if (existing !== null && existing !== undefined && existing.size === entry.size) continue;
    const written = await ledger.putSlot(entry.name, entry.text, { kind: entry.kind });
    if (written?.error !== undefined) {
      throw new AiError('AI0001',
        `compaction could not archive a round to slot '${entry.name}': ${written.error}`);
    }
  }
}

/**
 * Fit the history into `budget` characters WITHOUT destroying anything:
 * every dropped round is archived to an addressable slot first, and the
 * synopsis that replaces it carries the address. The excerpt stops being
 * a summary and becomes a preview of something a `recall` can fetch.
 *
 * The allowance is derived from the rounds being dropped rather than
 * flat, because the addresses make the synopsis grow with their number
 * and a fixed 600 would stop holding. With the built-in writer the
 * allowance is the synopsis's EXACT size — pure string work over a known
 * set of rounds, so the budget is spent to the character instead of
 * guessed at. A host writer is only ESTIMATED, by what the built-in
 * writer would have produced, and is then called once at the end: a hook
 * that talked to a model must not be run several times per request by
 * the settling loop, and whatever it returns is truncated to the
 * allowance anyway.
 * @param {any[]} messages
 * @param {number} budget
 * @param {((droppedRounds: any[][], addresses: any[]) => string) | null} hostWriter
 * @param {any} ledger
 * @param {{ index?: string }} recallOptions - updated with the current
 *   index address, so an unknown-slot rejection can point at the listing
 * @returns {Promise<any[]>}
 */
async function compactToLedger(messages, budget, hostWriter, ledger, recallOptions) {
  const ceiling = Math.max(SYNOPSIS_RESERVE, Math.floor(budget / SYNOPSIS_SHARE));
  const reserveFor = (dropped) => Math.min(ceiling, sizeOf({
    role: 'assistant',
    content: synopsizeAddressed(dropped, planArchive(dropped),
      hostWriter === null ? null : () => synopsize(dropped)),
  }));
  const plan = planCompaction(messages, budget, reserveFor);
  if (plan === null) return messages;

  const archive = planArchive(plan.dropped);
  const retained = [...plan.pins, ...plan.tail];
  await writeArchive(ledger, archive, JSON.stringify(retained),
    slotAddressesIn(retained.map((message) => message.content ?? '').join('\n')));
  recallOptions.index = archive.index.name;

  const content = synopsizeAddressed(plan.dropped, archive, hostWriter);
  return assemble(plan, content, budget,
    Math.max(SYNOPSIS_FLOOR, content.indexOf('\n') + 1 || content.length));
}

/**
 * A private toolbox holding just `recall`: the tool's schema compiles
 * once per agent, and a call to it answers `{ error }` under exactly the
 * rules every host tool answers under, because it goes through the same
 * registry. `options` is read at call time, so each compaction can point
 * an unknown-address rejection at the index it just wrote.
 * @param {any} ledger
 */
function recallToolbox(ledger) {
  /** @type {{ index?: string }} */
  const options = {};
  const box = createToolbox();
  box.add(createRecallTool(ledger, options));
  return { box, options };
}

//#endregion
