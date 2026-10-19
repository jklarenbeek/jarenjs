//@ts-check
/**
 * The studio's side of the OS host: the effects its action documents
 * name (sound and music, the pause hold, reading aloud, asking the docs,
 * the crew's turn, experience, what the games report), the subscriptions
 * that keep time for it (the coach watching its signals, the toast and
 * the spotlight fading), its widgets (the board, a built app, the
 * arcade) and the hooks the contract's studio handlers read (the
 * library, the arcade, the oracle's reply to a letter).
 *
 * Nothing here needs a browser either: sound, speech and the library are
 * handed in by the bootstrap and simply absent in a test, where every
 * effect still runs and says what it would have done.
 */

import { post } from '../kernel/studio.js';
import { createLibraryIndex, answerFromDocs, speechOf, isLibrary } from '../kernel/library.js';
import { scriptedCrew } from '../kernel/crew.js';
import { advanceCoach, COACH_SIGNALS } from '../kernel/coach.js';
import { award, rate } from '../kernel/ladder.js';
import { tapeMelody } from '../engine/audio.js';
import { createArcade } from '../games/arcade.js';
import { boardWidget } from '../stage/board-widget.js';
import { miniWidget } from '../stage/mini-widget.js';

/**
 * @typedef {import('../kernel/library.js').Library} Library
 * @typedef {{ speak: (lines: string[], hooks: { sentence: (i: number) => void, end: () => void }) => void, cancel: () => void }} Speech
 * @typedef {{
 *   getState: () => any, dispatch: (action: string, payload?: any) => void,
 *   timers: { setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void },
 *   now: () => number,
 *   council: { hold: (on: boolean) => void },
 *   invoke: (op: string, input?: any) => Promise<any>,
 *   games?: Record<string, import('../games/game.js').GameModule>,
 *   audio?: ReturnType<typeof import('../engine/audio.js').createAudio> | null,
 *   speech?: Speech | null,
 *   loadLibrary?: (() => Promise<Library | null>) | null,
 *   askDocs?: ((question: string, hits: any[]) => Promise<{ text: string, citations: any[] }>) | null,
 *   crewTurn?: ((project: any) => Promise<boolean>) | null,
 *   onBudget?: (tier: string) => void,
 *   report: (error: any) => void,
 * }} StudioHostOptions
 */

/** Which ladder area each game reports into. */
const AREAS = /** @type {Record<string, string>} */ ({ grove: 'math', dancers: 'turing', arena: 'ai' });

/** The pause between two of the scripted crew's moves, ms — long enough to watch. */
export const CREW_BEAT_MS = 650;

/**
 * Build the studio's host.
 * @param {StudioHostOptions} o
 */
export function createStudioHost(o) {
  const games = o.games ?? {};
  const audio = o.audio ?? null;
  const arcade = createArcade({ games, audio, now: o.now });
  /** @type {{ library: Library, index: ReturnType<typeof createLibraryIndex> } | null} */
  let library = null;
  /** @type {Promise<boolean> | null} */
  let loading = null;
  let questions = 0;
  const hostOf = () => ({ getState: o.getState, dispatch: o.dispatch, now: o.now });

  /** Open the library once; answer whether it is there. */
  function ensureLibrary() {
    if (library) return Promise.resolve(true);
    if (!loading) {
      loading = (o.loadLibrary ? o.loadLibrary() : Promise.resolve(null)).then((lib) => {
        if (!isLibrary(lib)) return false;
        library = { library: lib, index: createLibraryIndex(lib) };
        return true;
      }, () => false).finally(() => { loading = null; });
    }
    return loading;
  }

  /** @param {string} question */
  async function answer(question) {
    const ready = await ensureLibrary();
    const hits = ready && library ? library.index.search(question, 5) : [];
    const reply = o.askDocs ? await o.askDocs(question, hits) : answerFromDocs(question, hits);
    return { reply, hits };
  }

  /** The tape as the desk track's melody: the row under the painter. */
  const deskMelody = () => {
    const s = o.getState();
    const lead = s.world.heads[0];
    return tapeMelody(s.world.tape, s.world.width, lead ? lead.y : 0);
  };

  const effects = {
    /** @param {string} name */
    sound(name) {
      audio?.sfx(name);
    },
    /** The open game's track, or the desk's (`desk` insists on the desk);
     * `ensure` starts one only when nothing is playing.
     * @param {'play' | 'desk' | 'ensure' | 'pause' | 'resume' | 'stop'} mode */
    music(mode) {
      if (!audio) return;
      if (mode === 'pause') audio.pause();
      else if (mode === 'resume') audio.resume();
      else if (mode === 'stop') audio.stop();
      else if (mode !== 'ensure' || !audio.track) {
        const s = o.getState();
        const game = mode !== 'desk' && s.arcade.game ? games[s.arcade.game] : null;
        if (game) audio.play(game.track);
        else audio.play('desk', { melody: deskMelody, bpm: 84 + s.program.tempo * 3 });
      }
    },
    mix() {
      const a = o.getState().settings.audio;
      audio?.setMix({ master: a.master, music: a.music, sfx: a.sfx, muted: a.muted });
    },
    /** @param {boolean} on */
    hold(on) {
      o.council.hold(on);
      if (on) audio?.pause();
      else audio?.resume();
    },
    /** @param {string} tier */
    budget(tier) {
      o.onBudget?.(tier);
    },
    /** A game's lifecycle asked for a reset; the arcade starts the run from the new seed. */
    game() {},
    /** @param {unknown} _props @param {(a: string, p?: any) => void} send */
    async 'library-load'(_props, send) {
      if (await ensureLibrary() && library) {
        send('library/ready', library.library.docs.map((d) => ({ id: d.id, title: d.title, sections: d.sections.length })));
      }
      else send('library/unavailable');
    },
    /** Read a page aloud, or (null) stop. @param {any} sections @param {(a: string, p?: any) => void} send */
    speak(sections, send) {
      o.speech?.cancel();
      if (!Array.isArray(sections)) return;
      if (!o.speech) {
        send('library/spoken');
        send('studio/toast', 'This browser cannot read aloud.');
        return;
      }
      o.speech.speak(speechOf(sections), { sentence: (i) => send('library/sentence', i), end: () => send('library/spoken') });
    },
    /** @param {string} question @param {(a: string, p?: any) => void} send */
    async ask(question, send) {
      const { reply, hits } = await answer(question);
      send('library/answered', { answer: reply, hits });
      questions += 1;
      const thread = `library-${o.now().toString(36)}-${questions}`;
      post(hostOf(), { thread, subject: `Asked the docs: ${question}`, folder: 'library', from: 'human', to: ['oracle'], text: question, at: o.now() });
      post(hostOf(), { thread, folder: 'library', from: 'oracle', to: ['human'], text: reply.text, at: o.now() });
    },
    /** A project from the setup form: the title, the employers' names split
     * at their commas (four at most, "You" when none), the goal.
     * @param {{ title?: string, players?: string, goal?: number }} setup @param {(a: string, p?: any) => void} send */
    async 'crew-start'(setup, send) {
      const names = String(setup.players ?? '').split(',').map((n) => n.replace(/\s+/g, ' ').trim().slice(0, 24)).filter((n) => n.length > 0).slice(0, 4);
      const title = String(setup.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const outcome = await o.invoke('crew.start', { by: 'human', title: title || 'Our first app', players: names.length > 0 ? names : ['You'], goal: setup.goal ?? 4 });
      if (!outcome.ok) send('os/notice', { tone: 'warn', text: outcome.error?.message ?? 'The project could not start.' });
    },
    /** The crew's turn through the contract: the language model's when a
     * seat plays it (`crewTurn` answers whether it did), else the scripted crew's.
     * @param {string} _id @param {(a: string, p?: any) => void} send */
    async crew(_id, send) {
      const project = o.getState().crew.project;
      try {
        const played = o.crewTurn && project ? await o.crewTurn(project) : false;
        if (!played && project) {
          for (const move of scriptedCrew(project)) {
            await wait(o.timers, CREW_BEAT_MS);
            await o.invoke('crew.say', { by: move.by, idea: move.idea, text: move.say });
            await o.invoke('crew.build', { by: move.by, idea: move.idea, block: move.block });
            audio?.sfx('pop');
          }
          await wait(o.timers, CREW_BEAT_MS);
        }
      }
      catch (error) {
        o.report(error);
      }
      // however the turn went, it ends: a crew that stalls must not hold the round
      if (o.getState().crew.project?.phase === 'crew') await o.invoke('crew.done', { by: 'architect' });
      send('crew/idle');
    },
    /** @param {{ amount: number, badge?: string }} props @param {(a: string, p?: any) => void} send */
    xp(props, send) {
      const earned = award(o.getState().profile, Number(props.amount) || 0, props.badge);
      send('profile/set', earned.profile);
      if (earned.rankUp) {
        audio?.sfx('levelup');
        send('studio/toast', 'You climbed a rank!');
      }
    },
    /** What a game reported: dialogue, a rating, experience, a proposed setting.
     * @param {any} e @param {(a: string, p?: any) => void} send */
    'game-event'(e, send) {
      const s = o.getState();
      const game = s.arcade.game ?? 'arcade';
      if (e.kind === 'say') {
        post(hostOf(), { thread: `arcade-${game}`, subject: games[game]?.title ?? 'Arcade', folder: 'arcade', from: e.who, to: ['human'], text: e.text, at: o.now() });
        if (s.settings.captions) send('studio/toast', `${e.who}: ${e.text}`);
      }
      else if (e.kind === 'rate') {
        const attempt = { correct: e.correct, difficulty: e.difficulty, hinted: e.hinted === true };
        let profile = rate(s.profile, { ...attempt, skill: `${game}:${e.skill}` }).profile;
        profile = rate(profile, { ...attempt, skill: AREAS[game] ?? 'apps' }).profile;
        send('profile/set', profile);
      }
      else if (e.kind === 'xp') effects.xp({ amount: e.amount }, send);
      else if (e.kind === 'setting' && e.key === 'ai.toolBudget') {
        send('settings/budget', e.value);
        send('studio/toast', `Tool budget set to ${e.value}, as measured.`);
      }
    },
    /** @param {any} props */
    post(props) {
      post(hostOf(), { ...props, at: o.now() });
    },
  };

  const subs = {
    /** The coach watches its signals and moves on when a step's check holds.
     * @param {{ signals: any }} props @param {(a: string, p?: any) => void} send */
    coach(props, send) {
      // a turn later: the first start happens while the app is still booting
      const id = o.timers.setTimeout(() => {
        const s = o.getState();
        const out = advanceCoach(s.coach, s.profile, props.signals);
        if (out.events.length === 0) return;
        const last = out.events[out.events.length - 1];
        audio?.sfx(out.events.some((e) => e.kind === 'quest') ? 'levelup' : 'chime');
        send('coach/set', { coach: out.coach, profile: out.profile, toast: last.text });
      }, 0);
      return () => o.timers.clearTimeout(id);
    },
    /** A toast fades on its own. @param {unknown} _props @param {(a: string, p?: any) => void} send */
    toast(_props, send) {
      const id = o.timers.setTimeout(() => send('studio/toast', null), 3800);
      return () => o.timers.clearTimeout(id);
    },
    /** So does the coach's spotlight. @param {unknown} _props @param {(a: string, p?: any) => void} send */
    spotlight(_props, send) {
      const id = o.timers.setTimeout(() => send('studio/spotlight', null), 4200);
      return () => o.timers.clearTimeout(id);
    },
  };

  return {
    effects,
    subs,
    /** The studio's subscription entries for the app document. */
    entries: [
      { run: 'coach', withQuery: { quest: '$.coach.quest', step: '$.coach.step', signals: COACH_SIGNALS } },
      { run: 'toast', when: { $not: { '$is-null': '$.studio.toast' } }, withQuery: { seq: '$.studio.toastSeq' } },
      { run: 'spotlight', when: { $not: { '$is-null': '$.studio.spotlight' } }, withQuery: { target: '$.studio.spotlight' } },
    ],
    widgets: { board: boardWidget, mini: miniWidget, arcade: arcade.widget },
    arcade,
    /** The hooks the contract's studio handlers read. */
    system: {
      library: () => library,
      arcade: () => arcade,
      /** The oracle answers a letter, from the documentation. @param {string} thread @param {string} text */
      reply(thread, text) {
        answer(text).then(({ reply }) => {
          post(hostOf(), { thread, folder: 'inbox', from: 'oracle', to: ['human'], text: reply.text, at: o.now() });
        }, o.report);
      },
    },
    ensureLibrary,
  };
}

/** @param {StudioHostOptions['timers']} timers @param {number} ms */
function wait(timers, ms) {
  return new Promise((resolve) => { timers.setTimeout(() => resolve(undefined), ms); });
}
