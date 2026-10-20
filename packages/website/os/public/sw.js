/* The Radiant OS service worker: the OS works offline, all of it.
   - install: precache the shell and every file the build emitted, read
     from the list the build writes (precache.json: scripts, styles, the
     database worker, the SQLite wasm) — so an OS installed once boots
     with no network at all, not only after every chunk happened to load;
   - navigations and the library (library.json, the documentation the
     Library app reads): network-first, falling back to the cached copy;
   - hashed assets and precached statics: cache-first;
   - every cache.put is gated on response.ok, and only navigations to
     the shell itself refresh the cached shell.
   Its caches are the `radiant-os-` ones and it never touches another
   prefix: the classic site's worker shares this origin. */

const PREFIX = 'radiant-os-';
const CACHE = `${PREFIX}v2`;
const BASE = self.registration.scope; // e.g. https://host/jarenjs/os/
const SHELL_PATH = new URL(BASE).pathname;
const LIBRARY = `${BASE}library.json`;

const PRECACHE = [
  BASE,
  `${BASE}manifest.webmanifest`,
  `${BASE}radiant.svg`,
  `${BASE}icon-192.png`,
  `${BASE}icon-512.png`,
];

const putOk = (key, response) => {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(key, copy));
  }
  return response;
};

/** Every file the build emitted, from the list the build writes. */
const builtFiles = () => fetch(`${BASE}precache.json`)
  .then((response) => (response.ok ? response.json() : { files: [] }))
  .then((list) => (Array.isArray(list.files) ? list.files.map((file) => `${BASE}${file}`) : []))
  .catch(() => []);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).then(builtFiles).then((files) => cache.addAll(files)))
      .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(PREFIX) && key !== CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(BASE)) return;

  if (request.mode === 'navigate') {
    const isShell = new URL(request.url).pathname === SHELL_PATH;
    event.respondWith(
      fetch(request)
        .then((response) => (isShell ? putOk(BASE, response) : response))
        .catch(() => caches.match(BASE)));
    return;
  }

  if (request.url === LIBRARY) {
    event.respondWith(
      fetch(request)
        .then((response) => putOk(LIBRARY, response))
        .catch(() => caches.match(LIBRARY)));
    return;
  }

  const url = new URL(request.url);
  if (PRECACHE.includes(request.url) || url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit
        ?? fetch(request).then((response) => putOk(request, response))));
  }
});
