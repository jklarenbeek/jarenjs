//@ts-check
/**
 * Radiant OS, jaren edition — the browser bootstrap. Everything that
 * needs a real browser lives here and nowhere else: the database worker,
 * the service worker, the stylesheet the JTLT theme renders into, file
 * downloads, saved preferences, sound (opened on the first gesture, as
 * browsers require), reading aloud, the library the build ships, WebMCP.
 * The OS itself (`createOs`) runs the same with or without any of them.
 */

import './os.css';
import { compileContract } from '@jarenjs/contract';
import { openPortClient } from '@jarenjs/contract/port';
import { openLocalClient } from '@jarenjs/contract/local';
import { registerWebMcp } from '@jarenjs/contract/webmcp';
import storeDoc from './documents/store.contract.json' with { type: 'json' };
import { createMemoryStore } from './kernel/store.js';
import { createOs } from './app/createOs.js';
import { sessionSlice } from './app/state.js';
import { APPS } from './app/view.js';
import { createAudio } from './engine/audio.js';
import { GAMES } from './games/registry.js';
import { prefersReducedMotion } from '../lib/motion.js';

const PREFS_KEY = 'radiant-os-prefs';
const READY_MS = 10000;

/** What the About app says in this edition. */
const ABOUT = {
  lead: 'A browser OS that is a Turing machine, governed by a council of its own parts — and by you.',
  sections: [
    { title: 'The machine', text: 'The floor is the tape of a two-dimensional Turing machine. Four heads — the Painter, the Dancer, the Critic and the Architect — read the cell under them, paint, turn and step, all by one program: a jaren-fsm document compiled by @jarenjs/flow. Every block on the floor is a symbol the machine wrote.' },
    { title: 'The council', text: 'Every few hundred steps the council meets. Each member proposes one amendment to the program and judges every proposal by simulating it ahead; votes are weighted by merit. A session is a jaren-workflow document: a DAG gathers and tallies, then a wait state holds the winner for your verdict.' },
    { title: 'Merit', text: 'Merit is earned by measured results, in a jaren-dag of query documents: an enacted amendment is judged against the future it replaced, and gains most when it lifts every member’s taste together. A veto costs its proposer and backers a little — the council learns what you will not have.' },
    { title: 'The veto', text: 'It is always yours. The veto, the early approval and the repeal of an enacted amendment are operations of the OS contract that no tool projection carries: a language model connected over WebMCP sees every other operation, and none of these.' },
    { title: 'Code as art', text: 'Everything the OS runs is a JSON document — the program, the council, merit, the view you are reading, the system calls. The Source app sculpts any of them into dancing figures with one JSLT stylesheet, and lights up what is executing; Exports renders the artwork as CSS, HTML and JavaScript through JTLT templates.' },
    { title: 'Language models', text: 'When your browser offers navigator.modelContext, the OS registers its public contract operations as WebMCP tools, seated as the Oracle: an agent can read the machine, propose amendments and speak to the council, validated by the same contract as everyone else. The Tangle edition seats a language model through @tangleai/models.' },
    { title: 'The drawing', text: 'The figures are drawn in homage to the bold outlined line of 1980s subway and street art — Keith Haring’s above all — and reimagined rather than reproduced: cut-out dancers that are the heads of a Turing machine, on a floor their own program paints. Dark mode is the subway: chalk on black.' },
  ],
  links: [
    { label: 'The classic Jaren site', href: '../' },
    { label: 'Radiant OS, Tangle edition', href: 'https://jklarenbeek.github.io/tangleai/os/' },
    { label: 'Source on GitHub', href: 'https://github.com/jklarenbeek/jarenjs' },
  ],
};

/** Saved preferences, or the system's. */
function readPrefs() {
  /** @type {{ theme?: 'light' | 'dark' | 'neon', reduce?: boolean }} */
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {}; }
  catch { saved = {}; }
  return {
    theme: saved.theme === 'dark' || saved.theme === 'light' || saved.theme === 'neon'
      ? saved.theme
      : (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'),
    reduce: typeof saved.reduce === 'boolean' ? saved.reduce : prefersReducedMotion(window),
  };
}

/**
 * The studio's sound. A browser opens an audio context only after a
 * gesture, so none is made before one: until the first press every
 * effect is quietly skipped, and `arm` calls back once sound is allowed.
 */
function browserAudio() {
  const Context = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
  if (typeof Context !== 'function') return null;
  let allowed = false;
  const audio = createAudio({ createContext: () => (allowed ? new Context() : null) });
  /** @param {() => void} onFirst */
  const arm = (onFirst) => {
    const unlock = () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      allowed = true;
      if (audio.unlock()) onFirst();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  };
  return { audio, arm };
}

/**
 * Reading aloud through the browser's speech synthesis, a sentence at a
 * time so the page can light the one being read.
 * @returns {import('./app/studio-host.js').Speech | null}
 */
function browserSpeech() {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance !== 'function') return null;
  // each reading has its own token: a cancelled one's late callbacks are ignored
  let token = 0;
  return {
    speak(lines, hooks) {
      synth.cancel();
      const mine = ++token;
      const say = (/** @type {number} */ i) => {
        if (mine !== token) return;
        if (i >= lines.length) { hooks.end(); return; }
        const utterance = new SpeechSynthesisUtterance(lines[i]);
        utterance.lang = document.documentElement.lang || 'en';
        utterance.onstart = () => { if (mine === token) hooks.sentence(i); };
        utterance.onend = () => say(i + 1);
        utterance.onerror = () => { if (mine === token) { token += 1; hooks.end(); } };
        synth.speak(utterance);
      };
      say(0);
    },
    cancel() {
      token += 1;
      synth.cancel();
    },
  };
}

/**
 * Where a link asks the OS to open: `?app=<app>`, or `?game=<game>` for
 * a game on the arcade's shelf — one address per app and per game.
 * Nothing it does not know: the OS opens as it would without one.
 */
function landing() {
  const params = new URLSearchParams(location.search);
  const app = params.get('app');
  const game = params.get('game');
  const known = game !== null && Object.hasOwn(GAMES, game) ? game : null;
  return { app: APPS.some((a) => a.id === app) ? app : (known ? 'arcade' : null), game: known };
}

/** The library the build ships: every package's documentation and the OS guide. */
async function loadLibrary() {
  const response = await fetch(new URL('library.json', document.baseURI));
  return response.ok ? response.json() : null;
}

/**
 * Start the database worker and wait for it; fall back to memory.
 * @returns {Promise<{ invoke: (op: string, input?: any) => Promise<any> }>}
 */
async function openStore() {
  const contract = compileContract(storeDoc);
  try {
    const worker = new Worker(new URL('./db-worker.js', import.meta.url), { type: 'module' });
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), READY_MS);
      worker.addEventListener('message', (event) => {
        if (event.data?.radiant === 'ready') { clearTimeout(timer); resolve(true); }
        else if (event.data?.radiant === 'failed') { clearTimeout(timer); resolve(false); }
      });
      worker.addEventListener('error', () => { clearTimeout(timer); resolve(false); });
    });
    if (ready) return openPortClient(contract, { channel: worker, timeoutMs: 15000 });
    worker.terminate();
  }
  catch {
    // no module workers here: keep going in memory
  }
  return openLocalClient(contract, createMemoryStore());
}

/** @param {{ name: string, mime: string, text: string }} file */
function download(file) {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** @param {string} css */
function applyTheme(css) {
  let style = document.getElementById('radiant-theme');
  if (!style) {
    style = document.createElement('style');
    style.id = 'radiant-theme';
    document.head.appendChild(style);
  }
  style.textContent = css;
}

async function boot() {
  const node = /** @type {HTMLElement} */ (document.getElementById('os'));
  const prefs = readPrefs();
  const store = await openStore();
  const saved = await store.invoke('session.get').then((/** @type {any} */ o) => (o.ok ? o.value?.state ?? null : null));
  const sound = browserAudio();
  const land = landing();
  node.textContent = '';
  const os = createOs({
    node,
    document,
    edition: 'jaren edition',
    title: 'Radiant OS',
    about: ABOUT,
    theme: prefs.theme,
    reduce: prefs.reduce,
    app: window.matchMedia?.('(max-width: 760px)')?.matches ? 'none' : 'council',
    store,
    saved,
    applyTheme,
    download,
    savePrefs: (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode: the toggle still works for this visit */ } },
    keys: window,
    games: GAMES,
    audio: sound?.audio ?? null,
    speech: browserSpeech(),
    loadLibrary,
    // a boundary failure is reported, never thrown into the frame loop
    onError: (error) => { report(error); },
  });
  // a landing app opens the way a press on the dock opens it (the library loads, the coach notices)
  if (land.app) os.app.dispatch('os/app', land.app);
  if (land.game) os.app.dispatch('arcade/open', land.game);
  sound?.arm(() => os.app.dispatch('studio/music', 'ensure'));
  // a hidden tab is quiet, and a game in play waits for you to come back
  document.addEventListener('visibilitychange', () => {
    const s = os.app.getState();
    if (document.hidden) {
      sound?.audio.pause();
      if (s.arcade.flow.current === 'playing') os.app.dispatch('arcade/pause');
    }
    else if (!s.studio.paused && s.arcade.flow.current !== 'paused') sound?.audio.resume();
  });
  const info = await store.invoke('store.info');
  if (info.ok) os.app.dispatch('os/storage', info.value);
  os.app.dispatch('os/online', navigator.onLine !== false);
  window.addEventListener('online', () => os.app.dispatch('os/online', true));
  window.addEventListener('offline', () => os.app.dispatch('os/online', false));
  window.addEventListener('pagehide', () => {
    store.invoke('session.put', { state: sessionSlice(os.app.getState()) }).catch(() => {});
  });
  // language models reach the OS as the Oracle, through the public contract
  registerWebMcp(os.system.tools({ seat: 'oracle' }), { realm: window, onError: () => {} });
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).catch(() => {});
  }
}

/** The platform's error reporter, where there is one. @param {unknown} error */
function report(error) {
  if (typeof reportError === 'function') reportError(error);
}

boot().catch((error) => {
  report(error);
  const node = document.getElementById('os');
  if (node) node.textContent = `Radiant OS could not start: ${error?.message ?? error}`;
});
