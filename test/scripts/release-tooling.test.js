//@ts-check
/**
 * @file The close-out tooling, checked where it decides rather than where
 * it acts: the bump's npm-pin refusal, the deploy guard's reading of a
 * dirty artifact, and the live verifier's comparison — each a pure
 * function beside the command that runs it, so the refusals are proven
 * without bumping a version or publishing a site.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { npmMismatch, pinnedNpm } from '../../scripts/release-bump.js';
import { checkBenchmarkDrift } from '../../scripts/check-benchmark-drift.js';
import { verifyLiveSite } from '../../scripts/verify-live-site.js';
import { checkDocuments, fencesOf } from '../../scripts/check-documents.js';
import { checkSiteDesign, BANNED_HUES } from '../../scripts/check-site-design.js';

const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

describe('release:bump refuses an npm that is not the pinned one', function () {
  it('reads the pin from the root manifest', function () {
    assert.strictEqual(pinnedNpm(), JSON.parse(read('package.json')).packageManager.slice(4));
  });

  it('passes the pinned version and refuses every other', function () {
    const pin = pinnedNpm();
    assert.strictEqual(npmMismatch(`${pin}\n`, pin), null);
    const refusal = npmMismatch('10.0.0\n', pin);
    assert.ok(refusal !== null, 'a different npm is refused');
    // the lockfile shape is the reason, and the fix is one command
    assert.match(refusal, new RegExp(`npm i -g npm@${pin.replace(/\./g, '\\.')}`));
    assert.match(refusal, /lockfile/);
  });
});

describe('the deploy guard reads the tracked measurements', function () {
  it('is clean on a checkout whose benchmarks match HEAD', function () {
    const report = checkBenchmarkDrift();
    assert.strictEqual(report.code, 0,
      `deploying would publish figures no commit carries: ${report.changed.join(', ')}`);
  });

  it('reports a directory that is not a git checkout rather than passing it', function () {
    const report = checkBenchmarkDrift({ root: '/' });
    assert.strictEqual(report.code, 2);
  });
});

describe('the live verifier compares the publish to this checkout', function () {
  /** A one-shot static server answering `build.json` with `body`. */
  async function serving(body) {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
  }

  const want = { version: '9.9.9', commit: 'a'.repeat(40) };

  it('verifies a live site carrying exactly this build', async function () {
    const site = await serving({ ...want, built: '2026-08-22T00:00:00+02:00' });
    const report = await verifyLiveSite({ url: site.url, want, timeoutMs: 5000 });
    site.close();
    assert.strictEqual(report.code, 0);
    assert.strictEqual(report.attempts, 1);
  });

  it('refuses a live site still serving the previous revision', async function () {
    const site = await serving({ version: want.version, commit: 'b'.repeat(40), built: 'x' });
    // the branch push is not the publish: a stale commit is the failure
    // this exists to catch, and it must not be retried into a pass
    const report = await verifyLiveSite({
      url: site.url, want, timeoutMs: 1, log: () => {}, wait: async () => {},
    });
    site.close();
    assert.strictEqual(report.code, 1);
    assert.match(report.problems[0], /commit: live bbbbbbb/);
  });

  it('refuses a site it cannot reach at all', async function () {
    const report = await verifyLiveSite({
      url: 'http://127.0.0.1:1/', want, timeoutMs: 1, log: () => {}, wait: async () => {},
    });
    assert.strictEqual(report.code, 1);
    assert.match(report.problems[0], /unreachable/);
  });
});

describe('the document gate', function () {
  it('parses every checkable fence in the committed markdown surface', function () {
    const report = checkDocuments();
    assert.deepStrictEqual(report.failures, []);
    assert.ok(report.mermaid >= 40, `expected the repo's mermaid fences, found ${report.mermaid}`);
    assert.ok(report.json >= 100, `expected the repo's json fences, found ${report.json}`);
  });

  it('walks every committed markdown document outside the fixtures', function () {
    // a gate that reports a file count and silently skips a document is
    // worse than no gate: the count is what a reader concludes coverage
    // from. `test/**` is the one deliberate exclusion — a fixture's job
    // is sometimes to be malformed.
    const tracked = execFileSync('git', ['ls-files', '*.md'],
      { cwd: fileURLToPath(root), encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
      .filter((file) => !file.startsWith('test/'));
    assert.strictEqual(checkDocuments().files, tracked.length,
      'the gate walks exactly the committed markdown outside test fixtures');
  });

  it('reads an indented fence and its language, and reports the opener line', function () {
    const source = 'a\n\n  ```json\n  {}\n  ```\n\ntext\n\n```mermaid\nflowchart TD\n```\n';
    assert.deepStrictEqual(fencesOf(source).map((f) => [f.lang, f.line]),
      [['json', 3], ['mermaid', 9]]);
  });

  it('leaves a jsonc fence alone — notation never claimed to be a value', function () {
    assert.deepStrictEqual(fencesOf('```jsonc\n{ "$in": expr }\n```\n').map((f) => f.lang),
      ['jsonc']);
  });
});

describe('the design sweep', function () {
  it('finds no banned hue in the site source', function () {
    const report = checkSiteDesign();
    assert.deepStrictEqual(report.hits, []);
    assert.ok(report.files > 0, 'and it actually scanned something');
  });

  it('keeps the hue list in exactly one place', function () {
    // the list used to live in a grep command inside DESIGN.md; prose that
    // carries a value is prose that drifts from the value
    assert.ok(BANNED_HUES.length >= 13);
    for (const doc of ['docs/DESIGN.md', 'docs/workflow/CONVENTIONS.md']) {
      const text = read(doc);
      for (const hue of BANNED_HUES) {
        assert.ok(!text.includes(hue), `${doc} still carries the hue ${hue}; the script owns it`);
      }
    }
  });
});
