//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('JSLT compile profiles cover the selected transformation set', () => {
  for (const [filter, expected] of [['reshape', ['reshape']], ['surgical', ['surgical']],
    [null, ['identity', 'surgical', 'reshape', 'annotate']]]) {
    it(`reports ${filter ?? 'all stylesheets'} without timing unsupported sources`, (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'jaren-jslt-profile-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const output = join(directory, 'profile.json');
      execFileSync(process.execPath, ['benchmark/jslt.js', '--profile', '--engines', 'jaren,jsonata',
        '--iterations', '1', '--output', 'json', '--filepath', output,
        ...(filter === null ? [] : ['--filter', filter])],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
      const { compile } = JSON.parse(readFileSync(output, 'utf8'));
      assert.deepEqual(compile?.sources, expected);
      assert.ok(Number.isFinite(compile.results.jaren));
      if (expected.includes('reshape')) assert.equal(compile.results.jsonata, null);
      else assert.ok(Number.isFinite(compile.results.jsonata));
    });
  }
});
