//@ts-check
/** Browser bootstrap: real environment in, one running app document out. */

import './styles.css';
import { createSiteApp } from './app/createSiteApp.js';
import { parseHash } from './lib/route.js';

const BASE = import.meta.env.BASE_URL;
const THEME_KEY = 'jaren-theme';

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
});
