//@ts-check
/**
 * @file A worker that ticks recurring schedules before it claims
 * (`createWorker({ tick })`, JOBS-FORMAT §6 and §11), and a schedule's
 * lateness bound (`latenessMs`): one simulated clock steps over the
 * occurrences, and each test body runs on SQLite and, where JAREN_PG_URL
 * names a server, on PostgreSQL, answering the same occurrence ids. The
 * statement trace proves an idle worker over a store with no schedule
 * table issues what a worker without the option does, but for one
 * presence probe every 16 loop passes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStore, sqliteDialect } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { compileRecurrence, floatingValue } from '@jarenjs/core/calendar';
import { model, scenarioClock, ZONE, HOUR } from './schedules-scenario.js';
import { tempDbPath } from './helpers.js';

const url = process.env.JAREN_PG_URL;
const daily = compileRecurrence({ dtstart: floatingValue('2026-03-01', '09:00'), rrule: 'FREQ=DAILY' });
/** 09:00 in Amsterdam on a March day before the 29th: 08:00Z. @param {number} day */
const nineOn = (day) => Date.UTC(2026, 2, day, 8);

/** Record a statement's text each time it runs. @param {any} statement @param {string} sql @param {string[]} ran */
const watch = (statement, sql, ran) => new Proxy(statement, { get(target, member) {
  const value = Reflect.get(target, member);
  if (typeof value !== 'function') return value;
  return ['run', 'get', 'all', 'iterate'].includes(String(member))
    ? (/** @type {any[]} */ ...args) => { ran.push(sql); return value.apply(target, args); } : value.bind(target);
} });

/**
 * A SQLite driver that records every statement the database runs, at the
 * binding: below the store, so nothing it prepares or caches is missed.
 * @param {string[]} ran
 */
const recordingSqlite = (ran) => ({
  name: 'node-sqlite', dialect: sqliteDialect,
  open: (/** @type {string} */ dbPath, /** @type {any} */ options) => {
    const db = new DatabaseSync(dbPath, options?.timeout === undefined ? {} : { timeout: options.timeout });
    return adaptNodeDatabase({
      exec: (/** @type {string} */ sql) => { ran.push(sql); return db.exec(sql); },
      prepare: (/** @type {string} */ sql) => watch(db.prepare(sql), sql, ran),
      function: (/** @type {string} */ name, /** @type {any} */ o, /** @type {any} */ fn) => db.function(name, o, fn),
      aggregate: (/** @type {string} */ name, /** @type {any} */ spec) => db.aggregate(name, spec),
      createSession: (/** @type {any} */ o) => (o === undefined ? db.createSession() : db.createSession(o)),
      close: () => db.close(),
    });
  },
});

/**
 * A PostgreSQL pool that records every statement its clients send.
 * @param {any} target @param {string[]} ran
 */
const recordingPool = (target, ran) => {
  /** @param {any} query */
  const record = (query) => { ran.push(typeof query === 'string' ? query : query?.text); };
  /** @param {any} client */
  const wrapClient = (client) => new Proxy(client, { get(object, member) {
    const value = Reflect.get(object, member);
    if (member === 'query') return (/** @type {any[]} */ ...args) => { record(args[0]); return value.apply(object, args); };
    return typeof value === 'function' ? value.bind(object) : value;
  } });
  return new Proxy(target, { get(object, member) {
    const value = Reflect.get(object, member);
    if (member === 'connect') return async () => wrapClient(await value.call(object));
    if (member === 'query') return (/** @type {any[]} */ ...args) => { record(args[0]); return value.apply(object, args); };
    return typeof value === 'function' ? value.bind(object) : value;
  } });
};

/** Wait, bounded, until a condition holds. @param {() => any} done @param {string} what */
async function until(done, what) {
  const deadline = Date.now() + 20_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** @type {any} */
let pg = null;
/** @type {any} */
let pool = null;
let serial = 0;
before(async () => {
  if (!url) return;
  pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: url, max: 3 });
});
after(async () => { await pool?.end(); });

/**
 * One database per call, and a way to open stores over it — each store
 * its own connection on SQLite (a file), one pool on PostgreSQL (a schema).
 * @param {'sqlite' | 'postgres'} engine
 * @param {(open: (options: any, ran?: string[]) => Promise<any>) => Promise<void>} fn
 */
async function withDatabase(engine, fn) {
  /** @type {any[]} */
  const stores = [];
  const schema = `jaren_scheduleworker_${process.pid}_${serial++}`;
  const file = engine === 'sqlite' ? tempDbPath() : null;
  if (engine === 'postgres') await pool.query(`CREATE SCHEMA "${schema}"`);
  const open = async (/** @type {any} */ options, /** @type {string[] | undefined} */ ran = undefined) => {
    const driver = engine === 'sqlite' ? (ran === undefined ? nodeDriver() : recordingSqlite(ran))
      : postgresDriver(ran === undefined ? pool : recordingPool(pool, ran), { schema });
    const store = await openStore(model, { driver, ...(file === null ? {} : { path: file.dbPath }), ...options });
    stores.push(store);
    return store;
  };
  try { await fn(open); }
  finally {
    try { for (const store of stores) await store.close(); }
    finally {
      if (engine === 'postgres') await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      file?.cleanup();
    }
  }
}

/** The ids each handler run saw, in order. */
function recorder() {
  /** @type {string[]} */
  const ran = [];
  const handler = (/** @type {unknown} */ _payload, /** @type {any} */ context) => { ran.push(context.job.id); };
  return { ran, handlers: { digest: handler, report: handler } };
}

/** What every engine answers; the PostgreSQL run is compared against it. */
const answers = new Map();

for (const engine of /** @type {const} */ (['sqlite', 'postgres'])) {
  describe(`createWorker({ tick }) and latenessMs on ${engine}`, { skip: engine === 'postgres' && !url && 'JAREN_PG_URL is not set' }, () => {
    /** @param {string} name @param {any} value */
    const same = (name, value) => {
      if (engine === 'sqlite') answers.set(name, value);
      else if (answers.has(name)) assert.deepEqual(value, answers.get(name), `${name}: the same answer as SQLite`);
    };

    it('refuses the option without jobs.schedules (JD0016), and a malformed one', async () => {
      await withDatabase(engine, async (open) => {
        const bare = await open({ jobs: true });
        const { handlers } = recorder();
        assert.throws(() => bare.jobs.createWorker({ handlers, tick: true }),
          (error) => /** @type {any} */ (error).code === 'JD0016' && /jobs\.createWorker\b.*jobSchedules\(\)/.test(String(error)));
        // false, null and absent are the worker it always was, as a null reads for every worker option
        bare.jobs.createWorker({ handlers, tick: false });
        bare.jobs.createWorker({ handlers, tick: null });
        bare.jobs.createWorker({ handlers });
        const { options } = scenarioClock();
        const store = await open(options());
        for (const tick of ['yes', 1, [], 0]) assert.throws(() => store.jobs.createWorker({ handlers, tick }), TypeError, String(tick));
        assert.throws(() => store.jobs.createWorker({ handlers, tick: { limt: 5 } }), { code: 'JD0013' });
        for (const limit of [0, 1.5, -1]) assert.throws(() => store.jobs.createWorker({ handlers, tick: { limit } }), TypeError);
        store.jobs.createWorker({ handlers, tick: { limit: 5 } });
        store.jobs.createWorker({ handlers, tick: { limit: null } });
        store.jobs.createWorker({ handlers, tick: {} });
      });
    });

    it('ticks before it claims: each step fires its occurrences, and the worker runs them', async () => {
      await withDatabase(engine, async (open) => {
        const { clock, options } = scenarioClock();
        const store = await open(options());
        await store.jobs.schedule({ id: 'daily', kind: 'digest', series: daily, zone: ZONE, missed: 'skip' });
        await store.jobs.schedule({ id: 'twice', kind: 'report', series: daily, zone: ZONE, missed: { catchUp: 1 } });
        const { ran, handlers } = recorder();
        const worker = store.jobs.createWorker({ handlers, pollInterval: 5, tick: true }).start();
        /** @type {string[][]} */
        const steps = [];
        try {
          for (const at of [nineOn(21) + HOUR, nineOn(22) + HOUR, nineOn(25) + HOUR, nineOn(25) + 2 * HOUR]) {
            const seen = ran.length;
            clock.at = at;
            const due = (await store.jobs.schedules()).filter((/** @type {any} */ record) => record.nextRunAt <= at).length;
            if (due > 0) await until(async () => (await store.jobs.counts()).done >= seen + (at === nineOn(25) + HOUR ? 3 : 2), 'the step\'s jobs');
            else await new Promise((resolve) => setTimeout(resolve, 30));
            steps.push(ran.slice(seen).sort());
          }
        }
        finally { await worker.stop(); }
        assert.deepEqual(steps, [
          ['daily@2026-03-21T09:00:00', 'twice@2026-03-21T09:00:00'],
          ['daily@2026-03-22T09:00:00', 'twice@2026-03-22T09:00:00'],
          // two days without a tick: skip fires the current one, catchUp 1 the latest missed one beside it
          ['daily@2026-03-25T09:00:00', 'twice@2026-03-24T09:00:00', 'twice@2026-03-25T09:00:00'],
          [],
        ]);
        assert.ok(worker.stats().ticks > 0);
        assert.equal(worker.stats().tickErrors, 0);
        same('worker steps', steps);
      });
    });

    it('two workers on two connections fire each occurrence once', async () => {
      await withDatabase(engine, async (open) => {
        const { clock, options } = scenarioClock();
        const a = await open(options());
        const b = await open(options());
        const ids = Array.from({ length: 30 }, (_, i) => `s${String(i).padStart(2, '0')}`);
        for (const id of ids) await a.jobs.schedule({ id, kind: 'digest', series: daily, zone: ZONE, missed: 'skip' });
        const first = recorder();
        const second = recorder();
        // b's worker learns of the table a's schedules created at its start
        const workers = [a.jobs.createWorker({ handlers: first.handlers, pollInterval: 2, tick: { limit: 7 }, concurrency: 2 }).start(),
          b.jobs.createWorker({ handlers: second.handlers, pollInterval: 2, tick: { limit: 7 }, concurrency: 2 }).start()];
        try {
          clock.at = nineOn(21) + HOUR;
          await until(async () => (await a.jobs.counts()).done === ids.length, 'every fired job done');
          clock.at = nineOn(22) + HOUR;
          await until(async () => (await a.jobs.counts()).done === 2 * ids.length, 'the second day done');
        }
        finally { for (const worker of workers) await worker.stop(); }
        const all = [...first.ran, ...second.ran].sort();
        assert.deepEqual(all, ids.flatMap((id) => [`${id}@2026-03-21T09:00:00`, `${id}@2026-03-22T09:00:00`]).sort());
        for (const record of await b.jobs.schedules()) assert.deepEqual(record.counts, { fired: 2, skipped: 0 }, record.id);
        assert.equal((await a.jobs.counts()).done, 2 * ids.length);
      });
    });

    it('an idle poll runs the same statements with the option as without it, but for a probe every 16 passes, while no schedule exists', async () => {
      await withDatabase(engine, async (open) => {
        const { options } = scenarioClock();
        /** @type {string[]} */
        const ran = [];
        const store = await open(options(), ran);
        const { handlers } = recorder();
        // the queue's tables exist, so an idle claim reads them
        await store.jobs.enqueue('digest', null);
        const warm = store.jobs.createWorker({ handlers }).start();
        await until(async () => (await store.jobs.counts()).done === 1, 'the warm-up job');
        await warm.stop();
        /** The statements a worker runs over `polls` idle polls after its first, from a fresh start. @param {any} workerOptions */
        const idle = async (workerOptions, polls = 6) => {
          const worker = store.jobs.createWorker({ handlers, pollInterval: 3, ...workerOptions });
          ran.length = 0;
          worker.start();
          await until(() => worker.stats().polls >= 1, 'the first poll');
          const first = ran.splice(0);
          const from = worker.stats().polls;
          await until(() => worker.stats().polls >= from + polls, 'the idle polls');
          await worker.stop();
          return { first, steady: ran.splice(0), stats: worker.stats() };
        };
        const plain = await idle({});
        const ticking = await idle({ tick: true }, 40);
        const distinct = (/** @type {string[]} */ list) => [...new Set(list)].sort();
        const probe = (/** @type {string} */ sql) => /_jaren_job_schedules/.test(sql);
        // what the ticking polls ran beyond a plain poll's statements is the probes alone: on PostgreSQL each
        // reads its catalog rows through a cursor of its own, in a transaction of its own
        const control = (/** @type {string} */ sql) => /^(?:BEGIN|COMMIT|FETCH FORWARD \d+ FROM "jaren_c\d+"|CLOSE "jaren_c\d+")$/.test(sql);
        const extra = ticking.steady.filter((sql) => !plain.steady.includes(sql));
        assert.deepEqual(extra.filter((sql) => !probe(sql) && !control(sql)), []);
        assert.ok(extra.filter((sql) => sql === 'BEGIN').length <= ticking.steady.filter(probe).length);
        assert.deepEqual(distinct(ticking.steady.filter((sql) => !probe(sql) && !control(sql))), distinct(plain.steady));
        assert.ok(plain.steady.length > 0);
        assert.equal(plain.first.filter(probe).length + plain.steady.filter(probe).length, 0);
        // one presence probe at the first poll (on PostgreSQL inside a cursor of its own), and one every
        // 16th poll after it: each loop pass ticks once, and the passes are the polls and the one in flight
        assert.equal(ticking.first.filter(probe).length, 1, String(ticking.first.filter(probe)));
        const probes = ticking.first.filter(probe).length + ticking.steady.filter(probe).length;
        assert.equal(probes, Math.floor(ticking.stats.polls / 16) + 1, `${probes} probes over ${ticking.stats.polls} polls`);
        assert.ok(probes >= 3);
        assert.equal(ticking.stats.ticks, 0);
        // a second start probes at its first poll again
        const again = await idle({ tick: true }, 2);
        assert.equal(again.first.filter(probe).length, 1);
        assert.equal(again.steady.filter(probe).length, 0);
        same('idle statement counts', [plain.steady.length > 0, ticking.first.filter(probe).length, probes >= 3]);
      });
    });

    it('starts ticking when its own store writes the first schedule; another store\'s first schedule reaches it within 16 polls', async () => {
      await withDatabase(engine, async (open) => {
        const { clock, options } = scenarioClock();
        const own = await open(options());
        const other = await open(options());
        const mine = recorder();
        const theirs = recorder();
        const ownWorker = own.jobs.createWorker({ handlers: mine.handlers, pollInterval: 3, tick: true }).start();
        const otherWorker = other.jobs.createWorker({ handlers: theirs.handlers, pollInterval: 3, tick: true }).start();
        try {
          await until(() => ownWorker.stats().polls >= 2 && otherWorker.stats().polls >= 2, 'both probes');
          // the first schedule is written through `own`: its worker ticks at once
          const from = otherWorker.stats().polls;
          await own.jobs.schedule({ id: 'daily', kind: 'digest', series: daily, zone: ZONE, missed: 'skip' });
          clock.at = nineOn(21) + HOUR;
          await until(async () => (await own.jobs.counts()).done === 1, 'the first occurrence');
          assert.deepEqual([...mine.ran, ...theirs.ran], ['daily@2026-03-21T09:00:00']);
          assert.ok(ownWorker.stats().ticks > 0);
          await ownWorker.stop();
          // `other` started before the table existed: a probe within 16 of its polls finds it, and it ticks
          clock.at = nineOn(22) + HOUR;
          await until(() => otherWorker.stats().ticks > 0, 'the other worker\'s first tick');
          assert.ok(otherWorker.stats().polls - from <= 17, `found after ${otherWorker.stats().polls - from} polls`);
          await until(async () => (await other.jobs.counts()).done === 2, 'the second occurrence');
          // either worker may claim what a tick fired: the queue is one
          assert.deepEqual([...mine.ran, ...theirs.ran].sort(), ['daily@2026-03-21T09:00:00', 'daily@2026-03-22T09:00:00']);
          assert.ok(theirs.ran.includes('daily@2026-03-22T09:00:00'));
        }
        finally {
          await ownWorker.stop();
          await otherWorker.stop();
        }
      });
    });

    it('latenessMs skips an occurrence due longer ago than it, the latest too, under every missed policy', async () => {
      await withDatabase(engine, async (open) => {
        const { clock, options } = scenarioClock();
        const store = await open(options());
        const three = 3 * HOUR;
        await store.jobs.schedule({ id: 'skip', kind: 'digest', series: daily, zone: ZONE, missed: 'skip', latenessMs: three });
        await store.jobs.schedule({ id: 'catchup', kind: 'digest', series: daily, zone: ZONE, missed: { catchUp: 2 }, latenessMs: 30 * HOUR });
        await store.jobs.schedule({ id: 'once', kind: 'digest', series: daily, zone: ZONE, missed: 'once', latenessMs: three,
          limits: { maxWork: 100000 } });
        await store.jobs.schedule({ id: 'unbounded', kind: 'digest', series: daily, zone: ZONE, missed: 'skip' });
        const ticks = [];
        for (const at of [nineOn(21) + HOUR / 2, nineOn(25) + three, nineOn(27) + three + 1, nineOn(28) + 1]) {
          clock.at = at;
          const out = await store.jobs.tick();
          ticks.push({ at, fired: [...out.fired].sort(), skipped: out.skipped });
        }
        assert.deepEqual(ticks, [
          { at: nineOn(21) + HOUR / 2, skipped: 0,
            fired: ['catchup@2026-03-21T09:00:00', 'once@2026-03-21T09:00:00', 'skip@2026-03-21T09:00:00', 'unbounded@2026-03-21T09:00:00'] },
          // exactly three hours late still fires; thirty hours admit the 24th beside the 25th (skipped: skip, catchup, once, unbounded)
          { at: nineOn(25) + three, skipped: 3 + 2 + 3 + 3,
            fired: ['catchup@2026-03-24T09:00:00', 'catchup@2026-03-25T09:00:00', 'once@2026-03-25T09:00:00',
              'skip@2026-03-25T09:00:00', 'unbounded@2026-03-25T09:00:00'] },
          // a millisecond past three hours: the latest is skipped too, and the bound is not 'missed'
          { at: nineOn(27) + three + 1, skipped: 2 + 0 + 2 + 1,
            fired: ['catchup@2026-03-26T09:00:00', 'catchup@2026-03-27T09:00:00', 'unbounded@2026-03-27T09:00:00'] },
          { at: nineOn(28) + 1, skipped: 0,
            fired: ['catchup@2026-03-28T09:00:00', 'once@2026-03-28T09:00:00', 'skip@2026-03-28T09:00:00', 'unbounded@2026-03-28T09:00:00'] },
        ]);
        const byId = new Map((await store.jobs.schedules()).map((/** @type {any} */ record) => [record.id, record]));
        // the cursor passed the skipped occurrences: nothing is due again, and each is counted once
        assert.deepEqual([byId.get('skip').latenessMs, byId.get('skip').limits, byId.get('skip').counts, byId.get('skip').lastRecurrenceId],
          [three, null, { fired: 3, skipped: 5 }, '2026-03-28T09:00:00']);
        assert.deepEqual([byId.get('once').latenessMs, byId.get('once').limits], [three, { maxWork: 100000 }]);
        assert.deepEqual([byId.get('unbounded').latenessMs, byId.get('unbounded').limits], [null, null]);
        // rewriting without it clears it; a bad one refuses before anything is stored
        assert.equal((await store.jobs.schedule({ id: 'skip', kind: 'digest', series: daily, zone: ZONE, missed: 'skip' })).latenessMs, null);
        for (const latenessMs of [0, -1, 1.5, '1h', Number.NaN, Infinity])
          await assert.rejects(async () => store.jobs.schedule({ id: 'x', kind: 'k', series: daily, zone: ZONE, missed: 'skip', latenessMs }),
            { code: 'JD0013' }, String(latenessMs));
        await assert.rejects(async () => store.jobs.schedule({ id: 'x', kind: 'k', series: daily, zone: ZONE, missed: 'skip',
          limits: { latenessMs: 5 } }), { code: 'JD0013' });
        assert.equal(byId.size, 4);
        same('lateness ticks', ticks);
      });
    });
  });
}
