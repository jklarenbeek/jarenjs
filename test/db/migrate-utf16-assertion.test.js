//@ts-check
/**
 * @file A migration's `query` step over a SQLite file whose text encoding
 * is not UTF-8. A `$count` assertion over a collection is answered by a
 * native count, whose text comparison is the file's BINARY order: code
 * point order only over UTF-8. Over a UTF-16le file `'Ā' > 'ÿ'` counted no
 * row and `'ÿ' > 'Ā'` one (its bytes order U+0100 before U+00FF), and over
 * UTF-16le and UTF-16be alike `'😀' < '�'` counted one (a surrogate
 * orders before U+FFFD), so a precondition that holds refused the migration
 * and one that does not let it run. Over such a file the step reads its
 * documents through the engine, as every other assertion does, and
 * answers as over UTF-8; a UTF-8 file keeps the native count. A dry run
 * names the strategy the run takes.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { migrationIdentity } from './migration-fixture.js';
import { migrate, shapeHash, createModelShape } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const model = { $model: '0.1', collections: { docs: { schema: { type: 'object' }, key: '/id' } } };
const link = (/** @type {string} */ id, /** @type {any[]} */ steps) => ({ $migration: '0.2', identity: migrationIdentity(model), id, steps,
  from: shapeHash(model), to: shapeHash(model) });

/**
 * Apply one `$count` assertion over one stored text in a database of `encoding`.
 * @param {string} encoding @param {string} stored @param {any} assert
 * @returns {Promise<{ outcome: string, strategies: string[] }>}
 */
async function countOver(encoding, stored, assert) {
  const connection = await nodeDriver().open(':memory:');
  try {
    await connection.exec(`PRAGMA encoding='${encoding}'`);
    await createModelShape(connection, model);
    await connection.exec(`INSERT INTO docs(key,doc) VALUES('a',jsonb('${JSON.stringify({ id: 'a', s: stored })}'))`);
    /** @type {string[]} */
    const strategies = [];
    const step = { kind: 'query', collection: 'docs', assert, expect: 'ebv' };
    try {
      const result = await migrate({ connection }, [link('m', [step])], {
        baseline: model, shadow: false, onAssertionPlan: (/** @type {any} */ plan) => strategies.push(plan.strategy),
      });
      return { outcome: result.applied.join(), strategies };
    }
    catch (error) { return { outcome: /** @type {any} */ (error).code, strategies }; }
  }
  finally { await connection.close(); }
}

const where = (/** @type {string} */ op, /** @type {string} */ operand) =>
  ({ $count: { $for: { e: '$[*]' }, $where: { [op]: ['$e.s', operand] }, $return: '$e' } });

// [stored, operator, operand, the outcome by code point]
const CASES = [
  ['Ā', '$gt', 'ÿ', 'm'],
  ['ÿ', '$gt', 'Ā', 'JD0023'],
  ['\u{1F600}', '$lt', '�', 'JD0023'],
  ['�', '$lt', '\u{1F600}', 'm'],
];

for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
  it(`a $count assertion over a ${encoding} file compares text by code point`, async () => {
    for (const [stored, op, operand, outcome] of CASES) {
      assert.deepEqual(await countOver(encoding, stored, where(op, operand)),
        { outcome, strategies: [encoding === 'UTF-8' ? 'provider' : 'fold'] }, `${JSON.stringify(stored)} ${op} ${JSON.stringify(operand)}`);
    }
  });
}

it('a $count reading no text keeps answering over a UTF-16 file', async () => {
  for (const encoding of ['UTF-16le', 'UTF-16be']) {
    assert.deepEqual(await countOver(encoding, 'x', { $count: '$[*]' }), { outcome: 'm', strategies: ['fold'] });
    assert.deepEqual(await countOver(encoding, 'x', where('$eq', 'y')), { outcome: 'JD0023', strategies: ['fold'] });
  }
});

it('a dry run names the strategy the run takes: the native count over UTF-8, the fold over UTF-16', async () => {
  for (const [encoding, strategy] of [['UTF-8', 'provider'], ['UTF-16le', 'fold'], ['UTF-16be', 'fold']]) {
    const connection = await nodeDriver().open(':memory:');
    try {
      await connection.exec(`PRAGMA encoding='${encoding}'`);
      await createModelShape(connection, model);
      const step = { kind: 'query', collection: 'docs', assert: where('$gt', 'ÿ'), expect: 'ebv' };
      const result = await migrate({ connection }, [link('m', [step])], { baseline: model, shadow: false, dryRun: true });
      assert.deepEqual(result.statements,
        [`-- assert over 'docs' (${strategy}; the operand is partition-independent and items accumulate in original order)`], encoding);
    }
    finally { await connection.close(); }
  }
});
