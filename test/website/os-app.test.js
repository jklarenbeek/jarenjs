//@ts-check
/**
 * Radiant OS as one app document: `createOs` over the view DOM stub with
 * fake timers, a memory database and a recording host — the chrome, the
 * clock, a whole council session decided from the keyboard, the Machine,
 * Source, Exports and Gallery apps, autosave, the theme the leader wears
 * and the restore of a saved session.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createStubHost, fire, serialize } from '../view/dom.stub.js';
import { createOs, describeFailure, AUTOSAVE_MS } from '../../packages/website/src/os/app/createOs.js';
import { viewModel } from '../../packages/website/src/os/app/viewmodel.js';
import { DOCUMENTS } from '../../packages/website/src/os/app/documents.js';
import { APPS, VIEW } from '../../packages/website/src/os/app/view.js';
import { initialState, restoreState, sessionSlice } from '../../packages/website/src/os/app/state.js';
import { createMemoryStore } from '../../packages/website/src/os/kernel/store.js';
import { applyChange } from '../../packages/website/src/os/kernel/council.js';
import { compileMachine, stepWorld } from '../../packages/website/src/os/kernel/machine.js';
import { rulesToFsm, DEFAULT_RULES } from '../../packages/website/src/os/kernel/program.js';

/** Timers the test turns by hand. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  /** @type {Map<number, { fn: () => void, at: number, every: number }>} */
  const jobs = new Map();
  return {
    jobs,
    get now() { return now; },
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { jobs.set(next, { fn, at: now + ms, every: 0 }); return next++; },
    clearTimeout: (/** @type {number} */ id) => { jobs.delete(id); },
    setInterval: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { jobs.set(next, { fn, at: now + ms, every: ms }); return next++; },
    clearInterval: (/** @type {number} */ id) => { jobs.delete(id); },
    /** Run every job due within `ms`, in time order. @param {number} ms */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        /** @type {[number, { fn: () => void, at: number, every: number }] | null} */
        let due = null;
        for (const entry of jobs) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        const [id, job] = due;
        now = job.at;
        if (job.every) job.at += job.every;
        else jobs.delete(id);
        job.fn();
      }
      now = end;
    },
  };
}

/** A key target the keys subscription listens on. */
function keyTarget() {
  /** @type {Set<Function>} */
  const listeners = new Set();
  return {
    listeners,
    addEventListener: (/** @type {string} */ _type, /** @type {Function} */ fn) => { listeners.add(fn); },
    removeEventListener: (/** @type {string} */ _type, /** @type {Function} */ fn) => { listeners.delete(fn); },
    /** @param {string} key @param {Record<string, any>} [extra] */
    press(key, extra = {}) {
      const event = { key, target: { tagName: 'BODY' }, prevented: false, preventDefault() { event.prevented = true; }, ...extra };
      for (const fn of listeners) fn(event);
      return event;
    },
  };
}

/** A memory database behind the outcome shape the page's port client answers with, recording every call. */
function recordingStore() {
  const handlers = /** @type {Record<string, (input: any) => any>} */ (createMemoryStore());
  /** @type {Array<[string, any]>} */
  const calls = [];
  return {
    calls,
    invoke: async (/** @type {string} */ op, /** @type {any} */ input) => { calls.push([op, input]); return { ok: true, value: await handlers[op](input) }; },
  };
}

/**
 * A running OS over the stub DOM.
 * @param {Partial<import('../../packages/website/src/os/app/createOs.js').OsOptions>} [options]
 */
function boot(options = {}) {
  const { document, container } = createStubHost();
  const timers = fakeTimers();
  const keys = keyTarget();
  const store = recordingStore();
  /** @type {string[]} */
  const themes = [];
  /** @type {any[]} */
  const downloads = [];
  /** @type {any[]} */
  const prefs = [];
  const os = createOs({
    node: /** @type {any} */ (container), document: /** @type {any} */ (document),
    edition: 'test edition', title: 'Radiant OS',
    about: { lead: 'Lead', sections: [{ title: 'One', text: 'Text' }], links: [{ label: 'Home', href: '../' }] },
    store,
    applyTheme: (css) => themes.push(css),
    download: (file) => downloads.push(file),
    savePrefs: (p) => prefs.push(p),
    keys,
    timers,
    now: () => timers.now,
    schedule: (flush) => flush(),
    onError: (error) => { throw error; },
    ...options,
  });
  const state = () => os.app.getState();
  /** Let effects, awaits and the council's run settle. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  /** Wait until a condition holds. @param {() => boolean} test @param {string} what */
  const until = async (test, what) => {
    for (let i = 0; i < 2000; i++) {
      if (test()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  /** Let the clock run `ms`, a tick at a time. @param {number} ms */
  const run = async (ms) => {
    for (let t = 0; t < ms; t += 20) { timers.advance(20); await settle(); }
  };
  /** @param {string} selector - a class name */
  const find = (selector) => findNode(container, (n) => (n.getAttribute?.('class') ?? '').split(' ').includes(selector));
  return { os, container, document, timers, keys, store, themes, downloads, prefs, state, settle, until, run, find, html: () => serialize(container) };
}

/** @param {any} node @param {(n: any) => boolean} test @returns {any} */
function findNode(node, test) {
  if (test(node)) return node;
  for (const child of node.childNodes ?? []) {
    const hit = findNode(child, test);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

describe('the OS document', () => {
  it('boots headless, with nothing to render into', async () => {
    const timers = fakeTimers();
    const os = createOs({ edition: 'headless', title: 'Radiant OS', timers, now: () => timers.now });
    assert.equal(os.app.getState().os.edition, 'headless');
    assert.equal(os.app.getState().os.about.lead, '');
    assert.equal(os.council.open, false);
    assert.equal(os.system.contract.id, 'radiant');
    timers.advance(1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(os.app.getState().world.tick > 0, 'the ticker runs without a screen');
    os.destroy();
    const left = timers.jobs.size;
    timers.advance(1000);
    assert.equal(timers.jobs.size, left);
  });

  it('renders the desk: the bar, the stage, the window and the dock', async () => {
    const t = boot();
    const html = t.html();
    assert.match(html, /class="os" data-theme="light" data-app="council" data-phase="idle" data-motion="full"/);
    assert.match(html, /<span class="os-edition">test edition<\/span>/);
    assert.match(html, /class="os-stage-svg"/, 'the stage draws through the view renderer where no canvas exists');
    assert.equal(findNode(t.container, (n) => n.getAttribute?.('class') === 'os-dock')?.childNodes.length, APPS.length);
    assert.match(html, /Convene now/);
    assert.match(html, /aria-label="Members by merit"/);
    await t.settle();
    t.timers.advance(0);
    await t.settle();
    assert.equal(t.themes.length, 1, 'the theme renders once the app is up');
    assert.match(t.themes[0], /--os-lead: #2563eb;/);
    t.os.destroy();
  });

  it('dances on its clock and measures what it paints', async () => {
    const t = boot();
    await t.run(1000);
    const s = t.state();
    assert.ok(s.world.tick >= 10 && s.world.tick <= 13, `twelve steps a second (got ${s.world.tick})`);
    assert.equal(s.machine.fired.length, 4);
    assert.ok(s.machine.trail.length >= 1);
    assert.ok(s.machine.measure.harmony >= 0);
    assert.match(t.html(), new RegExp(`<span class="os-pill-value">${s.world.tick}</span>`));
    t.os.app.dispatch('machine/burst');
    await t.run(200);
    assert.ok(t.state().world.tick >= s.world.tick + 8, 'fast forward takes eight steps a tick');
    t.os.destroy();
  });

  it('answers the human’s controls', async () => {
    const t = boot();
    const { dispatch } = t.os.app;
    dispatch('machine/toggle');
    assert.equal(t.state().machine.running, false);
    const tick = t.state().world.tick;
    await t.run(500);
    assert.equal(t.state().world.tick, tick, 'a paused machine does not tick');
    dispatch('machine/tick', { steps: 1 });
    await t.until(() => t.state().world.tick === tick + 1, 'one step');
    dispatch('machine/run', true);
    assert.equal(t.state().machine.running, true);
    assert.equal(t.keys.press(' ').prevented, true);
    assert.equal(t.state().machine.running, false, 'space pauses');
    t.keys.press(' ', { target: { tagName: 'BUTTON' } });
    t.keys.press(' ', { ctrlKey: true });
    t.keys.press(' ', { target: { tagName: 'INPUT' } });
    t.keys.press(' ', { target: { tagName: 'DIV', isContentEditable: true } });
    assert.equal(t.state().machine.running, false, 'keys inside controls and with modifiers are left alone');

    dispatch('os/theme');
    assert.equal(t.state().os.theme, 'dark');
    assert.deepEqual(t.prefs.at(-1), { theme: 'dark', reduce: false });
    dispatch('os/motion');
    assert.equal(t.state().os.reduce, true);
    assert.deepEqual(t.prefs.at(-1), { theme: 'dark', reduce: true });
    assert.match(t.html(), /data-theme="dark"[^>]*data-motion="reduce"/);
    dispatch('os/theme');
    assert.equal(t.state().os.theme, 'light');

    dispatch('os/notice', { tone: 'warn', text: 'Careful' });
    assert.match(t.html(), /os-notice tone-warn/);
    dispatch('os/dismiss');
    assert.doesNotMatch(t.html(), /os-notice/);
    dispatch('os/storage', { mode: 'memory', detail: 'gone after a reload' });
    assert.equal(t.state().os.storage.mode, 'memory');
    dispatch('os/online', false);
    assert.match(t.html(), /<span class="os-pill-label">network<\/span> <span class="os-pill-value">offline<\/span>/);
    dispatch('os/online', true);
    assert.doesNotMatch(t.html(), /os-pill-label">oracle/, 'no model in the seat, no pill');
    dispatch('os/oracle', { label: 'a model' });
    assert.match(t.html(), /<span class="os-pill-label">oracle<\/span> <span class="os-pill-value">a model<\/span>/);

    dispatch('stage/pick', { kind: 'head', id: 'dancer' });
    assert.equal(t.state().os.focus, 'dancer');
    assert.match(t.html(), /class="os-member is-focused"/);
    dispatch('stage/pick', { kind: 'cell', id: '12' });
    assert.equal(t.state().os.focus, null);
    dispatch('os/app', 'about');
    dispatch('stage/pick', { kind: 'sign', id: 'x' });
    assert.equal(t.state().os.app, 'council', 'tapping the sign opens the council');
    dispatch('stage/unfocus');
    assert.equal(t.state().os.focus, null);
    t.os.destroy();
  });

  it('holds a session, takes the veto from the keyboard, then an approval', async () => {
    const t = boot();
    const { dispatch } = t.os.app;
    dispatch('machine/run', false);
    t.os.app.dispatch('council/convene');
    await t.until(() => t.state().council.phase === 'veto', 'the verdict');
    const winner = t.state().council.winner;
    assert.ok(winner.score > 0);
    assert.match(t.html(), /class="os-verdict"/);
    assert.match(t.html(), new RegExp(winner.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(t.html(), /data-phase="veto"/);
    assert.ok(t.state().council.proposals.length >= 2);
    t.timers.advance(500);
    assert.equal(t.state().os.now, t.timers.now, 'the countdown clock runs while the verdict is awaited');
    const ui = viewModel(t.state()).ui;
    assert.equal(ui.left, Math.ceil((t.state().council.deadline - t.timers.now) / 1000));
    assert.match(t.html(), /s to decide — then it passes/);

    dispatch('council/convene');
    await t.until(() => t.state().os.notice?.text === 'The council is already in session.', 'a refused convene');

    t.keys.press('v');
    await t.until(() => t.state().council.log[0]?.status === 'vetoed' && t.state().council.log[0]?.reward !== null, 'the veto');
    const vetoed = t.state().council.log[0];
    assert.equal(vetoed.proposal, winner.id);
    assert.ok(t.state().council.merits[winner.by] < 1, 'the proposer paid for it');
    assert.equal(t.state().events[0].kind, 'veto');
    assert.deepEqual(t.state().events[0].change, winner.change, 'the stage still knows what was refused');
    assert.equal(t.state().council.phase, 'idle');
    assert.ok(t.store.calls.some(([op, input]) => op === 'amendment.put' && input.amendment.id === vetoed.id), 'the constitution keeps it');
    assert.match(t.html(), /os-amendment is-vetoed/);

    t.keys.press('v');
    await t.settle();
    assert.equal(t.state().council.log.length, 1, 'with nothing awaiting, V does nothing');

    dispatch('council/convene');
    await t.until(() => t.state().council.phase === 'veto', 'the second verdict');
    t.keys.press('a');
    await t.until(() => t.state().council.log[0]?.status === 'enacted', 'the approval');
    assert.equal(t.state().events[0].kind, 'enact');
    assert.equal(t.state().council.session, 2);

    dispatch('council/veto');
    dispatch('council/approve');
    await t.settle();
    t.os.destroy();
  });

  it('repeals an enacted rule, and says why it cannot repeal a fold', async () => {
    const t = boot();
    const { dispatch } = t.os.app;
    const s = t.state();
    const change = { kind: 'rule', state: 'dance', symbol: 0, member: 'write', value: 4 };
    const applied = applyChange({ machine: s.program.machine, tempo: s.program.tempo }, s.world, /** @type {any} */ (change));
    dispatch('council/enacted', {
      program: { ...s.program, machine: applied.program.machine },
      world: s.world,
      amendment: { id: 'a9-painter', proposal: 'painter-9', session: 9, by: 'painter', title: 'Paint green', status: 'enacted',
        change, score: 0.5, reward: null, inverse: applied.inverse, previousTempo: 12, tick: 0 },
    });
    dispatch('council/enacted', {
      program: t.state().program,
      world: t.state().world,
      amendment: { id: 'a10-architect', proposal: 'architect-10', session: 10, by: 'architect', title: 'Fold', status: 'enacted',
        change: { kind: 'tape', op: 'mirror' }, score: 0.5, reward: null, inverse: [], previousTempo: 12, tick: 0 },
    });
    assert.equal(t.state().program.machine.transitions[0].effects[0].with, 4);
    assert.equal(findNode(t.container, (n) => n.tagName === 'button' && serialize(n).includes('Repeal')) !== undefined, true);
    dispatch('council/repeal', 'a9-painter');
    await t.until(() => t.state().council.log.find((/** @type {any} */ a) => a.id === 'a9-painter')?.status === 'repealed', 'the repeal');
    assert.equal(t.state().program.machine.transitions[0].effects[0].with, DEFAULT_RULES.dance[0].write);
    assert.equal(t.state().events[0].kind, 'repeal');
    dispatch('council/repeal', 'a10-architect');
    await t.until(() => /cannot be undone/.test(t.state().os.notice?.text ?? ''), 'the refusal');
    dispatch('council/merits', { merits: { ...t.state().council.merits, architect: 3, human: 9 }, amendment: 'a10-architect', reward: 0.25 });
    assert.equal(t.state().council.leader, 'architect', 'the human never leads the council');
    assert.equal(t.state().council.log.find((/** @type {any} */ a) => a.id === 'a10-architect').reward, 0.25);
    assert.match(t.html(), /\+0\.250 merit/);
    t.timers.advance(0);
    await t.settle();
    assert.match(t.themes.at(-1) ?? '', /--os-lead: #16a34a;/, 'the chrome wears the leader’s colour');
    t.os.destroy();
  });

  it('lets the human draft, forecast and propose a rule from the Machine app', async () => {
    const t = boot();
    const { dispatch } = t.os.app;
    dispatch('machine/run', false);
    dispatch('os/app', 'machine');
    assert.match(t.html(), /class="os-rules"/);
    const ui = viewModel(t.state()).ui;
    const cell = ui.rules[0].cells[2];
    dispatch('machine/draft', cell.cycleWrite);
    await t.until(() => t.state().machine.forecast !== null, 'the forecast');
    assert.equal(t.state().machine.forecast.title, 'When dance reads amber, paint blue');
    assert.match(t.html(), /Your proposal/);
    assert.equal(viewModel(t.state()).ui.forecast.length, 5);
    dispatch('machine/discard');
    assert.equal(t.state().machine.draft, null);
    dispatch('machine/propose');
    assert.equal(t.state().os.app, 'machine', 'nothing to propose without a draft');
    dispatch('machine/draft', cell.cycleTurn);
    await t.until(() => t.state().machine.forecast !== null, 'the second forecast');
    dispatch('machine/propose');
    assert.equal(t.state().os.app, 'council');
    await t.until(() => t.state().council.queue.length === 1, 'the queue');
    assert.equal(t.state().council.queue[0].by, 'human');
    dispatch('council/propose', { kind: 'tempo', tempo: 20 });
    await t.until(() => t.state().council.queue.length === 2, 'the second proposal');
    dispatch('council/propose', { kind: 'rule', state: 'sleep', symbol: 0, member: 'write', value: 1 });
    await t.until(() => /names a state the program does not have/.test(t.state().os.notice?.text ?? ''), 'the refusal');
    dispatch('council/convene');
    await t.until(() => t.state().council.phase === 'veto', 'the session');
    assert.deepEqual(t.state().council.queue, [], 'the session took the queue');
    assert.ok(t.state().council.proposals.some((/** @type {any} */ p) => p.by === 'human'));
    t.os.destroy();
  });

  it('carries the human’s words to the council', async () => {
    const t = boot();
    const input = findNode(t.container, (n) => n.getAttribute?.('id') === 'os-say-input');
    const form = findNode(t.container, (n) => n.tagName === 'form');
    fire(form, 'submit', { preventDefault() {} });
    await t.settle();
    assert.deepEqual(t.state().council.chat, [], 'an empty line says nothing');
    input.value = '  more   symmetry,  please ';
    fire(input, 'input');
    assert.equal(t.state().council.draft, '  more   symmetry,  please ');
    fire(form, 'submit', { preventDefault() {} });
    await t.until(() => t.state().council.chat.length === 1, 'the message');
    assert.equal(t.state().council.chat[0].text, 'more symmetry, please');
    assert.equal(t.state().council.chat[0].by, 'human');
    assert.equal(t.state().council.draft, '');
    assert.match(t.html(), /<strong>human<\/strong> more symmetry, please/);
    t.os.destroy();
  });

  it('renders the artwork as code and hands it over', async () => {
    const t = boot();
    const { dispatch } = t.os.app;
    dispatch('exports/download');
    assert.deepEqual(t.downloads, [], 'nothing to download before a render');
    dispatch('os/app', 'exports');
    await t.until(() => t.state().exports.status === 'done', 'the CSS');
    assert.equal(t.state().exports.name, 'radiant-theme.css');
    assert.match(t.html(), /class="tok-/);
    assert.match(t.html(), /class="os-legend"/);
    dispatch('exports/download');
    assert.deepEqual(Object.keys(t.downloads[0]), ['name', 'mime', 'text']);
    assert.equal(t.downloads[0].mime, 'text/css');
    dispatch('exports/format', 'js');
    await t.until(() => t.state().exports.name === 'radiant-machine.js', 'the module');
    assert.match(t.state().exports.text, /export function run/);
    dispatch('os/app', 'council');
    dispatch('os/app', 'exports');
    assert.equal(t.state().exports.status, 'done', 'an app opened again keeps what it rendered');
    t.os.destroy();
  });

  it('keeps artworks in the gallery and puts them back', async () => {
    const t = boot();
    const { dispatch } = t.os.app;
    dispatch('machine/run', false);
    dispatch('os/app', 'gallery');
    await t.until(() => t.state().gallery.status === 'idle', 'the listing');
    assert.match(t.html(), /Nothing kept yet\./);
    const input = findNode(t.container, (n) => n.getAttribute?.('id') === 'os-title-input');
    input.value = '   First   light  ';
    fire(input, 'input');
    fire(findNode(t.container, (n) => n.tagName === 'form'), 'submit', { preventDefault() {} });
    await t.until(() => t.state().gallery.items.length === 1, 'the artwork');
    assert.equal(t.state().gallery.items[0].title, 'First light');
    assert.equal(t.state().gallery.title, '');
    dispatch('gallery/save');
    await t.until(() => t.state().gallery.items.length === 2, 'the untitled artwork');
    assert.equal(t.state().gallery.items[0].title, 'Tick 0');
    dispatch('machine/tick', { steps: 30 });
    await t.until(() => t.state().world.tick === 30, 'the dance');
    dispatch('gallery/open', t.state().gallery.items[1].id);
    await t.until(() => t.state().world.tick === 0, 'the artwork back on the floor');
    assert.equal(t.state().os.notice.text, 'Back on the floor: First light');
    assert.equal(t.state().events[0].kind, 'boot');
    dispatch('gallery/refresh');
    await t.until(() => t.state().gallery.status === 'idle', 'the second listing');
    assert.equal(t.state().gallery.items.length, 2);
    assert.match(t.html(), /class="os-artwork"/);
    t.os.destroy();

    const none = boot({ store: null });
    none.os.app.dispatch('os/app', 'gallery');
    await none.until(() => none.state().gallery.status === 'unavailable', 'the refusal');
    none.os.app.dispatch('gallery/save');
    await none.until(() => /Could not keep the artwork/.test(none.state().os.notice?.text ?? ''), 'the notice');
    none.os.destroy();
  });

  it('sculpts every document it runs, and lights up what executes', async () => {
    const t = boot();
    const { dispatch } = t.os.app;
    await t.run(200);
    dispatch('os/app', 'source');
    assert.match(t.html(), /as a sculpture: \d+ figures/);
    const machine = viewModel(t.state()).ui;
    assert.deepEqual(machine.sculpture?.active, t.state().machine.fired.map((/** @type {number} */ i) => `$['transitions'][${i}]`));
    for (const doc of DOCUMENTS) {
      dispatch('source/doc', doc.id);
      const ui = viewModel(t.state()).ui;
      assert.equal(ui.source?.id, doc.id);
      assert.ok(ui.source.tokens > 0);
      assert.ok(ui.sculpture && ui.sculpture.layout.nodes.length > 0, doc.id);
      assert.match(t.html(), new RegExp(`<h3>${doc.label}`));
    }
    dispatch('source/doc', 'council');
    assert.deepEqual(viewModel(t.state()).ui.sculpture?.active, ["$['states']['adjourn']"]);
    dispatch('source/doc', 'nothing');
    assert.equal(viewModel(t.state()).ui.source?.id, 'machine', 'an unknown document shows the program');
    const view = DOCUMENTS.find((d) => d.id === 'view');
    assert.equal(view?.read(t.state()), VIEW);
    t.os.destroy();
  });

  it('saves the running session and restores it, leaving behind what it cannot run', async () => {
    const t = boot();
    await t.run(300);
    t.timers.advance(AUTOSAVE_MS);
    await t.settle();
    const saves = t.store.calls.filter(([op]) => op === 'session.put');
    assert.equal(saves.length, 1);
    assert.deepEqual(Object.keys(saves[0][1].state), ['program', 'world', 'council']);
    t.os.destroy();
    assert.equal(t.store.calls.filter(([op]) => op === 'session.put').length, 2, 'shutting down saves once more');

    const saved = sessionSlice(t.state());
    const again = boot({ saved, app: 'machine', theme: 'dark', reduce: true });
    assert.equal(again.state().world.tick, saved.world.tick);
    assert.equal(again.state().council.next, saved.world.tick + 360);
    assert.equal(again.state().os.app, 'machine');
    assert.match(again.html(), /data-theme="dark" data-app="machine"/);
    again.os.destroy();

    const fresh = initialState({ edition: 'e', title: 't' });
    const bad = structuredClone(saved);
    bad.program.machine.transitions[0].to = 'sleep';
    bad.program.tempo = 1000;
    bad.world.tape = bad.world.tape.slice(1);
    bad.council.log = 'no';
    bad.council.session = 'one';
    const restored = restoreState(fresh, bad);
    assert.equal(restored.program, fresh.program, 'an unrunnable program is left behind');
    assert.equal(restored.world, fresh.world, 'and so is a broken floor');
    assert.deepEqual(restored.council.log, []);
    assert.equal(restored.council.session, 0);
    assert.equal(restoreState(fresh, null), fresh);
    const tempoOnly = structuredClone(saved);
    tempoOnly.program.tempo = 99;
    assert.equal(restoreState(fresh, tempoOnly).program.tempo, 12, 'a tempo out of range keeps the default');
    assert.equal(restoreState(fresh, { ...saved, council: { ...saved.council, leader: undefined } }).council.leader, 'painter');
  });

  it('stops the machine, with a notice, when its program cannot run', async () => {
    const t = boot();
    const { dispatch } = t.os.app;
    const s = t.state();
    const broken = rulesToFsm(DEFAULT_RULES);
    broken.transitions[3].to = 'sleep';
    dispatch('gallery/opened', { title: 'Broken', world: s.world, program: { machine: broken, tempo: 12 } });
    dispatch('machine/tick', { steps: 1 });
    await t.until(() => t.state().machine.running === false, 'the stop');
    assert.match(t.state().os.notice.text, /^The machine stopped: /);
    t.os.destroy();
  });

  it('reads a refused call as words a person can act on', () => {
    assert.equal(describeFailure({ error: { code: 'not-awaiting' } }), 'Nothing is awaiting your verdict any more.');
    assert.equal(describeFailure({ error: { code: 'unreadable' } }), 'That artwork was kept in a form this OS cannot run, so it stays in the gallery.');
    assert.equal(describeFailure({ error: { code: 'JC2050', details: [{ path: '/by', keyword: 'const' }, { path: '', keyword: 'required' }] } }),
      'The OS refused the request: /by (const), / (required).');
    assert.equal(describeFailure({ error: { code: 'JC2050' } }), 'The OS refused the request: invalid input.');
    assert.equal(describeFailure({ error: { code: 'JC9999', message: 'odd' } }), 'odd');
    assert.equal(describeFailure(null), 'The request failed.');
  });

  it('derives what the view shows from the state', () => {
    const state = initialState({ edition: 'e', title: 't' });
    state.world = stepWorld(compileMachine(state.program.machine), state.world, 10).world;
    state.council.merits = { ...state.council.merits, critic: 2.5, human: 1 };
    state.machine.trail = [0.1];
    state.council.proposals = [{ id: 'critic-1', by: 'critic', title: 'Wash', why: '', change: { kind: 'tape', op: 'clear' } },
      { id: 'stranger-1', by: 'stranger', title: '?', why: '', change: { kind: 'tape', op: 'clear' } }];
    state.council.scores = [{ id: 'critic-1', score: 0.25 }];
    state.council.winner = { ...state.council.proposals[0], score: 0.25 };
    state.council.log = [{ id: 'a1', by: 'critic', status: 'enacted', change: { kind: 'tempo', tempo: 9 }, reward: -0.0125 },
      { id: 'a2', by: 'nobody', status: 'vetoed', change: { kind: 'tape', op: 'mirror' } }];
    const ui = viewModel(state).ui;
    assert.deepEqual(ui.members.map((m) => m.id).slice(0, 1), ['critic'], 'the merit ladder, highest first');
    assert.equal(ui.members[0].pct, 100);
    assert.equal(ui.spark, '', 'one sample draws no line');
    assert.equal(ui.proposals[0].score, 0.25);
    assert.equal(ui.proposals[0].winner, true);
    assert.equal(ui.proposals[1].who, 'stranger');
    assert.equal(ui.proposals[1].score, null);
    assert.equal(ui.left, null, 'no deadline, no countdown');
    assert.equal(ui.log[0].rewardText, '−0.013 merit');
    assert.equal(ui.log[0].repealable, true);
    assert.equal(ui.log[1].who, 'nobody');
    assert.equal(ui.log[1].repealable, false);
    assert.equal(ui.rules.length, 2);
    assert.equal(ui.rules[0].cells[3].cycleWrite.value, 0, 'the last ink cycles back to paper');
    assert.equal(ui.source, null, 'the Source app is closed');
    assert.match(ui.label, /4 dancers on a 20 by 20 floor, tick 10/);
    state.machine.trail = [0.2, 0.4, 0.6];
    state.exports = { ...state.exports, format: 'html', text: '<p class="x">hi</p>' };
    const more = viewModel(state).ui;
    assert.equal(more.spark, '0,24 50,18 100,12', 'harmony drawn into the 100 by 30 sparkline box');
    assert.ok(more.exports.tokens > 0);
    state.exports = { ...state.exports, format: 'js', text: 'let x = 1;' };
    assert.ok(viewModel(state).ui.exports.stats.some((/** @type {any} */ s) => s.label === 'kw'));
    state.council.phase = 'unknown';
    assert.equal(viewModel(state).ui.phaseText, '');
  });
});
