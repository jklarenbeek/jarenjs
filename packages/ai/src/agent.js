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
 */

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
 *   historyBudget?: number,
 *   compaction?: (droppedRounds: any[][]) => string }} options
 *   - `historyBudget` caps the request history in CHARACTERS (tokens
 *   are provider-private; characters are deterministic). When a
 *   request would exceed it, the middle of the conversation is
 *   replaced by one synopsis message; the system prompt, the first
 *   user message and the largest tail that fits always survive, and
 *   cuts happen only at tool-round boundaries so `tool_calls`/`tool`
 *   pairing stays wire-legal. `compaction` replaces the built-in
 *   synopsis writer (it receives the dropped rounds, each an array of
 *   wire messages). The returned transcript is always the FULL,
 *   uncompacted history.
 * @returns {{ send: (history: any[], hooks?: AgentHooks) => Promise<{
 *   message: any, messages: any[], steps: any[], stopReason: string }> }}
 */
export function createAgent(options) {
  const client = options.client;
  const toolbox = options.toolbox ?? null;
  const system = options.system ?? '';
  const maxToolRounds = options.maxToolRounds ?? 5;
  const maxToolResultChars = options.maxToolResultChars ?? 8000;
  const historyBudget = options.historyBudget;
  const compaction = options.compaction ?? synopsize;

  /**
   * @param {any[]} history
   * @param {AgentHooks} [hooks]
   */
  async function send(history, hooks = {}) {
    const messages = system !== '' && history[0]?.role !== 'system'
      ? [{ role: 'system', content: system }, ...history]
      : [...history];
    const tools = toolbox !== null ? toolbox.toFunctionTools() : [];
    /** @type {any[]} */
    const steps = [];

    for (let round = 0; ; round++) {
      const completion = await client.complete({
        messages: historyBudget === undefined
          ? messages
          : compactMessages(messages, historyBudget, compaction),
        tools: tools.length > 0 ? tools : undefined,
        onDelta: hooks.onDelta,
        onReasoning: hooks.onReasoning,
        signal: hooks.signal,
      });
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
        const result = parsed.error !== undefined || toolbox === null
          ? (parsed.error !== undefined ? parsed : { error: 'no tools are available' })
          : await toolbox.execute(call.name, parsed.value);
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

  return { send };
}

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

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

//#region history compaction

/** @param {any} message */
function messageSize(message) {
  return JSON.stringify(message).length;
}

/** A one-line excerpt: newlines collapsed, hard-capped. */
function excerpt(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
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
 * The built-in deterministic synopsis of dropped rounds: one line per
 * tool call (name, argument excerpt, result excerpt) or plain turn. No
 * second model call — a single-model local host runs unassisted.
 * @param {any[][]} dropped
 * @returns {string}
 */
function synopsize(dropped) {
  const lines = ['[Earlier context was compacted to fit the history budget. What happened:]'];
  for (const unit of dropped) {
    const head = unit[0];
    if (head.role === 'assistant' && Array.isArray(head.tool_calls)) {
      for (const call of head.tool_calls) {
        const reply = unit.find((m) => m.role === 'tool' && m.tool_call_id === call.id);
        lines.push(`- called ${call.function?.name}(${excerpt(call.function?.arguments, 60)}) → ${excerpt(reply?.content, 60)}`);
      }
    }
    else {
      lines.push(`- ${head.role}: ${excerpt(head.content, 60)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Fit the history into `budget` characters: pin the system prompt and
 * the first user message, keep the largest round-aligned tail that
 * fits, and replace the dropped middle with one synopsis message.
 * Under budget the array passes through untouched (same reference).
 * @param {any[]} messages
 * @param {number} budget
 * @param {(droppedRounds: any[][]) => string} compaction
 * @returns {any[]}
 */
function compactMessages(messages, budget, compaction) {
  let total = 0;
  for (const message of messages) total += messageSize(message);
  if (total <= budget) return messages;

  /** @type {any[]} */
  const pinnedSystem = [];
  let rest = messages;
  if (messages[0]?.role === 'system') {
    pinnedSystem.push(messages[0]);
    rest = messages.slice(1);
  }
  const units = roundUnits(rest);
  const firstUser = units.findIndex((unit) => unit[0].role === 'user');

  // budget the pins plus room for the synopsis itself, then take tail
  // units (newest first) while they fit — always at least the last one
  let used = pinnedSystem.reduce((n, m) => n + messageSize(m), 0)
    + (firstUser >= 0 ? unitSize(units[firstUser]) : 0)
    + 600;
  let cut = units.length;
  for (let k = units.length - 1; k > firstUser; k--) {
    const size = unitSize(units[k]);
    if (cut < units.length && used + size > budget) break;
    used += size;
    cut = k;
  }
  const dropped = units.slice(firstUser + 1, cut);
  if (dropped.length === 0) return messages;

  // the synopsis takes exactly the room the loop reserved: whatever
  // the writer (built-in or host hook) produced is truncated to the
  // remaining allowance so the budget holds deterministically
  const tail = units.slice(cut).flat();
  const kept = pinnedSystem.reduce((n, m) => n + messageSize(m), 0)
    + (firstUser >= 0 ? unitSize(units[firstUser]) : 0)
    + tail.reduce((n, m) => n + messageSize(m), 0);
  const synopsis = { role: 'assistant', content: compaction(dropped) };
  const excess = kept + messageSize(synopsis) - budget;
  if (excess > 0) {
    synopsis.content = truncate(synopsis.content,
      Math.max(180, synopsis.content.length - excess));
  }

  return [
    ...pinnedSystem,
    ...(firstUser >= 0 ? units[firstUser] : []),
    synopsis,
    ...tail,
  ];
}

/** @param {any[]} unit */
function unitSize(unit) {
  let total = 0;
  for (const message of unit) total += messageSize(message);
  return total;
}

//#endregion
