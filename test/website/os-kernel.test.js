//@ts-check
/**
 * Radiant OS kernel: the program as a jaren-fsm document, the tape unit,
 * the tastes and the council's judgement — pure, deterministic, headless.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYMBOLS, TURNS, DEFAULT_RULES, rulesToFsm, fsmToRules, rulePointer, programStates, isProgram,
} from '../../packages/website/src/os/kernel/program.js';
import {
  compileMachine, createWorld, stepWorld, mirrorWorld, clearWorld, isWorld,
} from '../../packages/website/src/os/kernel/machine.js';
import {
  balance, symmetry, structure, motion, measure, roundMeasure,
} from '../../packages/website/src/os/kernel/metrics.js';
import {
  MEMBERS, DANCERS, LOOKAHEAD, TEMPO_MIN, TEMPO_MAX, applyChange, simulate, voteOf, describeChange,
  candidates, propose, deliberate, hashString, SYMBOL_NAMES, fitsProgram, isTempo,
} from '../../packages/website/src/os/kernel/council.js';
import { START, WORLD_SIZE } from '../../packages/website/src/os/app/state.js';
import { mulberry32 } from '@jarenjs/core/random';

const program = () => ({ machine: rulesToFsm(DEFAULT_RULES), tempo: 12 });
const startWorld = () => createWorld({
  width: WORLD_SIZE, height: WORLD_SIZE,
  heads: DANCERS.map((id) => ({ id, ...START[id] })), initial: 'dance',
});

describe('the program document', () => {
  it('round-trips the rule table through jaren-fsm', () => {
    const doc = rulesToFsm(DEFAULT_RULES);
    assert.equal(doc.$fsm, '0.1');
    assert.equal(doc.initial, 'dance');
    assert.deepEqual(doc.states, ['dance', 'leap']);
    assert.equal(doc.transitions.length, 2 * SYMBOLS);
    assert.deepEqual(fsmToRules(doc), DEFAULT_RULES);
    assert.deepEqual(programStates(doc), ['dance', 'leap']);
    assert.deepEqual(programStates({ states: [{ id: 'a' }, 'b'] }), ['a', 'b']);
  });

  it('addresses one rule member by pointer', () => {
    const states = ['dance', 'leap'];
    assert.equal(rulePointer(states, 'leap', 3, 'turn'), '/transitions/9/effects/1/with');
    assert.equal(rulePointer(states, 'dance', 0, 'write'), '/transitions/0/effects/0/with');
    assert.equal(rulePointer(states, 'dance', 5, 'next'), '/transitions/5/to');
    assert.throws(() => rulePointer(states, 'nope', 0, 'write'), RangeError);
  });

  it('refuses tables and documents it cannot place', () => {
    assert.throws(() => rulesToFsm({}), RangeError);
    assert.throws(() => rulesToFsm({ a: [{ write: 0, turn: 'L', next: 'a' }] }), /must answer each/);
    const doc = rulesToFsm(DEFAULT_RULES);
    const shuffled = { ...doc, transitions: [doc.transitions[1], doc.transitions[0], ...doc.transitions.slice(2)] };
    assert.throws(() => fsmToRules(shuffled), /not the rule for/);
    assert.equal(rulesToFsm(DEFAULT_RULES, { initial: 'leap' }).initial, 'leap');
    assert.deepEqual(TURNS, ['L', 'R', 'U', 'N']);
  });

  it('tells a program it can run from one it cannot', () => {
    const doc = rulesToFsm(DEFAULT_RULES);
    assert.equal(isProgram(doc), true);
    /** @param {(d: any) => void} edit */
    const broken = (edit) => { const d = structuredClone(doc); edit(d); return isProgram(d); };
    assert.equal(broken((d) => { d.$fsm = '0.2'; }), false);
    assert.equal(broken((d) => { d.initial = 'sleep'; }), false);
    assert.equal(broken((d) => { d.transitions.pop(); }), false);
    assert.equal(broken((d) => { d.transitions[3].to = 'sleep'; }), false);
    assert.equal(broken((d) => { d.transitions[3].effects[0].with = 6; }), false);
    assert.equal(broken((d) => { d.transitions[3].effects[0].with = 1.5; }), false);
    assert.equal(broken((d) => { d.transitions[3].effects[1].with = 'X'; }), false);
    assert.equal(broken((d) => { [d.transitions[0], d.transitions[1]] = [d.transitions[1], d.transitions[0]]; }), false);
    assert.equal(broken((d) => { d.states = 'dance'; }), false);
    assert.equal(isProgram(null), false);
  });
});

describe('the tape unit', () => {
  it('steps purely, reporting writes and fired transitions', () => {
    const machine = compileMachine(rulesToFsm(DEFAULT_RULES));
    assert.equal(compileMachine(program().machine) !== machine, true, 'a new document compiles anew');
    const world = startWorld();
    const before = JSON.stringify(world);
    const { world: next, writes, fired, errors } = stepWorld(machine, world, 1);
    assert.equal(JSON.stringify(world), before, 'the input world is untouched');
    assert.equal(next.tick, 1);
    assert.equal(fired.length, DANCERS.length);
    assert.ok(fired.every((i) => i >= 0 && i < 2 * SYMBOLS));
    assert.ok(writes.length <= DANCERS.length);
    assert.deepEqual(errors, []);
    const many = stepWorld(machine, world, 50);
    assert.equal(many.world.tick, 50);
  });

  it('memoizes compiled programs by document identity', () => {
    const doc = rulesToFsm(DEFAULT_RULES);
    assert.equal(compileMachine(doc), compileMachine(doc));
  });

  it('turns every way, wraps the torus, and resets a head in a vanished state', () => {
    const doc = {
      $fsm: '0.1', initial: 'q', states: ['q'],
      transitions: [0, 1, 2, 3, 4, 5].map((s) => ({
        from: 'q', event: 'read', guard: { $eq: ['$.payload.symbol', s] }, to: 'q',
        effects: [{ run: 'write', with: (s + 1) % 6 }, { run: 'turn', with: ['L', 'R', 'U', 'N', 'X', 'L'][s] }],
      })),
    };
    const machine = compileMachine(doc);
    let world = createWorld({ width: 3, height: 3, heads: [{ id: 'h', x: 0, y: 0, dir: 0, state: 'gone' }], initial: 'q' });
    world = stepWorld(machine, world, 12).world;
    assert.equal(world.heads[0].state, 'q');
    assert.ok(world.heads[0].x >= 0 && world.heads[0].x < 3 && world.heads[0].y >= 0 && world.heads[0].y < 3);
  });

  it('records a guard that fails, once', () => {
    const doc = {
      initial: 'q', states: ['q'],
      transitions: [{ from: 'q', event: 'read', guard: { $add: ['$.payload.symbol', 'x'] }, to: 'q' },
        { from: 'q', event: 'read', to: 'q', effects: [{ run: 'write', with: 1 }] }],
    };
    const result = stepWorld(compileMachine(doc), createWorld({ width: 2, height: 2, heads: [{ id: 'h', x: 0, y: 0, dir: 1 }], initial: 'q' }), 3);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'JF2003');
  });

  it('tells a world it can step from one it cannot', () => {
    const world = startWorld();
    assert.equal(isWorld(world), true);
    /** @param {(w: any) => void} edit */
    const broken = (edit) => { const w = structuredClone(world); edit(w); return isWorld(w); };
    assert.equal(broken((w) => { w.tape.pop(); }), false);
    assert.equal(broken((w) => { w.tape[0] = 9; }), false);
    assert.equal(broken((w) => { w.width = 0; }), false);
    assert.equal(broken((w) => { w.tick = -1; }), false);
    assert.equal(broken((w) => { w.heads[0].x = WORLD_SIZE; }), false);
    assert.equal(broken((w) => { w.heads[0].dir = 4; }), false);
    assert.equal(broken((w) => { w.heads[0].state = 7; }), false);
    assert.equal(broken((w) => { w.heads = null; }), false);
    assert.equal(isWorld('floor'), false);
  });

  it('folds and washes the floor', () => {
    const world = { ...createWorld({ width: 4, height: 1, heads: [], initial: 'q' }), tape: [1, 2, 0, 0] };
    assert.deepEqual(mirrorWorld(world).tape, [1, 2, 2, 1]);
    assert.deepEqual(clearWorld(world).tape, [0, 0, 0, 0]);
  });
});

describe('the tastes', () => {
  it('score in [0, 1] and agree with their definitions', () => {
    assert.equal(balance([0, 0, 0, 0]), 0);
    assert.ok(Math.abs(balance([0, 1, 2, 3, 4, 5]) - 1) < 1e-12);
    assert.equal(symmetry([0, 0, 0, 0], 2, 2), 0, 'blank paper is not symmetry');
    assert.equal(symmetry([1, 1, 2, 2], 2, 2), 1, 'top and bottom rows mirror each other... left-right');
    assert.equal(structure([0, 0, 0, 0], 2, 2), Math.max(0, 1 - 0.35 / 0.65));
    assert.ok(structure([1, 2, 2, 1], 2, 2) < 0.1, 'every neighbour differs: noise');
    assert.equal(motion([0, 0, 0, 0]), 0);
    assert.equal(motion([1, 1, 1, 0, 0]), 1, 'sixty percent inked is the target');
    assert.ok(motion([1, 1, 1, 0, 0], [1, 1, 1, 0, 0]) < motion([1, 1, 1, 0, 0], [0, 0, 0, 0, 0]), 'a frozen floor bores the dancer');
    const m = measure({ tape: [0, 1, 2, 3, 4, 5, 0, 0, 1], width: 3, height: 3 });
    for (const v of Object.values(m)) assert.ok(v >= 0 && v <= 1);
    assert.deepEqual(roundMeasure({ a: 0.123456 }), { a: 0.1235 });
  });

  it('the default program keeps dancing, uses every ink, and leaves the council work', () => {
    const machine = compileMachine(rulesToFsm(DEFAULT_RULES));
    let world = startWorld();
    for (const at of [600, 2400]) {
      world = stepWorld(machine, world, at - world.tick).world;
      const past = world.tape;
      world = stepWorld(machine, world, LOOKAHEAD).world;
      const m = measure(world, past);
      assert.ok(m.motion > 0.5, `still rewriting the floor at ${at} (${m.motion})`);
      assert.ok(m.balance > 0.8, `using its inks at ${at} (${m.balance})`);
      assert.ok(m.harmony < 0.7, `room to improve at ${at} (${m.harmony})`);
    }
    const inks = new Set(Object.values(DEFAULT_RULES).flat().map((r) => r.write));
    assert.equal(inks.size, SYMBOLS);
  });
});

describe('the council', () => {
  it('seats five tastes and the human', () => {
    assert.equal(MEMBERS.length, 6);
    assert.equal(MEMBERS.find((m) => m.id === 'human')?.taste, null);
    assert.deepEqual(DANCERS, ['painter', 'dancer', 'critic', 'architect']);
    assert.equal(SYMBOL_NAMES.length, SYMBOLS);
  });

  it('applies rule, tempo and tape changes, with an inverse for rules', () => {
    const p = program();
    const w = startWorld();
    const rule = applyChange(p, w, { kind: 'rule', state: 'leap', symbol: 2, member: 'write', value: 4 });
    assert.equal(fsmToRules(rule.program.machine).leap[2].write, 4);
    assert.deepEqual(rule.inverse, [{ op: 'replace', path: '/transitions/8/effects/0/with', value: DEFAULT_RULES.leap[2].write }]);
    assert.equal(p.machine.transitions[8].effects[0].with, DEFAULT_RULES.leap[2].write, 'the original program is untouched');
    assert.equal(applyChange(p, w, { kind: 'tempo', tempo: 99 }).program.tempo, TEMPO_MAX);
    assert.equal(applyChange(p, w, { kind: 'tempo', tempo: 0 }).program.tempo, TEMPO_MIN);
    const washed = applyChange(p, { ...w, tape: w.tape.map(() => 3) }, { kind: 'tape', op: 'clear' });
    assert.ok(washed.world.tape.every((s) => s === 0));
    const folded = applyChange(p, { ...w, tape: w.tape.map((_, i) => i % 3) }, { kind: 'tape', op: 'mirror' });
    assert.equal(folded.world.tape[0], folded.world.tape[WORLD_SIZE - 1]);
  });

  it('judges changes by simulation and votes by taste', () => {
    const p = program();
    const w = stepWorld(compileMachine(p.machine), startWorld(), 200).world;
    const outcome = simulate(p, w, { kind: 'tape', op: 'mirror' });
    assert.ok(outcome.after.symmetry > outcome.before.symmetry, 'folding the floor makes it more symmetric');
    const architect = /** @type {any} */ (MEMBERS.find((m) => m.id === 'architect'));
    assert.ok(voteOf(architect, outcome) > 0);
    assert.equal(voteOf(/** @type {any} */ (MEMBERS.find((m) => m.id === 'human')), outcome), 0);
    assert.equal(voteOf(architect, { before: { symmetry: 0 }, after: { symmetry: 1 } }), 1);
    assert.equal(voteOf(architect, { before: { symmetry: 1 }, after: { symmetry: 0 } }), -1);
    const faster = simulate(p, w, { kind: 'tempo', tempo: 24 });
    assert.ok(faster.after.harmony >= 0);
  });

  it('admits only changes that name what the program has', () => {
    const machine = program().machine;
    assert.equal(fitsProgram({ kind: 'rule', state: 'dance', symbol: 1, member: 'write', value: 2 }, machine), true);
    assert.equal(fitsProgram({ kind: 'rule', state: 'sleep', symbol: 1, member: 'write', value: 2 }, machine), false);
    assert.equal(fitsProgram({ kind: 'rule', state: 'dance', symbol: 1, member: 'next', value: 'leap' }, machine), true);
    assert.equal(fitsProgram({ kind: 'rule', state: 'dance', symbol: 1, member: 'next', value: 'sleep' }, machine), false);
    assert.equal(fitsProgram({ kind: 'tape', op: 'mirror' }, machine), true);
    assert.equal(isTempo(TEMPO_MIN), true);
    assert.equal(isTempo(TEMPO_MAX + 1), false);
    assert.equal(isTempo(12.5), false);
    assert.equal(isTempo('12'), false);
  });

  it('describes every kind of change in words', () => {
    assert.equal(describeChange({ kind: 'tape', op: 'mirror' }), 'Fold the floor in half');
    assert.equal(describeChange({ kind: 'tape', op: 'clear' }), 'Wash the floor clean');
    assert.equal(describeChange({ kind: 'tempo', tempo: 9 }), 'Dance at 9 steps a second');
    assert.equal(describeChange({ kind: 'rule', state: 'dance', symbol: 2, member: 'write', value: 3 }), 'When dance reads amber, paint red');
    assert.equal(describeChange({ kind: 'rule', state: 'leap', symbol: 0, member: 'turn', value: 'U' }), 'When leap reads paper, turn around');
    assert.equal(describeChange({ kind: 'rule', state: 'leap', symbol: 1, member: 'next', value: 'dance' }), 'When leap reads blue, become dance');
  });

  it('gives each member its own temperament of candidates', () => {
    const p = program();
    const kinds = (/** @type {string} */ id) => candidates(/** @type {any} */ (MEMBERS.find((m) => m.id === id)), p, mulberry32(7), 12);
    assert.ok(kinds('painter').filter((c) => c.kind === 'rule').every((c) => c.kind === 'rule' && c.member === 'write'));
    assert.ok(kinds('dancer').some((c) => c.kind === 'tempo'));
    assert.ok(kinds('architect').some((c) => c.kind === 'tape' && c.op === 'mirror'));
    assert.ok(kinds('critic').some((c) => c.kind === 'tape' && c.op === 'clear'));
    assert.ok(kinds('oracle').some((c) => c.kind === 'rule' && c.member === 'next'));
  });

  it('proposes deterministically and judges every proposal', () => {
    const p = program();
    const w = stepWorld(compileMachine(p.machine), startWorld(), 300).world;
    const proposals = MEMBERS.map((m) => propose(m, p, w, 42)).filter((x) => x !== null);
    assert.ok(proposals.length >= 2);
    assert.deepEqual(MEMBERS.map((m) => propose(m, p, w, 42)).filter((x) => x !== null), proposals, 'same seed, same proposals');
    assert.equal(propose(/** @type {any} */ (MEMBERS.find((m) => m.id === 'human')), p, w, 42), null);
    for (const proposal of proposals) {
      assert.match(proposal.why, /over 240 steps/);
      assert.ok(proposal.title.length > 0);
    }
    const { ballots, outcomes } = deliberate(proposals, p, w);
    assert.equal(ballots.length, proposals.length * MEMBERS.filter((m) => m.taste !== null).length);
    assert.deepEqual(Object.keys(outcomes).sort(), proposals.map((x) => x.id).sort());
    assert.equal(hashString('painter'), hashString('painter'));
    assert.notEqual(hashString('painter'), hashString('dancer'));
  });

  it('proposes nothing when nothing helps', () => {
    const p = program();
    const blank = startWorld();
    const painter = /** @type {any} */ ({ ...MEMBERS[0], taste: 'balance' });
    // a floor already at perfect balance cannot be improved by any one edit
    const full = { ...blank, tape: blank.tape.map((_, i) => i % SYMBOLS) };
    const result = propose(painter, { ...p, machine: rulesToFsm(Object.fromEntries(Object.keys(DEFAULT_RULES).map((q) => [q, DEFAULT_RULES[q].map(() => ({ write: 0, turn: 'N', next: q }))]))) }, full, 1);
    assert.equal(result, null);
  });
});
