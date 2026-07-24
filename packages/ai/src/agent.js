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
 * @property {(call: { name: string, arguments: string }) => void} [onToolCall]
 * @property {(step: { name: string, result: any }) => void} [onToolResult]
 * @property {AbortSignal} [signal]
 */

/**
 * @param {{ client: { complete: (request: any) => Promise<any> },
 *   toolbox?: { toFunctionTools: () => any[], execute: (name: string, args: any) => any } | null,
 *   system?: string, maxToolRounds?: number, maxToolResultChars?: number }} options
 * @returns {{ send: (history: any[], hooks?: AgentHooks) => Promise<{
 *   message: any, messages: any[], steps: any[], stopReason: string }> }}
 */
export function createAgent(options) {
  const client = options.client;
  const toolbox = options.toolbox ?? null;
  const system = options.system ?? '';
  const maxToolRounds = options.maxToolRounds ?? 5;
  const maxToolResultChars = options.maxToolResultChars ?? 8000;

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
        messages,
        tools: tools.length > 0 ? tools : undefined,
        onDelta: hooks.onDelta,
        signal: hooks.signal,
      });
      const reply = completion.message;

      if (reply.toolCalls === null || reply.toolCalls === undefined
        || reply.toolCalls.length === 0) {
        const message = { role: 'assistant', content: reply.content };
        messages.push(message);
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
