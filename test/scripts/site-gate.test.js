//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

it('site:gate rejects malformed browser modes before any stage, including after skip', () => {
  const harness = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    cp.spawn = () => { throw new Error('GATE_STAGE_STARTED'); };
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'scripts/site-gate.js', '--browser=skip', process.argv[1]];
    await import('./scripts/site-gate.js');
  `;
  for (const invalid of ['--browser=typo', '--browser=', '--browser']) {
    const result = spawnSync(process.execPath,
      ['--input-type=module', '--eval', harness, '--', invalid],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'site-gate: use --browser=full|smoke|skip');
  }
});
