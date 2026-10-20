//@ts-check
/**
 * The studio's system calls: the board, the post office, the library,
 * the crew game, the arcade, the camera and the light — the operations
 * `os.contract.json` adds beside the machine and the council. Like those,
 * they are the only road in: the buttons a person presses and the tool
 * calls a language model makes arrive here alike, validated by the same
 * contract, and leave as one action replacing the slice they changed.
 *
 * The human's prerogatives stay the human's: starting a project, adding
 * ideas, ending a turn and the review are `audience: "server"`
 * operations, absent from every tool projection — the crew builds, the
 * people decide.
 */

import { addCard, editCard, linkCards, removeItem, blockedCards, emptyBoard } from './board.js';
import { postMail, readThread, threadSummaries, emptyMail } from './mail.js';
import { readSections } from './library.js';
import { BLOCK_CATALOG, describeBlock } from './blocks.js';
import { newProject, addIdea, endTurn, build, crewDone, review, CREW } from './crew.js';

/**
 * @typedef {{
 *   getState: () => any, dispatch: (action: string, payload?: any) => void, now: () => number,
 *   library: () => ({ library: import('./library.js').Library, index: ReturnType<typeof import('./library.js').createLibraryIndex> } | null),
 *   arcade: () => ({ read: () => any, tool: (name: string, input: any) => { ok: boolean, result?: any, error?: string } } | null),
 *   reply?: (thread: string, text: string, from: string) => void,
 * }} StudioHost
 */

/** Who a seat is, in a mail header. */
const SEAT_NAMES = /** @type {Record<string, string>} */ ({
  human: 'You', oracle: 'Oracle', painter: 'Painter', dancer: 'Dancer', critic: 'Critic', architect: 'Architect',
});

/** @param {string} seat */
export const seatName = (seat) => SEAT_NAMES[seat] ?? seat;

/**
 * Post into the OS's mail and publish the new post office.
 * @param {StudioHost} host @param {Parameters<typeof postMail>[1]} post
 */
export function post(host, post) {
  const mail = host.getState().mail ?? emptyMail();
  const out = postMail({ threads: mail.threads, seq: mail.seq }, post);
  host.dispatch('mail/set', out.mail);
  return out;
}

/**
 * The studio's handlers, keyed by operation id.
 * @param {StudioHost} host
 * @returns {Record<string, (input: any, ctx: any) => any>}
 */
export function createStudioHandlers(host) {
  const board = () => host.getState().board ?? emptyBoard();
  /** @param {any} next */
  const setBoard = (next) => host.dispatch('board/set', next);
  const project = () => host.getState().crew?.project ?? null;
  /** @param {any} next */
  const setProject = (next) => host.dispatch('crew/set', next);
  /** The idea's thread in the post office. @param {string} idea */
  const ideaThread = (idea) => `crew-${project()?.id ?? 'project'}-${idea}`;

  return {
    'board.read': () => {
      const b = board();
      const blocked = blockedCards(b);
      return { cards: b.cards.map((c) => ({ ...c, blocked: blocked.has(c.id) })), links: b.links };
    },
    'board.add': (input, ctx) => {
      const out = addCard(board(), { ...input, by: input.by });
      if ('error' in out) return ctx.fail(out.error);
      setBoard(out.board);
      return { id: out.id };
    },
    'board.edit': (input, ctx) => {
      const out = editCard(board(), input);
      if ('error' in out) return ctx.fail(out.error);
      setBoard(out.board);
      return { id: input.id };
    },
    'board.link': (input, ctx) => {
      const out = linkCards(board(), input);
      if ('error' in out) return ctx.fail(out.error);
      setBoard(out.board);
      return { id: out.id };
    },
    'board.remove': (input, ctx) => {
      const out = removeItem(board(), input.id);
      if ('error' in out) return ctx.fail(out.error);
      setBoard(out.board);
      return { removed: input.id };
    },

    'mail.read': (input, ctx) => {
      const mail = host.getState().mail ?? emptyMail();
      if (input?.thread) {
        const thread = mail.threads.find((/** @type {any} */ t) => t.id === input.thread);
        if (!thread) return ctx.fail('not-found');
        const [summary] = threadSummaries({ threads: [thread], seq: 0 });
        host.dispatch('mail/set', readThread(mail, thread.id));
        return { thread: summary, messages: thread.messages };
      }
      return { threads: threadSummaries(mail, input?.folder ?? 'all') };
    },
    'mail.send': (input, ctx) => {
      const mail = host.getState().mail ?? emptyMail();
      if (input.thread && !mail.threads.some((/** @type {any} */ t) => t.id === input.thread)) return ctx.fail('not-found');
      const to = input.to ?? ['oracle'];
      const out = post(host, { thread: input.thread ?? null, subject: input.subject, folder: 'inbox', from: input.by, to, text: input.text, at: host.now() });
      if (input.by === 'human' && to.includes('oracle')) host.reply?.(out.thread, input.text, 'oracle');
      return { thread: out.thread, id: out.message };
    },

    'library.search': (input, ctx) => {
      const lib = host.library();
      if (!lib) return ctx.fail('unavailable');
      return { hits: lib.index.search(input.query, input.limit ?? 5) };
    },
    'library.read': (input, ctx) => {
      const lib = host.library();
      if (!lib) return ctx.fail('unavailable');
      const page = readSections(lib.library, input.doc, input.from ?? 0, input.count ?? 2);
      if (!page) return ctx.fail('not-found');
      return page;
    },

    'crew.read': () => ({ project: project(), catalog: BLOCK_CATALOG.map((b) => ({ ...b })) }),
    'crew.start': (input) => {
      const p = newProject({ id: `project-${host.now().toString(36)}`, title: input.title, brief: input.brief, players: input.players, goal: input.goal });
      setProject(p);
      post(host, { thread: `crew-${p.id}`, subject: `Project: ${p.title}`, folder: 'crew', from: 'architect', to: ['human'], at: host.now(),
        text: `We are your crew for “${p.title}”. ${p.players.map((e) => e.name).join(', ')}: add your ideas in plain words, and we will build them a block at a time. ${p.goal} approved blocks ship it.` });
      return { id: p.id };
    },
    'crew.idea': (input, ctx) => {
      const p = project();
      if (!p) return ctx.fail('no-project');
      const out = addIdea(p, input);
      if ('error' in out) return ctx.fail(out.error);
      setProject(out.project);
      const by = p.players[p.turn]?.name ?? 'An employer';
      post(host, { thread: `crew-${p.id}-${out.id}`, subject: `Idea: ${input.text}`, folder: 'crew', from: 'human', to: CREW.map((c) => c.id), at: host.now(), text: `${by}: ${input.text}` });
      return { id: out.id };
    },
    'crew.end': (_input, ctx) => {
      const p = project();
      if (!p) return ctx.fail('no-project');
      const out = endTurn(p);
      if ('error' in out) return ctx.fail(out.error);
      setProject(out.project);
      if (out.effects.includes('crew-turn')) host.dispatch('crew/turn', out.project.id);
      return { phase: out.project.phase };
    },
    'crew.build': (input, ctx) => {
      const p = project();
      if (!p) return ctx.fail('no-project');
      const out = build(p, input);
      if ('error' in out) return ctx.fail(out.error);
      setProject(out.project);
      post(host, { thread: ideaThread(input.idea), subject: 'Idea', folder: 'crew', from: input.by, to: ['human'], at: host.now(),
        text: `${seatName(input.by)} built ${describeBlock(input.block)}.`, tool: { name: 'crew.build', ok: true, chars: JSON.stringify(input.block).length, chunks: 1 } });
      host.dispatch('studio/cheer', input.by);
      return { task: out.task };
    },
    'crew.say': (input, ctx) => {
      const p = project();
      if (!p) return ctx.fail('no-project');
      const out = post(host, { thread: input.idea ? ideaThread(input.idea) : `crew-${p.id}`, subject: p.title, folder: 'crew', from: input.by, to: ['human'], at: host.now(), text: input.text });
      return { id: out.message };
    },
    'crew.done': (_input, ctx) => {
      const p = project();
      if (!p) return ctx.fail('no-project');
      const out = crewDone(p);
      if ('error' in out) return ctx.fail(out.error);
      setProject(out.project);
      return { phase: out.project.phase };
    },
    'crew.review': (input, ctx) => {
      const p = project();
      if (!p) return ctx.fail('no-project');
      const out = review(p, input);
      if ('error' in out) return ctx.fail(out.error);
      setProject(out.project);
      if (out.effects.includes('launch')) host.dispatch('crew/launched', out.project);
      return out.project.phase === 'shipped' ? { phase: 'shipped', stars: out.project.stars } : { phase: out.project.phase };
    },

    'arcade.read': () => {
      const arcade = host.arcade();
      return arcade ? arcade.read() : { game: null, phase: 'title', hud: null, tools: [] };
    },
    'arcade.tool': (input, ctx) => {
      const arcade = host.arcade();
      if (!arcade || arcade.read().game === null) return ctx.fail('no-game');
      const out = arcade.tool(input.name, input.input ?? {});
      if (!out.ok) return ctx.fail(out.error === 'invalid' ? 'invalid' : 'not-found');
      return { result: out.result };
    },

    'studio.camera': (input) => {
      host.dispatch('studio/shot', input.shot);
      return { shot: input.shot };
    },
    'studio.light': (input) => {
      const light = host.getState().settings?.light ?? { hour: 10, bands: 3 };
      const hour = input.hour ?? light.hour;
      const bands = input.bands ?? light.bands;
      host.dispatch('settings/light', { hour, bands });
      return { hour, bands };
    },
  };
}
