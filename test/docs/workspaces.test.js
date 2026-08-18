//@ts-check
/**
 * @file The workspace drift gate: the documents that enumerate the
 * published packages must list exactly the public workspaces the root
 * `package.json` declares. Adding a workspace and forgetting a document
 * used to be invisible — three docs still said "nineteen" long after the
 * count reached 21, and PUBLISHING.md contradicted the list printed
 * directly beneath its own sentence.
 *
 * The gate asserts LISTS, never counts. A count is a second copy of a
 * fact the adjacent list already states, so the prose says "these public
 * workspaces" and lets the list carry it — nothing to go stale. Where a
 * document partitions the packages (CONSUMING's validation subset versus
 * the rest), the partition itself is checked, so a new package cannot be
 * added without being classified.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every workspace's manifest, split by the `private` flag. */
function workspaceNames() {
  const root = JSON.parse(read('package.json'));
  const publicNames = [];
  const privateNames = [];
  for (const dir of root.workspaces) {
    const manifest = JSON.parse(read(path.join(dir, 'package.json')));
    (manifest.private === true ? privateNames : publicNames).push(manifest.name);
  }
  return { publicNames: publicNames.sort(), privateNames: privateNames.sort() };
}

const { publicNames, privateNames } = workspaceNames();

/** The `@jarenjs/x` names a markdown region mentions, deduped and sorted. */
function namesIn(text, pattern) {
  const found = new Set();
  for (const match of text.matchAll(pattern)) found.add(match[1]);
  return [...found].sort();
}

/** The slice of a document between two markers (end optional). */
function section(text, start, end) {
  const from = text.indexOf(start);
  assert.notStrictEqual(from, -1, `missing marker: ${start}`);
  const rest = text.slice(from);
  if (end === undefined) return rest;
  const to = rest.indexOf(end);
  return to === -1 ? rest : rest.slice(0, to);
}

describe('the published package list matches the workspaces', () => {
  it('PUBLISHING.md lists exactly the public workspaces', () => {
    const bullets = namesIn(
      section(read('docs/workflow/PUBLISHING.md'), 'release publishes these public workspaces:', '## Authenticate'),
      /^- `(@jarenjs\/[a-z]+)`$/gm);
    assert.deepStrictEqual(bullets, publicNames);
  });

  it('the root README package table lists exactly the public workspaces', () => {
    const rows = namesIn(read('README.md'), /^\| \[`(@jarenjs\/[a-z]+)`\]\(/gm);
    assert.deepStrictEqual(rows, publicNames);
  });

  it('the ARCHITECTURE package table covers every public workspace', () => {
    const rows = namesIn(read('docs/ARCHITECTURE.md'), /^\| \[`(@jarenjs\/[a-z]+)`\]\(/gm);
    const missing = publicNames.filter((name) => !rows.includes(name));
    assert.deepStrictEqual(missing, [], 'public workspaces with no ARCHITECTURE row');
    // the table may also document a private workspace for context (the
    // website is the suite's own host), but nothing that is not a workspace
    const extra = rows.filter((name) => !publicNames.includes(name));
    assert.deepStrictEqual(extra.filter((name) => !privateNames.includes(name)), [],
      'ARCHITECTURE rows naming something that is not a workspace');
  });

  it('CONSUMING.md partitions the public workspaces, classifying every one', () => {
    const doc = read('docs/CONSUMING.md');
    const needed = namesIn(
      section(doc, '### Pick the packages', 'are independent of that set'),
      /^\| `(@jarenjs\/[a-z]+)` \|/gm);
    // the closing sentence names the rest by bare package name
    const rest = section(doc, 'are independent of that set', '###');
    const restNames = namesIn(
      section(doc, '`forms`,', 'are independent of that set') + rest,
      /`([a-z]+)`/g).map((short) => `@jarenjs/${short}`);
    const classified = [...new Set([...needed, ...restNames])].sort();
    assert.deepStrictEqual(classified, publicNames,
      'every public workspace must appear in the validation subset or the independent list');
    const both = needed.filter((name) => restNames.includes(name));
    assert.deepStrictEqual(both, [], 'a package cannot be both required and independent');
  });
});
