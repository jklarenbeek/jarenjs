//@ts-check
/**
 * Scoring reads no clock and no zone: the same scorings print the same
 * bytes in a child process under each of three host time zones (one of
 * them 13 hours east of UTC, one with daylight saving time).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./zone-child.js', import.meta.url));

describe('host time zones', () => {
  it('answer byte-identical scorings under UTC, Pacific/Apia and Europe/Amsterdam', () => {
    const outputs = ['UTC', 'Pacific/Apia', 'Europe/Amsterdam'].map((zone) => {
      const run = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CHILD], {
        env: { ...process.env, TZ: zone, FORCE_COLOR: '0' }, encoding: 'utf8',
      });
      assert.strictEqual(run.status, 0, run.stderr);
      return run.stdout;
    });
    assert.ok(outputs[0].length > 1000);
    assert.strictEqual(outputs[1], outputs[0]);
    assert.strictEqual(outputs[2], outputs[0]);
  });
});
