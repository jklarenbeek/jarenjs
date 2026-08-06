//@ts-check
/** Browser bootstrap: real environment in, one running app document out. */

import './styles.css';
import '@jarenjs/md/styles/md.css';
import '@jarenjs/mermaid/styles/mermaid.css';
import '@jarenjs/calc/styles/calc.css';
import '@jarenjs/charts/styles/charts.css';
import '@jarenjs/studio/styles/studio.css';
import '@jarenjs/scratch/styles/scratch.css';
import { createSiteApp } from './app/createSiteApp.js';
import { md } from './boundaries/markdown.js';
import { parseHash } from './lib/route.js';

const BASE = import.meta.env.BASE_URL;
const THEME_KEY = 'jaren-theme';
const IDE_KEY = 'jaren-ide';
const AI_KEY = 'jaren-ai';
const AI_CHAT_KEY = 'jaren-ai-chat';
const GAME_KEY = 'jaren-game';

/** A localStorage-backed JSON slot; failures degrade to in-memory. */
const jsonStore = (key) => ({
  read: () => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    }
    catch {
      return null;
    }
  },
  write: (data) => {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    }
    catch {
      // storage full or unavailable: the session keeps working
    }
  },
});

const stored = localStorage.getItem(THEME_KEY);
const theme = stored === 'dark' || stored === 'light'
  ? stored
  : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.classList.toggle('dark', theme === 'dark');

// Diagrams render complete; hydration only ADDS pan/zoom to them, so it runs
// after the DOM settles rather than as part of any frame. `md.hydrate` is
// idempotent — it skips an element whose content hash it has already wired —
// so re-running it on every mutation is cheap and needs no bookkeeping here.
const appNode = document.getElementById('app');
const hydrateDiagrams = () => md.hydrate(appNode);
new MutationObserver(hydrateDiagrams).observe(appNode, { childList: true, subtree: true });

createSiteApp({
  node: appNode,
  document,
  initialTheme: theme,
  fetchJson: (name) =>
    fetch(`${BASE}benchmarks/${name}.json`).then((response) => (
      response.ok ? response.json() : Promise.reject(new Error(String(response.status)))
    )),
  fetchText: (url) =>
    fetch(url).then((response) => (
      response.ok
        ? response.text()
        : Promise.reject(new Error(`${response.status} ${response.statusText}`))
    )),
  lockScroll: (on) => {
    document.body.classList.toggle('dialog-open', on);
  },
  revealActiveTab: () => {
    for (const el of document.querySelectorAll('.tabs .tab.active, .docs-sections .docs-link.active')) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  },
  applyTheme: (next) => {
    document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem(THEME_KEY, next);
  },
  listenHash: (cb) => {
    const fire = () => cb(parseHash(location.hash));
    addEventListener('hashchange', fire);
    fire();
    return () => removeEventListener('hashchange', fire);
  },
  navigate: (hash) => { location.hash = hash; },
  share: (hash) => {
    const url = `${location.origin}${location.pathname}${hash}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    return url;
  },
  storage: jsonStore(IDE_KEY),
  // the Studio's "keep it" escape hatch: save the document as a file
  download: (filename, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
  },
  // the AI assistant: real fetch to the user-chosen provider; settings
  // (including the bring-your-own key) and the conversation transcript
  // persisted locally and nowhere else
  aiFetch: (url, init) => fetch(url, init),
  aiStorage: jsonStore(AI_KEY),
  aiChat: jsonStore(AI_CHAT_KEY),
  // the adventure save slot: a raw JSONX string (the game serializes itself)
  gameSave: {
    read: () => { try { return localStorage.getItem(GAME_KEY); } catch { return null; } },
    write: (s) => { try { localStorage.setItem(GAME_KEY, s); } catch { /* private mode */ } },
  },
  modelContext: /** @type {any} */ (navigator).modelContext,
});

// PWA: register the service worker in production builds
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).catch(() => {});
  });
}
