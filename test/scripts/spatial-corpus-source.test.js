//@ts-check
/**
 * @file The spatial corpus lives in exactly one place, and every
 * executor reads that place.
 *
 * `test/json/fixtures/spatial-corpus.json` is the oracle three executors
 * are held to: the JavaScript engine, SQLite through the Node driver,
 * and SQLite compiled to wasm in a browser tab. A second copy — a
 * fixture pasted beside a runner, a build-time file that drifted from
 * its source — is a corpus that can disagree with itself while every
 * runner stays green. So this gate asserts three things by reading the
 * tree: one tracked fixture, every runner naming it (or the one shared
 * reader), and the site's built copy being the projection of the
 * source, byte for byte, whenever a build has produced it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  SPATIAL_CORPUS_PATH, readSpatialCorpus, buildSpatialCorpus,
} from '../../scripts/lib/spatial-corpus.js';
import { serializeSpatialCorpus } from '../../scripts/generate-site-data.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Every executor and projector of the corpus, and how each reaches it. */
const READERS = [
  ['test/json/query/spatial-corpus.test.js', /fixtures\/spatial-corpus\.json/, 'the engine runner'],
  ['test/db/spatial-oracle.test.js', /readSpatialCorpus/, 'the Node SQLite runner'],
  ['packages/website/e2e/spatial-agreement.spec.js', /test\/json\/fixtures\/spatial-corpus\.json/, 'the browser runner'],
  ['scripts/generate-site-data.js', /readSpatialCorpus/, 'the site projection'],
  ['benchmark/spatial.js', /readSpatialCorpus|spatial-corpus\.json/, 'the storage suite'],
];

describe('the spatial corpus has one source (D9)', () => {
  it('is tracked exactly once, at the path the shared reader names', () => {
    const tracked = execFileSync('git', ['ls-files', '--', '*spatial-corpus.json'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((line) => line !== '');
    assert.deepStrictEqual(tracked, [SPATIAL_CORPUS_PATH],
      'a second tracked copy is a corpus that can disagree with itself');
    assert.ok(Array.isArray(readSpatialCorpus()) && readSpatialCorpus().length > 0,
      'the shared reader reads that file');
  });

  it('every executor reads that file, or the one reader over it', () => {
    for (const [file, pattern, role] of READERS) {
      assert.match(read(file), pattern, `${role} (${file}) no longer reaches the corpus by its one path`);
    }
    // and none of them carries a second fixture path
    for (const [file] of READERS) {
      const others = read(file).match(/[\w./-]*spatial-corpus[\w.-]*\.json/g) ?? [];
      for (const hit of others) {
        assert.ok(hit.endsWith('fixtures/spatial-corpus.json') || hit.endsWith('site/spatial-corpus.json'),
          `${file} names an unexpected corpus file: ${hit}`);
      }
    }
  });

  it('the site\'s built copy is the projection of the source, byte for byte, whenever it exists', () => {
    // generated and gitignored: present after a build, absent on a clean
    // checkout — which is why every Node test derives the projection
    // rather than reading it, and why THIS check is the one that holds
    // a stale build to the fixture
    const built = join(ROOT, 'packages/website/public/site/spatial-corpus.json');
    const expected = serializeSpatialCorpus(buildSpatialCorpus(readSpatialCorpus()));
    if (!existsSync(built)) {
      assert.ok(expected.length > 0, 'the projection builds from the source (no site build present to compare)');
      return;
    }
    assert.strictEqual(readFileSync(built, 'utf8'), expected,
      'the built site carries a spatial corpus that is not the projection of the tracked fixture — rebuild');
  });
});
