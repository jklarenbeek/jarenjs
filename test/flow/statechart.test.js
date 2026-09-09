import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileStatechart, createStatechartSession } from '@jarenjs/flow';

const effect = (run) => [{ run }];
const compile = (states, transitions, initial = 'running', options) => compileStatechart({
  $fsm: '0.2', initial, states, transitions,
}, options);
const historyChart = (history) => compile([
  { id: 'running', initial: 'editing', entry: effect('enter-running'), exit: effect('exit-running') },
  { id: 'editing', parent: 'running', initial: 'a', entry: effect('enter-editing'), exit: effect('exit-editing') },
  { id: 'a', parent: 'editing', entry: effect('enter-a'), exit: effect('exit-a') },
  { id: 'b', parent: 'editing', entry: effect('enter-b'), exit: effect('exit-b') },
  { id: 'memory', parent: 'running', history },
  'paused',
], [
  { from: 'a', event: 'next', to: 'b' },
  { from: 'running', event: 'pause', to: 'paused' },
  { from: 'paused', event: 'resume', to: 'memory' },
]);

describe('explicit-time statecharts', () => {
  it('discovers inherited events and probes guarded transitions without persisting or advancing a session', () => {
    const chart = compile([
      { id: 'running', initial: 'child' }, { id: 'child', parent: 'running' },
      'inactive', { id: 'done', final: true },
    ], [
      { from: 'child', event: 'go', guard: '$.payload.allow', to: 'done' },
      { from: 'running', event: 'go', guard: false, to: 'done' },
      { from: 'running', event: 'cancel', to: 'done' },
      { from: 'child', after: 10, to: 'done' },
      { from: 'inactive', event: 'hidden', to: 'done' },
    ]);
    let saves = 0;
    const session = createStatechartSession(chart, { store: { load: () => null, save: () => { saves++; } } });
    const original = session.state;
    assert.deepEqual(chart.events(original), ['go', 'cancel']);
    assert.equal(session.done, false);
    assert.equal(session.can('go', { payload: { allow: false } }), false);
    assert.equal(session.can('go', { payload: { allow: true } }), true);
    assert.equal(session.can('hidden'), false);
    assert.equal(session.state, original);
    assert.equal(saves, 1, 'probing does not write a checkpoint');
    session.send('go', { payload: { allow: true } });
    assert.equal(saves, 2);
    assert.equal(session.done, true);
    assert.deepEqual(chart.events(session.state), []);
  });

  it('enters ancestors once and exits from the leaf, with shallow and deep history', () => {
    for (const [mode, leaf] of [['shallow', 'a'], ['deep', 'b']]) {
      const chart = historyChart(mode);
      const start = chart.start();
      assert.deepEqual(start.effects.map((e) => e.run), ['enter-running', 'enter-editing', 'enter-a']);
      const next = chart.step(start.state, 'next');
      assert.deepEqual(next.effects.map((e) => e.run), ['exit-a', 'enter-b']);
      const pause = chart.step(next.state, 'pause');
      assert.deepEqual(pause.effects.map((e) => e.run), ['exit-b', 'exit-editing', 'exit-running']);
      const restored = chart.restore(JSON.parse(JSON.stringify(pause.state)));
      assert.deepEqual(chart.step(restored, 'resume').state.active, [leaf]);
      assert.deepEqual(start.state.active, ['a'], 'steps never mutate their input');
    }
  });

  it('chooses child transitions before parents and preserves document order within a source', () => {
    const chart = compile([
      { id: 'running', initial: 'child' }, { id: 'child', parent: 'running' }, 'out',
    ], [
      { from: 'running', event: 'go', to: 'out' },
      { from: 'child', to: 'child', type: 'internal', effects: effect('wildcard') },
      { from: 'child', event: 'go', to: 'out' },
    ]);
    const result = chart.step(chart.start().state, 'go');
    assert.deepEqual(result.state.active, ['child']);
    assert.deepEqual(result.effects, effect('wildcard'));
    assert.deepEqual(result.entered, []);
  });

  it('restores history from inside its owner without exiting the owner or overwriting memory', () => {
    const chart = compile([
      { id: 'running', initial: 'a', exit: effect('leave-owner') },
      { id: 'a', parent: 'running' }, { id: 'b', parent: 'running' },
      { id: 'memory', parent: 'running', history: 'deep' }, 'outside',
    ], [
      { from: 'a', event: 'next', to: 'b' },
      { from: 'running', event: 'leave', to: 'outside' },
      { from: 'outside', event: 'default', to: 'running' },
      { from: 'a', event: 'recall', to: 'memory' },
    ]);
    let state = chart.step(chart.start().state, 'next').state;
    state = chart.step(state, 'leave').state;
    state = chart.step(state, 'default').state;
    assert.deepEqual(state.active, ['a']);
    const result = chart.step(state, 'recall');
    assert.deepEqual(result.state.active, ['b']);
    assert.deepEqual(result.effects, []);
    assert.deepEqual(result.state.history.memory, ['b']);
  });

  it('defaults unvisited history, preserves independent parallel leaves and rejects incomplete restored regions', () => {
    const chart = compile([
      'outside', { id: 'running', type: 'parallel' },
      { id: 'left', parent: 'running', initial: 'a' },
      { id: 'a', parent: 'left' }, { id: 'b', parent: 'left' },
      { id: 'right', parent: 'running', initial: 'c' },
      { id: 'c', parent: 'right' }, { id: 'd', parent: 'right' },
      { id: '__proto__', parent: 'running', history: 'deep' },
    ], [
      { from: 'outside', event: 'enter', to: '__proto__' },
      { from: 'a', event: 'go', to: 'b' }, { from: 'c', event: 'go', to: 'd' },
      { from: 'running', event: 'leave', to: 'outside' },
    ], 'outside');
    let state = chart.step(chart.start().state, 'enter').state;
    assert.deepEqual(state.active, ['a', 'c']);
    state = chart.step(state, 'go').state;
    assert.deepEqual(state.active, ['b', 'd']);
    assert.throws(() => chart.restore({ ...state, active: ['b'] }), { code: 'JF2010' });
    state = chart.step(state, 'leave').state;
    assert.deepEqual(chart.step(state, 'enter').state.active, ['b', 'd']);
  });

  const parallel = (extra = []) => compile([
    { id: 'running', type: 'parallel' },
    { id: 'left', parent: 'running', initial: 'l1' },
    { id: 'l1', parent: 'left' }, { id: 'l2', parent: 'left', final: true },
    { id: 'right', parent: 'running', initial: 'r1' },
    { id: 'r1', parent: 'right' }, { id: 'r2', parent: 'right', final: true },
    { id: 'finished', final: true },
  ], [...extra,
    { from: 'l1', event: 'go', to: 'l2', effects: effect('left-done') },
    { from: 'r1', event: 'go', to: 'r2', effects: effect('right-done') },
    { from: 'running', done: true, to: 'finished' },
  ]);

  it('fires independent regions together and completes only when all regions finish', () => {
    const chart = parallel();
    assert.deepEqual(chart.start().state.active, ['l1', 'r1']);
    const r = chart.step(chart.start().state, 'go');
    assert.deepEqual(r.effects, [...effect('left-done'), ...effect('right-done')]);
    assert.deepEqual(r.state.active, ['finished']);
    assert.equal(r.final, true);
    assert.deepEqual(r.transitions, [0, 1, 2]);
  });

  it('a transition leaving parallel control suppresses a conflicting sibling', () => {
    const chart = parallel([{ from: 'l1', event: 'go', to: 'finished' }]);
    const r = chart.step(chart.start().state, 'go');
    assert.deepEqual(r.state.active, ['finished']);
    assert.deepEqual(r.effects, []);
    assert.deepEqual(r.transitions, [0]);
  });

  it('a cross-region transition re-enters the other region defaults', () => {
    const chart = parallel([{ from: 'l1', event: 'cross', to: 'r2' }]);
    const r = chart.step(chart.start().state, 'cross');
    assert.deepEqual(r.state.active, ['l1', 'r2']);
    assert.equal(r.final, false);
    assert.ok(r.exited.includes('running'));
  });

  it('persists absolute deadlines, cancels them on exit, and does not interpret timer names as events', () => {
    const chart = compile(['running', 'paused', { id: 'done', final: true }], [
      { from: 'running', after: 10, to: 'done' },
      { from: 'running', event: 'pause', to: 'paused' },
      { from: 'paused', event: 'resume', to: 'running' },
    ]);
    const start = chart.start({ now: 100 });
    assert.equal(chart.advance(start.state, 109).final, false);
    assert.equal(chart.advance(chart.restore(JSON.parse(JSON.stringify(start.state))), 110).final, true);
    const paused = chart.step(start.state, 'pause', { now: 105 });
    assert.deepEqual(paused.state.timers, []);
    const resumed = chart.step(paused.state, 'resume', { now: 110 });
    assert.equal(resumed.state.timers[0].at, 120);
    assert.notEqual(resumed.state.timers[0].token, start.state.timers[0].token);
    assert.equal(chart.step(resumed.state, '@timer/0').changed, false);
    assert.throws(() => chart.advance(resumed.state, 109), { code: 'JF2011' });
  });

  it('consumes a false timer once; equal deadlines use transition order and newly scheduled delays use logical time', () => {
    const chart = compile(['running', 'next', { id: 'done', final: true }], [
      { from: 'running', after: 5, guard: false, to: 'done' },
      { from: 'running', after: 5, to: 'next' },
      { from: 'next', after: 5, to: 'done' },
    ]);
    const r = chart.advance(chart.start().state, 100);
    assert.equal(r.final, true);
    assert.deepEqual(r.transitions, [1, 2]);
    assert.deepEqual(r.state.timers, []);
  });

  it('bounds zero-delay and eventless cycles without partially advancing a session', () => {
    const chart = compile(['running'], [{ from: 'running', after: 0, to: 'running' }], 'running', { maxMicrosteps: 3 });
    const session = createStatechartSession(chart);
    const original = session.state;
    assert.throws(() => session.advance(0), { code: 'JF2012' });
    assert.equal(session.state, original);
    const always = compile(['running'], [{ from: 'running', always: true, to: 'running' }], 'running', { maxMicrosteps: 3 });
    assert.throws(() => always.start(), { code: 'JF2012' });
  });

  it('persists full history/timers before advancing and rejects invalid restored configurations', () => {
    const chart = historyChart('deep');
    let stored = null;
    let fail = false;
    const store = { load: () => stored, save: (state) => {
      if (fail) throw new Error('disk failed');
      stored = JSON.parse(JSON.stringify(state));
    } };
    const session = createStatechartSession(chart, { store });
    fail = true;
    assert.throws(() => session.send('next'), /disk failed/);
    assert.deepEqual(session.state.active, ['a']);
    fail = false;
    session.send('next'); session.send('pause');
    const resumed = createStatechartSession(chart, { store });
    assert.equal(resumed.initial, null, 'restoring does not replay entry effects');
    assert.deepEqual(resumed.send('resume').state.active, ['b']);
    assert.throws(() => chart.restore({ ...stored, active: ['a', 'b'] }), { code: 'JF2010' });
    assert.throws(() => chart.restore({ ...stored, history: { memory: ['paused'] } }), { code: 'JF2010' });
  });

  it('refuses malformed hierarchy, initial, history, trigger, internal and final-state declarations', () => {
    const cases = [
      [[{ id: 'running', parent: 'running' }], []],
      [[{ id: 'running', type: 'compound' }], []],
      [[{ id: 'running', history: 'deep' }], []],
      [['running', 'b'], [{ from: 'running', after: -1, to: 'b' }]],
      [['running', 'b'], [{ from: 'running', event: 'go', after: 1, to: 'b' }]],
      [['running', 'b'], [{ from: 'running', type: 'internal', to: 'b' }]],
      [[{ id: 'running', final: true }, 'b'], [{ from: 'running', to: 'b' }]],
    ];
    for (const [states, transitions] of cases) assert.throws(() => compile(states, transitions), { code: 'JF0020' });
  });
});
