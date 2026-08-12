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
 */

import { AiError } from './errors.js';
import { createToolbox } from './toolbox.js';
import {
  RECALL_TOOL_NAME, createRecallTool, roundSlotName, indexSlotName, slotAddress, slotRef,
} from './recall.js';

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
 *   original lossy path runs unchanged.
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
  const ledger = options.ledger ?? null;
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

  /**
   * One tool call, to `recall` or to the host's toolbox. `recall` is
   * dispatched here rather than being added to the host's registry
   * because the host's toolbox belongs to the host: an agent may not
   * quietly grow it a tool that outlives the agent.
   * @param {string} name
   * @param {any} args
   * @param {boolean} recalling - whether this agent listed `recall`
   */
  async function dispatch(name, args, recalling) {
    if (recalling && name === RECALL_TOOL_NAME) return recallBox.box.execute(name, args);
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
    const tools = recalling
      ? [...hostTools, ...recallBox.box.toFunctionTools()]
      : hostTools;
    /** @type {any[]} */
    const steps = [];

    for (let round = 0; ; round++) {
      const completion = await client.complete({
        messages: historyBudget === undefined
          ? messages
          : ledger === null
            ? compactMessages(messages, historyBudget, compaction)
            : await compactToLedger(messages, historyBudget, hostCompaction,
              ledger, recallBox.options),
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
        const result = parsed.error !== undefined
          ? parsed
          : await dispatch(call.name, parsed.value, recalling);
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

/** @param {any[]} unit */
function unitSize(unit) {
  let total = 0;
  for (const message of unit) total += messageSize(message);
  return total;
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
  for (const message of messages) total += messageSize(message);
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
  const pinned = pinnedSystem.reduce((n, m) => n + messageSize(m), 0)
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
    kept: pinned + tail.reduce((n, m) => n + messageSize(m), 0),
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
  const excess = plan.kept + messageSize(synopsis) - budget;
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
async function writeArchive(ledger, archive) {
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
  const sizeOf = (dropped) => Math.min(ceiling, messageSize({
    role: 'assistant',
    content: synopsizeAddressed(dropped, planArchive(dropped),
      hostWriter === null ? null : () => synopsize(dropped)),
  }));
  const plan = planCompaction(messages, budget, sizeOf);
  if (plan === null) return messages;

  const archive = planArchive(plan.dropped);
  await writeArchive(ledger, archive);
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
