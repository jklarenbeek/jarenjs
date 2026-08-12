/* The jarenjs website service worker: offline-capable playground.
   - navigation requests: network-first, falling back to the cached shell
   - hashed assets (/assets/): cache-first (immutable by construction)
   - benchmark data: stale-while-revalidate */

const CACHE = 'jaren-website-v15';
const BASE = self.registration.scope; // e.g. https://host/jarenjs/

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll([
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
      ]))
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
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(BASE, copy));
          return response;
        })
        .catch(() => caches.match(BASE)));
    return;
  }

  const url = new URL(request.url);
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })));
    return;
  }

  if (url.pathname.includes('/benchmarks/')) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const refresh = fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        }).catch(() => hit);
        return hit ?? refresh;
      }));
  }
});
