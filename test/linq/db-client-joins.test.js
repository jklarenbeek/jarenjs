//@ts-check
/**
 * @file DB-CLIENT.md §6's recipe "Joins that run in the database, and the
 * ones that don't", run as printed: every comment in its fence is the
 * answer the client gives at this revision — a join of the entity sets
 * first is one statement, a filter before it runs the join in the engine
 * with its reason, an `or` across the two sides keeps the `$where` in the
 * engine while the same comparison as its own conjunct is native, `strict`
 * refuses `JD0010` (mixed roots and a top-level `$exists` included), and
 * two collections join only inside `federate()`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARK = "**Joins that run in the database, and the ones that don't.**";
const REASON_FOR = 'bindings must each range over one declared entity array ($.Entity[*])';
const REASON_WHERE = 'a conjunct must belong to one binding (or be the single join equality, or a comparison between mapped columns of one comparison family that the engine and the database decide alike)';

/** The recipe's text, its `js` fence and the `json` fence after it. */
function recipe() {
  const doc = readFileSync(new URL('../../packages/linq/docs/DB-CLIENT.md', import.meta.url), 'utf8');
  const at = doc.indexOf(MARK);
  assert.ok(at !== -1, 'the recipe is in DB-CLIENT.md');
  const open = doc.indexOf('```js\n', at) + '```js\n'.length;
  const close = doc.indexOf('\n```\n', open);
  const jsonOpen = doc.indexOf('```json\n', close);
  assert.equal(jsonOpen, close + '\n```\n\n'.length, 'the JSON fence follows the example');
  return {
    prose: doc.slice(at, open).replace(/\s+/g, ' '),
    code: doc.slice(open, close),
    json: JSON.parse(doc.slice(jsonOpen + '```json\n'.length, doc.indexOf('\n```\n', jsonOpen))),
  };
}

describe('DB-CLIENT.md: joins that run in the database, and the ones that don\'t', () => {
  it('the recipe runs as printed and exports the JSON after it', async () => {
    const { code: source, json } = recipe();
    let code = source;
    // the fence imports the packages by name; a scratch module resolves them from here
    for (const specifier of ['@jarenjs/linq/db', '@jarenjs/linq/model', '@jarenjs/linq', '@jarenjs/db/node']) {
      code = code.replaceAll(`'${specifier}'`, `'${import.meta.resolve(specifier)}'`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'db-client-joins-'));
    try {
      const file = join(dir, 'recipe.mjs');
      writeFileSync(file, code);
      const mod = await import(pathToFileURL(file).href);
      assert.deepEqual(Object.keys(mod), ['joins'], 'the example exports one value');
      assert.deepEqual(JSON.parse(JSON.stringify(mod.joins)), json);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the JSON says what the prose says: native first, the engine with its reason, strict JD0010, collections JL0005', () => {
    const { prose, json } = recipe();
    assert.deepEqual([json.joinFirst.plan.mode, json.joinFirst.plan.join], ['native', true]);
    assert.deepEqual(json.joinFirst.rows, json.innerFirst.rows);
    assert.deepEqual(json.joinFirst.rows, json.outerFirst.rows);
    for (const side of [json.innerFirst, json.outerFirst]) assert.deepEqual(side.plan, { mode: 'set', streaming: 'buffered', join: false, reasons: [REASON_FOR] });
    assert.equal(json.eitherSide, 'native');
    assert.deepEqual([json.acrossOr.plan.mode, json.acrossOr.plan.reasons], ['set', [REASON_WHERE]]);
    assert.deepEqual([json.across.plan.mode, json.across.plan.join], ['native', true]);
    assert.deepEqual(json.strict, { acrossOr: 'JD0010', mixedRoots: 'JD0010', topLevelExists: 'JD0010', count: 2 });
    // the handle as the inner side is the sequence over it: the same statement and rows
    assert.deepEqual(json.handleAsInner, json.joinFirst);
    assert.deepEqual(json.collections.map((/** @type {any} */ r) => r.code), ['JL0005', 'JL0005']);
    for (const quoted of [REASON_FOR, REASON_WHERE, 'join takes another async sequence over a provider (with no mapAsync) as its inner side',
      'join\'s other side must derive from the same source, or from two providers sharing one scope']) {
      assert.ok(prose.includes(quoted), quoted);
    }
  });
});

describe('an entity handle as a join\'s inner side', () => {
  it('reads as the sequence over it, in join, groupJoin and after a where; another store\'s handle and a non-provider are still JL0005', async () => {
    const { fromAsync } = await import('@jarenjs/linq');
    const { open } = await import('@jarenjs/linq/db');
    const m = await import('@jarenjs/linq/model');
    const { nodeDriver } = await import('@jarenjs/db/node');
    const Assignment = m.object({ id: m.string().key(), employee: m.string(), position: m.string(), level: m.integer() });
    const Permission = m.object({ id: m.string().key(), position: m.string(), permission: m.string(), minLevel: m.integer() });
    const model = m.defineModel({ entities: { Assignment, Permission } });
    const client = await open(model, { driver: nodeDriver(), path: ':memory:' });
    const other = await open(model, { driver: nodeDriver(), path: ':memory:' });
    try {
      const A = client.entities.Assignment, P = client.entities.Permission;
      await A.create({ id: 'a1', employee: 'ann', position: 'clerk', level: 2 });
      await A.create({ id: 'a2', employee: 'bob', position: 'desk', level: 1 });
      await P.create({ id: 'p1', position: 'clerk', permission: 'orders.read', minLevel: 1 });
      await P.create({ id: 'p2', position: 'clerk', permission: 'orders.approve', minLevel: 2 });
      const pair = (/** @type {any} */ a, /** @type {any} */ p) => ({ employee: a.employee, permission: p.permission });
      const counted = (/** @type {any} */ a, /** @type {any} */ g) => ({ a: a.id, n: g.count() });
      for (const [title, build, mode] of /** @type {[string, (inner: any) => any, string][]} */ ([
        ['join', (inner) => A.join(inner, (a) => a.position, (p) => p.position, pair), 'native'],
        ['groupJoin', (inner) => A.groupJoin(inner, (a) => a.position, (p) => p.position, counted), 'native'],
        ['a join after a where', (inner) => A.where((a) => a.level.gt(0)).join(inner, (a) => a.position, (p) => p.position, pair), 'set'],
      ])) {
        const byHandle = build(P), bySequence = build(fromAsync(P));
        assert.deepEqual(byHandle.toDocument(), bySequence.toDocument(), title);
        assert.deepEqual(await byHandle.toArray(), await bySequence.toArray(), title);
        assert.equal((await A.explain(byHandle)).mode, mode, title);
      }
      assert.deepEqual(await A.join(P, (a) => a.position, (p) => p.position, pair).toArray(),
        [{ employee: 'ann', permission: 'orders.read' }, { employee: 'ann', permission: 'orders.approve' }]);
      assert.throws(() => A.join(other.entities.Permission, (a) => a.position, (p) => p.position, pair),
        (/** @type {any} */ error) => error.code === 'JL0005' && error.message.includes("join's other side must derive from the same source"));
      for (const inner of [[], { position: 'clerk' }, null]) {
        assert.throws(() => A.join(inner, (a) => a.position, (/** @type {any} */ p) => p.position, pair),
          (/** @type {any} */ error) => error.code === 'JL0005' && error.message.includes('join takes another async sequence over a provider'));
      }
    }
    finally {
      await client.close();
      await other.close();
    }
  });
});
