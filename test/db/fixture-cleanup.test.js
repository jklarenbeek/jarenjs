//@ts-check
/** A native fixture must enact its cleanup budget independently of host retry options. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { removeTempDirectory, tempDbPath } from './helpers.js';

it('transient removal failures settle within one shared linear budget', () => {
  const codes = ['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'];
  const waits = [];
  let calls = 0;
  removeTempDirectory('owned-fixture', (dir, options) => {
    assert.equal(dir, 'owned-fixture');
    assert.deepEqual(options, { recursive: true, force: true, maxRetries: 0 });
    if (calls++ < codes.length) throw Object.assign(new Error('transient'), { code: codes[calls - 1] });
  }, (ms) => { waits.push(ms); });
  assert.equal(calls, 6);
  assert.deepEqual(waits, [100, 200, 300, 400, 500]);
});

it('persistent removal failure preserves the final error after exactly ten retries', () => {
  const waits = [];
  const failure = Object.assign(new Error('still owned'), { code: 'EBUSY' });
  let calls = 0;
  assert.throws(() => removeTempDirectory('owned-fixture', () => {
    calls++;
    throw failure;
  }, (ms) => { waits.push(ms); }), (error) => error === failure);
  assert.equal(calls, 11);
  assert.deepEqual(waits, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  assert.equal(waits.reduce((total, ms) => total + ms, 0), 5500);
});

it('unclassified removal errors fail immediately without a wait', () => {
  const failure = Object.assign(new Error('invalid fixture path'), { code: 'EINVAL' });
  let calls = 0;
  assert.throws(() => removeTempDirectory('owned-fixture', () => {
    calls++;
    throw failure;
  }, () => { assert.fail('an unclassified error must not wait'); }), (error) => error === failure);
  assert.equal(calls, 1);
});

it('the native pause enforces backoff even when removal ignores retry options', () => {
  let calls = 0;
  const started = performance.now();
  removeTempDirectory('owned-fixture', () => {
    if (calls++ === 0) throw Object.assign(new Error('transient'), { code: 'EBUSY' });
  });
  assert.equal(calls, 2);
  assert.ok(performance.now() - started >= 90, 'the first 100ms backoff must actually wait');
});

it('real fixture cleanup removes its file and remains idempotent', () => {
  const { dbPath, cleanup } = tempDbPath();
  writeFileSync(dbPath, 'owned fixture');
  cleanup();
  assert.equal(existsSync(dirname(dbPath)), false);
  cleanup();
});
