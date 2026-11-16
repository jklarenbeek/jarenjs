//@ts-check
/**
 * The churn total the local search keeps per slot, held to a churn
 * counted again from nothing after every edit, preview and reset, over
 * seeded edit streams.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { churnOf, ChurnTotal } from '../../../packages/core/src/assign/search/churn.js';
import { lcg } from './stream.js';

const SLOTS = [['t1', 'lead'], ['t1', 'crew'], ['t2', 'crew'], ['t3', 'lead']];
const PEOPLE = ['a', 'b', 'c', 'd', 'e'];

/** @param {any[]} list @param {any} edit */
function applied(list, edit) {
  const same = (/** @type {any} */ item, /** @type {any} */ t) => item.task === t.task && item.slot === t.slot && item.resource === t.resource;
  if (edit.op === 'assign') return [...list, { task: edit.task, slot: edit.slot, resource: edit.resource }];
  if (edit.op === 'unassign') return list.filter((item) => !same(item, edit));
  if (edit.op === 'move') return list.map((item) => (same(item, { ...edit, resource: edit.from }) ? { ...item, resource: edit.to } : item));
  return list.map((item) => (same(item, edit.a) ? { ...item, resource: edit.b.resource } : same(item, edit.b) ? { ...item, resource: edit.a.resource } : item));
}

/** @param {() => number} draw @param {any[]} list */
function editOf(draw, list) {
  for (;;) {
    const kind = draw() % 4;
    const [task, slot] = SLOTS[draw() % SLOTS.length];
    const here = list.filter((item) => item.task === task && item.slot === slot);
    const free = PEOPLE.filter((p) => !here.some((item) => item.resource === p));
    if (kind === 0 && free.length > 0) return { op: 'assign', task, slot, resource: free[draw() % free.length] };
    if (kind === 1 && here.length > 0) return { op: 'unassign', ...here[draw() % here.length] };
    if (kind === 2 && here.length > 0 && free.length > 0) return { op: 'move', task, slot, from: here[draw() % here.length].resource, to: free[draw() % free.length] };
    if (kind === 3 && list.length > 1) {
      const a = list[draw() % list.length];
      const b = list[draw() % list.length];
      const has = (/** @type {any} */ x, /** @type {string} */ r) => list.some((item) => item.task === x.task && item.slot === x.slot && item.resource === r);
      if (a.resource !== b.resource && (a.task !== b.task || a.slot !== b.slot) && !has(a, b.resource) && !has(b, a.resource)) return { op: 'swap', a, b };
    }
  }
}

describe('the local search\'s churn total', () => {
  it('equals a churn counted from nothing after every preview, edit and reset', () => {
    let steps = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const next = lcg(seed);
      const draw = () => next(1 << 20);
      /** @type {any[]} */
      let baseline = [];
      for (let i = 0; i < 6; i++) baseline = applied(baseline, editOf(draw, baseline));
      let list = seed % 3 === 0 ? [] : baseline.slice(0, seed % 5);
      const total = new ChurnTotal(baseline, list);
      assert.strictEqual(total.total, churnOf(baseline, list).total);
      for (let step = 0; step < 40; step++) {
        const edit = editOf(draw, list);
        const after = applied(list, edit);
        assert.strictEqual(total.after(/** @type {any} */ (edit)), churnOf(baseline, after).total, `seed ${seed} step ${step} preview`);
        assert.strictEqual(total.total, churnOf(baseline, list).total, 'a preview changed the total');
        if (draw() % 3 === 0) continue;
        total.commit(/** @type {any} */ (edit));
        list = after;
        assert.strictEqual(total.total, churnOf(baseline, list).total, `seed ${seed} step ${step} edit`);
        if (draw() % 10 === 0) {
          total.reset(list);
          assert.strictEqual(total.total, churnOf(baseline, list).total, 'reset');
        }
        steps++;
      }
    }
    assert.ok(steps > 500, String(steps));
  });
});
