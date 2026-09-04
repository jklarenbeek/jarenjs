//@ts-check
/**
 * @file `$overlaps` over a declared interval: the pre-filter, and every
 * boundary it has to agree with the engine about.
 *
 * §8.16's interval test is half-open — touching spans do not overlap —
 * and it does not answer `false` for a span that is not a span: an
 * empty or reversed one RAISES. A pushed filter that dropped such a row
 * would answer where the engine errors, so the promotion keeps every
 * one of them and the residual decides. That is the property this file
 * pins, against the engine itself, over a corpus built to sit exactly
 * on the boundaries: touching, one instant of overlap, an empty span, a
 * reversed span, and a row carrying no span at all.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore, DbCompileError } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { queryJson } from '@jarenjs/json/query';

/** A span the schema requires, so a missing or textual bound is unwritable. */
const SPAN = {
  type: 'object',
  required: ['start', 'end'],
  properties: { start: { type: 'integer' }, end: { type: 'integer' } },
};
const MODEL = (indexes) => ({
  $model: '0.1',
  collections: {
    booking: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, room: { type: 'string' }, span: SPAN },
      },
      key: '/id',
      indexes,
    },
  },
});
const MAPPED = [
  { name: 'by_start', path: '$.span.start' },
  { name: 'by_end', path: '$.span.end' },
];
/** Only ONE bound declared: the pair is not mapped, so nothing pushes. */
const HALF_MAPPED = [{ name: 'by_start', path: '$.span.start' }];

/** The corpus, every row of it a boundary. */
const ROWS = [
  { id: 'before', room: 'a', span: { start: 0, end: 100 } },
  { id: 'touching-below', room: 'a', span: { start: 0, end: 200 } },
  { id: 'one-instant', room: 'b', span: { start: 0, end: 201 } },
  { id: 'inside', room: 'b', span: { start: 250, end: 260 } },
  { id: 'touching-above', room: 'c', span: { start: 300, end: 400 } },
  { id: 'after', room: 'c', span: { start: 500, end: 600 } },
  { id: 'no-span', room: 'd' },
];
/** `[200, 300)`: it touches both neighbours and contains `inside`. */
const PROBE = { start: 200, end: 300 };
/** What the promotion records when it fires. */
const PREFILTER = { construct: '$overlaps', via: 'columns',
  columns: ['gx_span_start', 'gx_span_end'], exact: false };
/** A profile makes the document foreign: nothing is registered, so the
 * planner's own answer is the one the store runs. */
const PROFILE = { maxRows: 100 };

const flwor = (probe, ret = '$it.id') => ({
  $for: { it: '$[*]' },
  $where: { $overlaps: ['$it.span', { $const: probe }] },
  $return: ret,
});

/** A store over the corpus, plus the same rows as plain JSON. */
async function seeded(indexes = MAPPED, rows = ROWS) {
  const store = await openStore(MODEL(indexes), { driver: nodeDriver() });
  const booking = store.collection('booking');
  for (const row of rows) await booking.insert(row);
  return { store, booking, rows };
}

/** The engine's own answer for the same document over the same rows. */
const resident = (document, rows) => queryJson(document, rows);

describe('$overlaps over a declared interval', () => {
  it('narrows through the declared columns and lets the operator decide', async () => {
    const { store, booking } = await seeded();
    const explained = await booking.explain(flwor(PROBE));
    assert.deepStrictEqual(explained.prefilters, [PREFILTER]);
    // the cheap conjunct prunes, the engine's own operator decides, and
    // the statement never reads the document to answer the bound
    assert.strictEqual(explained.mode, 'native');
    assert.strictEqual(explained.udfs.length, 1);
    assert.match(explained.sql, /"gx_span_start" < \? AND "gx_span_end" > \?/);
    assert.doesNotMatch(explained.sql, /json_type\("doc", '\$\."span"/);
    await store.close();
  });

  it('without the hatch the same conjunct still narrows, and names its residual', async () => {
    const { store, booking } = await seeded();
    // a profile makes the document foreign, so nothing is registered
    const explained = await booking.explain(flwor(PROBE), { profile: PROFILE });
    assert.strictEqual(explained.mode, 'set');
    assert.deepStrictEqual(explained.prefilters, [PREFILTER]);
    assert.match(explained.residual.reasons[0].reason,
      /a half-open bound pre-filter is pushed over the declared interval columns/);
    assert.deepStrictEqual(await booking.execute(flwor(PROBE), { profile: PROFILE }),
      resident(flwor(PROBE), ROWS));
    await assert.rejects(async () => booking.execute(flwor(PROBE), { profile: PROFILE, strict: true }),
      (error) => error instanceof DbCompileError && error.code === 'JD0010');
    await store.close();
  });

  it('touching does not overlap, and one shared instant does', async () => {
    const { store, booking, rows } = await seeded();
    const document = flwor(PROBE);
    const engine = resident(document, rows);
    assert.deepStrictEqual(engine, ['one-instant', 'inside']);
    assert.deepStrictEqual(await booking.execute(document), engine);
    assert.deepStrictEqual(await booking.execute(document, { pushdown: false }), engine);
    await store.close();
  });

  it('the pruned rows never reach the engine — a row bound proves it', async () => {
    // the profile's row bound counts what the STATEMENT hands back, so
    // a bound of three passes only if the fetch really narrowed: seven
    // rows are stored and two of them overlap
    const narrow = { maxRows: 3 };
    const mapped = await seeded();
    assert.deepStrictEqual(
      await mapped.booking.execute(flwor(PROBE), { profile: narrow }),
      ['one-instant', 'inside']);
    await mapped.store.close();

    const unmapped = await seeded(HALF_MAPPED);
    await assert.rejects(async () => unmapped.booking.execute(flwor(PROBE),
      { profile: narrow }), { code: 'JD2007' });
    await unmapped.store.close();
  });

  for (const [label, span] of Object.entries({
    'an empty span': { start: 300, end: 300 },
    'a reversed span': { start: 500, end: 100 },
  })) {
    it(`${label} is fetched, so the store raises exactly where the engine does`, async () => {
      const rows = [...ROWS, { id: 'bad', room: 'e', span }];
      const { store, booking } = await seeded(MAPPED, rows);
      const document = flwor(PROBE);
      assert.throws(() => resident(document, rows), { code: 'JQ2001' });
      await assert.rejects(async () => booking.execute(document), { code: 'JQ2001' });
      await store.close();
    });
  }

  it('a probe that is not a span pushes nothing, and raises as the engine does', async () => {
    const { store, booking } = await seeded();
    for (const probe of [{ start: 300, end: 300 }, { start: 300, end: 100 }]) {
      const document = flwor(probe);
      const explained = await booking.explain(document, { profile: PROFILE });
      assert.deepStrictEqual(explained.prefilters, []);
      assert.match(explained.residual.reasons[0].reason,
        /the literal interval is not a half-open span of two instants/);
      // the probe raises for every row, so a plan that answered would
      // be hiding the caller's own error
      assert.throws(() => resident(document, ROWS), { code: 'JQ2001' });
      await assert.rejects(async () => booking.execute(document), { code: 'JQ2001' });
    }
    await store.close();
  });

  it('a row with no span at all is not a match and not an error', async () => {
    const rows = [{ id: 'no-span', room: 'd' }];
    const { store, booking } = await seeded(MAPPED, rows);
    const document = flwor(PROBE);
    assert.deepStrictEqual(resident(document, rows), undefined);
    assert.deepStrictEqual(await booking.execute(document), undefined);
    await store.close();
  });

  it('an unmapped pair pushes nothing, and strict mode names it', async () => {
    const { store, booking } = await seeded(HALF_MAPPED);
    const document = flwor(PROBE);
    const explained = await booking.explain(document, { profile: PROFILE });
    assert.deepStrictEqual(explained.prefilters, []);
    assert.match(explained.residual.reasons[0].reason,
      /the interval bounds are not both declared columns/);
    assert.deepStrictEqual(await booking.execute(document), resident(document, ROWS));
    await assert.rejects(async () => booking.execute(document, { profile: PROFILE, strict: true }),
      (error) => error instanceof DbCompileError && error.code === 'JD0010');
    await store.close();
  });

  it('a schema that admits a textual bound is not an interval this can push', async () => {
    const model = MODEL(MAPPED);
    model.collections.booking.schema.properties.span = {
      ...SPAN,
      properties: { start: { type: ['integer', 'string'] }, end: { type: 'integer' } },
    };
    const store = await openStore(model, { driver: nodeDriver() });
    const booking = store.collection('booking');
    await booking.insert(ROWS[0]);
    const explained = await booking.explain(flwor(PROBE), { profile: PROFILE });
    assert.deepStrictEqual(explained.prefilters, []);
    assert.match(explained.residual.reasons[0].reason,
      /the schema does not type the member as an object whose start and end/);
    await store.close();
  });
});
