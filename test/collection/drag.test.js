//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createDragInteraction } from '@jarenjs/collection';

const target = { container: 'grid', key: 'row-b', column: 'day-b' };
function fixture(extra = {}) {
  const sources = new Map([['item-a', { key: 'item-a', revision: 4 }]]);
  const commands = [];
  const engine = createDragInteraction({ resolveSource: (key) => sources.get(key), validTarget: () => true,
    commit: (intent) => { commands.push(intent); }, ...extra });
  return { engine, sources, commands };
}

it('drag activation keeps only serializable stable keys and one move/copy intent', async () => {
  const { engine, commands } = fixture();
  engine.begin('item-a', { point: { x: 2, y: 3 } });
  engine.move({ x: 3, y: 3 }, target);
  assert.equal(engine.state().phase, 'armed');
  assert.equal(commands.length, 0);
  engine.move({ x: 22, y: 3 }, target, true);
  const snapshot = engine.state(); snapshot.source.revision = 100;
  assert.equal(engine.state().source.revision, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.state())), engine.state());
  const dropping = engine.drop();
  await engine.drop(); await dropping;
  assert.equal(engine.state().phase, 'settled');
  assert.deepEqual(commands, [{ source: { key: 'item-a', revision: 4 }, target, mode: 'copy' }]);
  engine.dispose(); engine.dispose(); assert.equal(engine.state().phase, 'disposed');
});

it('source revisions and disabled or removed targets cancel before dispatch', async () => {
  let valid = true;
  const { engine, sources, commands } = fixture({ validTarget: () => valid });
  engine.begin('item-a', { input: 'keyboard' }); engine.move({ x: 0, y: 0 }, target);
  sources.set('item-a', { key: 'item-a', revision: 5 });
  assert.equal(engine.revalidate().reason, 'source-changed'); await engine.drop();
  engine.begin('item-a', { input: 'keyboard' }); engine.move({ x: 0, y: 0 }, target);
  valid = false;
  assert.equal(engine.revalidate().reason, 'target-unavailable'); await engine.drop();
  assert.equal(commands.length, 0);
  assert.throws(() => engine.begin('item-a', { point: { x: NaN, y: 0 } }), TypeError);
  engine.dispose();
});

it('cancelled async permission retains one pending credit and rejects stale completion', async () => {
  let resolve, signal;
  const { engine, commands } = fixture({ validate: (_, context) => {
    signal = context.signal; return new Promise((done) => { resolve = done; });
  } });
  engine.begin('item-a', { input: 'keyboard' }); engine.move({ x: 0, y: 0 }, target);
  const dropping = engine.drop(); engine.cancel('route-changed');
  assert.equal(signal.aborted, true);
  assert.equal(engine.state().pending, true);
  assert.deepEqual(engine.begin('item-a'), { phase: 'refused', reason: 'busy' });
  resolve(true); await dropping;
  assert.equal(commands.length, 0); assert.equal(engine.state().pending, false);
  assert.equal(engine.state().phase, 'cancelled'); engine.dispose();
});

it('permission and command rejection never update source data or dispatch twice', async () => {
  for (const mode of ['permission', 'command', 'throw']) {
    let calls = 0;
    const { engine, sources } = fixture({ validate: () => mode !== 'permission', commit: () => {
      calls++; if (mode === 'throw') throw new Error('revision rejected'); return false;
    } });
    engine.begin('item-a', { input: 'keyboard' }); engine.move({ x: 0, y: 0 }, target);
    await Promise.all([engine.drop(), engine.drop()]);
    assert.equal(calls, mode === 'permission' ? 0 : 1);
    assert.equal(engine.state().phase, 'cancelled');
    assert.equal(sources.get('item-a').revision, 4); engine.dispose();
  }
});

it('disposal fences a late authority reply and leaves one bounded pending promise', async () => {
  let resolve;
  const { engine } = fixture({ commit: () => new Promise((done) => { resolve = done; }) });
  engine.begin('item-a', { input: 'keyboard' }); engine.move({ x: 0, y: 0 }, target);
  const dropping = engine.drop(); await Promise.resolve();
  assert.equal(engine.state().phase, 'committing'); engine.dispose(); engine.dispose();
  resolve(true); await dropping;
  assert.equal(engine.state().phase, 'disposed'); assert.equal(engine.state().pending, false);
  assert.deepEqual(engine.begin('item-a'), { phase: 'refused', reason: 'disposed' });
});

it('invalid sources, absent targets and throwing observers preserve disposal state', () => {
  assert.throws(() => fixture({ activationDistance: -1 }), RangeError);
  const { engine } = fixture();
  assert.equal(engine.begin('missing').phase, 'refused');
  engine.begin('item-a'); assert.equal(engine.cancel('escape').phase, 'cancelled');
  assert.equal(engine.cancel().phase, 'cancelled');
  engine.dispose();
  const broken = fixture({ onChange: () => { throw new Error('observer'); } }).engine;
  assert.throws(() => broken.dispose(), /observer/);
  assert.equal(broken.state().phase, 'disposed'); broken.dispose();
});

it('a failing validation observer releases admission without dispatching an authority command', async () => {
  const { engine, commands } = fixture({ onChange: (state) => {
    if (state.phase === 'validating') throw new Error('observer failed');
  } });
  engine.begin('item-a', { input: 'keyboard' }); engine.move({ x: 0, y: 0 }, target);
  const result = await engine.drop();
  assert.match(result.error.message, /observer failed/);
  assert.equal(engine.state().pending, false);
  assert.equal(commands.length, 0);
  assert.equal(engine.begin('item-a').phase, 'armed');
  engine.dispose();
});
