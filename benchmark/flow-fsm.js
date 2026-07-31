#!/usr/bin/env node

/**
 * @jarenjs/flow FSM performance + the serializability wedge.
 *
 * Rival: XState v5. The same logical machine — a cycle of N states,
 * each transition answering one event behind a guard that reads
 * context — is built both ways, and three honest things are measured:
 *
 *  - compile: `compileFsm(doc)` vs `createMachine(config, impl)` +
 *    `createActor(...)`. XState's actor model does scheduling and
 *    snapshot work our pure compile does not, so this is not a
 *    like-for-like — it is the cost each engine charges to go from a
 *    description to something you can drive, and the table says which.
 *  - transition throughput: our pure `step` (a total function, no held
 *    state) AND our `createFsmSession` wrapper (the mutable convenience)
 *    against an XState actor's `send`. Both our routes are on the page
 *    so the comparison is not pure-function-vs-actor by omission.
 *  - the WEDGE (a conformance row, not a timing): a jaren-fsm document
 *    is JSON *including its guards*, so it survives `JSON.stringify` →
 *    `JSON.parse` and still compiles and still fires the guard with
 *    identical results. An XState machine's guards are FUNCTIONS in the
 *    second `createMachine` argument; `JSON.stringify` drops them, and
 *    the round-tripped machine throws "Guard not implemented" at the
 *    guarded transition. Serialize-store-replay-validate is the whole
 *    reason the flow document is data all the way down; this measures
 *    that it is, and that the rival is not.
 *
 * Usage:
 *   node --expose-gc benchmark/flow-fsm.js
 *   node benchmark/flow-fsm.js --output json --filepath out.json
 */

import { writeFileSync } from 'node:fs';

import { compileFsm, createFsmSession } from '@jarenjs/flow';
import { createMachine, createActor } from 'xstate';

import { makeMeasure, printTable } from './lib/measure.js';

//#region options
const args = process.argv.slice(2);
const numOpt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const ITERATIONS = numOpt('iterations', 20000);
const WARMUP = Math.max(50, Math.floor(ITERATIONS / 20));
const OUTPUT = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
const FILEPATH = args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null;
const SIZES = [5, 50, 500];
//#endregion

//#region machine builders — the SAME logical machine, both engines

/**
 * A jaren-fsm document: a cycle s0 → s1 → … → s0, every transition on
 * 'GO' guarded by `$.context.ok` (always true here, so the cycle turns).
 * @param {number} n
 */
function jarenMachine(n) {
  const states = [];
  const transitions = [];
  for (let i = 0; i < n; i++) {
    states.push(`s${i}`);
    transitions.push({ from: `s${i}`, event: 'GO', guard: '$.context.ok', to: `s${(i + 1) % n}` });
  }
  return { $fsm: '0.1', initial: 's0', states, transitions };
}

/**
 * The XState config (serializable) and its guard implementation (NOT
 * serializable — the wedge). Same cycle, same guard.
 * @param {number} n
 */
function xstateMachine(n) {
  /** @type {any} */
  const states = {};
  for (let i = 0; i < n; i++) {
    states[`s${i}`] = { on: { GO: { target: `s${(i + 1) % n}`, guard: 'isOk' } } };
  }
  const config = { id: 'm', initial: 's0', context: { ok: true }, states };
  const impl = { guards: { isOk: ({ context }) => context.ok === true } };
  return { config, impl };
}
//#endregion

const measure = makeMeasure(WARMUP, ITERATIONS);
const scope = { context: { ok: true } };

/** Correctness: both engines must agree the cycle turns, before timing. */
function assertAgrees(n) {
  const fsm = compileFsm(jarenMachine(n));
  let state = fsm.initial;
  for (let i = 0; i < n; i++) state = fsm.step(state, 'GO', scope).state;
  if (state !== 's0') throw new Error(`jaren cycle of ${n} did not return to s0 (got ${state})`);

  const { config, impl } = xstateMachine(n);
  const actor = createActor(createMachine(config, impl));
  actor.start();
  for (let i = 0; i < n; i++) actor.send({ type: 'GO' });
  if (actor.getSnapshot().value !== 's0') throw new Error(`xstate cycle of ${n} did not return to s0`);
}

//#region timing tables
/** @type {Record<string, any>} */
const collected = { compile: {}, transition: {} };

for (const n of SIZES) {
  assertAgrees(n);
  const doc = jarenMachine(n);
  const { config, impl } = xstateMachine(n);

  const compileRows = [
    measure('jaren compileFsm', () => { compileFsm(doc); }),
    measure('xstate createMachine+Actor', () => { createActor(createMachine(config, impl)); }),
  ];
  collected.compile[n] = compileRows;
  printTable(`compile — ${n}-state machine`, compileRows);

  // transition throughput: each engine cycles through its own states
  const fsm = compileFsm(doc);
  let pureState = fsm.initial;
  const session = createFsmSession(fsm);
  const actor = createActor(createMachine(config, impl));
  actor.start();
  const transitionRows = [
    measure('jaren step (pure)', () => { pureState = fsm.step(pureState, 'GO', scope).state; }),
    measure('jaren session.send', () => { session.send('GO', scope); }),
    measure('xstate actor.send', () => { actor.send({ type: 'GO' }); }),
  ];
  collected.transition[n] = transitionRows;
  printTable(`transition — ${n}-state machine`, transitionRows);
}
//#endregion

//#region the wedge — a conformance row, not a timing
/**
 * Round-trip each engine's machine through JSON and report whether it
 * survives: compiles again, and its guard still decides the transition.
 */
function wedge() {
  // jaren: the WHOLE document, guards included, is JSON
  const doc = jarenMachine(5);
  let jarenSurvives = false;
  let jarenAgrees = false;
  try {
    const restored = JSON.parse(JSON.stringify(doc));
    const before = compileFsm(doc).step('s0', 'GO', scope);
    const after = compileFsm(restored).step('s0', 'GO', scope);
    jarenSurvives = true;
    jarenAgrees = before.state === after.state && after.state === 's1';
    // and the guard still BITES: ok=false must block the transition
    const blocked = compileFsm(restored).step('s0', 'GO', { context: { ok: false } });
    jarenAgrees = jarenAgrees && blocked.changed === false;
  }
  catch { /* jarenSurvives stays false */ }

  // xstate: JSON.stringify drops the guard functions; the restored
  // machine cannot evaluate its guard
  const { config, impl } = xstateMachine(5);
  const droppedImpl = JSON.parse(JSON.stringify(impl));   // {"guards":{}}
  let xstateSurvives = false;
  try {
    const restored = createActor(createMachine(JSON.parse(JSON.stringify(config)), droppedImpl));
    // the guard error is raised through the actor's async error channel,
    // not thrown from send(); an error subscriber consumes it (and is
    // how we observe that the machine is broken)
    let errored = false;
    restored.subscribe({ error: () => { errored = true; } });
    restored.start();
    restored.send({ type: 'GO' });   // "Guard 'isOk' is not implemented"
    xstateSurvives = !errored && restored.getSnapshot().value === 's1';
  }
  catch { xstateSurvives = false; }

  return {
    guardsSurviveJson: { jaren: jarenSurvives && jarenAgrees, xstate: xstateSurvives },
    droppedGuardCount: Object.keys(droppedImpl.guards ?? {}).length,
  };
}

const wedgeResult = wedge();
console.log('\nSerializability wedge — does the guarded machine survive a JSON round trip?');
console.log(`  jaren-fsm (document IS data, guards included)   ${wedgeResult.guardsSurviveJson.jaren ? 'YES' : 'no'}`);
console.log(`  xstate (guards are functions, dropped by JSON)  ${wedgeResult.guardsSurviveJson.xstate ? 'yes' : 'NO'}`);
//#endregion

//#region memory — live set after a forced GC
/** @type {any} */
let memory = null;
if (typeof globalThis.gc === 'function') {
  const N = 500;
  const COUNT = 200;
  const liveSet = () => {
    globalThis.gc();
    globalThis.gc();
    return process.memoryUsage().heapUsed;
  };
  const doc = jarenMachine(N);
  const { config, impl } = xstateMachine(N);

  const base = liveSet();
  const jarenHeld = [];
  for (let i = 0; i < COUNT; i++) jarenHeld.push(compileFsm(doc));
  const jarenBytes = liveSet() - base;

  const base2 = liveSet();
  const xstateHeld = [];
  for (let i = 0; i < COUNT; i++) { const a = createActor(createMachine(config, impl)); a.start(); xstateHeld.push(a); }
  const xstateBytes = liveSet() - base2;

  void jarenHeld.length; void xstateHeld.length;
  memory = { states: N, count: COUNT, jarenBytesPer: Math.round(jarenBytes / COUNT), xstateBytesPer: Math.round(xstateBytes / COUNT) };
  console.log(`\nLive set — ${COUNT} compiled ${N}-state machines held, after forced GC`);
  console.log(`  jaren compiled machine   ${(memory.jarenBytesPer / 1024).toFixed(1)} KiB each`);
  console.log(`  xstate actor (started)   ${(memory.xstateBytesPer / 1024).toFixed(1)} KiB each`);
}
else {
  console.log('\n(memory: run with `node --expose-gc` to measure the live set)');
}
//#endregion

if (OUTPUT === 'json') {
  const slim = (rows) => rows.map((r) => ({ label: r.label, ns: Number(r.ns.toPrecision(4)) }));
  const data = {
    date: new Date().toISOString(),
    node: process.version,
    xstate: '5',
    iterations: ITERATIONS,
    sizes: SIZES,
    compile: Object.fromEntries(SIZES.map((n) => [n, slim(collected.compile[n])])),
    transition: Object.fromEntries(SIZES.map((n) => [n, slim(collected.transition[n])])),
    wedge: wedgeResult,
    memory,
  };
  const json = JSON.stringify(data, null, 2);
  if (FILEPATH !== null) { writeFileSync(FILEPATH, json); console.log(`\nwrote ${FILEPATH}`); }
  else console.log(json);
}

console.log('\nMethodology: the same logical machine (an N-state cycle, one guard per transition) is');
console.log('built with @jarenjs/flow and XState v5 and asserted to agree before timing. Compile pits');
console.log("compileFsm against createMachine+createActor — XState's actor does scheduling and snapshot");
console.log('work the pure compile does not, so the row is each engine\'s description→drivable cost, not');
console.log('a like-for-like. Transition throughput shows BOTH jaren routes (pure step, session.send).');
console.log('The wedge is a conformance fact: the jaren-fsm document round-trips through JSON with its');
console.log('guards intact; the XState machine\'s guards are functions JSON drops, so the restored machine');
console.log('throws at the guarded transition.');
