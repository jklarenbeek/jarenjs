//@ts-check
/** Published pen coverage, derived from exports and executable keyword routes. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSubpaths } from './lib/exports.js';
import { KEYWORD_ROUTES } from '../test/linq/schema-keyword-corpus.js';

/**
 * Enumerate the published family and prove every owned keyword is emitted by
 * its dedicated route. A lost mapping fails derivation instead of publishing
 * a coverage number based only on method names.
 * @param {string} root repository root
 */
export function penCensus(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages/linq/package.json'), 'utf8'));
  const subpaths = importSubpaths(manifest).filter((name) => name !== '@jarenjs/linq').sort();
  const source = readFileSync(join(root, 'packages/linq/src/schema/builders.js'), 'utf8');
  const block = /const OWNED = new Set\(\[([\s\S]*?)\]\);/.exec(source);
  if (!block) throw new Error('schema owned-keyword set is missing');
  const owned = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
  const routes = Object.keys(KEYWORD_ROUTES).sort();
  if (JSON.stringify(owned) !== JSON.stringify(routes))
    throw new Error('schema owned keywords differ from the dedicated route corpus');
  for (const [keyword, build] of Object.entries(KEYWORD_ROUTES)) {
    if (/\.(?:keyword|from)\s*\(/.test(String(build)))
      throw new Error(`${keyword}: an escape hatch is not a dedicated route`);
    const value = build();
    if (!Object.hasOwn(value.schema ?? value, keyword))
      throw new Error(`${keyword}: the dedicated route does not emit its keyword`);
  }
  return { subpaths, owned, routes };
}

let rootAsked = fileURLToPath(new URL('../', import.meta.url));

/** The common derivation runner owns marker parsing and drift diagnostics. */
export const penCoverage = /** @type {import('./lib/derive.js').Registry} */ ({
  name: 'LINQ exports and executable schema routes',
  docs: (root) => {
    rootAsked = root;
    return ['packages/linq/README.md', 'packages/linq/docs/LINQ-FORMAT.md'];
  },
  facts: () => ({
    'coverage.pens': () => {
      const { subpaths, owned, routes } = penCensus(rootAsked);
      return `${subpaths.length} public pen/client subpaths beside the chain; `
        + `${routes.length}/${owned.length} owned schema keywords have dedicated emission routes.`;
    },
    'coverage.subpaths': () => penCensus(rootAsked).subpaths
      .map((name) => `\`${name.replace('@jarenjs/linq', '.')}\``).join(', '),
  }),
});
