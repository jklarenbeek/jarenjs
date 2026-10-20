//@ts-check
/**
 * The studio's part of the OS state: settings (the art direction, sound,
 * camera, light, motion, the language model's tool budget), the pause
 * menu, the board, the post office, the library, the crew game, the
 * arcade, the coach and the player's ladder. Like the rest of the state
 * it is one JSON value; `restoreStudio` lays a saved session over a fresh
 * one slice by slice, keeping only what passes its slice's check, and
 * `studioSlice` is what a save keeps.
 */

import { emptyMail, isMail } from '../kernel/mail.js';
import { emptyBoard, isBoard } from '../kernel/board.js';
import { emptyCoach, isCoach } from '../kernel/coach.js';
import { emptyProfile, isProfile } from '../kernel/ladder.js';
import { isProject } from '../kernel/crew.js';
import { isBlock } from '../kernel/blocks.js';

/** The three art directions: each is a theme of the chrome and the stage. */
export const ART = Object.freeze([
  { id: 'pop', theme: 'light', name: 'Pop Shop', blurb: 'Cream paper, flat primaries, the bold black line — the poster on the shop wall.' },
  { id: 'chalk', theme: 'dark', name: 'Subway Chalk', blurb: 'White chalk on the black paper of an empty advertising panel, colour used like a stick of pastel.' },
  { id: 'neon', theme: 'neon', name: 'Neon Night', blurb: 'The club at three in the morning: lines that glow on deep night blue, in lime, cyan and amber.' },
]);

/** The tool budget a language model gets: measured, or picked by hand. */
export const BUDGETS = Object.freeze(['auto', 'tiny', 'small', 'medium', 'large', 'unlimited']);

/** The art direction a theme wears. @param {string} [theme] */
export const artOf = (theme) => ART.find((a) => a.theme === theme)?.id ?? 'pop';

/** The studio's slices of a fresh OS, dressed for the boot's theme. @param {string} [theme] */
export function studioState(theme = 'light') {
  return {
    settings: {
      art: artOf(theme),
      audio: { master: 0.8, music: 0.5, sfx: 0.8, muted: false },
      camera: { orbit: true },
      light: { hour: 10, bands: 3, shadows: true },
      motion: { ragdoll: true },
      ai: { budget: 'auto', model: '' },
      lang: 'en',
      captions: true,
    },
    studio: { paused: false, resumeRunning: false, shot: null, shotSeq: 0, toast: null, toastSeq: 0, burst: null, burstSeq: 0, cheer: null, cheerSeq: 0, spotlight: null },
    mail: { ...emptyMail(), folder: 'all', open: null, draft: '', subject: '' },
    board: { ...emptyBoard(), selected: null, linking: null, draft: '', kind: 'note' },
    library: { status: 'idle', docs: [], page: null, query: '', hits: [], answer: null, speaking: false, sentence: -1 },
    crew: { project: null, made: [], setup: { title: '', players: 'You', goal: 4 }, draft: '', preview: null, busy: false },
    arcade: { game: null, flow: { current: 'title' }, hud: null, outcome: null, seed: 1, act: { seq: 0, action: null }, saves: {}, players: 1 },
    coach: emptyCoach(),
    profile: emptyProfile(),
  };
}

/** @param {unknown} v @param {number} lo @param {number} hi */
const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Settings from a save, member by member: anything malformed keeps the default.
 * @param {any} fresh @param {any} saved
 */
function restoreSettings(fresh, saved) {
  if (!saved || typeof saved !== 'object') return fresh;
  const a = saved.audio ?? {};
  const l = saved.light ?? {};
  return {
    // the art direction is the theme this boot chose, saved with the preferences
    art: fresh.art,
    audio: {
      master: inRange(a.master, 0, 1) ? a.master : fresh.audio.master,
      music: inRange(a.music, 0, 1) ? a.music : fresh.audio.music,
      sfx: inRange(a.sfx, 0, 1) ? a.sfx : fresh.audio.sfx,
      muted: typeof a.muted === 'boolean' ? a.muted : fresh.audio.muted,
    },
    camera: { orbit: typeof saved.camera?.orbit === 'boolean' ? saved.camera.orbit : fresh.camera.orbit },
    light: {
      hour: inRange(l.hour, 0, 24) ? l.hour : fresh.light.hour,
      bands: Number.isInteger(l.bands) && l.bands >= 1 && l.bands <= 6 ? l.bands : fresh.light.bands,
      shadows: typeof l.shadows === 'boolean' ? l.shadows : fresh.light.shadows,
    },
    motion: { ragdoll: typeof saved.motion?.ragdoll === 'boolean' ? saved.motion.ragdoll : fresh.motion.ragdoll },
    ai: {
      budget: BUDGETS.includes(saved.ai?.budget) ? saved.ai.budget : fresh.ai.budget,
      model: typeof saved.ai?.model === 'string' ? saved.ai.model.slice(0, 120) : fresh.ai.model,
    },
    lang: saved.lang === 'nl' ? 'nl' : 'en',
    captions: typeof saved.captions === 'boolean' ? saved.captions : fresh.captions,
  };
}

/** A shipped app as kept: its blocks (the app document is rebuilt from them, never trusted). @param {any} m */
const isMade = (m) => Boolean(m) && typeof m.id === 'string' && typeof m.title === 'string' && Array.isArray(m.blocks) && m.blocks.every(isBlock)
  && Number.isInteger(m.stars);

/**
 * Lay a saved session's studio over a fresh one.
 * @param {ReturnType<typeof studioState>} fresh @param {any} saved
 */
export function restoreStudio(fresh, saved) {
  if (!saved || typeof saved !== 'object') return fresh;
  return {
    ...fresh,
    settings: restoreSettings(fresh.settings, saved.settings),
    mail: isMail(saved.mail) ? { ...fresh.mail, threads: saved.mail.threads, seq: saved.mail.seq } : fresh.mail,
    board: isBoard(saved.board) ? { ...fresh.board, cards: saved.board.cards, links: saved.board.links, seq: saved.board.seq } : fresh.board,
    crew: {
      ...fresh.crew,
      project: isProject(saved.crew?.project) ? saved.crew.project : null,
      made: Array.isArray(saved.crew?.made) ? saved.crew.made.filter(isMade).slice(0, 24) : [],
    },
    arcade: { ...fresh.arcade, saves: saved.arcade?.saves && typeof saved.arcade.saves === 'object' ? saved.arcade.saves : {} },
    coach: isCoach(saved.coach) ? saved.coach : fresh.coach,
    profile: isProfile(saved.profile) ? saved.profile : fresh.profile,
  };
}

/** What a session save keeps of the studio. @param {any} state */
export function studioSlice(state) {
  return {
    settings: state.settings,
    mail: { threads: state.mail.threads, seq: state.mail.seq },
    board: { cards: state.board.cards, links: state.board.links, seq: state.board.seq },
    crew: { project: state.crew.project, made: state.crew.made },
    arcade: { saves: state.arcade.saves },
    coach: state.coach,
    profile: state.profile,
  };
}
