//@ts-check
/** Bundle the standalone runtime once at build time, using the installed
 * lockfile versions. Exporting a project downloads these exact bytes. */
import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'packages/website/public/studio-offline');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({ absWorkingDir: root, entryPoints: {
  runtime: 'packages/website/src/offline-runtime.js',
  'project-db-worker': 'packages/website/src/project-db-worker.js',
}, outdir: out, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
define: { 'import.meta.env.BASE_URL': '"./"' }, legalComments: 'eof',
loader: { '.woff2': 'file' }, assetNames: '[name]',
plugins: [{ name: 'local-fonts', setup(plugin) {
  plugin.onResolve({ filter: /^\/jarenjs\/fonts\// }, (args) => ({ path: resolve(root, 'packages/website/public', args.path.slice('/jarenjs/'.length)) }));
} }] });
for (const name of ['sqlite3.wasm', 'sqlite3-opfs-async-proxy.js'])
  await copyFile(resolve(root, `node_modules/@sqlite.org/sqlite-wasm/dist/${name}`), resolve(out, name));
const suite = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sqlite = JSON.parse(await readFile(resolve(root, 'node_modules/@sqlite.org/sqlite-wasm/package.json'), 'utf8'));
await writeFile(resolve(out, 'versions.json'), JSON.stringify({ jaren: suite.version, sqlite: sqlite.version,
  policy: 'bundled from the exporting build; no CDN dependencies' }, null, 2));
await copyFile(resolve(root, 'LICENSE'), resolve(out, 'LICENSE-jaren.txt'));
await copyFile(resolve(root, 'node_modules/@sqlite.org/sqlite-wasm/README.md'), resolve(out, 'SQLite-README.md'));
const files = (await readdir(out)).filter((name) => name !== 'manifest.json').sort();
await writeFile(resolve(out, 'manifest.json'), JSON.stringify({ files }, null, 2));
