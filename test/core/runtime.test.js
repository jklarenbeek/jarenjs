//@ts-check
/**
 * @file `@jarenjs/core/runtime` — the runtime record. Its defaults are
 * the platform's own, member for member (the very functions every
 * subsystem fell back to before the record existed), a partial override
 * keeps the rest, the record is frozen and closed, and the module is a
 * type plus a freeze: it reaches for no `Intl`, no clock and no random
 * source of its own.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createRuntime, resolveRuntime, RUNTIME_MEMBERS } from '@jarenjs/core/runtime';
import { mulberry32 } from '@jarenjs/core/random';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A provider-shaped pair, enough for the record's validation. */
const provider = { toParts: () => ({}), toEpoch: () => 0 };

describe('core/runtime — the default record', function () {
  it('is the platform\'s own, member for member', function () {
    const runtime = createRuntime();
    assert.deepStrictEqual(Object.keys(runtime), [...RUNTIME_MEMBERS]);
    assert.strictEqual(runtime.now, Date.now, 'the clock IS Date.now, not a wrapper');
    assert.strictEqual(runtime.random, Math.random, 'the source IS Math.random');
    assert.strictEqual(runtime.zoneProvider, null, 'a named zone stays a refusal');
    const a = runtime.uuid();
    const b = runtime.uuid();
    assert.match(a, UUID_V4);
    assert.match(b, UUID_V4);
    assert.notStrictEqual(a, b);
    const before = Date.now();
    const at = runtime.now();
    assert.ok(at >= before && at <= Date.now());
    const draw = runtime.random();
    assert.ok(draw >= 0 && draw < 1);
  });

  it('is frozen and shared: building it twice is one record', function () {
    assert.ok(Object.isFrozen(createRuntime()));
    assert.strictEqual(createRuntime(), createRuntime());
    assert.strictEqual(createRuntime(undefined), createRuntime(null));
    assert.strictEqual(resolveRuntime(), createRuntime());
    assert.strictEqual(resolveRuntime(createRuntime()), createRuntime());
  });

  it('names its four members in the order every subsystem spells them', function () {
    assert.deepStrictEqual([...RUNTIME_MEMBERS], ['now', 'uuid', 'random', 'zoneProvider']);
    assert.ok(Object.isFrozen(RUNTIME_MEMBERS));
  });
});

describe('core/runtime — overrides', function () {
  it('keeps every member it was not given', function () {
    const clock = () => 1_700_000_000_000;
    const runtime = createRuntime({ now: clock });
    assert.strictEqual(runtime.now, clock);
    assert.strictEqual(runtime.random, Math.random);
    assert.strictEqual(runtime.zoneProvider, null);
    assert.match(runtime.uuid(), UUID_V4);
    assert.ok(Object.isFrozen(runtime));
    assert.notStrictEqual(runtime, createRuntime());
  });

  it('takes a seeded source, a counting identifier and a provider', function () {
    let n = 0;
    const runtime = createRuntime({ random: mulberry32(1), uuid: () => `id-${++n}`, zoneProvider: provider });
    assert.strictEqual(runtime.random(), mulberry32(1)());
    assert.deepStrictEqual([runtime.uuid(), runtime.uuid()], ['id-1', 'id-2']);
    assert.strictEqual(runtime.zoneProvider, provider);
    assert.strictEqual(createRuntime({ zoneProvider: null }).zoneProvider, null);
  });

  it('ignores an undefined member and resolves a partial record the same way', function () {
    const runtime = resolveRuntime({ now: undefined, uuid: () => 'x' });
    assert.strictEqual(runtime.now, Date.now);
    assert.strictEqual(runtime.uuid(), 'x');
    assert.ok(Object.isFrozen(runtime));
  });

  it('is closed: a member it does not have is a refusal naming the four it has', function () {
    assert.throws(() => createRuntime(/** @type {any} */ ({ clock: Date.now })),
      /a runtime record has 'now', 'uuid', 'random', 'zoneProvider', not 'clock'/);
    assert.throws(() => resolveRuntime(/** @type {any} */ ({ zone: 'Europe/Amsterdam' })), /not 'zone'/);
  });

  it('refuses a member that is not a function, and a provider that is not one', function () {
    assert.throws(() => createRuntime(/** @type {any} */ ({ now: 5 })), /runtime\.now is a function/);
    assert.throws(() => createRuntime(/** @type {any} */ ({ uuid: 'abc' })), /runtime\.uuid is a function/);
    assert.throws(() => createRuntime(/** @type {any} */ ({ random: null })), /runtime\.random is a function/);
    assert.throws(() => createRuntime(/** @type {any} */ ({ zoneProvider: { toParts: () => 1 } })),
      /runtime\.zoneProvider is null or a provider with toParts\(epoch, zone\) and toEpoch/);
    assert.throws(() => createRuntime(/** @type {any} */ ({ zoneProvider: 'Europe/Amsterdam' })), /runtime\.zoneProvider/);
    assert.throws(() => createRuntime(/** @type {any} */ ('now')), /a runtime record is an object/);
    assert.throws(() => resolveRuntime(/** @type {any} */ (5)), /a runtime record is an object/);
  });
});

describe('core/runtime — a type plus a freeze', function () {
  it('reaches for no Intl, no clock and no random source of its own', function () {
    const source = readFileSync(resolve(REPO_ROOT, 'packages/core/src/runtime.js'), 'utf8');
    assert.ok(!source.includes('Intl'), 'the record builds an Intl object');
    assert.ok(!/Date\.now\(\)/.test(source), 'the record reads the clock');
    assert.ok(!/new Date\(/.test(source), 'the record constructs a Date');
    assert.ok(!/Math\.random\(\)/.test(source), 'the record draws a number');
    assert.ok(!/resolvedOptions|getTimezoneOffset/.test(source), 'the record reads the host zone');
    // the platform defaults are referenced, never re-implemented
    assert.ok(source.includes('now: Date.now,'));
    assert.ok(source.includes('random: Math.random,'));
    assert.ok(source.includes('globalThis.crypto.randomUUID()'));
  });

  it('is not reachable from query compilation: the kernel has no now', function () {
    const kernel = ['packages/json/src/query', 'packages/core/src/series', 'packages/core/src/dates'];
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.js')) files.push(full);
      }
    };
    for (const dir of kernel) walk(resolve(REPO_ROOT, dir));
    assert.ok(files.length > 10);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      assert.ok(!source.includes('core/runtime'), `${file} imports the runtime record`);
      assert.ok(!/\bDate\.now\(\)/.test(source), `${file} reads the clock`);
    }
  });
});
