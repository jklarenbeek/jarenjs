//@ts-check
/**
 * @file FSM persistence (FLOW-FORMAT §7.7): nothing new was needed —
 * `step` is pure and a session's whole run state IS its current state
 * string — so these helpers are deliberately thin. `snapshotFsm`
 * captures a session as JSON, `resumeFsmSession` rebuilds one (the
 * existing JF2001 refusal covers a snapshot naming an undeclared
 * state), and `createDurableFsmSession` persists through a
 * SYNCHRONOUS `{ load, save }` store on every state CHANGE — a store
 * that throws fails the send, never loses a transition silently. An
 * asynchronous store composes its own wrapper; the session contract
 * stays synchronous.
 */

import { createFsmSession } from './fsm.js';

/**
 * Capture a session's durable state — the whole of it.
 * @param {{ state: string, done: boolean }} session
 * @returns {{ state: string }}
 */
export function snapshotFsm(session) {
  return { state: session.state };
}

/**
 * Rebuild a session from a snapshot. An undeclared state refuses with
 * the session's own JF2001.
 * @param {any} fsm - a machine from `compileFsm`
 * @param {{ state: string }} snapshot
 */
export function resumeFsmSession(fsm, snapshot) {
  if (snapshot === null || typeof snapshot !== 'object'
    || typeof snapshot.state !== 'string') {
    throw new TypeError('resumeFsmSession: the snapshot must carry a string "state"');
  }
  return createFsmSession(fsm, snapshot.state);
}

/**
 * A session that persists its state through a synchronous store:
 * `load()` answers the stored state (or null/undefined for a fresh
 * start), `save(state)` records each CHANGED state before the step
 * result is returned.
 * @param {any} fsm - a machine from `compileFsm`
 * @param {{ load: () => string | null | undefined,
 *   save: (state: string) => void }} store
 */
export function createDurableFsmSession(fsm, store) {
  if (typeof store?.load !== 'function' || typeof store.save !== 'function') {
    throw new TypeError('createDurableFsmSession: the store must provide load and save');
  }
  const stored = store.load();
  const session = createFsmSession(fsm, stored ?? undefined);
  return Object.freeze({
    get state() { return session.state; },
    get done() { return session.done; },
    can: (event, opts) => session.can(event, opts),
    send(event, opts) {
      const result = session.send(event, opts);
      if (result.changed) store.save(result.state);
      return result;
    },
  });
}
