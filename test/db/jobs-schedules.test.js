//@ts-check
/** Recurring job schedules on SQLite (JOBS-FORMAT §11): the shared scenario's values, and each refusal and rule. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStore, JOB_SCHEDULES_TABLE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { jobSchedules } from '@jarenjs/db/schedules';
import { createRuntime } from '@jarenjs/core/runtime';
import { compileRecurrence, floatingValue } from '@jarenjs/core/calendar';
import { model, scenarioClock, runScenario, assertScenario, ZONE, HOUR } from './schedules-scenario.js';
import { tempDbPath } from './helpers.js';

const daily = compileRecurrence({ dtstart: floatingValue('2026-03-01', '09:00'), rrule: 'FREQ=DAILY' });
const spec = (extra = {}) => ({ id: 'd', kind: 'digest', series: daily, zone: ZONE, missed: 'skip', ...extra });
const tablesOf = (file) => {
  const raw = new DatabaseSync(file, { readOnly: true });
  try { return raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '_jaren_job%' ORDER BY name").all().map((row) => row.name); }
  finally { raw.close(); }
};

describe('recurring job schedules', () => {
  it('fires the scenario: 09:00 local across both transitions, missed policies, gap, a small budget, unresolved', async () => {
    const { clock, provider, options } = scenarioClock();
    const store = await openStore(model, { driver: nodeDriver(), ...options() });
    try {
      const [transcript] = await runScenario([store], clock);
      assertScenario(transcript, provider, assert);
    }
    finally { await store.close(); }
  });

  it('refuses every schedule call without jobs.schedules, and creates no table', async (t) => {
    const { dbPath: file, cleanup } = tempDbPath();
    t.after(cleanup);
    const store = await openStore(model, { driver: nodeDriver(), path: file, jobs: true });
    try {
      for (const call of [() => store.jobs.schedule(spec()), () => store.jobs.tick(), () => store.jobs.schedules(),
        () => store.jobs.unschedule('d')])
        await assert.rejects(async () => call(), { code: 'JD0016' });
      assert.equal(typeof (await store.jobs.enqueue('k', null)), 'string');
    }
    finally { await store.close(); }
    assert.deepEqual(tablesOf(file), ['_jaren_job_checkpoints', '_jaren_jobs']);
    await assert.rejects(openStore(model, { driver: nodeDriver(), jobs: { schedules: { attach: () => ({}) } } }), { code: 'JD0009' });
  });

  it('reads and writes nothing until the first schedule, which creates the table', async (t) => {
    const { dbPath: file, cleanup } = tempDbPath();
    t.after(cleanup);
    const { options } = scenarioClock();
    const store = await openStore(model, { driver: nodeDriver(), path: file, ...options() });
    try {
      assert.deepEqual(await store.jobs.schedules(), []);
      assert.equal(await store.jobs.unschedule('d'), false);
      assert.deepEqual(await store.jobs.tick(), { fired: [], skipped: 0, advanced: 0, more: false });
      assert.deepEqual(tablesOf(file), ['_jaren_job_checkpoints', '_jaren_jobs']);
      await store.jobs.schedule(spec());
      assert.deepEqual(tablesOf(file), ['_jaren_job_checkpoints', '_jaren_job_schedules', '_jaren_jobs']);
      // the engine's own table: introspect() derives nothing from it
      const { model: derived } = await store.introspect();
      assert.deepEqual(Object.keys(derived.entities ?? {}), []);
      assert.equal(JOB_SCHEDULES_TABLE, '_jaren_job_schedules');
    }
    finally { await store.close(); }
  });

  it('refuses an adopted store without the table, and adopts one that has it', async (t) => {
    const { dbPath: file, cleanup } = tempDbPath();
    t.after(cleanup);
    const { options } = scenarioClock();
    await (await openStore(model, { driver: nodeDriver(), path: file, ...options() })).close();
    let adopted = await openStore(model, { driver: nodeDriver(), path: file, adopt: true, ...options() });
    try {
      await assert.rejects(async () => adopted.jobs.schedule(spec()), { code: 'JD0002' });
      assert.deepEqual(await adopted.jobs.schedules(), []);
    }
    finally { await adopted.close(); }
    const writer = await openStore(model, { driver: nodeDriver(), path: file, ...options() });
    await writer.jobs.schedule(spec());
    await writer.close();
    adopted = await openStore(model, { driver: nodeDriver(), path: file, adopt: true, ...options() });
    try {
      assert.equal((await adopted.jobs.schedule(spec({ id: 'e' }))).state, 'active');
      assert.deepEqual((await adopted.jobs.schedules()).map((record) => record.id), ['d', 'e']);
    }
    finally { await adopted.close(); }
  });

  it('refuses a model naming the engine\'s schedule table', async () => {
    const named = { $model: '0.1', collections: { [JOB_SCHEDULES_TABLE]: { key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' } } } } } };
    await assert.rejects(openStore(named, { driver: nodeDriver() }), { code: 'JD0004' });
  });

  it('refuses a tick in a process without a zone provider and leaves every schedule as it was', async (t) => {
    const { dbPath: file, cleanup } = tempDbPath();
    t.after(cleanup);
    const { clock, options } = scenarioClock();
    const store = await openStore(model, { driver: nodeDriver(), path: file, ...options() });
    const bare = await openStore(model, { driver: nodeDriver(), path: file,
      runtime: createRuntime({ now: () => clock.at }), jobs: { now: () => clock.at, schedules: jobSchedules() } });
    try {
      const before = await store.jobs.schedule(spec());
      clock.at += 2 * 24 * HOUR;
      await assert.rejects(async () => bare.jobs.tick(), { code: 'JD0016' });
      assert.deepEqual(await bare.jobs.schedules(), [before]);
      // a zone with no provider to read it refuses at schedule time
      await assert.rejects(async () => bare.jobs.schedule(spec({ id: 'x' })), { code: 'JY0004' });
      // two days late under 'skip': the latest one fires, the one before it is skipped
      assert.deepEqual(await store.jobs.tick(), { fired: ['d@2026-03-22T09:00:00'], skipped: 1, advanced: 1, more: false });
    }
    finally { await bare.close(); await store.close(); }
  });

  it('replaces a definition and keeps its history; a repeated tick or schedule fires nothing again', async () => {
    const { clock, options } = scenarioClock();
    const store = await openStore(model, { driver: nodeDriver(), ...options() });
    try {
      await store.jobs.schedule(spec({ payload: { v: 1 } }));
      clock.at = Date.UTC(2026, 2, 21, 8);
      assert.deepEqual((await store.jobs.tick()).fired, ['d@2026-03-21T09:00:00']);
      assert.deepEqual((await store.jobs.tick()).fired, []);
      const replaced = await store.jobs.schedule(spec({ payload: { v: 2 } }));
      assert.deepEqual([replaced.nextRecurrenceId, replaced.lastRecurrenceId, replaced.counts, replaced.createdAt],
        ['2026-03-22T09:00:00', '2026-03-21T09:00:00', { fired: 1, skipped: 0 }, Date.UTC(2026, 2, 20, 12)]);
      assert.deepEqual((await store.jobs.tick()).fired, []);
      clock.at = Date.UTC(2026, 2, 22, 8);
      assert.deepEqual((await store.jobs.tick()).fired, ['d@2026-03-22T09:00:00']);
      assert.deepEqual((await store.jobs.get('d@2026-03-22T09:00:00')).payload, { v: 2 });
      assert.deepEqual((await store.jobs.get('d@2026-03-21T09:00:00')).payload, { v: 1 });
      // a schedule written in a zone later is no longer unresolved
      const unresolved = await store.jobs.schedule(spec({ id: 'late', zone: undefined }));
      assert.equal(unresolved.state, 'unresolved');
      assert.equal((await store.jobs.schedule(spec({ id: 'late' }))).nextRecurrenceId, '2026-03-22T09:00:00');
      assert.equal(await store.jobs.unschedule('d'), true);
      assert.equal(await store.jobs.unschedule('d'), false);
      assert.equal((await store.jobs.get('d@2026-03-22T09:00:00')).state, 'pending');
      assert.deepEqual((await store.jobs.schedules()).map((record) => record.id), ['late']);
    }
    finally { await store.close(); }
  });

  it('fires at most limit schedules per tick and says more are due', async () => {
    const { clock, options } = scenarioClock();
    const store = await openStore(model, { driver: nodeDriver(), ...options() });
    try {
      for (const id of ['a', 'b', 'c']) await store.jobs.schedule(spec({ id }));
      clock.at = Date.UTC(2026, 2, 21, 8);
      assert.deepEqual(await store.jobs.tick({ limit: 2 }),
        { fired: ['a@2026-03-21T09:00:00', 'b@2026-03-21T09:00:00'], skipped: 0, advanced: 2, more: true });
      assert.deepEqual(await store.jobs.tick({ limit: 2 }), { fired: ['c@2026-03-21T09:00:00'], skipped: 0, advanced: 1, more: false });
      await assert.rejects(async () => store.jobs.tick({ limit: 0 }), TypeError);
      await assert.rejects(async () => store.jobs.tick({ lmit: 2 }), { code: 'JD0013' });
    }
    finally { await store.close(); }
  });

  it('refuses a malformed definition JD0013 and stores nothing', async () => {
    const { options } = scenarioClock();
    const store = await openStore(model, { driver: nodeDriver(), ...options() });
    try {
      const zoned = compileRecurrence({ dtstart: { kind: 'zoned', date: '2026-03-01', time: '07:15', zone: ZONE }, rrule: 'FREQ=DAILY' });
      for (const bad of [null, spec({ id: '' }), spec({ kind: 7 }), spec({ series: { kind: 'event' } }), spec({ missed: 'twice' }),
        spec({ missed: { catchUp: 0 } }), spec({ limits: { maxSteps: 3 } }), spec({ limits: { maxWork: -1 } }),
        spec({ zone: undefined, zoneSource: 'explicit' }), spec({ zone: '' }), spec({ policy: 'earlier' }),
        { id: 'z', kind: 'k', series: zoned, policy: 'later', missed: 'skip' }])
        await assert.rejects(async () => store.jobs.schedule(bad), { code: 'JD0013' }, JSON.stringify(bad));
      assert.deepEqual(await store.jobs.schedules(), []);
    }
    finally { await store.close(); }
  });

  it('stalls at an occurrence its policy refuses to bind, after firing the ones before it', async () => {
    const { clock, options } = scenarioClock(Date.UTC(2026, 2, 27, 12));
    const store = await openStore(model, { driver: nodeDriver(), ...options() });
    try {
      const night = compileRecurrence({ dtstart: floatingValue('2026-03-01', '02:30'), rrule: 'FREQ=DAILY' });
      await store.jobs.schedule({ id: 'n', kind: 'k', series: night, zone: ZONE, policy: 'reject', missed: 'skip' });
      clock.at = Date.UTC(2026, 2, 28, 2);
      assert.deepEqual((await store.jobs.tick()).fired, ['n@2026-03-28T02:30:00']);
      const [record] = await store.jobs.schedules();
      assert.equal(record.state, 'stalled');
      assert.equal(record.stall.code, 'JY0002');
      assert.equal(record.stall.recurrenceId, '2026-03-29T02:30:00');
      assert.equal(record.lastRecurrenceId, '2026-03-28T02:30:00');
    }
    finally { await store.close(); }
  });

  it('stores a schedule whose first search a limit stops as stalled, never as a refusal', async () => {
    const { options } = scenarioClock();
    const store = await openStore(model, { driver: nodeDriver(), ...options() });
    try {
      const record = await store.jobs.schedule(spec({ limits: { maxWork: 1 } }));
      // the Intl provider lists its offset changes: the floating series' binding asks for them (two calls) before the
      // search's first step meets the limit
      assert.deepEqual([record.state, record.nextRunAt, record.stall],
        ['stalled', null, { limit: 'maxWork', counts: { emitted: 0, work: 1, providerCalls: 2 } }]);
      // written again with room to search, it resumes
      assert.equal((await store.jobs.schedule(spec())).state, 'active');
    }
    finally { await store.close(); }
  });

  it('keeps the schedule calls off a transaction view', async () => {
    const { options } = scenarioClock();
    const store = await openStore(model, { driver: nodeDriver(), ...options() });
    try {
      await store.transaction((tx) => {
        assert.equal(tx.jobs.schedule, undefined);
        assert.equal(tx.jobs.tick, undefined);
      });
    }
    finally { await store.close(); }
  });
});
