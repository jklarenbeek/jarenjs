import { defineConfig } from 'vite';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectLibrary } from './scripts/os-library.js';

// Radiant OS is its own installable app at /jarenjs/os/: its own page,
// manifest, service worker scope and lean bundle, built after the site
// into dist/os. The sqlite wasm is fetched by the database worker itself
// and must not be pre-bundled in development.
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const OUT = here('./dist/os');
const ROOT = here('../..');

/** The Library app's documents (`library.json`): the OS guide and every
 * workspace's site.md, collected fresh on each request in development so
 * an edited page reads at once, and emitted once into the build. */
const library = () => ({
  name: 'radiant-library',
  configureServer(server) {
    server.middlewares.use('/jarenjs/os/library.json', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(collectLibrary(ROOT)));
    });
  },
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'library.json', source: `${JSON.stringify(collectLibrary(ROOT))}\n` });
  },
});

/** Write the list of every built asset — the page's chunks AND what the
 * database worker's own build emitted (its wasm, its OPFS proxy), which
 * Vite's manifest does not list — for the OS service worker to precache
 * at install, so the OS boots offline after a single visit. */
const precacheList = () => ({
  name: 'radiant-precache-list',
  apply: 'build',
  closeBundle() {
    const files = readdirSync(`${OUT}/assets`).filter((name) => !name.endsWith('.map')).sort().map((name) => `assets/${name}`);
    if (existsSync(`${OUT}/library.json`)) files.push('library.json');
    writeFileSync(`${OUT}/precache.json`, `${JSON.stringify({ files }, null, 2)}\n`);
  },
});

export default defineConfig({
  root: here('./os'),
  base: '/jarenjs/os/',
  publicDir: here('./os/public'),
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  server: { fs: { allow: [here('../..')] } },
  plugins: [library(), precacheList()],
  build: {
    outDir: OUT,
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1600,
  },
});
