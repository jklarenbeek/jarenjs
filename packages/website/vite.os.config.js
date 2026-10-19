import { defineConfig } from 'vite';
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Radiant OS is its own installable app at /jarenjs/os/: its own page,
// manifest, service worker scope and lean bundle, built after the site
// into dist/os. The sqlite wasm is fetched by the database worker itself
// and must not be pre-bundled in development.
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const OUT = here('./dist/os');

/** Write the list of every built asset — the page's chunks AND what the
 * database worker's own build emitted (its wasm, its OPFS proxy), which
 * Vite's manifest does not list — for the OS service worker to precache
 * at install, so the OS boots offline after a single visit. */
const precacheList = () => ({
  name: 'radiant-precache-list',
  apply: 'build',
  closeBundle() {
    const files = readdirSync(`${OUT}/assets`).filter((name) => !name.endsWith('.map')).sort().map((name) => `assets/${name}`);
    writeFileSync(`${OUT}/precache.json`, `${JSON.stringify({ files }, null, 2)}\n`);
  },
});

export default defineConfig({
  root: here('./os'),
  base: '/jarenjs/os/',
  publicDir: here('./os/public'),
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  server: { fs: { allow: [here('../..')] } },
  plugins: [precacheList()],
  build: {
    outDir: OUT,
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1600,
  },
});
