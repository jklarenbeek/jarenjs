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
    assert.equal(json.handleAsInner.code, 'JL0005');
    assert.deepEqual(json.collections.map((/** @type {any} */ r) => r.code), ['JL0005', 'JL0005']);
    assert.notEqual(json.collections[0].reason, json.handleAsInner.reason, 'a collection inner is refused for its source, not its shape');
    for (const quoted of [REASON_FOR, REASON_WHERE, 'join takes another async sequence over a provider (with no mapAsync) as its inner side',
      'join\'s other side must derive from the same source, or from two providers sharing one scope']) {
      assert.ok(prose.includes(quoted), quoted);
    }
  });
});
