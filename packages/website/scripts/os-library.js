//@ts-check
/**
 * The Radiant OS library, collected at build time: the OS's own field
 * guide first, then every workspace's `site.md` in workspace order — the
 * documents the site's documentation page renders — cut into sections by
 * the OS's own `libraryFrom`. What the Library app reads, reads aloud
 * and answers from is what the packages say about themselves, so it
 * cannot drift from them.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseMarkdown } from '@jarenjs/md';

import { libraryFrom } from '../src/os/kernel/library.js';

/** The OS's own guide, repo-relative. */
export const GUIDE = 'packages/website/src/os/documents/guide.md';

/**
 * The library document, from a checkout.
 * @param {string} root - the repository root
 * @returns {import('../src/os/kernel/library.js').Library}
 */
export function collectLibrary(root) {
  const workspaces = /** @type {string[]} */ (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces);
  const sources = [{ id: 'radiant-os', title: 'Radiant OS field guide', source: GUIDE, markdown: readFileSync(join(root, GUIDE), 'utf8') }];
  for (const workspace of workspaces) {
    const dir = workspace.replace(/^\.\//, '');
    const path = join(root, dir, 'site.md');
    if (!existsSync(path)) continue;
    const markdown = readFileSync(path, 'utf8');
    const front = /** @type {any} */ (parseMarkdown(markdown)).frontmatter ?? {};
    const name = typeof front.package === 'string' ? front.package : dir;
    sources.push({
      id: name.replace(/^@[^/]+\//, ''),
      title: typeof front.card?.title === 'string' ? front.card.title : name,
      source: `${dir}/site.md`,
      markdown,
    });
  }
  return libraryFrom(sources);
}
