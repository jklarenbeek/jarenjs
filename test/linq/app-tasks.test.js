//@ts-check
/**
 * @file The app pen's conditional transition and task slot (APP-PEN §5,
 * TASKS.md): `when(cond, then, otherwise?)` writes `{ "$if": … }` — no
 * cast, nesting, an optional else — and `taskSlot()` writes the async-task
 * convention's three actions with the increment written once and every
 * completion guarded on the slot's id. The worked example of TASKS.md is
 * rebuilt through the slot and compared byte for byte, and the slot's
 * actions run under `createApp` with `createTaskEffect`: a stale
 * completion changes nothing, the fresh one lands.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { action, defineApp, replace, taskSlot, transition, when } from '@jarenjs/linq/app';
import { op } from '@jarenjs/linq/jslt';
import { createApp, createTaskEffect } from '@jarenjs/app';

/** @param {string} code @param {RegExp} [pattern] */
const coded = (code, pattern = /./) => (/** @type {any} */ error) => error.code === code && pattern.test(error.message);
const sync = (/** @type {() => void} */ flush) => flush();
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** TASKS.md's one json block: the worked example. */
function workedExample() {
  const md = readFileSync(new URL('../../packages/app/docs/TASKS.md', import.meta.url), 'utf8');
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)];
  assert.strictEqual(blocks.length, 1);
  return JSON.parse(blocks[0][1]);
}

describe('when() — a conditional transition', () => {
  it('writes $if with the branches spelled as the action spells its own result, and needs no else', () => {
    const doc = action((/** @type {any} */ s, /** @type {any} */ x) =>
      when(x.payload.id.eq(s.tasks.scan.id), transition({ patch: [replace((st) => st.tasks.scan.status, 'idle')] }))).document;
    assert.deepStrictEqual(doc, { $if: [{ $eq: ['$payload.id', '$.tasks.scan.id'] },
      { patch: [{ op: 'replace', path: '/tasks/scan/status', value: 'idle' }] }] });
  });

  it('nests, takes an otherwise, and takes a literal boolean', () => {
    const doc = action((/** @type {any} */ s) => when(s.ready, when(true, transition({ state: { a: 1 } })), transition({}))).document;
    assert.deepStrictEqual(doc, { $if: ['$.ready', { $if: [true, { state: { a: 1 } }] }, {}] });
  });

  it('refuses what is not a condition or a branch (JL0101), and works only inside a capture (JL0005)', () => {
    for (const [cond, then] of /** @type {[any, any][]} */ ([['yes', {}], [1, {}]])) {
      assert.throws(() => action(() => when(cond, then)), coded('JL0101', /a condition/));
    }
    assert.throws(() => action((/** @type {any} */ s) => when(s.ready, 42)), coded('JL0101', /a transition/));
    assert.throws(() => action((/** @type {any} */ s) => when(s.ready, { patch: [], nope: 1 })), coded('JL0101', /a transition/));
    assert.throws(() => action((/** @type {any} */ s) => when(s.ready, s.other)), coded('JL0101', /neither/));
    assert.throws(() => when(true, {}), coded('JL0005'));
  });
});

describe('taskSlot() — the task convention written once', () => {
  const list = taskSlot('list', { at: (/** @type {any} */ s) => s.tasks.list });
  const detail = taskSlot('detail', { at: (/** @type {any} */ s) => s.tasks.detail, fail: true });
  const actions = {
    ...list.start('http', { url: '/api/items' }),
    ...list.done((/** @type {any} */ _s, /** @type {any} */ x) => [replace((st) => st.items, x.payload.result)]),
    ...detail.start('http', (/** @type {any} */ _s, /** @type {any} */ x) =>
      ({ url: op('$concat', ['/api/items/', op('$string', x.payload)]) })),
    ...detail.done((/** @type {any} */ _s, /** @type {any} */ x) => [replace((st) => st.detail, x.payload.result)]),
    ...detail.fail(),
  };

  it('rebuilds the worked example of TASKS.md byte for byte, under the slot\'s own action names', () => {
    // a mechanical rename: the example names its actions freely, a slot
    // names them <slot>/start, <slot>/done and <slot>/fail
    const names = /** @type {const} */ ({ loadList: 'list/start', listLoaded: 'list/done', openDetail: 'detail/start',
      detailLoaded: 'detail/done', detailFailed: 'detail/fail' });
    const example = workedExample();
    for (const [hand, slot] of Object.entries(names)) {
      let text = JSON.stringify(example.actions[hand]);
      for (const [from, to] of Object.entries(names)) text = text.replaceAll(`"${from}"`, `"${to}"`);
      assert.strictEqual(JSON.stringify(actions[slot].document), text, slot);
    }
    assert.deepStrictEqual(list.initial, example.state.tasks.list);
  });

  it('writes the increment once: the patch and the effect carry one expression', () => {
    const doc = /** @type {any} */ (actions['list/start'].document);
    assert.deepStrictEqual(doc.patch[0].value, doc.effects[0].with.id);
    assert.deepStrictEqual(doc.effects[0].with.id, { $add: ['$.tasks.list.id', 1] });
    assert.deepStrictEqual(Object.keys(doc.effects[0].with), ['id', 'done', 'slot', 'url']);
    assert.deepStrictEqual(Object.keys(/** @type {any} */ (actions['detail/start'].document).effects[0].with),
      ['id', 'done', 'fail', 'slot', 'url']);
  });

  it("mode 'exhaust' adds the document's guard: a start while loading changes nothing", () => {
    const save = taskSlot('save', { at: (/** @type {any} */ s) => s.save, mode: 'exhaust' });
    const start = save.start('http');
    const doc = /** @type {any} */ (start['save/start'].document);
    assert.deepStrictEqual(doc.$if[0], { $ne: ['$.save.status', 'loading'] });
    assert.deepStrictEqual(Object.keys(doc.$if[1]), ['patch', 'effects']);
    // the host registers the same mode: the document cannot carry it
    /** @type {any[]} */
    const runs = [];
    const http = createTaskEffect((props) => new Promise(() => { runs.push(props.id); }), { mode: 'exhaust' });
    const app = createApp(defineApp({ state: { save: save.initial }, view: [{ match: '$', body: ['main'] }],
      actions: { ...start, ...save.done() } }).document, { schedule: sync, effects: { http } });
    app.dispatch('save/start');
    app.dispatch('save/start');
    assert.deepStrictEqual(app.getState().save, { id: 1, status: 'loading', error: null });
    assert.deepStrictEqual(runs, [1]);
    app.destroy();
  });

  it('refuses what it does not take (JL0101): options, names, props it owns, a fail it does not route', () => {
    const at = (/** @type {any} */ s) => s.x;
    for (const [name, options, pattern] of /** @type {[any, any, RegExp][]} */ ([
      ['', { at }, /non-empty string/], ['x', null, /options are/], ['x', { at, mood: 'switch' }, /does not take 'mood'/],
      ['x', { at: 'tasks.x' }, /at is a lambda/], ['x', { at, mode: 'merge' }, /mode is one of/], ['x', { at, fail: 'yes' }, /fail is a boolean/],
    ])) assert.throws(() => taskSlot(name, options), coded('JL0101', pattern), JSON.stringify(name));
    const slot = taskSlot('x', { at });
    assert.throws(() => slot.fail(), coded('JL0101', /no fail action/));
    assert.throws(() => slot.start(''), coded('JL0101', /handler's name/));
    assert.throws(() => slot.start('http', { id: 1 }), coded('JL0101', /cannot set 'id'/));
    assert.throws(() => slot.start('http', /** @type {any} */ ('url')), coded('JL0101', /an object of the effect's own props/));
    // a patch the completion cannot read names the call it was handed to
    assert.throws(() => slot.done(/** @type {any} */ (7)), coded('JL0101', /^JL0101: done\(\) patch is an array/));
    assert.throws(() => taskSlot('y', { at, fail: true }).fail(/** @type {any} */ ([1])),
      coded('JL0101', /^JL0101: fail\(\) patch\[0\] is one of/));
  });

  it('runs under createApp and createTaskEffect: of two starts, the stale completion changes nothing and the fresh one lands', async () => {
    const scan = taskSlot('scan', { at: (/** @type {any} */ s) => s.scan });
    const app = defineApp({
      state: { scan: scan.initial, result: null }, view: [{ match: '$', body: ['main'] }],
      actions: {
        ...scan.start('fetch', (/** @type {any} */ _s, /** @type {any} */ x) => ({ q: x.payload })),
        ...scan.done((/** @type {any} */ _s, /** @type {any} */ x) => [replace((st) => st.result, x.payload.result)]),
      },
    });
    /** @type {{ props: any, resolve: (value: any) => void }[]} */
    const calls = [];
    // parallel: nothing aborts the first request, so only the id guard can reject its answer
    const fetchEffect = createTaskEffect((props) => new Promise((resolve) => { calls.push({ props, resolve }); }), { mode: 'parallel' });
    const running = createApp(app.document, { schedule: sync, effects: { fetch: fetchEffect } });
    running.dispatch('scan/start', 'first');
    running.dispatch('scan/start', 'second');
    assert.deepStrictEqual(calls.map((call) => [call.props.id, call.props.q]), [[1, 'first'], [2, 'second']]);
    assert.deepStrictEqual(running.getState().scan, { id: 2, status: 'loading', error: null });
    calls[0].resolve('stale');
    await drain();
    assert.deepStrictEqual(running.getState(), { scan: { id: 2, status: 'loading', error: null }, result: null },
      'the stale completion is the empty sequence: nothing changed');
    calls[1].resolve('fresh');
    await drain();
    assert.deepStrictEqual(running.getState(), { scan: { id: 2, status: 'done', error: null }, result: 'fresh' });
    running.destroy();
  });

  it('routes a failure to done by default, or to its own action', async () => {
    const one = taskSlot('one', { at: (/** @type {any} */ s) => s.one });
    const own = taskSlot('own', { at: (/** @type {any} */ s) => s.own, fail: true });
    const app = defineApp({
      state: { one: one.initial, own: own.initial }, view: [{ match: '$', body: ['main'] }],
      actions: { ...one.start('fail'), ...one.done(), ...own.start('fail'), ...own.done(), ...own.fail() },
    });
    const failing = createTaskEffect(() => Promise.reject(new Error('down')));
    const running = createApp(app.document, { schedule: sync, effects: { fail: failing } });
    running.dispatch('one/start');
    running.dispatch('own/start');
    await drain();
    assert.deepStrictEqual(running.getState(), {
      one: { id: 1, status: 'error', error: 'down' }, own: { id: 1, status: 'error', error: 'down' } });
    running.destroy();
  });
});
