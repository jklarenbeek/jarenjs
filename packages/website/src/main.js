//@ts-check
/** Browser bootstrap: real environment in, one running app document out. */

import './styles.css';
import { createSiteApp } from './app/createSiteApp.js';
import { parseHash } from './lib/route.js';

const BASE = import.meta.env.BASE_URL;
const THEME_KEY = 'jaren-theme';
const IDE_KEY = 'jaren-ide';

const stored = localStorage.getItem(THEME_KEY);
const theme = stored === 'dark' || stored === 'light'
  ? stored
  : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.classList.toggle('dark', theme === 'dark');

createSiteApp({
  node: document.getElementById('app'),
  document,
  initialTheme: theme,
  fetchJson: (name) =>
    fetch(`${BASE}benchmarks/${name}.json`).then((response) => (
      response.ok ? response.json() : Promise.reject(new Error(String(response.status)))
    )),
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
  storage: {
    read: () => {
      try {
        const raw = localStorage.getItem(IDE_KEY);
        return raw === null ? null : JSON.parse(raw);
      }
      catch {
        return null;
      }
    },
    write: (data) => {
      try {
        localStorage.setItem(IDE_KEY, JSON.stringify(data));
      }
      catch {
        // storage full or unavailable: the session keeps working
      }
    },
  },
  modelContext: /** @type {any} */ (navigator).modelContext,
});

// PWA: register the service worker in production builds
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).catch(() => {});
  });
}
