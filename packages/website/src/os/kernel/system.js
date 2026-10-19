//@ts-check
/**
 * The system call table: `os.contract.json` compiled once, served
 * in-process, and the one way anything — the human's buttons, a local
 * member, a language model behind WebMCP or a Tangle client — asks the
 * OS to do something.
 *
 * Every call is validated on the way in and on the way out by the same
 * compiled contract, so a model's malformed proposal is refused with a
 * pointer to the member that broke it before any handler runs, and a
 * handler that answered off-contract is a fault, not a render. Three
 * operations are the human's alone — the veto, the early approval and
 * the repeal — and carry `audience: "server"`: they are served like the
 * rest but kept out of every projection, so no tool list an agent is
 * handed contains them. The input schema says the same thing a second
 * time (`by` must be `human`).
 */

import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { contractTools } from '@jarenjs/contract/project';
import { JarenValidator } from '@jarenjs/validate';
import { renderToString } from '@jarenjs/view';
import contractDoc from '../documents/os.contract.json' with { type: 'json' };
import { MEMBERS, describeChange, fitsProgram, isTempo } from './council.js';
import { programStates, isProgram } from './program.js';
import { isWorld } from './machine.js';
import { renderArt, FORMATS } from './exports.js';
import { roundMeasure } from './metrics.js';
import { QUEUE_MAX } from './session.js';
import { sceneOf } from '../app/scene.js';
import { stillFrame } from '../stage/widget.js';
import { createStudioHandlers } from './studio.js';

/** The OS contract, compiled with a collecting validator. */
export const osContract = compileContract(contractDoc, { validator: new JarenValidator({ collectErrors: true }) });

/** The operations any caller may be told about — every one but the
 * human's, read from the document's own policy. */
const PUBLIC_OPERATIONS = Object.freeze(Object.entries(contractDoc.operations)
  .filter(([, op]) => /** @type {any} */ (op).policy?.audience !== 'server')
  .map(([id]) => id));

/** A proposal validator compiled from the contract's own `$defs`, for
 * proposals that arrive by another road than `council.propose` (the
 * oracle seam). */
const proposalCheck = new JarenValidator().compile({ $defs: contractDoc.$defs, $ref: '#/$defs/Proposal' });

/** @param {any} proposal */
export const isProposal = (proposal) => proposalCheck(proposal) === true;

/**
 * @typedef {{ edition: string, title: string, getState: () => any, dispatch: (action: string, payload?: any) => void,
 *   council: ReturnType<typeof import('./session.js').createCouncilDriver>,
 *   store: { invoke: (op: string, input?: any) => Promise<any> } | null,
 *   ids?: () => string, now?: () => number,
 *   library?: import('./studio.js').StudioHost['library'], arcade?: import('./studio.js').StudioHost['arcade'],
 *   reply?: import('./studio.js').StudioHost['reply'] }} SystemHost
 */

/**
 * Bind the contract to a running OS.
 * @param {SystemHost} host
 */
export function createSystem(host) {
  let counter = 0;
  const nextId = host.ids ?? (() => `${Date.now().toString(36)}-${(counter++).toString(36)}`);

  /** Call the storage port; a refusal there is this contract's `storage` failure.
   * @param {any} ctx @param {string} op @param {any} [input] */
  async function stored(ctx, op, input) {
    if (!host.store) return ctx.fail('storage', null, { reason: 'no database is attached' });
    const outcome = await host.store.invoke(op, input);
    if (!outcome.ok) return ctx.fail('storage', null, { reason: outcome.error?.message ?? 'the database refused' });
    return { value: outcome.value };
  }

  /** @type {Record<string, (input: any, ctx: any) => any>} */
  const handlers = {
    'os.describe': () => {
      const state = host.getState();
      return {
        edition: host.edition,
        title: host.title,
        members: membersOf(state),
        operations: [...PUBLIC_OPERATIONS],
      };
    },

    'machine.read': (input) => {
      const state = host.getState();
      return {
        program: state.program.machine,
        tempo: state.program.tempo,
        running: state.machine.running,
        tick: state.world.tick,
        width: state.world.width,
        height: state.world.height,
        heads: state.world.heads,
        ...(input?.tape ? { tape: state.world.tape } : {}),
        measure: roundMeasure(state.machine.measure),
      };
    },

    'machine.control': (input) => {
      const state = host.getState();
      if (input.action === 'step') {
        host.dispatch('machine/tick', { steps: input.steps ?? 1 });
        return { running: state.machine.running, tick: state.world.tick + (input.steps ?? 1) };
      }
      host.dispatch('machine/run', input.action === 'run');
      return { running: input.action === 'run', tick: state.world.tick };
    },

    'council.read': () => sessionOf(host.getState()),

    'council.propose': (input, ctx) => {
      const state = host.getState();
      const change = input.change;
      if (!fitsProgram(change, state.program.machine)) {
        return ctx.fail('unknown-state', null, { states: programStates(state.program.machine) });
      }
      const queue = state.council.queue ?? [];
      if (queue.length >= QUEUE_MAX) return ctx.fail('queue-full', null, { max: QUEUE_MAX });
      const proposal = {
        id: `${input.by}-q${nextId()}`,
        by: input.by,
        title: input.title ?? describeChange(change),
        why: input.why ?? '',
        change,
      };
      host.dispatch('council/enqueue', proposal);
      return { id: proposal.id, queued: queue.length + 1 };
    },

    'council.say': (input) => {
      const id = `m${nextId()}`;
      host.dispatch('council/said', { id, by: input.by, text: input.text, at: new Date().toISOString() });
      return { id };
    },

    'council.convene': async (_input, ctx) => {
      if (host.council.open) return ctx.fail('in-session');
      const result = await host.council.convene();
      if (!result) return ctx.fail('in-session');
      return result;
    },

    'council.veto': async (input, ctx) => {
      const session = host.getState().council.session;
      if (!(await host.council.verdict('veto', input.proposal))) return ctx.fail('not-awaiting');
      return { session, vetoed: input.proposal };
    },

    'council.approve': async (input, ctx) => {
      const session = host.getState().council.session;
      if (!(await host.council.verdict('approve', input.proposal))) return ctx.fail('not-awaiting');
      return { session, enacted: input.proposal };
    },

    'council.repeal': (input, ctx) => {
      const result = host.council.repeal(input.amendment);
      if (result !== 'repealed') return ctx.fail(result);
      return { repealed: input.amendment };
    },

    'art.export': async (input) => {
      const state = host.getState();
      const svg = renderToString(stillFrame(sceneOf(state), { width: 1200, height: 800, title: `Radiant OS at tick ${state.world.tick}` }));
      const format = /** @type {keyof typeof FORMATS} */ (input.format);
      const meta = FORMATS[format];
      if (format === 'svg') return { name: meta.name, mime: meta.mime, text: svg };
      const art = await renderArt(state, { svg });
      return { name: meta.name, mime: meta.mime, text: art[format] };
    },

    'gallery.save': async (input, ctx) => {
      const state = host.getState();
      const at = new Date().toISOString();
      const artwork = {
        id: `art-${nextId()}`,
        title: input.title,
        at,
        tick: state.world.tick,
        harmony: Math.round((state.machine.measure?.harmony ?? 0) * 10000) / 10000,
        world: state.world,
        program: { machine: state.program.machine, tempo: state.program.tempo },
        merits: state.council.merits,
      };
      const result = await stored(ctx, 'artwork.put', { artwork });
      if (!('value' in result)) return result;
      host.dispatch('gallery/saved', { id: artwork.id, title: artwork.title, at, harmony: artwork.harmony, tick: artwork.tick });
      return { id: artwork.id, at };
    },

    'gallery.list': async (_input, ctx) => {
      const result = await stored(ctx, 'artwork.list');
      if (!('value' in result)) return result;
      const info = await host.store?.invoke('store.info');
      return { items: result.value, storage: info?.ok ? info.value.mode : 'unknown' };
    },

    'gallery.open': async (input, ctx) => {
      const result = await stored(ctx, 'artwork.get', { id: input.id });
      if (!('value' in result)) return result;
      const kept = result.value;
      if (kept === null) return ctx.fail('not-found');
      // a kept artwork is data at rest: put back only what this OS can run
      if (!isProgram(kept.program?.machine) || !isTempo(kept.program.tempo) || !isWorld(kept.world)) return ctx.fail('unreadable');
      host.dispatch('gallery/opened', kept);
      return { opened: input.id };
    },
  };

  // the studio's operations: the board, mail, the library, the crew, the arcade, camera and light
  Object.assign(handlers, createStudioHandlers({
    getState: host.getState,
    dispatch: host.dispatch,
    now: host.now ?? (() => Date.now()),
    library: host.library ?? (() => null),
    arcade: host.arcade ?? (() => null),
    ...(host.reply ? { reply: host.reply } : {}),
  }));

  const client = openLocalClient(osContract, handlers, {
    validateOutput: 'always',
    // the in-process binding needs no globally unique trace; a counter
    // keeps every call traceable without reaching for crypto.randomUUID
    // (absent on a plain-HTTP origin)
    trace: () => `os-${(counter++).toString(36)}`,
  });

  return {
    contract: osContract,
    client,
    handlers,
    /**
     * The contract as agent tools — every public operation, none of the
     * human's. `by` is the seat the agent sits in: it is no part of what
     * a tool asks for (one field fewer for a small model to get right)
     * and every call that speaks is pinned to that seat, so a tool call
     * can speak for no one else.
     * @param {{ seat?: string, prefix?: string }} [options]
     */
    tools(options = {}) {
      const seat = options.seat ?? 'oracle';
      const prefix = options.prefix ?? 'radiant_';
      return contractTools(osContract, client, { name: (/** @type {string} */ id) => `${prefix}${id.replace(/\./g, '_')}` })
        .map((/** @type {any} */ tool) => {
          const schema = tool.inputSchema;
          if (!schema?.properties?.by) return tool;
          const { by: _seat, ...properties } = schema.properties;
          return {
            ...tool,
            inputSchema: { ...schema, properties, required: (schema.required ?? []).filter((/** @type {string} */ k) => k !== 'by') },
            execute: (/** @type {any} */ args, /** @type {any} */ ctx) => tool.execute({ ...(args && typeof args === 'object' ? args : {}), by: seat }, ctx),
          };
        });
    },
  };
}

/** The council's members with their merits.
 * @param {any} state */
export function membersOf(state) {
  return MEMBERS.map((m) => ({
    id: m.id, name: m.name, taste: m.taste, motto: m.motto,
    merit: Math.round((Number(state.council.merits?.[m.id]) || 1) * 1000) / 1000,
  }));
}

/** The `council.read` answer.
 * @param {any} state */
export function sessionOf(state) {
  const c = state.council;
  return {
    phase: c.phase,
    session: c.session,
    members: membersOf(state),
    proposals: (c.proposals ?? []).map(stripScore),
    winner: c.winner ? stripScore(c.winner) : null,
    deadline: c.deadline ?? null,
    log: (c.log ?? []).slice(0, 12).map((/** @type {any} */ a) => ({
      id: a.id, session: a.session, by: a.by, title: a.title, status: a.status, change: a.change,
      score: a.score ?? 0, reward: a.reward ?? null,
    })),
  };
}

/** A proposal as the contract's Proposal schema states it.
 * @param {any} p */
const stripScore = (p) => ({ id: p.id, by: p.by, title: p.title, why: p.why ?? '', change: p.change });
