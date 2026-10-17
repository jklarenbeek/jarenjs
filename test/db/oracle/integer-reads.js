//@ts-check
/**
 * @file The integer-read corpus every SQLite host runs (bun:sqlite under Bun
 * as well): integers a double holds exactly read back as written on every
 * read, an included child's included, and an integer a number would round,
 * written beside the store, is refused `JD2003` on every read. Every write
 * beside the store comes before the store's first read, so a host whose
 * connection keeps a read snapshot past a statement cannot hide one.
 */
import assert from 'node:assert/strict';

const entity = (/** @type {Record<string, any>} */ extra) => ({ schema: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } }, ...extra } } });
const child = () => entity({ pid: { type: 'string' }, v: { type: 'integer' }, n: { type: 'number' } });

export const INTEGER_MODEL = { $model: '0.1', entities: {
  P: entity({
    kids: { 'x-entity': { relation: { to: 'K', many: true, via: 'pid', onDelete: 'cascade' } } },
    odd: { 'x-entity': { relation: { to: 'R', many: true, via: 'pid', onDelete: 'cascade' } } },
  }),
  K: child(),
  R: child(),
} };

/** Integers a double holds exactly, past ±(2^53 - 1) and within it. */
export const EXACT = [2 ** 53 + 2, 2 ** 60, -(2 ** 62), 9007199254740991, -9007199254740991, 7];
/** Integers a number would round: past 2^53 by one, and 2^60 + 24 (the
 * digits a JavaScript number spells 2^60 by, which SQLite holds exactly). */
export const ROUNDED = ['9007199254740993', '-9007199254740993', '1152921504606847000'];

/** Every item a cursor yields. @param {AsyncIterable<any>} cursor */
const drain = async (cursor) => {
  const items = [];
  for await (const item of cursor) items.push(item);
  return items;
};

/** @param {any} error @param {RegExp} digits */
const refusal = (error, digits) => {
  assert.deepEqual({ code: error.code, class: error.class, retryable: error.retryable, cause: error.cause?.code },
    { code: 'JD2003', class: 'data', retryable: false, cause: 'ERR_OUT_OF_RANGE' });
  assert.match(error.reason, new RegExp('^a stored integer cannot be represented exactly as a JavaScript number: '
    + `Value is too large to be represented as a JavaScript number: ${digits.source}$`));
  return true;
};

/**
 * Run the corpus over a store `open` makes, `raw` running one statement
 * beside it on the same database.
 * @param {(model: any) => Promise<any>} open
 * @param {(sql: string) => void | Promise<void>} raw
 */
export async function checkIntegerReads(open, raw) {
  const store = await open(INTEGER_MODEL);
  try {
    const kids = store.entity('K');
    const odd = store.entity('R');
    await store.entity('P').create({ id: 'p' });
    const written = EXACT.map((v, i) => ({ id: `k${i}`, pid: 'p', v, n: v }));
    for (const kid of written) await kids.create(kid);
    await kids.create({ id: 'k6', pid: 'p', v: 1, n: 1 });
    for (const [i] of ROUNDED.entries()) await odd.create({ id: `r${i}`, pid: 'p', v: 1, n: 1 });
    // the exact integer another writer spelled by its own digits, and the
    // rounding ones
    await raw('UPDATE "K" SET "v" = 1152921504606846976 WHERE "id" = \'k6\'');
    for (const [i, digits] of ROUNDED.entries()) await raw(`UPDATE "R" SET "v" = ${digits} WHERE "id" = 'r${i}'`);
    const all = [...written, { id: 'k6', pid: 'p', v: 2 ** 60, n: 1 }];
    for (const kid of all) assert.deepEqual(await kids.asNoTracking().get(kid.id), kid);
    assert.deepEqual(await kids.asNoTracking().load({ orderBy: '$it.id' }), all);
    // a cursor pulls its rows through the binding's own row iterator
    assert.deepEqual(await drain(kids.loadCursor({ orderBy: '$it.id' })), all);
    assert.deepEqual(await drain(kids.cursor({ $for: { it: '$.K[*]' }, $orderby: ['$it.id'], $return: '$it.v' })),
      all.map((kid) => kid.v));
    const projected = (/** @type {string} */ name) => ({ $for: { it: `$.${name}[*]` }, $orderby: ['$it.id'], $return: '$it.v' });
    assert.equal((await store.explain(projected('K'))).mode, 'native');
    assert.deepEqual(await store.execute(projected('K')), all.map((kid) => kid.v));
    assert.deepEqual(await store.execute(projected('K'), { pushdown: false }), all.map((kid) => kid.v));
    const [parent] = await store.entity('P').asNoTracking().load({ include: { kids: true } });
    assert.deepEqual(parent.kids.map((/** @type {any} */ kid) => kid.v).sort((a, b) => a - b),
      all.map((kid) => kid.v).sort((a, b) => a - b));
    for (const [i, digits] of ROUNDED.entries())
      await assert.rejects(async () => odd.asNoTracking().get(`r${i}`), (error) => refusal(error, new RegExp(digits)));
    const any = new RegExp(`(?:${ROUNDED.join('|')})`);
    for (const read of [() => odd.asNoTracking().load({}), () => drain(odd.loadCursor({})),
      () => store.execute(projected('R')),
      () => store.execute(projected('R'), { pushdown: false }),
      () => store.entity('P').asNoTracking().load({ include: { odd: true } })])
      await assert.rejects(async () => read(), (error) => refusal(error, any));
  }
  finally { await store.close(); }
}
