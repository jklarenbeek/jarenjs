//@ts-check
/**
 * @file The data studio's handler table, over a real store.
 *
 * The worker that hosts this table is browser-only — a wasm build, an
 * OPFS pool, two message channels — which is why the table itself does
 * not live there. Here it runs over the Node driver against a real
 * SQLite file, so the rules the studio depends on are held by
 * assertions rather than by a page nobody can run headless:
 *
 *  - a store fault reaches the page with its MESSAGE, whatever shape the
 *    host put in `code`;
 *  - the live-registration count is the number of registrations, and a
 *    reopen brings it down by ending them;
 *  - a refused migration leaves the store on the model it still has;
 *  - every reopen is announced, because it dropped every tab's
 *    subscription;
 *  - a client tab cannot recreate the database the owner holds;
 *  - the oracle answers over a THROWAWAY store — derived spatial indexes
 *    included, the empty sequence flagged, a refusal crossing as the db
 *    failure — and leaves the studio's store, its registrations and its
 *    peers exactly as they were; and the shape it takes is the shape the
 *    site builds the spatial corpus into, proven entry by entry.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileContract, isContractFailure } from '@jarenjs/contract';
import { nodeDriver } from '@jarenjs/db/node';
import { createJsltRegistry, mathPack } from '@jarenjs/json/jslt';
import { equalsJson } from '@jarenjs/core/object';

import { createDataHandlers, wireError } from '../../packages/website/src/db-handlers.js';
import { tripPipeline, TRIP_CSV } from '../../packages/website/src/boundaries/data.js';
import { tempDbPath } from '../db/helpers.js';
import { readSpatialCorpus, buildSpatialCorpus } from '../../scripts/lib/spatial-corpus.js';

const doc = JSON.parse(readFileSync(
  new URL('../../packages/website/src/contracts/data.contract.json', import.meta.url), 'utf8'));

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, points: { type: 'integer' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_points', path: '$.points' }],
    },
  },
};

/** The worked migration the studio's own control plans. */
const INDEXED = JSON.parse(JSON.stringify(MODEL));
INDEXED.collections.notes.indexes.push({ name: 'by_title', path: '$.title' });

/**
 * A host over a real file-backed store: what the worker supplies from a
 * wasm build and an OPFS pool, supplied here from `node:sqlite`.
 */
function testHost() {
  const { dbPath, cleanup } = tempDbPath();
  const announced = [];
  let unlinked = 0;
  /** The oracle's throwaway connections, counted at both ends. */
  const scratch = { opened: 0, closed: 0 };
  return {
    announced,
    cleanup,
    scratch,
    unlinks: () => unlinked,
    host: {
      init: () => Promise.resolve({ topology: 'owner', vfs: 'node', version: '3' }),
      makeDriver: () => nodeDriver(),
      makeScratchDriver: () => {
        const driver = nodeDriver();
        return {
          ...driver,
          open: async (/** @type {string} */ path, /** @type {any} */ options) => {
            assert.strictEqual(path, ':memory:', 'the oracle never opens a file');
            const raw = await driver.open(path, options);
            scratch.opened += 1;
            // the connection is frozen; the count wraps it rather than patching it
            return { ...raw, close: () => { scratch.closed += 1; return raw.close(); } };
          },
        };
      },
      path: () => dbPath,
      vfs: () => 'node',
      durable: () => true,
      unlink: () => { unlinked += 1; },
      announce: (/** @type {any} */ notice) => announced.push(notice),
      operators: createJsltRegistry().use(mathPack),
    },
  };
}

/** The value of a settled handler call, or the declared failure it answered. */
const settled = (value) => (isContractFailure(value)
  ? { ok: false, error: value }
  : { ok: true, value });

describe('the wire error the studio reports', function () {
  it('carries a coded refusal through as its code', function () {
    assert.deepStrictEqual(
      wireError(Object.assign(new Error('held'), { code: 'JD2061' })),
      { code: 'JD2061', message: 'held' });
  });

  it('leaves an uncoded fault uncoded, rather than inventing one', function () {
    assert.deepStrictEqual(wireError(new Error('something broke')),
      { code: null, message: 'something broke' });
    assert.deepStrictEqual(wireError('a thrown string'),
      { code: null, message: 'a thrown string' });
  });

  it('keeps a DOMException\'s MESSAGE, whose numeric code the contract cannot carry', function () {
    // the regression: `code` is declared ["string","null"], so a numeric
    // one failed the operation's own output validation and the page
    // showed a shape refusal with the store's message gone — the one
    // case where the message mattered most
    const fault = Object.assign(new Error('storage quota exceeded'),
      { name: 'QuotaExceededError', code: 22 });
    const wired = wireError(fault);
    assert.strictEqual(wired.code, null, 'a number is not a JD code, and is not passed off as one');
    assert.match(wired.message, /storage quota exceeded/, 'the message survives');
    assert.match(wired.message, /QuotaExceededError \(code 22\)/, 'and what it was is said, not dropped');
    const declared = compileContract(doc).operations['data.insert'].errors.db;
    assert.strictEqual(declared.validate(wired).valid, true,
      'so the failure the page receives is one the contract declares');
  });
});

describe('the handler table and the contract it is described by', function () {
  it('serves exactly the operations the document declares, and no others', function () {
    const contract = compileContract(doc);
    const { handlers, clientHandlers } = createDataHandlers(testHost().host);
    assert.deepStrictEqual(Object.keys(handlers).sort(), [...contract.ids].sort(),
      'a worker that stopped serving an operation, or serves one nothing declares,'
      + ' is the drift a frozen id list cannot see');
    assert.deepStrictEqual(Object.keys(clientHandlers).sort(), [...contract.ids].sort(),
      'and the client table answers the same operations, under its own policy');
  });
});

describe('the studio over a real store', function () {
  let fixture;
  let table;
  before(async function () {
    fixture = testHost();
    table = createDataHandlers(fixture.host);
    await table.handlers['data.open']({ model: MODEL });
    for (const doc_ of [
      { id: 'n1', title: 'first', points: 5 },
      { id: 'n2', title: 'second', points: 40 },
    ]) await table.handlers['data.insert']({ collection: 'notes', doc: doc_ });
  });
  after(async function () {
    await table.dispose();
    fixture.cleanup();
  });

  it('counts the live registrations it is actually holding', async function () {
    assert.deepStrictEqual(await table.handlers['data.lives'](), { count: 0 });
    const first = await table.handlers['data.live']({ collection: 'notes', document: [{ $for: { it: '$[*]' }, $return: '$it' }] });
    const second = await table.handlers['data.live']({ collection: 'notes', document: [{ $for: { it: '$[*]' }, $return: '$it' }] });
    assert.deepStrictEqual(await table.handlers['data.lives'](), { count: 2 });
    first.close();
    assert.deepStrictEqual(await table.handlers['data.lives'](), { count: 1 });
    // told twice is told once: the count is a SET's size, so a repeated
    // release cannot drive it below what is held
    first.close();
    first.close();
    assert.deepStrictEqual(await table.handlers['data.lives'](), { count: 1 });
    second.close();
    assert.deepStrictEqual(await table.handlers['data.lives'](), { count: 0 });
  });

  it('brings the count down by ENDING the registrations a reopen drops', async function () {
    const live = await table.handlers['data.live']({ collection: 'notes', document: [{ $for: { it: '$[*]' }, $return: '$it' }] });
    assert.deepStrictEqual(await table.handlers['data.lives'](), { count: 1 });
    await table.handlers['data.open']({ model: MODEL });
    assert.deepStrictEqual(await table.handlers['data.lives'](), { count: 0 },
      'the reopen released what it was feeding');
    // and the peer's own later release is still safe: it was already gone
    live.close();
    assert.deepStrictEqual(await table.handlers['data.lives'](), { count: 0 },
      'never negative — a negative count fails its own output schema and freezes');
  });

  it('announces every reopen, because every reopen dropped a subscription', async function () {
    const before_ = fixture.announced.length;
    await table.handlers['data.open']({ model: MODEL });
    await table.handlers['data.open']({ model: MODEL, reset: true });
    assert.deepStrictEqual(fixture.announced.slice(before_), [
      { store: 'opened', reset: false },
      { store: 'opened', reset: true },
    ], 'silence would leave every live pane showing its last rows, looking live');
  });

  it('answers the boot, the query pair and the write half the panes call', async function () {
    assert.deepStrictEqual(await table.handlers['data.init'](),
      { topology: 'owner', vfs: 'node', version: '3' });

    // the query pane: the same document run and explained, which is
    // what makes the pushdown visible beside the rows
    const query = { $for: { it: '$[*]' }, $where: { $gt: ['$it.points', 10] }, $return: '$it' };
    const results = await table.handlers['data.execute']({ collection: 'notes', document: query });
    assert.deepStrictEqual(results, { id: 'n2', title: 'second', points: 40 });
    const explain = await table.handlers['data.explain']({ collection: 'notes', document: query });
    assert.match(explain.sql, /SELECT/i, 'the SQL the query was pushed down to');
    assert.ok(Array.isArray(explain.indexes));

    // the live pane, end to end: the snapshot it starts from, and the
    // RFC 6902 emissions a write and a DELETE arrive on
    const live = await table.handlers['data.live'](
      { collection: 'notes', document: [{ $for: { it: '$[*]' }, $return: '$it' }] });
    assert.deepStrictEqual(live.snapshot().rows.map((/** @type {any} */ row) => row.id),
      ['n1', 'n2']);
    const events = [];
    live.subscribe((/** @type {any} */ event) => events.push(event));
    await table.handlers['data.insert'](
      { collection: 'notes', doc: { id: 'n3', title: 'third', points: 7 } });
    await table.handlers['data.delete']({ collection: 'notes', key: 'n1' });
    assert.deepStrictEqual(events.map((/** @type {any} */ event) => event.patch), [
      [{ op: 'add', path: '/rows/2', value: { id: 'n3', title: 'third', points: 7 } }],
      [{ op: 'remove', path: '/rows/0' }],
    ], 'a delete reaches the live pane as a removal, on the feed an insert arrives on');
    live.close();
    const rows = await table.handlers['data.rows']({ collection: 'notes' });
    assert.deepStrictEqual(rows.map((/** @type {any} */ row) => row.id), ['n2', 'n3']);
    // put the fixture back where the rest of the suite expects it
    await table.handlers['data.delete']({ collection: 'notes', key: 'n3' });
    await table.handlers['data.insert'](
      { collection: 'notes', doc: { id: 'n1', title: 'first', points: 5 } });
  });

  it('answers the oracle beside the open store without touching it', async function () {
    const live = await table.handlers['data.live'](
      { collection: 'notes', document: [{ $for: { it: '$[*]' }, $return: '$it' }] });
    const events = [];
    live.subscribe((/** @type {any} */ event) => events.push(event));
    const announcedBefore = fixture.announced.length;
    const rowsBefore = await table.handlers['data.rows']({ collection: 'notes' });
    const answer = await table.handlers['data.oracle']({
      model: MODEL, collection: 'notes',
      documents: [{ id: 'x1', title: 'scratch', points: 99 }],
      query: { $for: { it: '$[*]' }, $return: '$it.title' },
    });
    assert.deepStrictEqual(answer, { answer: 'scratch', empty: false });
    assert.deepStrictEqual(await table.handlers['data.rows']({ collection: 'notes' }), rowsBefore,
      'the throwaway document never reached the studio\'s collection');
    assert.deepStrictEqual(await table.handlers['data.lives'](), { count: 1 },
      'the registration the page holds is still held');
    assert.deepStrictEqual(events, [], 'and it saw no write — nothing it subscribes to changed');
    assert.strictEqual(fixture.announced.length, announcedBefore, 'no peer was told anything');
    live.close();
  });

  it('refuses a client tab the recreate that would unlink the owner\'s database', async function () {
    const unlinksBefore = fixture.unlinks();
    const refused = settled(await table.clientHandlers['data.open']({ model: MODEL, reset: true }));
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.error.code, 'db');
    assert.strictEqual(refused.error.details.code, 'JD2061');
    assert.match(refused.error.details.message, /run it in that tab/);
    assert.strictEqual(fixture.unlinks(), unlinksBefore, 'nothing was unlinked');
    // the same tab may still open a model — it is the DESTRUCTIVE half
    // that is the owner's alone
    const opened = settled(await table.clientHandlers['data.open']({ model: MODEL }));
    assert.strictEqual(opened.ok, true);
    // and in the owning tab the control does what it says
    await table.handlers['data.open']({ model: MODEL, reset: true });
    assert.strictEqual(fixture.unlinks(), unlinksBefore + 1);
  });
});

describe('a migration the studio runs', function () {
  /** Each scenario gets its own database: a migrated store cannot be
   * reopened on the baseline model (the store refuses the reshape), so
   * sharing one file between them would be testing that refusal. */
  async function opened() {
    const fixture = testHost();
    const table = createDataHandlers(fixture.host);
    await table.handlers['data.open']({ model: MODEL });
    await table.handlers['data.insert']({ collection: 'notes', doc: { id: 'n1', title: 'first', points: 5 } });
    return { fixture, table };
  }

  it('applies the worked migration, and reports the ids the runner applied', async function () {
    const { fixture, table } = await opened();
    try {
      const report = await table.handlers['data.migrate']({ to: INDEXED, id: 'add-title-index' });
      assert.strictEqual(isContractFailure(report), false, 'the migration was applied, not refused');
      assert.deepStrictEqual(table.state.model, INDEXED, 'and the store is on the new model');
      assert.deepStrictEqual(report.applied, ['add-title-index'],
        'the runner answers ids as strings; reading an `id` member off them'
        + ' published a list of nulls under a declaration of strings');
      assert.ok(report.planned.length > 0, 'the plan it applied is reported');
      assert.deepStrictEqual(fixture.announced.at(-1), { store: 'migrated', applied: true },
        'the reopen it ends with is announced, like every other');
      assert.strictEqual(
        compileContract(doc).operations['data.migrate'].output.validate(report).valid, true,
        'and the report is one the page reads it through');
    }
    finally {
      await table.dispose();
      fixture.cleanup();
    }
  });

  it('leaves the model where it was when the migration is REFUSED', async function () {
    const { fixture, table } = await opened();
    try {
      // a target whose schema the stored data does not satisfy: the
      // runner validates the migrated state and refuses the whole chain
      const unreachable = JSON.parse(JSON.stringify(MODEL));
      unreachable.collections.notes.schema.required = ['absent'];
      unreachable.collections.notes.schema.properties.absent = { type: 'string' };
      const outcome = settled(await table.handlers['data.migrate']({ to: unreachable, id: 'refused' }));
      assert.strictEqual(outcome.ok, false, 'the refusal crosses as the declared db failure');
      assert.deepStrictEqual(table.state.model, MODEL,
        'a refused migration must not leave the worker believing it applied');
      // and the store is usable again, on the model it still has
      const rows = await table.handlers['data.rows']({ collection: 'notes' });
      assert.ok(Array.isArray(rows), 'reopened on the baseline, not left closed');
      assert.deepStrictEqual(fixture.announced.at(-1), { store: 'migrated', applied: false },
        'the tabs are told either way — their subscriptions ended either way');
    }
    finally {
      await table.dispose();
      fixture.cleanup();
    }
  });

  it('explains a store that is not open, instead of dereferencing null', async function () {
    const fixture = testHost();
    const table = createDataHandlers(fixture.host);
    try {
      const outcome = settled(await table.handlers['data.rows']({ collection: 'notes' }));
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(outcome.error.details.code, 'JD2005');
      assert.match(outcome.error.details.message, /the store is not open/);
    }
    finally {
      fixture.cleanup();
    }
  });
});

describe('the oracle — a second executor held to the engine from any tab', function () {
  const REGION = { type: 'Polygon', coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]] };
  const PLACES = {
    $model: '0.1',
    collections: {
      places: {
        schema: { type: 'object', properties: { id: { type: 'string' }, at: { type: ['array', 'object'] } } },
        key: '/id',
        indexes: [{ name: 'by_box', path: '$.at', derive: 'bbox' }],
      },
    },
  };
  const DOCS = [{ id: 'ams', at: [4.9041, 52.3676] }, { id: 'par', at: [2.3522, 48.8566] }];
  const within = (/** @type {any} */ region) => ({
    $for: { p: '$[*]' }, $where: { $within: ['$p.at', region] }, $return: '$p.id',
  });

  it('answers over a throwaway store on the model it is handed, with NO store open', async function () {
    const fixture = testHost();
    const table = createDataHandlers(fixture.host);
    try {
      const answer = await table.handlers['data.oracle'](
        { model: PLACES, collection: 'places', documents: DOCS, query: within(REGION) });
      assert.deepStrictEqual(answer, { answer: 'ams', empty: false },
        'the derived box index is declared on the scratch model and the plan over it agrees');
      assert.strictEqual(table.state.store, null, 'the studio still has no store — the oracle needed none');
      assert.deepStrictEqual(fixture.scratch, { opened: 1, closed: 1 },
        'the throwaway store is closed once the answer is in hand');
      assert.deepStrictEqual(fixture.announced, [], 'no peer is told: nothing they subscribe to changed');
    }
    finally {
      fixture.cleanup();
    }
  });

  it('crosses the empty sequence as a flag beside a null answer', async function () {
    const fixture = testHost();
    const table = createDataHandlers(fixture.host);
    try {
      const far = { type: 'Polygon', coordinates: [[[10, 40], [11, 40], [11, 41], [10, 41], [10, 40]]] };
      assert.deepStrictEqual(
        await table.handlers['data.oracle'](
          { model: PLACES, collection: 'places', documents: DOCS, query: within(far) }),
        { answer: null, empty: true });
      assert.deepStrictEqual(fixture.scratch, { opened: 1, closed: 1 });
    }
    finally {
      fixture.cleanup();
    }
  });

  it('answers the plan beside the answer when asked: the studio\'s round trip, held in Node', async function () {
    // the fourth card's whole loop, minus the browser: the pure half
    // makes the documents, the model and the linq document; the handler
    // runs them over a throwaway store with the derived indexes and
    // explains the plan it ran — the box seek, the exact refinement
    const fixture = testHost();
    const table = createDataHandlers(fixture.host);
    try {
      const trip = tripPipeline(TRIP_CSV);
      assert.strictEqual(trip.valid, true);
      const request = {
        model: trip.model, collection: trip.collectionName, documents: trip.documents,
        query: trip.query, externals: trip.externals,
      };
      const explained = await table.handlers['data.oracle']({ ...request, explain: true });
      assert.strictEqual(explained.empty, false);
      assert.deepStrictEqual(explained.answer.map((/** @type {any} */ f) => f.properties.name),
        ['Amsterdam', 'Utrecht', 'Rotterdam'], 'the three Dutch cities, not Paris or Berlin');
      assert.deepStrictEqual(explained.explain.prefilters.map((/** @type {any} */ p) => [p.construct, p.exact]),
        [['$within', false]], 'the box is pushed as a pre-filter and containment refines exactly');
      assert.match(explained.explain.scanNarrative, /SEARCH places USING INDEX places_by_box/,
        'the database\'s own plan seeks the derived box index');
      assert.deepStrictEqual(explained.explain.indexes, ['places_by_box'], 'the physical name the store gave the declared by_box');
      assert.match(explained.explain.sql, /SELECT/);
      assert.strictEqual(explained.explain.residual?.mode, 'set');
      // and without asking, the answer is the answer — the shape order 07 fixed
      const plain = await table.handlers['data.oracle'](request);
      assert.deepStrictEqual(Object.keys(plain).sort(), ['answer', 'empty']);
      assert.deepStrictEqual(fixture.scratch, { opened: 2, closed: 2 });
      assert.strictEqual(table.state.store, null);
    }
    finally {
      fixture.cleanup();
    }
  });

  it('crosses a refused model as the db failure, and still closes what it opened', async function () {
    const fixture = testHost();
    const table = createDataHandlers(fixture.host);
    try {
      const broken = JSON.parse(JSON.stringify(PLACES));
      // a derived index over a member the schema does not type as geography
      broken.collections.places.indexes = [{ name: 'by_id', path: '$.id', derive: 'bbox' }];
      const outcome = settled(await table.handlers['data.oracle'](
        { model: broken, collection: 'places', documents: DOCS, query: within(REGION) }));
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(outcome.error.code, 'db');
      assert.match(outcome.error.details.code, /^JD/);
      assert.strictEqual(fixture.scratch.opened, fixture.scratch.closed,
        'a refusal leaks no connection');
    }
    finally {
      fixture.cleanup();
    }
  });

  it('answers the corpus the site builds, entry by entry — the shape the browser posts', async function () {
    // the spatial corpus, projected exactly as the build ships it to the
    // data studio: the same request shape, the same comparator the page
    // uses, so the browser leg cannot disagree with this one on wiring
    const corpus = buildSpatialCorpus(readSpatialCorpus());
    const fixture = testHost();
    const table = createDataHandlers(fixture.host);
    try {
      const moved = [];
      let ran = 0;
      for (const [mapping, model] of Object.entries(corpus.mappings)) {
        for (const entry of corpus.entries) {
          const outcome = await table.handlers['data.oracle']({
            model, collection: corpus.collection, documents: entry.documents, query: entry.query,
          });
          ran += 1;
          const where = `sqlite-node via data.oracle (${mapping}) disagreed on ${entry.name}`
            + ` — query ${JSON.stringify(entry.query)}`;
          if (isContractFailure(outcome)) {
            moved.push(`${where}: refused, ${outcome.details.message}`);
          }
          else if (entry.empty === true) {
            if (outcome.empty !== true) moved.push(`${where}: recorded the empty sequence, answered ${JSON.stringify(outcome.answer)}`);
          }
          else if (outcome.empty === true || !equalsJson(outcome.answer, entry.expected)) {
            moved.push(`${where}: recorded ${JSON.stringify(entry.expected)}, answered ${JSON.stringify(outcome.answer)}`);
          }
        }
      }
      assert.deepStrictEqual(moved, []);
      assert.strictEqual(ran, corpus.entries.length * Object.keys(corpus.mappings).length,
        'every entry ran under every mapping');
      assert.ok(corpus.entries.length >= 80, `only ${corpus.entries.length} entries`);
      assert.deepStrictEqual(fixture.scratch, { opened: ran, closed: ran },
        'one throwaway store per entry, every one closed');
    }
    finally {
      fixture.cleanup();
    }
  });
});
