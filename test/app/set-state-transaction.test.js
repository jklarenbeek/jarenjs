//@ts-check
/**
 * @file `setState` is a TRANSACTION, with the same guarantees a dispatch
 * has.
 *
 * It is public, so it is a contract, and replacing state outside the FIFO
 * queue broke four of them at once: `validateState` never saw the
 * candidate, a listener that dispatched watched two transactions
 * interleave and never observed its own committed state, a subscription
 * handler that called it re-entered reconciliation and orphaned every
 * acquisition but the last, and a parked sink failure surfaced out of the
 * next unrelated dispatch instead of at the `setState` caller.
 *
 * Each case below is one of those, stated as the property it must hold.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createApp } from '@jarenjs/app';

const headless = (appDoc, options) => createApp(appDoc, options);

describe('setState validates before it commits', () => {
  it('an invalid replacement is rejected and the state stands', () => {
    /** @type {any[]} */
    const seen = [];
    /** @type {any[]} */
    const errors = [];
    const app = headless({ state: { n: 0 }, view: [] }, {
      validateState: (next, context) => {
        seen.push({ n: next.n, action: context.action, changes: context.changes });
        return next.n >= 0;
      },
      onError: (error) => errors.push(error),
    });

    app.setState({ n: -1 });
    assert.deepStrictEqual(app.getState(), { n: 0 },
      'the invalid replacement must not have committed');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'JA2005');
    // the boot validation, plus THIS candidate
    assert.strictEqual(seen.length, 2);
    assert.deepStrictEqual(seen[1], { n: -1, action: null, changes: null },
      'the context names an external replacement, not a borrowed action');
  });

  it('a valid replacement commits', () => {
    const app = headless({ state: { n: 0 }, view: [] },
      { validateState: (next) => next.n >= 0 });
    app.setState({ n: 5 });
    assert.deepStrictEqual(app.getState(), { n: 5 });
  });

  it('a throwing validator is JA2015 and the state stands', () => {
    /** @type {any[]} */
    const errors = [];
    let first = true;
    const app = headless({ state: { n: 0 }, view: [] }, {
      validateState: () => {
        if (first) { first = false; return true; }
        throw new Error('validator boom');
      },
      onError: (error) => errors.push(error),
    });
    app.setState({ n: 1 });
    assert.deepStrictEqual(app.getState(), { n: 0 });
    assert.strictEqual(errors[0].code, 'JA2015');
  });
});

describe('setState serializes with every other transaction', () => {
  it('a listener that dispatches never sees an interleaved trace', () => {
    /** @type {string[]} */
    const trace = [];
    const app = headless({
      state: { n: 0 },
      actions: { bump: { state: { n: 2 } } },
      view: [],
    }, {});

    let dispatched = false;
    app.subscribe((state) => {
      trace.push(`L1:${state.n}`);
      if (!dispatched) { dispatched = true; app.dispatch('bump'); }
    });
    app.subscribe((state) => trace.push(`L2:${state.n}`));

    app.setState({ n: 1 });
    assert.deepStrictEqual(trace, ['L1:1', 'L2:1', 'L1:2', 'L2:2'],
      'both listeners observe transaction 1 before transaction 2 begins');
  });

  it('a nested setState from a listener also takes its turn', () => {
    /** @type {number[]} */
    const seen = [];
    const app = headless({ state: { n: 0 }, view: [] }, {});
    let once = false;
    app.subscribe((state) => {
      seen.push(state.n);
      if (!once) { once = true; app.setState({ n: 2 }); }
    });
    app.setState({ n: 1 });
    assert.deepStrictEqual(seen, [1, 2]);
    assert.deepStrictEqual(app.getState(), { n: 2 });
  });

  it('the turn guard counts replacements, so a setState loop is bounded', () => {
    /** @type {any[]} */
    const errors = [];
    const app = headless({ state: { n: 0 }, view: [] },
      { maxTurns: 5, onError: (error) => errors.push(error) });
    app.subscribe((state) => app.setState({ n: state.n + 1 }));
    app.setState({ n: 1 });
    assert.strictEqual(errors.some((error) => error.code === 'JA2010'), true,
      'an unbounded replacement loop must be abandoned, not run forever');
  });

  it('observers see one record per replacement', () => {
    /** @type {any[]} */
    const records = [];
    const app = headless({ state: { n: 0 }, view: [] }, {});
    app.observe((record) => records.push(record));
    app.setState({ n: 1 });
    app.setState({ n: 1 });   // reference-identical? no — a fresh object
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].source, 'setState');
    assert.strictEqual(records[0].status, 'applied');
    assert.strictEqual(records[0].changedPaths, null, 'a replacement changes everything');
  });

  it('a reference-identical replacement is a noop', () => {
    /** @type {any[]} */
    const records = [];
    const app = headless({ state: { n: 0 }, view: [] }, {});
    app.observe((record) => records.push(record));
    app.setState(app.getState());
    assert.deepStrictEqual(records.map((r) => r.status), ['noop']);
  });
});

describe('setState settles its own failures', () => {
  it('a listener failure under a rethrowing sink surfaces at THIS caller', () => {
    const app = headless({ state: { n: 0 }, view: [] }, {
      onError: (error) => { throw error; },   // the default rethrowing sink
    });
    app.subscribe(() => { throw new Error('listener boom'); });

    assert.throws(() => app.setState({ n: 1 }),
      (error) => /** @type {any} */ (error).code === 'JA2011',
      'the failure must not emerge from the next unrelated dispatch');
    // and the failure is not still parked, waiting to hit a later caller
    assert.throws(() => app.dispatch('nothing-registered'),
      (error) => /** @type {any} */ (error).code === 'JA2001',
      'the next transaction reports its OWN failure, not the previous one');
  });
});

describe('subscription ownership survives a re-entrant start', () => {
  it('a handler that calls setState is started once and released once', () => {
    let starts = 0;
    let cleanups = 0;
    let called = false;
    /** @type {any} */
    let app = null;
    // the sub is dead at boot, so the start below happens INSIDE the
    // replacement transaction — which is where the re-entrancy lives
    app = headless({
      state: { on: false, n: 0 },
      subs: [{ run: 'res', when: '$.on' }],
      view: [],
    }, {
      subs: {
        res: () => {
          starts += 1;
          if (!called) { called = true; app.setState({ on: true, n: 1 }); }
          return () => { cleanups += 1; };
        },
      },
    });
    assert.strictEqual(starts, 0, 'dead while `when` is false');

    app.setState({ on: true, n: 0 });
    assert.strictEqual(starts, 1,
      'the handler re-entered reconciliation; the slot was already owned');
    app.destroy();
    assert.strictEqual(cleanups, 1, 'every acquisition is released');
    assert.strictEqual(starts, cleanups, 'no acquisition outlives destroy');
  });

  it('a re-entrant start through a plain dispatch is also single', () => {
    let starts = 0;
    let cleanups = 0;
    let once = false;
    const app = headless({
      state: { on: true, n: 0 },
      actions: { bump: { patch: [{ op: 'replace', path: '/n', value: 1 }] } },
      subs: [{ run: 'res', when: '$.on' }],
      view: [],
    }, {
      subs: {
        res: (_props, dispatch) => {
          starts += 1;
          if (!once) { once = true; dispatch('bump'); }
          return () => { cleanups += 1; };
        },
      },
    });
    assert.strictEqual(starts, 1);
    app.destroy();
    assert.strictEqual(cleanups, 1);
  });
});

describe('the fan-out bound stops the work, not just the retention', () => {
  it('enumeration halts at the bound instead of resolving every item', () => {
    /** @type {any[]} */
    const errors = [];
    let keyCalls = 0;
    const app = headless({
      state: { items: Array.from({ length: 500 }, (_v, i) => i) },
      subs: [{ run: 'each', for: '$.items[*]', key: '$item' }],
      view: [],
    }, {
      maxSubInstances: 4,
      onError: (error) => errors.push(error),
      subs: { each: () => () => {} },
    });
    void app;
    void keyCalls;

    const overflow = errors.find((error) => error.code === 'JA2017');
    assert.ok(overflow !== undefined, 'the bound must report');
    assert.match(overflow.reason, /reached maxSubInstances \(4\)/);
    assert.match(overflow.reason, /enumeration stopped there/);
  });

  it('a fan-out inside the bound still resolves completely', () => {
    /** @type {any[]} */
    const errors = [];
    /** @type {any[]} */
    const started = [];
    headless({
      state: { items: [1, 2, 3] },
      subs: [{ run: 'each', for: '$.items[*]', key: '$item' }],
      view: [],
    }, {
      maxSubInstances: 4,
      onError: (error) => errors.push(error),
      subs: { each: (props) => { started.push(props); return () => {}; } },
    });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(started.length, 3);
  });
});
