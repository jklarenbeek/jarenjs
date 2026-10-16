//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { JarenValidator } from '@jarenjs/validate';
import { EvalLog } from '../../packages/validate/src/tools.js';

// unevaluatedProperties/unevaluatedItems read the evaluation log, which holds
// one entry per member or item a sibling keyword evaluated. A check that
// scanned the log once per member was quadratic in the instance's size; a
// long log is now gathered into one set, and only a short one is scanned.

const D2020 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Count the per-member (per-item) scans of the evaluation log while `run` runs.
 * @param {() => void} run
 * @returns {number}
 */
function countScans(run) {
  const proto = EvalLog.prototype;
  const { hasKey, hasItem } = proto;
  let scans = 0;
  proto.hasKey = function (/** @type {any[]} */ ...args) {
    scans++;
    return hasKey.apply(this, args);
  };
  proto.hasItem = function (/** @type {any[]} */ ...args) {
    scans++;
    return hasItem.apply(this, args);
  };
  try {
    run();
  }
  finally {
    proto.hasKey = hasKey;
    proto.hasItem = hasItem;
  }
  return scans;
}

/**
 * @param {number} n
 * @returns {{ properties: Record<string, any>, data: Record<string, number> }}
 */
function members(n) {
  /** @type {Record<string, any>} */
  const properties = {};
  /** @type {Record<string, number>} */
  const data = {};
  for (let i = 0; i < n; ++i) {
    properties['p' + i] = { type: 'number' };
    data['p' + i] = i;
  }
  return { properties, data };
}

describe('unevaluated* reads a long evaluation log in one pass', () => {
  const { properties, data } = members(64);
  const items = Array.from({ length: 64 }, (_, i) => i);
  const prefixItems = items.map(() => ({ type: 'number' }));

  /** @type {Array<[string, any, any, boolean, number]>} */
  const cases = [
    ['properties beside unevaluatedProperties: false', { properties, unevaluatedProperties: false }, data, true, 0],
    ['properties in an allOf branch', { allOf: [{ properties }], unevaluatedProperties: false }, data, true, 0],
    ['properties in an anyOf branch', { anyOf: [{ properties }, { required: ['none'] }], unevaluatedProperties: false }, data, true, 0],
    // Only the member nothing evaluated is looked up, past the gathered stretch.
    ['the schema form, one member left over', { allOf: [{ properties }], unevaluatedProperties: { type: 'string' } },
      { ...data, extra: 'x' }, true, 1],
    ['prefixItems beside unevaluatedItems: false', { prefixItems, unevaluatedItems: false }, items, true, 0],
    ['items: true in a branch covers every item', { allOf: [{ prefixItems }, { items: true }], unevaluatedItems: false },
      [...items, 'more'], true, 0],
    ['the schema form of unevaluatedItems, one item left over', { prefixItems, unevaluatedItems: { type: 'string' } },
      [...items, 'more'], true, 1],
    ['items: true in a branch leaves the schema form nothing to check', {
      allOf: [{ prefixItems }, { items: true }], unevaluatedItems: { type: 'string' },
    }, [...items, 5], true, 0],
  ];

  for (const [name, schema, instance, valid, scans] of cases) {
    it(name, () => {
      for (const options of [{}, { collectErrors: true }]) {
        const validate = new JarenValidator(options).compile({ $schema: D2020, ...schema });
        let result;
        assert.equal(countScans(() => { result = validate(instance); }), scans);
        assert.equal(typeof result === 'boolean' ? result : /** @type {any} */ (result).valid, valid);
      }
    });
  }

  it('a short log is still scanned per member', () => {
    const validate = new JarenValidator().compile({ $schema: D2020, properties: { a: {}, b: {}, c: {} }, unevaluatedProperties: false });
    assert.equal(countScans(() => assert.equal(validate({ a: 1, b: 2, c: 3 }), true)), 3);
  });

  it('collects the same failures, in member order, from a long log', () => {
    // `kid` evaluates a member named `x` of its own object, not of this one.
    const validate = new JarenValidator({ collectErrors: true }).compile({
      $schema: D2020,
      allOf: [{ properties: { ...properties, kid: { properties: { x: {} } } } }],
      unevaluatedProperties: false,
    });
    const result = /** @type {any} */ (validate({ x: 1, ...data, kid: { x: 0 }, y: 2 }));
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map((/** @type {any} */ e) => [e.keyword, e.instancePath, e.params]), [
      ['unevaluatedProperties', '', { unevaluatedProperty: 'x' }],
      ['unevaluatedProperties', '', { unevaluatedProperty: 'y' }],
    ]);
    const tuple = new JarenValidator({ collectErrors: true })
      .compile({ $schema: D2020, allOf: [{ prefixItems }], unevaluatedItems: false });
    const failed = /** @type {any} */ (tuple([...items, 'a', 'b']));
    assert.equal(failed.valid, false);
    assert.deepEqual(failed.errors.map((/** @type {any} */ e) => [e.keyword, e.params]),
      [['unevaluatedItems', { unevaluatedItem: 64 }]]);
  });

  it('sees what the check itself evaluates on an instance that holds itself', () => {
    // Validating member `self` (the instance again) against the schema form
    // evaluates member `z` of the very instance being checked, after the log
    // was gathered: `z` then counts as evaluated, as a scan would find.
    const validate = new JarenValidator().compile({
      $schema: D2020,
      allOf: [{ properties }],
      unevaluatedProperties: { type: 'object', properties: { z: {} } },
    });
    /** @type {any} */
    const instance = { ...data };
    instance.self = instance;
    instance.z = 1;
    assert.equal(validate(instance), true);
    // The same for an item: validating the array in itself evaluates all of it.
    const tuple = new JarenValidator().compile({
      $schema: D2020,
      prefixItems,
      unevaluatedItems: { type: 'array', items: true },
    });
    /** @type {any[]} */
    const array = [...items];
    array.push(array, 5);
    assert.equal(tuple(array), true);
  });
});

describe('the cost of a check grows with the instance, not with its square', () => {
  /**
   * Time one validation of an `n`-member instance: the fastest of five rounds,
   * so a pause from the host or the collector does not count.
   * @param {any} build - (properties) => schema
   * @param {number} n
   */
  function perValidation(build, n) {
    const { properties, data } = members(n);
    const validate = new JarenValidator().compile({ $schema: D2020, ...build(properties) });
    assert.equal(validate(data), true);
    const reps = Math.max(4, Math.round(64000 / n));
    let fastest = Infinity;
    for (let round = 0; round < 5; ++round) {
      const start = process.hrtime.bigint();
      for (let i = 0; i < reps; ++i) validate(data);
      fastest = Math.min(fastest, Number(process.hrtime.bigint() - start) / reps);
    }
    return fastest;
  }

  // The member loop itself grows a little faster than linearly at these
  // sizes (larger objects, colder caches); the same loop with
  // additionalProperties: false, which reads no log, is the yardstick.
  for (const [name, build] of /** @type {Array<[string, (p: any) => any]>} */ ([
    ['properties', (properties) => ({ properties, unevaluatedProperties: false })],
    ['an anyOf branch', (properties) => ({ anyOf: [{ properties }, { required: ['none'] }], unevaluatedProperties: false })],
  ])) {
    it(name, () => {
      const baseline = (/** @type {number} */ n) => perValidation((properties) => ({ properties, additionalProperties: false }), n);
      // A scan per member grows ~64x over this 8x step, ~3x the yardstick.
      // One noisy sample of either side flips a single comparison on a
      // loaded runner, so the check passes when any of three paired trials
      // does: a quadratic scan stays ~3x over the yardstick in all three.
      const trials = [];
      for (let trial = 0; trial < 3; ++trial) {
        const checked = perValidation(build, 8000) / perValidation(build, 1000);
        const yardstick = baseline(8000) / baseline(1000);
        trials.push(`${checked.toFixed(1)}x against ${yardstick.toFixed(1)}x`);
        if (checked < yardstick * 1.8) return;
      }
      assert.fail(`grew in every trial: ${trials.join('; ')}`);
    });
  }
});

describe('the evaluation log keeps no instance alive', () => {
  it('after the next validation, also past a rolled-back branch', () => {
    const entry = new URL('../../packages/validate/src/index.js', import.meta.url).href;
    const script = `
      const { JarenValidator } = await import(${JSON.stringify(entry)});
      const validate = new JarenValidator().compile({
        $schema: '${D2020}',
        anyOf: [{ allOf: [{ properties: { a: {}, b: {} } }, false] }, { properties: { b: {} } }],
        unevaluatedProperties: false,
      });
      let big = { a: 1, b: 2 };
      const ref = new WeakRef(big);
      validate(big);
      big = null;
      validate(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.gc();
      console.log(JSON.stringify({ collected: ref.deref() === undefined }));
    `;
    const out = execFileSync(process.execPath,
      ['--no-warnings=ExperimentalWarning', '--expose-gc', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: process.cwd() });
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop() ?? '{}'), { collected: true });
  });
});
