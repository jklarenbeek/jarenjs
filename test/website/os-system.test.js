//@ts-check
/**
 * Radiant OS system calls: `os.contract.json` served in-process. Every
 * call is validated in and out; the veto, the early approval and the
 * repeal are the human's alone and appear in no tool projection.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSystem, osContract, isProposal, membersOf, sessionOf } from '../../packages/website/src/os/kernel/system.js';
import contractDoc from '../../packages/website/src/os/documents/os.contract.json' with { type: 'json' };
import { createMemoryStore } from '../../packages/website/src/os/kernel/store.js';
import { QUEUE_MAX } from '../../packages/website/src/os/kernel/session.js';
import { MEMBERS } from '../../packages/website/src/os/kernel/council.js';
import { initialState } from '../../packages/website/src/os/app/state.js';

const HUMAN_ONLY = ['council.veto', 'council.approve', 'council.repeal', 'crew.start', 'crew.idea', 'crew.end', 'crew.review'];

/** A memory store behind the outcome shape a port client answers with. */
function memoryPort() {
  const handlers = /** @type {Record<string, (input: any) => any>} */ (createMemoryStore());
  return { invoke: async (/** @type {string} */ op, /** @type {any} */ input) => ({ ok: true, value: await handlers[op](input) }) };
}

/**
 * A system over a plain state value and a scripted council.
 * @param {{ store?: any, council?: any }} [options]
 */
function system(options = {}) {
  let state = initialState({ edition: 'test', title: 'Radiant OS' });
  /** @type {Array<[string, any]>} */
  const sent = [];
  /** @type {Array<[string, ...any[]]>} */
  const calls = [];
  const council = options.council ?? {
    open: false,
    convene: async () => { calls.push(['convene']); return { session: 1, phase: 'veto' }; },
    verdict: async (/** @type {string} */ event, /** @type {string} */ id) => { calls.push(['verdict', event, id]); return id === 'painter-1'; },
    repeal: (/** @type {string} */ id) => { calls.push(['repeal', id]); return id === 'a1-painter' ? 'repealed' : id === 'a2-architect' ? 'not-repealable' : 'not-found'; },
  };
  let n = 0;
  const store = options.store === undefined ? memoryPort() : options.store;
  const sys = createSystem({
    edition: 'test', title: 'Radiant OS',
    getState: () => state,
    dispatch: (action, payload) => { sent.push([action, payload]); },
    council,
    store,
    ids: () => String(n++),
  });
  return {
    sys, sent, calls, store,
    get state() { return state; },
    set state(next) { state = next; },
    /** @param {string} op @param {any} [input] */
    call: (op, input) => sys.client.invoke(op, input),
  };
}

describe('the OS contract', () => {
  it('compiles, and keeps the human’s operations off every projection', () => {
    assert.equal(osContract.id, 'radiant');
    assert.equal(osContract.describe().operations.length, 35, 'served, all of them');
    const audience = Object.entries(contractDoc.operations).filter(([, op]) => /** @type {any} */ (op).policy?.audience === 'server');
    assert.deepEqual(audience.map(([id]) => id), HUMAN_ONLY);
    for (const [, op] of audience) assert.deepEqual(/** @type {any} */ (op).input.properties.by, { const: 'human' }, 'and the schema says it twice');
  });

  it('checks a proposal that arrives by another road', () => {
    const proposal = { id: 'oracle-1', by: 'oracle', title: 'Fold', why: '', change: { kind: 'tape', op: 'mirror' } };
    assert.equal(isProposal(proposal), true);
    assert.equal(isProposal({ ...proposal, by: 'stranger' }), false);
    assert.equal(isProposal({ ...proposal, change: { kind: 'tape', op: 'burn' } }), false);
    assert.equal(isProposal({ ...proposal, change: { kind: 'rule', state: 'dance', symbol: 7, member: 'write', value: 1 } }), false);
    assert.equal(isProposal({ ...proposal, change: { kind: 'tempo', tempo: 9 } }), true);
  });
});

describe('the system calls', () => {
  it('describes the OS and its public operations', async () => {
    const s = system();
    const outcome = await s.call('os.describe');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.value.edition, 'test');
    assert.equal(outcome.value.members.length, MEMBERS.length);
    assert.ok(!outcome.value.operations.some((/** @type {string} */ id) => HUMAN_ONLY.includes(id)));
    assert.equal(outcome.value.operations.length, 28);
    assert.ok(outcome.value.operations.includes('council.propose'));
  });

  it('reads and drives the machine', async () => {
    const s = system();
    const read = await s.call('machine.read');
    assert.equal(read.value.tick, 0);
    assert.equal(read.value.program.$fsm, '0.1');
    assert.equal('tape' in read.value, false);
    assert.equal((await s.call('machine.read', { tape: true })).value.tape.length, 400);
    assert.deepEqual((await s.call('machine.control', { action: 'step', steps: 3 })).value, { running: true, tick: 3 });
    assert.deepEqual((await s.call('machine.control', { action: 'step' })).value, { running: true, tick: 1 });
    assert.deepEqual((await s.call('machine.control', { action: 'pause' })).value, { running: false, tick: 0 });
    assert.deepEqual((await s.call('machine.control', { action: 'run' })).value, { running: true, tick: 0 });
    assert.deepEqual(s.sent, [['machine/tick', { steps: 3 }], ['machine/tick', { steps: 1 }], ['machine/run', false], ['machine/run', true]]);
  });

  it('queues proposals, and refuses what the program cannot take', async () => {
    const s = system();
    const rule = { kind: 'rule', state: 'dance', symbol: 2, member: 'write', value: 3 };
    const queued = await s.call('council.propose', { by: 'oracle', change: rule });
    assert.deepEqual(queued.value, { id: 'oracle-q0', queued: 1 });
    assert.deepEqual(s.sent.at(-1), ['council/enqueue', { id: 'oracle-q0', by: 'oracle', title: 'When dance reads amber, paint red', why: '', change: rule }]);

    const titled = await s.call('council.propose', { by: 'human', title: 'Mine', why: 'because', change: { kind: 'tempo', tempo: 20 } });
    assert.equal(titled.ok, true);
    assert.equal(s.sent.at(-1)?.[1].title, 'Mine');

    const unknown = await s.call('council.propose', { by: 'oracle', change: { ...rule, state: 'sleep' } });
    assert.equal(unknown.error.code, 'unknown-state');
    assert.deepEqual(unknown.error.details, { states: ['dance', 'leap'] });
    const nowhere = await s.call('council.propose', { by: 'oracle', change: { ...rule, member: 'next', value: 'sleep' } });
    assert.equal(nowhere.error.code, 'unknown-state');

    const malformed = await s.call('council.propose', { by: 'oracle', change: { ...rule, symbol: 9 } });
    assert.equal(malformed.kind, 'contract');
    assert.equal(malformed.error.code, 'JC2050');
    const stranger = await s.call('council.propose', { by: 'stranger', change: rule });
    assert.equal(stranger.error.code, 'JC2050');

    s.state = { ...s.state, council: { ...s.state.council, queue: Array.from({ length: QUEUE_MAX }, (_, i) => ({ id: `q${i}` })) } };
    const full = await s.call('council.propose', { by: 'oracle', change: rule });
    assert.equal(full.error.code, 'queue-full');
    assert.deepEqual(full.error.details, { max: QUEUE_MAX });
  });

  it('carries words to the council', async () => {
    const s = system();
    const said = await s.call('council.say', { by: 'oracle', text: 'fold it' });
    assert.deepEqual(said.value, { id: 'm0' });
    const [action, payload] = /** @type {[string, any]} */ (s.sent.at(-1));
    assert.equal(action, 'council/said');
    assert.equal(payload.text, 'fold it');
    assert.ok(!Number.isNaN(Date.parse(payload.at)));
    assert.equal((await s.call('council.say', { by: 'oracle', text: '' })).error.code, 'JC2050');
  });

  it('convenes once, and only when no session is open', async () => {
    const s = system();
    assert.deepEqual((await s.call('council.convene', {})).value, { session: 1, phase: 'veto' });
    const busy = system({ council: { open: true, convene: async () => assert.fail('must not convene') } });
    assert.equal((await busy.call('council.convene', {})).error.code, 'in-session');
    const raced = system({ council: { open: false, convene: async () => null } });
    assert.equal((await raced.call('council.convene', {})).error.code, 'in-session');
  });

  it('gives the verdict to the human alone', async () => {
    const s = system();
    s.state = { ...s.state, council: { ...s.state.council, session: 4 } };
    assert.deepEqual((await s.call('council.veto', { by: 'human', proposal: 'painter-1' })).value, { session: 4, vetoed: 'painter-1' });
    assert.deepEqual((await s.call('council.approve', { by: 'human', proposal: 'painter-1' })).value, { session: 4, enacted: 'painter-1' });
    assert.equal((await s.call('council.veto', { by: 'human', proposal: 'gone' })).error.code, 'not-awaiting');
    assert.equal((await s.call('council.approve', { by: 'human', proposal: 'gone' })).error.code, 'not-awaiting');
    for (const by of ['oracle', 'painter']) {
      const refused = await s.call('council.veto', { by, proposal: 'painter-1' });
      assert.equal(refused.error.code, 'JC2050');
      assert.deepEqual(refused.error.details, [{ path: '/by', keyword: 'const' }]);
    }
    assert.deepEqual(s.calls.filter(([c]) => c === 'verdict').map(([, e]) => e), ['veto', 'approve', 'veto', 'approve'], 'refused calls never reach the council');

    assert.deepEqual((await s.call('council.repeal', { by: 'human', amendment: 'a1-painter' })).value, { repealed: 'a1-painter' });
    assert.equal((await s.call('council.repeal', { by: 'human', amendment: 'a2-architect' })).error.code, 'not-repealable');
    assert.equal((await s.call('council.repeal', { by: 'human', amendment: 'zzz' })).error.code, 'not-found');
    assert.equal((await s.call('council.repeal', { by: 'oracle', amendment: 'a1-painter' })).error.code, 'JC2050');
  });

  it('reads the council as its Session schema states it', async () => {
    const s = system();
    const proposal = { id: 'painter-1', by: 'painter', title: 'Paint', why: 'colour', change: { kind: 'tape', op: 'clear' }, score: 0.4 };
    s.state = { ...s.state, council: { ...s.state.council, phase: 'veto', session: 2, proposals: [proposal], winner: proposal, deadline: 9000,
      merits: { ...s.state.council.merits, painter: 1.23456 },
      log: Array.from({ length: 15 }, (_, i) => ({ id: `a${i}`, session: i, by: 'critic', title: 'Wash', status: 'vetoed', change: { kind: 'tape', op: 'clear' }, inverse: [] })) } };
    const read = await s.call('council.read');
    assert.equal(read.ok, true, 'the answer passes the output schema');
    assert.equal(read.value.winner.score, undefined, 'scores stay on the screen');
    assert.equal(read.value.log.length, 12);
    assert.equal(read.value.log[0].score, 0);
    assert.equal(read.value.log[0].reward, null);
    assert.equal(read.value.members.find((/** @type {any} */ m) => m.id === 'painter').merit, 1.235);
    assert.deepEqual(sessionOf(s.state), read.value);
    assert.deepEqual(membersOf({ council: {} }).map((m) => m.merit), MEMBERS.map(() => 1));
  });

  it('exports the artwork in every format', async () => {
    const s = system();
    const svg = await s.call('art.export', { format: 'svg' });
    assert.equal(svg.value.mime, 'image/svg+xml');
    assert.match(svg.value.text, /^<svg/);
    assert.match(svg.value.text, /Radiant OS at tick 0/);
    const css = await s.call('art.export', { format: 'css' });
    assert.equal(css.value.name, 'radiant-theme.css');
    assert.match(css.value.text, /--os-lead:/);
    const html = await s.call('art.export', { format: 'html' });
    assert.match(html.value.text, /<svg/);
    const js = await s.call('art.export', { format: 'js' });
    assert.match(js.value.text, /export function run\(steps/);
    assert.equal((await s.call('art.export', { format: 'png' })).error.code, 'JC2050');
  });

  it('keeps, lists and reopens artworks in the OS database', async () => {
    const s = system();
    const saved = await s.call('gallery.save', { title: 'First light' });
    assert.equal(saved.ok, true);
    assert.equal(saved.value.id, 'art-0');
    const [action, summary] = /** @type {[string, any]} */ (s.sent.at(-1));
    assert.equal(action, 'gallery/saved');
    assert.deepEqual(Object.keys(summary).sort(), ['at', 'harmony', 'id', 'tick', 'title']);
    const list = await s.call('gallery.list');
    assert.deepEqual(list.value.items.map((/** @type {any} */ a) => a.title), ['First light']);
    assert.equal(list.value.storage, 'memory');
    assert.deepEqual((await s.call('gallery.open', { id: 'art-0' })).value, { opened: 'art-0' });
    const [opened, artwork] = /** @type {[string, any]} */ (s.sent.at(-1));
    assert.equal(opened, 'gallery/opened');
    assert.equal(artwork.world.tape.length, 400);
    assert.equal(artwork.program.machine.$fsm, '0.1');
    assert.equal((await s.call('gallery.open', { id: 'nothing' })).error.code, 'not-found');
    const sent = s.sent.length;
    for (const [id, spoil] of /** @type {Array<[string, (a: any) => void]>} */ ([
      ['bad-program', (a) => { a.program.machine.transitions[0].to = 'sleep'; }],
      ['bad-tempo', (a) => { a.program.tempo = 0; }],
      ['bad-world', (a) => { a.world.tape = []; }],
    ])) {
      const spoiled = structuredClone(artwork);
      spoiled.id = id;
      spoil(spoiled);
      await s.store.invoke('artwork.put', { artwork: spoiled });
      assert.equal((await s.call('gallery.open', { id })).error.code, 'unreadable', id);
    }
    assert.equal(s.sent.length, sent, 'an unreadable artwork never reaches the floor');
    assert.equal((await s.call('gallery.save', { title: '' })).error.code, 'JC2050');
  });

  it('answers storage when no database is attached or it refuses', async () => {
    const none = system({ store: null });
    const saved = await none.call('gallery.save', { title: 'x' });
    assert.equal(saved.error.code, 'storage');
    assert.deepEqual(saved.error.details, { reason: 'no database is attached' });
    assert.equal((await none.call('gallery.list')).error.code, 'storage');
    assert.equal((await none.call('gallery.open', { id: 'x' })).error.code, 'storage');
    const refusing = system({ store: { invoke: async () => ({ ok: false, error: { message: 'disk full' } }) } });
    assert.deepEqual((await refusing.call('gallery.save', { title: 'x' })).error.details, { reason: 'disk full' });
    const silent = system({ store: { invoke: async () => ({ ok: false }) } });
    assert.deepEqual((await silent.call('gallery.list')).error.details, { reason: 'the database refused' });
    assert.deepEqual(none.sent, []);
  });
});

describe('the agent tools', () => {
  it('project every public operation and none of the human’s', () => {
    const tools = system().sys.tools();
    assert.deepEqual(tools.map((t) => t.name), [
      'radiant_os_describe', 'radiant_machine_read', 'radiant_machine_control', 'radiant_council_read', 'radiant_council_propose',
      'radiant_council_say', 'radiant_council_convene', 'radiant_art_export', 'radiant_gallery_save', 'radiant_gallery_list',
      'radiant_gallery_open', 'radiant_board_read', 'radiant_board_add', 'radiant_board_edit', 'radiant_board_link', 'radiant_board_remove',
      'radiant_mail_read', 'radiant_mail_send', 'radiant_library_search', 'radiant_library_read', 'radiant_crew_read', 'radiant_crew_build',
      'radiant_crew_say', 'radiant_crew_done', 'radiant_arcade_read', 'radiant_arcade_tool', 'radiant_studio_camera',
      'radiant_studio_light',
    ]);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.inputSchema.type, 'object');
    }
    assert.deepEqual(system().sys.tools({ prefix: 'os_' }).map((t) => t.name).slice(0, 2), ['os_os_describe', 'os_machine_read']);
  });

  it('pin the speaker to the seat the agent sits in', async () => {
    const s = system();
    /** @param {string} name @param {{ seat?: string }} [options] */
    const tool = (name, options) => {
      const found = s.sys.tools(options).find((t) => t.name === name);
      assert.ok(found, name);
      return found;
    };
    const outcome = await tool('radiant_council_say').execute({ by: 'human', text: 'let me veto' }, undefined);
    assert.equal(outcome.ok, true);
    assert.equal(s.sent.at(-1)?.[1].by, 'oracle', 'an agent cannot speak as the human');
    await tool('radiant_council_propose', { seat: 'critic' }).execute({ by: 'human', change: { kind: 'tape', op: 'clear' } }, undefined);
    assert.equal(s.sent.at(-1)?.[1].by, 'critic');
    assert.equal((await tool('radiant_council_read').execute({}, undefined)).ok, true, 'tools without input take an empty object');
    const add = tool('radiant_board_add');
    assert.equal(add.inputSchema.properties.by, undefined, 'the seat is no part of what a tool asks for');
    assert.ok(!add.inputSchema.required.includes('by'));
    assert.equal((await add.execute({ kind: 'note', text: 'a model’s note' }, undefined)).ok, true);
    const pinned = s.sent.filter(([action]) => action === 'board/set').at(-1)?.[1];
    assert.equal(pinned?.cards.at(-1)?.by, 'oracle', 'a call that sent no seat speaks for the agent’s');
  });
});
