//@ts-check
/**
 * @file The vector corpus lives in exactly one place, and every executor
 * reads that place.
 *
 * `test/json/fixtures/vector-corpus.json` is the oracle three executors
 * are held to: the JavaScript engine, SQLite through the Node driver and
 * SQLite compiled to wasm. A second copy — a fixture pasted beside a
 * runner, a projection that drifted from its source — is a corpus that
 * can disagree with itself while every runner stays green, which is the
 * one failure a differential oracle cannot survive.
 *
 * The projection `buildVectorCorpus` produces is not consumed by a site
 * build today; it is asserted here anyway, because a projection nobody
 * checks is how the spatial one would have drifted before its browser
 * leg existed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  VECTOR_CORPUS_PATH, readVectorCorpus, buildVectorCorpus,
} from '../../scripts/lib/vector-corpus.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Every executor and projector of the corpus, and how each reaches it. */
const READERS = [
  ['test/json/query/vector-corpus.test.js', /readVectorCorpus|fixtures\/vector-corpus\.json/, 'the engine runner'],
  ['test/db/vector-oracle.test.js', /readVectorCorpus/, 'the Node and wasm SQLite runners'],
  ['scripts/generate-vector-corpus.js', /VECTOR_CORPUS_PATH|vector-corpus\.json/, 'the generator'],
];

describe('the vector corpus has one source', () => {
  it('is tracked exactly once, at the path the shared reader names', () => {
    const tracked = execFileSync('git', ['ls-files', '--', '*vector-corpus.json'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((line) => line !== '');
    assert.deepStrictEqual(tracked, [VECTOR_CORPUS_PATH],
      'a second tracked copy is a corpus that can disagree with itself');
    const corpus = readVectorCorpus();
    assert.ok(Array.isArray(corpus.entries) && corpus.entries.length > 0,
      'the shared reader reads that file');
  });

  it('every executor reads that file, or the one reader over it', () => {
    for (const [file, pattern, role] of READERS) {
      assert.match(read(file), pattern, `${role} (${file}) no longer reaches the corpus by its one path`);
    }
    for (const [file] of READERS) {
      const others = read(file).match(/[\w./-]*vector-corpus[\w.-]*\.json/g) ?? [];
      for (const hit of others) {
        assert.ok(hit.endsWith('fixtures/vector-corpus.json'),
          `${file} names an unexpected corpus file: ${hit}`);
      }
    }
  });

  it('the projection an executor outside Node would read builds from that source', () => {
    const projected = buildVectorCorpus(readVectorCorpus());
    assert.ok(projected.entries.length > 0, 'the projection carries no entries');
    assert.strictEqual(projected.dims, readVectorCorpus().dims,
      'the projection changed the corpus width');
  });
});
