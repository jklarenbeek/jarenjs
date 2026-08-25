//@ts-check
/**
 * @file D3, as a test: `@jarenjs/ai` keeps exactly two dependencies.
 *
 * `scripts/check-dependencies.js` already proves the weaker, repo-wide
 * claim — no published package may depend on anything outside
 * `@jarenjs/*`. This file pins the STRONGER one for this package alone,
 * because the tempting additions here are all in-scope and would pass
 * that gate: importing `@jarenjs/db` for the ledger's storage,
 * `@jarenjs/json` for its retrieval query, `@jarenjs/flow` for a
 * pipeline. Each is one line, each is reasonable in isolation, and each
 * ends the property that `@jarenjs/ai` loads in a static page with two
 * dependencies and degrades to in-memory and schema-only.
 *
 * Everything heavy arrives through a constructor seam instead — the same
 * discipline `@jarenjs/db` follows when it injects `compileDag` rather
 * than importing `@jarenjs/flow`, and `@jarenjs/md` when it injects a
 * query compiler rather than importing `@jarenjs/json`.
 *
 * If a later change needs one of those packages, the seam is the answer.
 * Editing this list is the wrong fix.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../../packages/ai/package.json', import.meta.url), 'utf8'));

describe('ai — the dependency contract (D3)', function () {
  it('declares exactly @jarenjs/core and @jarenjs/validate', function () {
    assert.deepStrictEqual(Object.keys(manifest.dependencies ?? {}).sort(),
      ['@jarenjs/core', '@jarenjs/validate'],
      'the ledger takes its store and its query compiler through seams — adding a '
      + 'dependency here ends the static-page posture this package exists to keep');
  });

  it('declares no peer, optional or bundled dependencies either', function () {
    // a peerDependency is a runtime dependency with the install pushed
    // onto the consumer; it would defeat the check above by wording alone
    for (const field of ['peerDependencies', 'optionalDependencies', 'bundledDependencies']) {
      assert.strictEqual(manifest[field], undefined, `${field} must stay absent`);
    }
  });

  it('the compaction path imports nothing outside those two either', function () {
    // same rule as below, one level looser on the specifier: `recall.js`
    // reaches for `@jarenjs/core/string` because the suite has exactly
    // one content-hash primitive and a second one here would give the
    // same round two addresses. A SUBPATH of an allowed package is still
    // that package; a different package is not.
    for (const file of ['agent.js', 'recall.js']) {
      const source = readFileSync(
        new URL(`../../packages/ai/src/${file}`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)) {
        const specifier = match[1];
        if (specifier.startsWith('.')) continue;
        const pkg = specifier.split('/').slice(0, 2).join('/');
        assert.ok(['@jarenjs/core', '@jarenjs/validate'].includes(pkg),
          `${file} imports '${specifier}' — inject it instead`);
      }
    }
  });

  it('the embeddings client and the shared retry policy import nothing outside those two', function () {
    // the pointed case again: every vector kernel the embedder needs
    // lives in `@jarenjs/core/vector` and its reference hash in
    // `@jarenjs/core/string` — a second dot product or a second FNV-1a
    // here is exactly what the one-implementation rule forbids, and a
    // heavier embedding runtime is a host injection through the seam
    for (const file of ['embed.js', 'retry.js']) {
      const source = readFileSync(
        new URL(`../../packages/ai/src/${file}`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)) {
        const specifier = match[1];
        if (specifier.startsWith('.')) continue;
        const pkg = specifier.split('/').slice(0, 2).join('/');
        assert.ok(['@jarenjs/core', '@jarenjs/validate'].includes(pkg),
          `${file} imports '${specifier}' — inject it instead`);
      }
    }
  });

  it('the ledger, refinement and their schemas import nothing outside those two', function () {
    // the manifest is a claim; the source is the fact. A relative import
    // is this package's own code, a bare specifier is a dependency.
    //
    // `refine.js` is the pointed case: it applies RFC 6902 patches, and
    // `@jarenjs/json` ships an RFC 6902 engine. One import would work,
    // and would end the property that this package runs in a static page
    // with two dependencies — so the engine arrives as `applyPatch` and
    // refinement declines with a stated reason when nobody wired it.
    for (const file of ['ledger.js', 'refine.js', 'environment.js',
      'storage/memory.js', 'schemas/ledger.js', 'schemas/patch.js']) {
      const source = readFileSync(
        new URL(`../../packages/ai/src/${file}`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)) {
        const specifier = match[1];
        if (specifier.startsWith('.')) continue;
        // a SUBPATH of an allowed package is still that package: the
        // excerpt/size/chunk helpers live in `@jarenjs/core/chunk`
        // because the repo's rule sends pure helpers to core, and a
        // second copy here is exactly what that rule exists to prevent
        const pkg = specifier.split('/').slice(0, 2).join('/');
        assert.ok(['@jarenjs/core', '@jarenjs/validate'].includes(pkg),
          `${file} imports '${specifier}' — inject it instead`);
      }
    }
  });
});
