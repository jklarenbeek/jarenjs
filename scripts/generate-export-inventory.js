//@ts-check
/**
 * The export inventory of every public workspace, derived from its
 * manifest and written into its README between `<!--fact:exports.<name>-->`
 * … `<!--/fact-->` markers by `scripts/derive-docs.js`.
 *
 * Why it exists: a package's public subpaths were discoverable only where
 * a README author had typed them, and `@jarenjs/emit` had typed none —
 * four JavaScript routes and a schema directory a consumer could import
 * and could not find. A hand-kept list is a second copy of the manifest,
 * and a second copy drifts; this block IS the manifest, so `npm run
 * docs:check` fails the moment an export is added or removed until the
 * README is regenerated. The prose around the block — what each route is
 * for, what it costs, when to reach for it — stays hand-written.
 *
 * The census is `scripts/lib/exports.js`, the one parser the
 * packed-consumer check reads too (`npm run test:packed`), so every
 * JavaScript row documented here is a subpath that gate installs from a
 * tarball and imports; the schema, asset and metadata rows are the
 * manifest's other public names, listed beside them.
 *
 *   npm run docs:derive          # rewrite the derived text
 *   npm run docs:check           # fail on drift
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportEntries } from './lib/exports.js';

/**
 * The public workspaces: `{ name, dir, pkg }` for every non-private
 * workspace the root manifest lists, in the root's order.
 * @param {string} root
 */
export function publicWorkspaces(root) {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  /** @type {{ name: string, dir: string, pkg: any }[]} */
  const out = [];
  for (const dir of rootPkg.workspaces) {
    const manifestPath = join(root, dir, 'package.json');
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (pkg.private === true) continue;
    out.push({ name: pkg.name, dir: join(root, dir), pkg });
  }
  return out;
}

/** The marker key of a workspace: `exports.<unscoped name>`. */
export const inventoryKey = (/** @type {string} */ name) => `exports.${name.replace(/^@jarenjs\//, '')}`;

/**
 * One README's inventory table.
 * @param {{ name: string, dir: string, pkg: any }} workspace
 * @returns {string}
 */
export function inventoryTable(workspace) {
  const KIND = {
    javascript: 'JavaScript', schema: 'schema', asset: 'asset', metadata: 'metadata', pattern: 'pattern',
  };
  const rows = exportEntries(workspace.pkg, workspace.dir).map((entry) => {
    const declared = entry.kind === 'javascript' ? (entry.types ? 'declared' : 'none') : '—';
    return `| \`${entry.subpath}\` | ${KIND[entry.kind]} | ${declared} |`;
  });
  // a block: the marker stays on its own line above and below the table
  return `\n${['| Import | Kind | Declarations |', '|---|---|---|', ...rows].join('\n')}\n`;
}

/** The repository this file lives in, as a path — never a URL's pathname. */
const OWN_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The root the runner last asked `docs` about: `facts` describes the same tree. */
let rootAsked = OWN_ROOT;

/** @type {import('./lib/derive.js').Registry} */
export const exportInventory = {
  name: 'the workspace manifests (exports)',
  docs: (root) => {
    rootAsked = root;
    return publicWorkspaces(root)
      .map(({ dir }) => join(dir, 'README.md'))
      .filter((readme) => existsSync(readme))
      .map((readme) => readme.slice(root.length).replace(/^[\\/]+/, '').split('\\').join('/'));
  },
  facts: () => {
    // the registry is asked for facts by marker; every public workspace
    // answers its own key, computed from its manifest and its directory
    /** @type {Record<string, () => string>} */
    const facts = {};
    for (const workspace of publicWorkspaces(rootAsked)) {
      facts[inventoryKey(workspace.name)] = () => inventoryTable(workspace);
    }
    return facts;
  },
};
