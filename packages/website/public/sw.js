/* The jarenjs website service worker: offline-capable playground.
   - navigation requests: network-first, falling back to the cached shell
   - precached statics (manifest, icons, fonts): cache-first
   - hashed assets (/assets/): cache-first (immutable by construction)
   - generated data (benchmarks, the package census, the build
     provenance): stale-while-revalidate
   Every cache.put is gated on response.ok: a 404/502 must never be
   cached forever, and a bad navigation response must never replace the
   shell — nor may a navigation to anything but the shell itself. */

const CACHE = 'jaren-website-v29';
const BASE = self.registration.scope; // e.g. https://host/jarenjs/
const SHELL_PATH = new URL(BASE).pathname;

/* Precached at install AND served by the fetch handler's cache-first
   branch below — a precache no branch serves is unreachable (the fonts
   are requested by the built CSS as `${BASE}fonts/*.woff2`). */
const PRECACHE = [
  BASE,
  `${BASE}manifest.webmanifest`,
  `${BASE}jaren.svg`,
  `${BASE}icon-192.png`,
  `${BASE}icon-512.png`,
  `${BASE}fonts/inter-latin-400-normal.woff2`,
  `${BASE}fonts/inter-latin-600-normal.woff2`,
  `${BASE}fonts/inter-latin-700-normal.woff2`,
  `${BASE}fonts/jetbrains-mono-latin-400-normal.woff2`,
  `${BASE}fonts/jetbrains-mono-latin-700-normal.woff2`,
];

const putOk = (key, response) => {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(key, copy));
  }
  return response;
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(BASE)) return;

  if (request.mode === 'navigate') {
    /* Only a navigation to the shell's own path refreshes the cached
       shell: any other page in scope — a raw benchmarks/*.json opened in
       a tab — is not the app, and must not become what the site root
       serves offline. */
    const isShell = new URL(request.url).pathname === SHELL_PATH;
    event.respondWith(
      fetch(request)
        .then((response) => (isShell ? putOk(BASE, response) : response))
        .catch(() => caches.match(BASE)));
    return;
  }

  const url = new URL(request.url);
  if (PRECACHE.includes(request.url) || url.pathname.includes('/fonts/')
    || url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit
        ?? fetch(request).then((response) => putOk(request, response))));
    return;
  }

  /* Everything the build generates about this repository: the benchmark
     files, the package census the docs rail renders and the build
     provenance the footer prints. Fresh whenever the network answers,
     and still there when it does not — the docs page must not lose its
     package list offline. */
  if (url.pathname.includes('/benchmarks/') || url.pathname.includes('/site/')
    || url.pathname.endsWith('/build.json')) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const refresh = fetch(request)
          .then((response) => putOk(request, response))
          .catch(() => hit);
        return hit ?? refresh;
      }));
  }
});
