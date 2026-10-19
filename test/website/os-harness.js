//@ts-check
/**
 * A running Radiant OS for tests: `createOs` over the view DOM stub with
 * timers the test turns by hand, a key target it presses, a memory
 * database that records every call and a host that records what the OS
 * hands back (themes, downloads, preferences).
 */
import assert from 'node:assert/strict';

import { createStubHost, serialize } from '../view/dom.stub.js';
import { createOs } from '../../packages/website/src/os/app/createOs.js';
import { createMemoryStore } from '../../packages/website/src/os/kernel/store.js';

/** Timers the test turns by hand. */
export function fakeTimers() {
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
export function keyTarget() {
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
export function recordingStore() {
  const handlers = /** @type {Record<string, (input: any) => any>} */ (createMemoryStore());
  /** @type {Array<[string, any]>} */
  const calls = [];
  return {
    calls,
    invoke: async (/** @type {string} */ op, /** @type {any} */ input) => { calls.push([op, input]); return { ok: true, value: await handlers[op](input) }; },
  };
}

/** @param {any} node @param {(n: any) => boolean} test @returns {any} */
export function findNode(node, test) {
  if (test(node)) return node;
  for (const child of node.childNodes ?? []) {
    const hit = findNode(child, test);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Every node under `node` that passes `test`. @param {any} node @param {(n: any) => boolean} test @returns {any[]} */
export function findAll(node, test) {
  /** @type {any[]} */
  const out = [];
  if (test(node)) out.push(node);
  for (const child of node.childNodes ?? []) out.push(...findAll(child, test));
  return out;
}

/**
 * A running OS over the stub DOM.
 * @param {Partial<import('../../packages/website/src/os/app/createOs.js').OsOptions>} [options]
 */
export function bootOs(options = {}) {
  const { document, container } = createStubHost();
  const timers = fakeTimers();
  const keys = keyTarget();
  const store = recordingStore();
  /** @type {any[]} */
  const prefs = [];
  const os = createOs({
    node: /** @type {any} */ (container), document: /** @type {any} */ (document),
    edition: 'test edition', title: 'Radiant OS',
    store,
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
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  /** Wait until a condition holds, turning the clock a little each time. @param {() => boolean} test @param {string} what */
  const until = async (test, what) => {
    for (let i = 0; i < 3000; i++) {
      if (test()) return;
      timers.advance(20);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  /** @param {string} name - a class name */
  const find = (name) => findNode(container, (n) => (n.getAttribute?.('class') ?? '').split(' ').includes(name));
  return { os, container, document, timers, keys, store, prefs, state, settle, until, find, html: () => serialize(container), dispatch: os.app.dispatch };
}

/**
 * A widget host on a window whose frames, clock and listeners the test
 * drives: `flush()` runs every pending animation frame at `win.time`.
 * @param {{ raf?: boolean }} [options]
 */
export function windowHost(options = { raf: true }) {
  /** @type {Map<number, (t: number) => void>} */
  const frames = new Map();
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  let nextFrame = 1;
  /** @type {any} */
  const win = {
    devicePixelRatio: 1,
    time: 1000,
    performance: { now: () => win.time },
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)?.add(fn); },
    removeEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => { listeners.get(type)?.delete(fn); },
    listeners,
    frames,
    /** Fire a window event. @param {string} type @param {any} event */
    fire(type, event) { for (const fn of listeners.get(type) ?? []) fn(event); },
    /** Run every pending frame at the window's time. */
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const fn of pending) fn(win.time);
    },
  };
  if (options.raf) {
    win.requestAnimationFrame = (/** @type {(t: number) => void} */ fn) => { frames.set(nextFrame, fn); return nextFrame++; };
    win.cancelAnimationFrame = (/** @type {number} */ id) => { frames.delete(id); };
  }
  const { document } = createStubHost();
  /** @type {any} */ (document).defaultView = win;
  const host = /** @type {any} */ (document.createElement('div'));
  host.clientWidth = 800;
  host.clientHeight = 500;
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500 });
  return { win, document, host };
}
