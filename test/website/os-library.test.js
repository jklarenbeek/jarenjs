//@ts-check
/**
 * The library the OS build ships (`library.json`): the field guide first,
 * then every workspace that writes a `site.md`, in workspace order, as
 * sections small enough to read aloud and to hand a model in one call —
 * and the same bytes from the same checkout, every build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { collectLibrary, GUIDE } from '../../packages/website/scripts/os-library.js';
import { isLibrary, createLibraryIndex, readSections, SECTION_MAX } from '../../packages/website/src/os/kernel/library.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('the Radiant OS library', () => {
  const library = collectLibrary(ROOT);

  it('opens with the field guide and holds every site.md in workspace order', () => {
    assert.ok(isLibrary(library));
    assert.equal(library.docs[0].id, 'radiant-os');
    assert.equal(library.docs[0].source, GUIDE);
    const workspaces = /** @type {string[]} */ (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).workspaces)
      .map((w) => w.replace(/^\.\//, '')).filter((dir) => existsSync(join(ROOT, dir, 'site.md')));
    assert.deepEqual(library.docs.slice(1).map((d) => d.source), workspaces.map((dir) => `${dir}/site.md`));
    assert.equal(new Set(library.docs.map((d) => d.id)).size, library.docs.length, 'every document has its own id');
  });

  it('cuts every document into bounded sections of plain text', () => {
    for (const doc of library.docs) {
      assert.ok(doc.sections.length > 0, doc.id);
      for (const s of doc.sections) {
        assert.ok(s.text.length > 0 && s.text.length <= SECTION_MAX, `${doc.id} ${s.id}`);
        if (!s.code) assert.doesNotMatch(s.text, /\]\(|\*\*|^---$/m, `${doc.id} ${s.id} keeps no markup`);
      }
    }
    assert.ok(JSON.stringify(library).length < 250_000, 'small enough to precache');
  });

  it('is the same document from the same checkout', () => {
    assert.equal(JSON.stringify(collectLibrary(ROOT)), JSON.stringify(library));
  });

  it('answers the studio’s own questions from the guide and the packages’ from theirs', () => {
    const index = createLibraryIndex(library);
    assert.equal(index.search('veto review approve', 3)[0].doc, 'radiant-os');
    assert.ok(index.search('state machine statechart', 5).some((h) => h.doc === 'flow'));
    const page = readSections(library, 'radiant-os', 0, 3);
    assert.equal(page?.sections.length, 3);
    assert.equal(page?.next, 3);
  });
});
