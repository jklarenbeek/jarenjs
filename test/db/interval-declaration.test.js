//@ts-check
/**
 * @file A declared interval. The collection member `intervals` names a span
 * member the schema types as two indexed integer bounds, and from then on
 * every stored span is a half-open one of two safe integers (no longer than
 * `maxDuration`, where one is declared): the store refuses anything else
 * before the statement, hook or no hook (`JD2003`), and one named CHECK on
 * the table refuses every other writer (`JD2005`, class `constraint`) on
 * SQLite and PostgreSQL alike. The CHECK is verified at every open (`JD0002`
 * when dropped, altered, renamed or — on PostgreSQL — left unvalidated),
 * `$overlaps` over the declared span plans exactly (no disjunct, no
 * residual, no UDF) and answers what the engine answers — under a
 * `maxDuration`, with the start bounded from below as well, so its index is
 * sought from both sides — and the declaration is held to its rules
 * (`JD0005`). The two spellings of the CHECK are pinned verbatim: a changed
 * spelling is a changed guarantee.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  openStore, normalizeModel, planCollection, sqliteDialect, classifyDriverError, wrapDriverError,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { JarenValidator } from '@jarenjs/validate';
import { queryJson } from '@jarenjs/json/query';

import { PG_URL, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EIGHT_HOURS = 8 * HOUR;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MIN_SAFE = Number.MIN_SAFE_INTEGER;
/** A span the schema requires, so a missing or textual bound is unwritable under a hook. */
const SPAN = {
  type: 'object',
  required: ['start', 'end'],
  properties: { start: { type: 'integer' }, end: { type: 'integer' } },
};
const MAPPED = [
  { name: 'by_start', path: '$.span.start' },
  { name: 'by_end', path: '$.span.end' },
];
const SLOT = { name: 'slot', path: '$.span', maxDuration: EIGHT_HOURS };

/**
 * The booking model: `intervals` as given (none when `intervals` is
 * omitted — the member is then absent, not undefined).
 * @param {{ intervals?: any, indexes?: any[], span?: any }} [options]
 */
const model = ({ intervals, indexes = MAPPED, span = SPAN } = {}) => ({
  $model: '0.1',
  collections: {
    booking: {
      schema: { type: 'object', properties: { id: { type: 'string' }, span } },
      key: '/id',
      indexes,
      ...(intervals === undefined ? {} : { intervals }),
    },
  },
});
const DECLARED = model({ intervals: [SLOT] });
const UNDECLARED = model();

/** `$overlaps` of the row's span with a literal probe. @param {any} probe */
const flwor = (probe) => ({
  $for: { it: '$[*]' },
  $where: { $overlaps: ['$it.span', { $const: probe }] },
  $return: '$it.id',
});

/** The one spelling per engine (`maxDuration` present), verbatim. */
const SQLITE_CHECK = 'CONSTRAINT "slot_interval" CHECK (json_type("doc", \'$."span"\') IS NULL OR '
  + '(json_type("doc", \'$."span"\') = \'object\' AND json_type("doc", \'$."span"."start"\') IS \'integer\' '
  + 'AND json_type("doc", \'$."span"."end"\') IS \'integer\' '
  + 'AND "gx_span_start" BETWEEN -9007199254740991 AND 9007199254740991 '
  + 'AND "gx_span_end" BETWEEN -9007199254740991 AND 9007199254740991 '
  + 'AND "gx_span_start" < "gx_span_end" AND "gx_span_end" - "gx_span_start" <= 28800000))';
const POSTGRES_CHECK = 'CONSTRAINT "slot_interval" CHECK (jsonb_typeof(("doc" #> \'{"span"}\')) IS NULL OR '
  + '(jsonb_typeof(("doc" #> \'{"span"}\')) = \'object\' AND "gx_span_start" IS NOT NULL AND "gx_span_end" IS NOT NULL '
  + 'AND "gx_span_start" = trunc("gx_span_start") AND "gx_span_end" = trunc("gx_span_end") '
  + 'AND "gx_span_start" BETWEEN -9007199254740991 AND 9007199254740991 '
  + 'AND "gx_span_end" BETWEEN -9007199254740991 AND 9007199254740991 '
  + 'AND "gx_span_start" < "gx_span_end" AND "gx_span_end" - "gx_span_start" <= 28800000))';
/** What PostgreSQL 16, 17 and 18 deparse that CHECK as, identically. */
const POSTGRES_DEPARSE = "((jsonb_typeof((doc #> '{span}'::text[])) IS NULL) OR ((jsonb_typeof((doc #> '{span}'::text[])) = 'object'::text) "
  + 'AND (gx_span_start IS NOT NULL) AND (gx_span_end IS NOT NULL) AND (gx_span_start = trunc(gx_span_start)) '
  + "AND (gx_span_end = trunc(gx_span_end)) AND ((gx_span_start >= ('-9007199254740991'::bigint)::numeric) "
  + "AND (gx_span_start <= ('9007199254740991'::bigint)::numeric)) AND ((gx_span_end >= ('-9007199254740991'::bigint)::numeric) "
  + "AND (gx_span_end <= ('9007199254740991'::bigint)::numeric)) AND (gx_span_start < gx_span_end) "
  + 'AND ((gx_span_end - gx_span_start) <= (28800000)::numeric)))';

/** Every span the declaration refuses, by what is wrong with it. */
const REFUSED = {
  'null': null,
  'a scalar': 5,
  'an array': [],
  'a half span (no start)': { end: 250 },
  'a half span (no end)': { start: 5 },
  'a null bound': { start: 250, end: null },
  'an empty span': { start: 5, end: 5 },
  'a reversed span': { start: 250, end: 5 },
  'a boolean bound': { start: true, end: 5 },
  'a textual bound': { start: '1', end: 5 },
  'a fractional bound': { start: 1.5, end: 2 },
  'an unsafe bound': { start: 2 ** 53, end: 2 ** 53 + 2 },
  'a span over maxDuration': { start: 0, end: EIGHT_HOURS + 1 },
};
/** And every one it accepts. */
const ACCEPTED = {
  'a span of exactly maxDuration': { start: 0, end: EIGHT_HOURS },
  'the largest safe span': { start: MAX_SAFE - 1, end: MAX_SAFE },
};

/** The code and docPath of a refused model. @param {any} doc */
const refusal = (doc) => {
  try { normalizeModel(doc); return 'accepted'; }
  catch (/** @type {any} */ error) { return `${error.code} ${error.docPath}`; }
};

/** The CREATE TABLE statement a dialect plans for the booking table. @param {any} doc @param {any} dialect */
const createTableOf = (doc, dialect) => planCollection('booking', normalizeModel(doc).get('booking'), dialect).createSql[0];

/** A seeded span corpus: `n` spans over a year, thirty minutes to eight hours long. @param {number} n */
function corpus(n) {
  let state = 11;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: n }, (_, i) => {
    const start = Math.floor(next() * 365 * DAY);
    return { id: `b${i}`, span: { start, end: start + 1_800_000 + Math.floor(next() * 6.5 * HOUR) } };
  });
}
/** One-hour probes at day 10, 180 and 355 of that year. */
const WINDOWS = [10, 180, 355].map((day) => ({ day, probe: { start: day * DAY + 12 * HOUR, end: day * DAY + 13 * HOUR } }));
/** A span meeting each window for certain, so no window answers nothing by chance. */
const MET = WINDOWS.map(({ day, probe }) => ({ id: `met-${day}`, span: { start: probe.start - HOUR, end: probe.end + HOUR } }));
/** A query's answer as a list: a sequence of one item is handed back bare, and an empty one as `undefined`. @param {any} answer */
const items = (answer) => (answer === undefined ? [] : Array.isArray(answer) ? answer : [answer]);

/** The declaration without its duration: the conjunction alone. */
const UNBOUNDED = model({ intervals: [{ name: 'slot', path: '$.span' }] });
/**
 * The three parameters of the two-sided seek in text order: the lower bound
 * on the start (the window's start, floored, less the maximum duration),
 * the window's end, the window's start.
 * @param {{ start: number, end: number }} probe
 */
const twoSided = ({ start, end }) => [{ literal: Math.floor(start) - EIGHT_HOURS }, { literal: end }, { literal: start }];
/**
 * Two spans of exactly the maximum duration at a window's lower edge: one
 * ends where the window starts (touching, not an overlap — its start sits ON
 * the lower bound, which is strict) and one an instant later (an overlap —
 * its start is the first past the bound).
 * @param {string | number} day
 * @param {{ start: number }} probe
 */
const edges = (day, { start }) => [
  { id: `edge-out-${day}`, span: { start: Math.floor(start) - EIGHT_HOURS, end: Math.floor(start) } },
  { id: `edge-in-${day}`, span: { start: Math.floor(start) - EIGHT_HOURS + 1, end: Math.floor(start) + 1 } },
];
/** The three windows, a window of exactly the maximum duration, and a probe whose instants are fractional. */
const PROBES = [...WINDOWS,
  { day: 'a window of exactly maxDuration', probe: { start: 180 * DAY, end: 180 * DAY + EIGHT_HOURS } },
  { day: 'a fractional probe', probe: { start: 180 * DAY + 12 * HOUR + 0.5, end: 180 * DAY + 13 * HOUR + 0.5 } }];

describe('the declaration', () => {
  it('normalizes to the constraint name, the bound columns and the duration', () => {
    const [interval] = normalizeModel(DECLARED).get('booking').intervals;
    assert.equal(interval.name, 'slot');
    assert.equal(interval.constraint, 'slot_interval');
    assert.equal(interval.maxDuration, EIGHT_HOURS);
    assert.equal(normalizeModel(model({ intervals: [{ name: 'slot', path: '$.span' }] })).get('booking').intervals[0].maxDuration, null);
    assert.deepEqual(normalizeModel(UNDECLARED).get('booking').intervals, []);
  });

  it('is JD0005 at the member for every malformed declaration', () => {
    const at = '/collections/booking/intervals/0';
    for (const [label, doc, docPath] of /** @type {[string, any, string][]} */ ([
      ['a misspelt member', { ...UNDECLARED, collections: { booking: { ...UNDECLARED.collections.booking, intervls: [SLOT] } } }, '/collections/booking/intervls'],
      ['intervals that are not an array', model({ intervals: SLOT }), '/collections/booking/intervals'],
      ['an entry that is not an object', model({ intervals: ['slot'] }), at],
      ['an unknown entry member', model({ intervals: [{ ...SLOT, maxDuratoin: 1 }] }), `${at}/maxDuratoin`],
      ['a name that is not an identifier', model({ intervals: [{ ...SLOT, name: 'a slot' }] }), `${at}/name`],
      ['a constraint name over 63 bytes', model({ intervals: [{ ...SLOT, name: 'x'.repeat(55) }] }), `${at}/name`],
      ['a duplicate name', model({ intervals: [SLOT, { ...SLOT, path: '$.span' }] }), '/collections/booking/intervals/1/name'],
      ['a path that is not a string', model({ intervals: [{ ...SLOT, path: ['$.span'] }] }), `${at}/path`],
      ['a path that is not singular', model({ intervals: [{ ...SLOT, path: '$.spans[*]' }] }), `${at}/path`],
      ['a path to no member', model({ intervals: [{ ...SLOT, path: '$.nope' }] }), `${at}/path`],
      ['a path to a bound rather than the span', model({ intervals: [{ ...SLOT, path: '$.span.start' }] }), `${at}/path`],
      ['a span whose bounds are not required', model({ intervals: [SLOT], span: { ...SPAN, required: ['start'] } }), `${at}/path`],
      ['a bound typed number', model({ intervals: [SLOT], span: { ...SPAN, properties: { start: { type: 'number' }, end: { type: 'integer' } } } }), `${at}/path`],
      ['a bound admitting text', model({ intervals: [SLOT], span: { ...SPAN, properties: { start: { type: ['integer', 'string'] }, end: { type: 'integer' } } } }), `${at}/path`],
      ['an unindexed bound', model({ intervals: [SLOT], indexes: [MAPPED[0]] }), `${at}/path`],
      ['a bound indexed only through a derived index', model({ intervals: [SLOT], indexes: [MAPPED[0], { name: 'cells', path: '$.span.end', derive: 'geohash', precision: 6 }] }), `${at}/path`],
      ['maxDuration 0', model({ intervals: [{ ...SLOT, maxDuration: 0 }] }), `${at}/maxDuration`],
      ['maxDuration 1.5', model({ intervals: [{ ...SLOT, maxDuration: 1.5 }] }), `${at}/maxDuration`],
      ['maxDuration 2^53', model({ intervals: [{ ...SLOT, maxDuration: 2 ** 53 }] }), `${at}/maxDuration`],
      ['maxDuration as text', model({ intervals: [{ ...SLOT, maxDuration: '8h' }] }), `${at}/maxDuration`],
    ])) {
      assert.equal(refusal(doc), `JD0005 ${docPath}`, label);
    }
    assert.equal(refusal(model({ intervals: [{ ...SLOT, name: 'x'.repeat(54) }] })), 'accepted', 'a constraint name of exactly 63 bytes');
    assert.equal(refusal(model({ intervals: [SLOT], indexes: [{ name: 'both', path: ['$.span.start', '$.span.end'] }] })), 'accepted',
      'a composite index gives each bound its column');
  });

  it('names the index an unindexed bound needs', () => {
    assert.throws(() => normalizeModel(model({ intervals: [SLOT], indexes: [MAPPED[0]] })),
      (/** @type {any} */ error) => error.code === 'JD0005' && /\$\.span\.end/.test(error.message) && /index/.test(error.message));
  });
});

describe('the CHECK', () => {
  it('is spelled once per engine, verbatim', () => {
    assert.ok(createTableOf(DECLARED, sqliteDialect).endsWith(`, ${SQLITE_CHECK}) STRICT`), createTableOf(DECLARED, sqliteDialect));
    assert.ok(createTableOf(DECLARED, postgresDialect()).endsWith(`, ${POSTGRES_CHECK})`), createTableOf(DECLARED, postgresDialect()));
  });

  it('carries no duration clause without maxDuration, and nothing at all undeclared', () => {
    const unbounded = model({ intervals: [{ name: 'slot', path: '$.span' }] });
    for (const dialect of [sqliteDialect, postgresDialect()]) {
      const sql = createTableOf(unbounded, dialect);
      assert.match(sql, /CONSTRAINT "slot_interval" CHECK \(/);
      assert.doesNotMatch(sql, /<= 28800000/);
      assert.doesNotMatch(createTableOf(UNDECLARED, dialect), /CHECK/);
    }
  });
});

describe('the store refuses a malformed span before the statement', () => {
  for (const hook of [false, true]) {
    it(`through insert, put and patch, ${hook ? 'with' : 'without'} a validation hook`, async () => {
      const validator = new JarenValidator({ collectErrors: true });
      const store = await openStore(DECLARED, {
        driver: nodeDriver(),
        ...(hook ? { compileSchema: (/** @type {any} */ schema) => validator.compile(schema) } : {}),
      });
      const booking = store.collection('booking');
      try {
        await booking.put({ id: 'p', span: { start: 0, end: 10 } });
        const refused = (/** @type {any} */ error) => error.code === 'JD2003' && /'slot'/.test(error.message) && /\$\.span/.test(error.message);
        for (const [label, span] of Object.entries(REFUSED)) {
          await assert.rejects(async () => booking.insert({ id: 'i', span }), refused, `insert ${label}`);
          await assert.rejects(async () => booking.put({ id: 'u', span }), refused, `put ${label}`);
          await assert.rejects(async () => booking.patch('p', [{ op: 'replace', path: '/span', value: span }]), refused, `patch ${label}`);
        }
        assert.equal(await booking.get('i'), undefined);
        assert.deepEqual(await booking.get('p'), { id: 'p', span: { start: 0, end: 10 } });
        await booking.put({ id: 'absent' });
        for (const [label, span] of Object.entries(ACCEPTED)) {
          await booking.put({ id: label, span });
          assert.deepEqual(await booking.get(label), { id: label, span });
        }
        await booking.patch('p', [{ op: 'replace', path: '/span', value: { start: 5, end: 6 } }]);
        assert.deepEqual(await booking.get('p'), { id: 'p', span: { start: 5, end: 6 } });
      }
      finally { await store.close(); }
    });
  }

  it('an undeclared collection stores what it stored before', async () => {
    const store = await openStore(UNDECLARED, { driver: nodeDriver() });
    try {
      await store.collection('booking').put({ id: 'x', span: { start: 5, end: 5 } });
      assert.deepEqual(await store.collection('booking').get('x'), { id: 'x', span: { start: 5, end: 5 } });
    }
    finally { await store.close(); }
  });
});

describe('a raw SQL writer meets the CHECK on SQLite', () => {
  it('is refused for every shape the store refuses, as a constraint violation', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(DECLARED, { driver: nodeDriver(), path: dbPath });
      try {
        await store.collection('booking').put({ id: 'ok', span: { start: 0, end: 10 } });
        const raw = new DatabaseSync(dbPath);
        try {
          const insert = raw.prepare('INSERT INTO "booking" ("key", "doc") VALUES (?, jsonb(?))');
          for (const [label, span] of Object.entries(REFUSED)) {
            assert.throws(() => insert.run(`raw ${label}`, JSON.stringify({ id: `raw ${label}`, span })), (/** @type {any} */ error) => {
              // STRICT refuses a fractional bound's type before the CHECK reads it
              assert.ok([275, 3091].includes(error.errcode), `${label}: errcode ${error.errcode}`);
              assert.equal(classifyDriverError(error).class, 'constraint', label);
              assert.equal(wrapDriverError(error).code, 'JD2005', label);
              return true;
            });
          }
          insert.run('raw absent', JSON.stringify({ id: 'raw absent' }));
          for (const [label, span] of Object.entries(ACCEPTED)) insert.run(`raw ${label}`, JSON.stringify({ id: `raw ${label}`, span }));
        }
        finally { raw.close(); }
        assert.equal((await store.collection('booking').execute({ $for: { it: '$[*]' }, $return: '$it.id' })).length, 2 + Object.keys(ACCEPTED).length);
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });
});

describe('reopening a drifted table on SQLite', () => {
  /**
   * Build the declared store, close it, rewrite the booking table from an
   * edit of its own CREATE text (the indexes kept) where one is given, and
   * reopen under `reopenAs`.
   * @param {((create: string) => string) | null} edit
   * @param {any} [reopenAs]
   */
  const reopenAfter = async (edit, reopenAs = DECLARED) => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(DECLARED, { driver: nodeDriver(), path: dbPath });
      await store.close();
      if (edit !== null) {
        const db = new DatabaseSync(dbPath);
        try {
          const rows = db.prepare("SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND tbl_name = 'booking'").all();
          const create = String(rows.find((row) => row.name === 'booking')?.sql);
          const edited = edit(create);
          assert.notEqual(edited, create, 'the edit must change the text');
          db.exec('DROP TABLE "booking"');
          db.exec(edited);
          for (const row of rows) if (String(row.sql).startsWith('CREATE INDEX')) db.exec(String(row.sql));
        }
        finally { db.close(); }
      }
      await assert.rejects(() => openStore(reopenAs, { driver: nodeDriver(), path: dbPath }), { code: 'JD0002' });
    }
    finally { cleanup(); }
  };

  it('a dropped CHECK', () => reopenAfter((create) => create.replace(`, ${SQLITE_CHECK}`, '')));
  it('an altered CHECK', () => reopenAfter((create) => create.replace('<= 28800000', '<= 28800001')));
  it('a renamed CHECK', () => reopenAfter((create) => create.replace('"slot_interval"', '"slot_check"')));
  it('a CHECK the model no longer declares', () => reopenAfter(null, UNDECLARED));

  it('an identical table reopens, and a declaration added to an undeclared file is drift', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const first = await openStore(DECLARED, { driver: nodeDriver(), path: dbPath });
      await first.collection('booking').put({ id: 'a', span: { start: 1, end: 2 } });
      await first.close();
      const again = await openStore(DECLARED, { driver: nodeDriver(), path: dbPath });
      assert.deepEqual(await again.collection('booking').get('a'), { id: 'a', span: { start: 1, end: 2 } });
      await again.close();
    }
    finally { cleanup(); }
    const undeclared = tempDbPath();
    try {
      const store = await openStore(UNDECLARED, { driver: nodeDriver(), path: undeclared.dbPath });
      await store.close();
      await assert.rejects(() => openStore(DECLARED, { driver: nodeDriver(), path: undeclared.dbPath }), { code: 'JD0002' });
    }
    finally { undeclared.cleanup(); }
  });
});

describe('$overlaps over the declared span plans exactly on SQLite', () => {
  it('two comparisons, no disjunct, no residual, no UDF — and the engine\'s answer at every window', async () => {
    const rows = [...corpus(2_000), ...MET, { id: 'no-span' }];
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(DECLARED, { driver: nodeDriver(), path: dbPath });
      try {
        const booking = store.collection('booking');
        await store.transaction(async (tx) => {
          for (const row of rows) await tx.collection('booking').put(row);
        });
        const raw = new DatabaseSync(dbPath);
        try { raw.exec('ANALYZE'); }
        finally { raw.close(); }
        for (const { day, probe } of WINDOWS) {
          const document = flwor(probe);
          const explained = await booking.explain(document);
          assert.match(explained.sql, /"gx_span_start" < \S+ AND "gx_span_end" > \S+/, `day ${day}`);
          assert.doesNotMatch(explained.sql, />= "gx_span_end"/, `day ${day}`);
          assert.deepEqual(explained.prefilters, [], `day ${day}`);
          assert.equal(explained.mode, 'native', `day ${day}`);
          assert.deepEqual(explained.udfs, [], `day ${day}`);
          const engine = items(queryJson(document, rows));
          assert.ok(engine.includes(`met-${day}`), `day ${day}: the probe meets some spans`);
          assert.deepEqual(items(await booking.execute(document)), engine, `day ${day}`);
          assert.deepEqual(items(await booking.execute(document, { pushdown: false })), engine, `day ${day}`);
          // the exact conjunction seeks the bound's index rather than scanning
          const plan = new DatabaseSync(dbPath);
          try {
            const steps = plan.prepare(`EXPLAIN QUERY PLAN ${explained.sql}`).all(...explained.params.map((/** @type {any} */ p) => p.literal))
              .map((step) => String(step.detail));
            assert.ok(steps.some((detail) => /SEARCH booking USING INDEX booking_by_/.test(detail)), steps.join(' | '));
          }
          finally { plan.close(); }
        }
        // the negation stays total: a row with no span is not an overlap
        const negated = { ...flwor(WINDOWS[0].probe), $where: { $not: flwor(WINDOWS[0].probe).$where } };
        const engine = items(queryJson(negated, rows));
        assert.ok(engine.includes('no-span') && !engine.includes('met-10'));
        assert.deepEqual(items(await booking.execute(negated)), engine);
        assert.deepEqual(items(await booking.execute(negated, { pushdown: false })), engine);
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });

  it('the undeclared collection keeps its pre-filter, byte for byte', async () => {
    const store = await openStore(UNDECLARED, { driver: nodeDriver() });
    try {
      const explained = await store.collection('booking').explain(flwor(WINDOWS[0].probe));
      assert.match(explained.sql, /\(\("gx_span_start" < \? AND "gx_span_end" > \?\) OR "gx_span_start" >= "gx_span_end"\)/);
      assert.deepEqual(explained.prefilters, [{ construct: '$overlaps', via: 'columns', columns: ['gx_span_start', 'gx_span_end'], exact: false }]);
      assert.equal(explained.udfs.length, 1);
    }
    finally { await store.close(); }
  });
});

describe('a maximum duration bounds the start from below', () => {
  it('binds from - maxDuration under the start as a third parameter, and answers the engine at every window', async () => {
    const rows = [...corpus(2_000), ...MET, ...PROBES.flatMap(({ day, probe }) => edges(day, probe)), { id: 'no-span' }];
    const store = await openStore(DECLARED, { driver: nodeDriver() });
    try {
      const booking = store.collection('booking');
      await store.transaction(async (tx) => {
        for (const row of rows) await tx.collection('booking').put(row);
      });
      for (const { day, probe } of PROBES) {
        const document = flwor(probe);
        const explained = await booking.explain(document);
        assert.match(explained.sql, /"gx_span_start" > \? AND "gx_span_start" < \? AND "gx_span_end" > \?/, `${day}`);
        assert.deepEqual(explained.params, twoSided(probe), `${day}`);
        assert.deepEqual(explained.prefilters, [], `${day}`);
        assert.equal(explained.mode, 'native', `${day}`);
        const engine = items(queryJson(document, rows));
        assert.ok(engine.includes(`edge-in-${day}`) && !engine.includes(`edge-out-${day}`), `${day}: the edge spans sit on the bound`);
        assert.deepEqual(items(await booking.execute(document)), engine, `${day}`);
        assert.deepEqual(items(await booking.execute(document, { pushdown: false })), engine, `${day}`);
      }
    }
    finally { await store.close(); }
  });

  it('without maxDuration the plan is the declared conjunction alone, byte for byte', async () => {
    const store = await openStore(UNBOUNDED, { driver: nodeDriver() });
    try {
      const { probe } = WINDOWS[1];
      const explained = await store.collection('booking').explain(flwor(probe));
      assert.match(explained.sql, /WHERE \("gx_span_start" IS NOT NULL AND "gx_span_end" IS NOT NULL AND "gx_span_start" < \? AND "gx_span_end" > \?\) ORDER BY/);
      assert.deepEqual(explained.params, [{ literal: probe.end }, { literal: probe.start }]);
    }
    finally { await store.close(); }
  });

  it('drops the lower bound where it would fall below the least safe integer, and keeps it at exactly that', async () => {
    const store = await openStore(DECLARED, { driver: nodeDriver() });
    try {
      const booking = store.collection('booking');
      const rows = [
        { id: 'least', span: { start: MIN_SAFE, end: MIN_SAFE + EIGHT_HOURS } },
        { id: 'next', span: { start: MIN_SAFE + 1, end: MIN_SAFE + 1 + EIGHT_HOURS } },
      ];
      for (const row of rows) await booking.put(row);
      // one below the least safe integer: every stored start is at least that, so the two parameters alone
      const below = flwor({ start: MIN_SAFE + EIGHT_HOURS - 1, end: MIN_SAFE + EIGHT_HOURS + HOUR });
      const unbounded = await booking.explain(below);
      assert.doesNotMatch(unbounded.sql, /"gx_span_start" > /);
      assert.deepEqual(unbounded.params, [{ literal: MIN_SAFE + EIGHT_HOURS + HOUR }, { literal: MIN_SAFE + EIGHT_HOURS - 1 }]);
      assert.deepEqual(items(queryJson(below, rows)), ['least', 'next']);
      assert.deepEqual(items(await booking.execute(below)), ['least', 'next']);
      // exactly the least safe integer: bound, and the span starting there is rightly not an overlap
      const least = flwor({ start: MIN_SAFE + EIGHT_HOURS, end: MIN_SAFE + EIGHT_HOURS + HOUR });
      const bounded = await booking.explain(least);
      assert.deepEqual(bounded.params, [{ literal: MIN_SAFE }, { literal: MIN_SAFE + EIGHT_HOURS + HOUR }, { literal: MIN_SAFE + EIGHT_HOURS }]);
      assert.deepEqual(items(queryJson(least, rows)), ['next']);
      assert.deepEqual(items(await booking.execute(least)), ['next']);
    }
    finally { await store.close(); }
  });
});

describe('a declared interval on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  /** The stored CHECK of the booking table: its deparse and whether it is validated. @param {any} pool @param {string} schema */
  const storedCheck = async (pool, schema) => {
    const { rows } = await pool.query('SELECT c.conname AS name, pg_get_expr(c.conbin, c.conrelid) AS expression, c.convalidated AS validated '
      + 'FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace '
      + "WHERE c.contype = 'c' AND n.nspname = $1 AND t.relname = 'booking' ORDER BY c.conname", [schema]);
    return rows;
  };

  it('creates the CHECK, refuses the store\'s and a raw writer\'s malformed spans, and plans exactly', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(DECLARED, { driver: driver() });
      try {
        assert.deepEqual(await storedCheck(pool, schema), [{ name: 'slot_interval', expression: POSTGRES_DEPARSE, validated: true }]);
        const booking = store.collection('booking');
        await booking.put({ id: 'p', span: { start: 0, end: 10 } });
        for (const [label, span] of Object.entries(REFUSED)) {
          await assert.rejects(async () => booking.put({ id: 'u', span }), { code: 'JD2003' }, `put ${label}`);
          await assert.rejects(async () => booking.patch('p', [{ op: 'replace', path: '/span', value: span }]), { code: 'JD2003' }, `patch ${label}`);
          await assert.rejects(pool.query(`INSERT INTO "${schema}"."booking" ("key", "doc") VALUES ($1, $2)`, [`raw ${label}`, JSON.stringify({ id: `raw ${label}`, span })]),
            (/** @type {any} */ error) => {
              assert.equal(error.code, '23514', `${label}: ${error.message}`);
              assert.equal(error.constraint, 'slot_interval', label);
              assert.equal(classifyDriverError(error).class, 'constraint', label);
              return true;
            }, `raw ${label}`);
        }
        await pool.query(`INSERT INTO "${schema}"."booking" ("key", "doc") VALUES ($1, $2)`, ['raw absent', JSON.stringify({ id: 'raw absent' })]);
        for (const [label, span] of Object.entries(ACCEPTED)) {
          await booking.put({ id: label, span });
          await pool.query(`INSERT INTO "${schema}"."booking" ("key", "doc") VALUES ($1, $2)`, [`raw ${label}`, JSON.stringify({ id: `raw ${label}`, span })]);
        }
        // the corpus, bulk-written behind the store (every span of it is a half-open one)
        const rows = [...corpus(3_000), ...MET];
        await pool.query(`INSERT INTO "${schema}"."booking" ("key", "doc") SELECT d->>'id', d FROM jsonb_array_elements($1::jsonb) AS d`, [JSON.stringify(rows)]);
        for (const { day, probe } of WINDOWS) {
          const document = flwor(probe);
          const explained = await booking.explain(document);
          assert.match(explained.sql, /"gx_span_start" < \S+ AND "gx_span_end" > \S+/, `day ${day}`);
          assert.doesNotMatch(explained.sql, />= "gx_span_end"/, `day ${day}`);
          assert.deepEqual(explained.prefilters, [], `day ${day}`);
          assert.equal(explained.mode, 'native', `day ${day}`);
          const engine = items(queryJson(document, rows));
          assert.ok(engine.includes(`met-${day}`), `day ${day}`);
          assert.deepEqual(items(await booking.execute(document)), engine, `day ${day}`);
          assert.deepEqual(items(await booking.execute(document, { pushdown: false })), engine, `day ${day}`);
        }
      }
      finally { await store.close(); }
    });
  });

  it('verifies the CHECK at every open: dropped, altered, renamed, unvalidated and undeclared are drift', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const table = `"${schema}"."booking"`;
      const first = await openStore(DECLARED, { driver: driver() });
      await first.collection('booking').put({ id: 'a', span: { start: 1, end: 2 } });
      await first.close();
      const again = await openStore(DECLARED, { driver: driver() });
      try { assert.deepEqual(await again.collection('booking').get('a'), { id: 'a', span: { start: 1, end: 2 } }); }
      finally { await again.close(); }
      const [{ expression }] = await storedCheck(pool, schema);
      const refuses = async (/** @type {string} */ label, /** @type {RegExp} */ reason) => {
        /** @type {any} */
        let opened;
        try {
          await assert.rejects(Promise.resolve().then(async () => { opened = await openStore(DECLARED, { driver: driver() }); }),
            (/** @type {any} */ error) => error.code === 'JD0002' && reason.test(error.message), label);
        }
        finally { await opened?.close(); }
      };
      await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT "slot_interval"`);
      await refuses('dropped', /slot_interval/);
      await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT "slot_interval" CHECK (${expression.replace('28800000', '28800001')})`);
      await refuses('altered', /slot_interval/);
      await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT "slot_interval"`);
      await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT "slot_check" CHECK (${expression})`);
      await refuses('renamed', /slot_interval/);
      await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT "slot_check"`);
      await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT "slot_interval" CHECK (${expression}) NOT VALID`);
      await refuses('not validated', /validated/);
      await pool.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT "slot_interval"`);
      const validated = await openStore(DECLARED, { driver: driver() });
      await validated.close();
      await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT "extra" CHECK (true)`);
      await refuses('an undeclared CHECK beside the declared one', /extra/);
      await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT "extra"`);
      // a collection declaring no interval reads none of its table's CHECKs:
      // the declared one stays, unrefused, as any foreign CHECK did before
      const undeclared = await openStore(UNDECLARED, { driver: driver() });
      try { assert.deepEqual(await undeclared.collection('booking').get('a'), { id: 'a', span: { start: 1, end: 2 } }); }
      finally { await undeclared.close(); }
    });
  });

  it('with maxDuration the start index is sought from both sides, at the window the one-sided plan scanned too', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const store = await openStore(DECLARED, { driver: driver() });
      try {
        const booking = store.collection('booking');
        const rows = [...corpus(3_000), ...MET, ...WINDOWS.flatMap(({ day, probe }) => edges(day, probe))];
        await pool.query(`INSERT INTO "${schema}"."booking" ("key", "doc") SELECT d->>'id', d FROM jsonb_array_elements($1::jsonb) AS d`, [JSON.stringify(rows)]);
        await pool.query(`ANALYZE "${schema}"."booking"`);
        for (const { day, probe } of WINDOWS) {
          const document = flwor(probe);
          const explained = await booking.explain(document);
          assert.match(explained.sql, /"gx_span_start" > \$1 AND "gx_span_start" < \$2 AND "gx_span_end" > \$3/, `day ${day}`);
          assert.deepEqual(explained.params, twoSided(probe), `day ${day}`);
          assert.deepEqual(explained.prefilters, [], `day ${day}`);
          const engine = items(queryJson(document, rows));
          assert.ok(engine.includes(`edge-in-${day}`) && !engine.includes(`edge-out-${day}`), `day ${day}`);
          assert.deepEqual(items(await booking.execute(document)), engine, `day ${day}`);
          assert.deepEqual(items(await booking.execute(document, { pushdown: false })), engine, `day ${day}`);
          // the server's plan: one index condition carrying both bounds of the start, and no sequential scan
          const { rows: lines } = await pool.query({ text: `EXPLAIN ${explained.sql.replace('FROM "booking"', `FROM "${schema}"."booking"`)}`,
            values: explained.params.map((/** @type {any} */ p) => p.literal) });
          const text = lines.map((line) => line['QUERY PLAN']).join('\n');
          // a bound deparses as a quoted cast ('…'::numeric), signed where it is negative, or as a bare literal where it is fractional
          assert.match(text, /Index Cond: \(.*\(gx_span_start > '?-?\d+(?:\.\d+)?'?(?:::numeric)?\) AND \(gx_span_start < '?-?\d+(?:\.\d+)?'?(?:::numeric)?\)\)/, `day ${day}:\n${text}`);
          assert.doesNotMatch(text, /Seq Scan/, `day ${day}:\n${text}`);
        }
      }
      finally { await store.close(); }
    });
  });
});
