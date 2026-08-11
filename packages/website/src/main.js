//@ts-check
/** Browser bootstrap: real environment in, one running app document out. */

import './styles.css';
import '@jarenjs/md/styles/md.css';
import '@jarenjs/mermaid/styles/mermaid.css';
import '@jarenjs/calc/styles/calc.css';
import '@jarenjs/charts/styles/charts.css';
import '@jarenjs/studio/styles/studio.css';
import '@jarenjs/play/styles/play.css';
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

const app = createSiteApp({
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
  // an in-page link in a rendered document: the target heading carries
  // the id @jarenjs/md minted for it. The header overlap is the
  // stylesheet's job (`--md-scroll-margin`), so this stays one line.
  scrollToAnchor: (id) => {
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
  // `download`'s twin: open the file picker and hand back what was chosen.
  // Resolves null when the user dismisses it — there is no cancel event, so
  // the input is discarded either way and a dismissed picker simply never
  // resolves a file. A host without this capability omits it and the
  // surface says so, exactly as it does for a missing `download`.
  openFile: (accept = '.json,application/json') => new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) { resolve(null); return; }
      file.text().then((text) => resolve({ name: file.name, text }), () => resolve(null));
    }, { once: true });
    input.click();
  }),
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

// ——— the mobile keyboard seam (browser-only; headless hosts never load
// this bootstrap, so they no-op by construction) ———
// When the on-screen keyboard opens, the LAYOUT viewport keeps its height
// but the VISUAL viewport shrinks — a focused editor near the bottom ends
// up behind the keys. Publish the difference as a CSS var (`--kb-inset`);
// the active editor pane reserves it as bottom padding, so the caret
// always has scroll room above the keyboard line.
const publishKeyboardInset = () => {
  const vv = window.visualViewport;
  if (!vv) return;
  const inset = Math.max(0, document.documentElement.clientHeight - vv.height);
  document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
};
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', publishKeyboardInset);
  window.visualViewport.addEventListener('scroll', publishKeyboardInset);
  publishKeyboardInset();
}
// While an editor is focused: mark the body (the sticky header un-sticks
// so it cannot cover the field) and center the field in the visual
// viewport, clear of both the header and the keyboard.
// the site's editors carry `.editor`; the @jarenjs/studio component's
// carries its own `.js-editor-input` — both get the seam
const isSeamEditor = (target) => target?.classList !== undefined
  && (target.classList.contains('editor') || target.classList.contains('js-editor-input'));
document.addEventListener('focusin', (event) => {
  const target = /** @type {any} */ (event.target);
  if (!isSeamEditor(target)) return;
  document.body.classList.add('kb-editing');
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
});
document.addEventListener('focusout', (event) => {
  const target = /** @type {any} */ (event.target);
  if (isSeamEditor(target)) document.body.classList.remove('kb-editing');
});

// close the nav dropdown groups on Escape or a click outside the header nav
// (the in-nav triggers own opening; route/set closes them on navigation)
addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && app.getState().navOpen) app.dispatch('nav/close');
});
document.addEventListener('click', (event) => {
  const target = /** @type {any} */ (event.target);
  if (app.getState().navOpen && !(target?.closest && target.closest('#site-nav'))) {
    app.dispatch('nav/close');
  }
});

// PWA: register the service worker in production builds
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).catch(() => {});
  });
}
