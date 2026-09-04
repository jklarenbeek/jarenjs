//@ts-check
/**
 * @file A `for await` over a provider-backed entity chain is a real
 * cursor: the pushed document goes to the provider's `cursor()`, one
 * row is pulled per item from an open statement, and breaking,
 * throwing or aborting releases that statement exactly once. Where the
 * plan must materialise — a set residual, a chain's window — the cursor
 * still does, and records why (`streaming`, `barrier`). A provider that
 * offers no cursor keeps the element window it always had. The grep
 * gates at the end are what would have caught the materialising
 * iterator: the streamable branch names no `toArray`, the cursor module
 * knows no `.all()`, and exactly one cursor mechanism exists.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { open } from '@jarenjs/linq/db';
import { fromAsync } from '@jarenjs/linq';
import * as m from '@jarenjs/linq/model';

import { statementCountingDriver } from '../db/helpers.js';

const Row = m.object({
  id: m.integer().key(),
  n: m.integer(),
  pad: m.string(),
});
const model = m.defineModel({ entities: { Row } });

/** A client over the counting driver with `count` rows seeded. */
async function seeded(count = 50) {
  const counters = { iterate: 0, next: 0, return: 0, all: 0 };
  const client = await open(model, { driver: statementCountingDriver(counters), validator: null });
  const rows = client.store.sync.entity('Row');
  client.store.sync.transaction(() => {
    for (let i = 1; i <= count; i++) rows.create({ id: i, n: i, pad: 'x'.repeat(16) });
  });
  // a create is a tracked write; the unit of work starts empty here
  for (let i = 1; i <= count; i++) rows.discard(i);
  counters.iterate = 0;
  counters.next = 0;
  counters.return = 0;
  counters.all = 0;
  return { client, counters };
}

const codeIs = (code) => (error) => error.code === code;

describe('a native entity iterator does not materialize', () => {
  it('pulling three rows from a 20,000-row chain grows the heap by a bounded amount (forced GC, subprocess)', () => {
    const script = `
      import { open } from '@jarenjs/linq/db';
      import { nodeDriver } from '@jarenjs/db/node';
      const model = { $model: '0.1', entities: { Row: { schema: { type: 'object', required: ['id'],
        properties: { id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' },
          pad: { type: 'string' } } } } } };
      const client = await open(model, { driver: nodeDriver(), validator: null });
      const rows = client.store.sync.entity('Row');
      client.store.sync.transaction(() => {
        for (let i = 0; i < 20000; i++) rows.create({ id: i, n: i, pad: 'x'.repeat(170) });
      });
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      let count = 0;
      let first = null;
      for await (const item of client.entities.Row.where((r) => r.n.ge(0))) {
        if (first === null) { globalThis.gc(); first = process.memoryUsage().heapUsed - before; }
        if (++count === 3) break;
      }
      console.log(JSON.stringify({ count, growthKiB: Math.round(first / 1024) }));
      await client.close();
    `;
    const out = execFileSync(process.execPath,
      ['--no-warnings=ExperimentalWarning', '--expose-gc', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: process.cwd() });
    const { count, growthKiB } = JSON.parse(out.trim().split('\n').pop() ?? '{}');
    assert.strictEqual(count, 3);
    assert.ok(growthKiB < 2048,
      `the heap grew ${growthKiB} KiB before the first item — the whole result was read to yield three rows`);
  });

  it('the chain pulls one row per item from one open statement and never calls all()', async () => {
    const { client, counters } = await seeded();
    const seen = [];
    for await (const row of client.entities.Row.where((r) => r.n.gt(10))) {
      seen.push(row.n);
      if (seen.length === 3) break;
    }
    assert.deepStrictEqual(seen, [11, 12, 13]);
    assert.strictEqual(counters.iterate, 1, 'one statement opened');
    assert.strictEqual(counters.all, 0, 'nothing materialised');
    assert.strictEqual(counters.next, 3, 'exactly the rows the consumer asked for were pulled');
    await client.close();
  });

  it('toArray() over a pushable chain is one pushed window, run whole — the terminal asked for the array', async () => {
    const { client, counters } = await seeded(5);
    const all = await client.entities.Row.where((r) => r.n.gt(2)).toArray();
    assert.deepStrictEqual(all.map((r) => r.n), [3, 4, 5]);
    assert.strictEqual(counters.iterate, 0);
    assert.strictEqual(counters.all, 1);
    await client.close();
  });
});

describe('breaking after one item releases the statement exactly once', () => {
  it('after a break', async () => {
    const { client, counters } = await seeded();
    for await (const row of client.entities.Row.orderBy((r) => r.n)) {
      void row;
      break;
    }
    assert.strictEqual(counters.iterate, 1);
    assert.strictEqual(counters.return, 1);
    await client.close();
  });

  it('after a throw inside the loop body', async () => {
    const { client, counters } = await seeded();
    await assert.rejects(async () => {
      for await (const row of client.entities.Row.orderBy((r) => r.n)) {
        void row;
        throw new Error('consumer failed');
      }
    }, /consumer failed/);
    assert.strictEqual(counters.iterate, 1);
    assert.strictEqual(counters.return, 1);
    await client.close();
  });

  it('after an abort', async () => {
    const { client, counters } = await seeded();
    const controller = new AbortController();
    const cursor = client.entities.Row.cursor(
      { $for: { r: '$.Row[*]' }, $orderby: ['$r.n'], $return: '$r' }, { signal: controller.signal });
    assert.strictEqual(cursor.streaming, 'row');
    assert.strictEqual(cursor.barrier, null);
    const first = await cursor.next();
    assert.strictEqual(first.value.n, 1);
    controller.abort();
    await assert.rejects(() => cursor.next(), codeIs('JD2072'));
    await cursor.return();
    await cursor.return();
    assert.strictEqual(counters.iterate, 1);
    assert.strictEqual(counters.return, 1, 'abort released once; return() after it is idempotent');
    await client.close();
  });

  it('exhausting the cursor releases nothing twice: the statement reset itself', async () => {
    const { client, counters } = await seeded(4);
    const seen = [];
    for await (const row of client.entities.Row.where((r) => r.n.gt(0))) seen.push(row.n);
    assert.deepStrictEqual(seen, [1, 2, 3, 4]);
    assert.strictEqual(counters.next, 5, 'four rows and the done step');
    assert.strictEqual(counters.return, 0);
    await client.close();
  });
});

describe('cancellation performs no further pulls', () => {
  it('after abort the underlying statement receives no further next()', async () => {
    const { client, counters } = await seeded();
    const controller = new AbortController();
    const cursor = client.entities.Row.cursor(
      { $for: { r: '$.Row[*]' }, $return: '$r' }, { signal: controller.signal });
    await cursor.next();
    await cursor.next();
    const pulled = counters.next;
    controller.abort();
    await assert.rejects(() => cursor.next(), codeIs('JD2072'));
    await assert.rejects(() => cursor.next(), codeIs('JD2072'));
    assert.strictEqual(counters.next, pulled, 'no pull reached the statement after the abort');
    assert.strictEqual(counters.return, 1);
    await client.close();
  });

  it('a cursor asked for under an already-aborted signal is refused before it exists, and pulls nothing', async () => {
    const { client, counters } = await seeded();
    assert.throws(() => client.entities.Row.cursor(
      { $for: { r: '$.Row[*]' }, $return: '$r' }, { signal: AbortSignal.abort() }), codeIs('JD2072'));
    assert.strictEqual(counters.iterate, 0);
    assert.strictEqual(counters.next, 0);
    await client.close();
  });
});

describe('a barrier plan still materializes and records why', () => {
  it('a projection of member paths STREAMS; one an operator touches buffers and names $return', async () => {
    const { client, counters } = await seeded(6);
    // a member path projects into the statement, so the cursor pulls
    const streamed = client.entities.Row.select((r) => r.n);
    const rowCursor = client.entities.Row.cursor(streamed.toDocument());
    assert.strictEqual(rowCursor.streaming, 'row');
    assert.strictEqual(rowCursor.barrier, null);
    const pulled = [];
    for await (const n of streamed) {
      pulled.push(n);
      if (pulled.length === 2) break;
    }
    assert.deepStrictEqual(pulled, [1, 2]);
    assert.ok(counters.iterate >= 1, 'a row-streamable plan pulls through iterate()');

    counters.iterate = 0;
    counters.all = 0;
    const chain = client.entities.Row.select((r) => ({ c: r.n.add(1) }));
    const cursor = client.entities.Row.cursor(chain.toDocument());
    assert.strictEqual(cursor.streaming, 'buffered');
    assert.strictEqual(cursor.barrier?.construct, '$return');
    const seen = [];
    for await (const item of chain) {
      seen.push(item);
      if (seen.length === 2) break;
    }
    assert.deepStrictEqual(seen, [{ c: 2 }, { c: 3 }]);
    assert.strictEqual(counters.iterate, 0, 'a barrier opens no row iterator');
    assert.ok(counters.all >= 1, 'the fetched root was materialised, as declared');
    await client.close();
  });

  it('a chain window and a count each yield their one item; a window is a declared barrier', async () => {
    const { client } = await seeded(3);
    const window = client.entities.Row.cursor([{ $for: { r: '$.Row[*]' }, $return: '$r' }]);
    assert.strictEqual(window.streaming, 'buffered');
    assert.strictEqual(window.barrier?.construct, 'window');
    const items = [];
    for await (const item of window) items.push(item);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].length, 3, 'the window is one item: the whole array');
    const counted = [];
    for await (const item of client.entities.Row.cursor({ $count: { $for: { r: '$.Row[*]' }, $return: '$r' } }))
      counted.push(item);
    assert.deepStrictEqual(counted, [3]);
    await client.close();
  });

  it('an external the database cannot bind diverts, and the cursor says so before it runs', async () => {
    const { client, counters } = await seeded(4);
    const document = { $for: { r: '$.Row[*]' }, $where: { $eq: ['$r.n', '$flag'] }, $return: '$r' };
    const bound = client.entities.Row.cursor(document, { externals: { flag: 2 } });
    assert.strictEqual(bound.streaming, 'row');
    const diverted = client.entities.Row.cursor(document, { externals: { flag: true } });
    assert.strictEqual(diverted.streaming, 'buffered');
    assert.strictEqual(diverted.barrier?.construct, 'external');
    assert.match(diverted.barrier?.reason ?? '', /'flag'/);
    assert.strictEqual(counters.iterate + counters.all, 0, 'classification ran no statement');
    const rows = [];
    for await (const row of bound) rows.push(row.n);
    assert.deepStrictEqual(rows, [2]);
    await client.close();
  });

  it('the forced-residual harness switch is a named barrier too', async () => {
    const { client } = await seeded(3);
    const cursor = client.entities.Row.cursor(
      { $for: { r: '$.Row[*]' }, $return: '$r' }, { pushdown: false });
    assert.strictEqual(cursor.streaming, 'buffered');
    assert.strictEqual(cursor.barrier?.construct, 'pushdown');
    let n = 0;
    for await (const row of cursor) n += row.n;
    assert.strictEqual(n, 6);
    await client.close();
  });
});

describe('a provider without cursor() keeps the element window it always had', () => {
  it('one execute call with the toArray-wrapped document, its array iterated, closed on break', async () => {
    const calls = [];
    const provider = {
      execute(document, options) {
        calls.push({ document, options });
        return [{ id: 1 }, { id: 2 }, { id: 3 }];
      },
    };
    const seen = [];
    for await (const row of fromAsync(provider).where((r) => r.id.gt(1))) {
      seen.push(row.id);
      break;
    }
    assert.deepStrictEqual(seen, [1], 'the provider answered its array; the where rode inside the document');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].document,
      [{ $for: { it: '$[*]' }, $where: { $gt: ['$it.id', 1] }, $return: '$it' }]);
  });
});

describe('a cursor over an entity chain registers no tracker snapshots by default', () => {
  it('the chain and the untracked cursor leave the unit of work empty; tracking: true fills it', async () => {
    const { client } = await seeded(5);
    for await (const row of client.entities.Row.where((r) => r.n.gt(0))) void row;
    const document = { $for: { r: '$.Row[*]' }, $return: '$r' };
    for await (const row of client.entities.Row.cursor(document)) void row;
    assert.strictEqual(client.store.stats().tracker?.tracked, 0);
    const tracked = [];
    for await (const row of client.entities.Row.cursor(document, { tracking: true })) tracked.push(row);
    assert.strictEqual(client.store.stats().tracker?.tracked, 5, 'one snapshot per yielded row');
    assert.ok(Object.isFrozen(tracked[0]), 'a tracked read hands out the frozen snapshot');
    // and the snapshot is live: a change to a tracked row saves
    client.entities.Row.put({ ...tracked[0], n: 100 });
    const report = await client.saveChanges();
    assert.strictEqual(report.updated, 1);
    await client.close();
  });

  it('tracking a document that yields no entity documents is refused by code', async () => {
    const { client } = await seeded(2);
    for (const document of [
      { $for: { r: '$.Row[*]' }, $return: '$r.n' },
      { $count: { $for: { r: '$.Row[*]' }, $return: '$r' } },
      [{ $for: { r: '$.Row[*]' }, $return: '$r' }],
    ]) {
      assert.throws(() => client.entities.Row.cursor(document, { tracking: true }), codeIs('JD0034'));
    }
    await client.close();
  });
});

describe('a transaction view pins its cursor to its exact scope', () => {
  it('a cursor opened inside the callback can neither begin nor continue after it settles', async () => {
    const { client } = await seeded(3);
    /** @type {any} */
    let begun = null;
    /** @type {any} */
    let unbegun = null;
    await client.transaction(async (tx) => {
      const document = { $for: { r: '$.Row[*]' }, $orderby: ['$r.n'], $return: '$r' };
      const walked = [];
      for await (const row of tx.entities.Row.cursor(document)) walked.push(row.n);
      assert.deepStrictEqual(walked, [1, 2, 3]);
      begun = tx.entities.Row.cursor(document);
      assert.strictEqual((await begun.next()).value.n, 1);
      unbegun = tx.entities.Row.cursor(document);
      assert.strictEqual(unbegun.streaming, 'row');
    });
    await assert.rejects(() => begun.next(), codeIs('JD2070'));
    await assert.rejects(() => unbegun.next(), codeIs('JD2070'));
    await client.close();
  });
});

describe('the drift gates', () => {
  /** A file's CODE: comments stripped, so prose may name what code may not. */
  const code = (file) => fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  /** The body of one method of a class, from its signature to the next
   * member. @param {string} source @param {string} signature */
  const methodBody = (source, signature) => {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} exists`);
    const rest = source.slice(start + signature.length);
    const next = rest.indexOf('\n  }\n');
    return next < 0 ? rest : rest.slice(0, next);
  };

  it('the streamable provider branch names no toArray and pushes no window (the gate that would have caught the materialising iterator)', () => {
    const source = code('packages/linq/src/async.js');
    const iterator = methodBody(source, 'async* [Symbol.asyncIterator]()');
    const at = iterator.indexOf("kind === 'provider'");
    assert.ok(at >= 0, 'the iterator has a provider branch');
    const branch = iterator.slice(at, iterator.indexOf('else {', at));
    assert.match(branch, /#providerStream\(/, 'the provider branch hands the pushed document to #providerStream');
    assert.doesNotMatch(branch, /toArray|pushWindow\(|\.all\(/,
      'the provider branch never runs the window whole to iterate it');
    const stream = methodBody(source, '#providerStream(stages, values) {');
    const streamable = stream.slice(0, stream.indexOf('return this.#materializedWindow'));
    assert.match(streamable, /source\.cursor\(/, 'the streamable branch asks the provider for its cursor');
    assert.doesNotMatch(streamable, /toArray|pushWindow\(|\.all\(/);
  });

  it('the cursor module knows neither .all() nor toArray(), and the entity core calls no .all()', () => {
    assert.doesNotMatch(code('packages/db/src/cursor.js'), /\.all\(|toArray/);
    assert.doesNotMatch(code('packages/db/src/entity.js'), /\.all\(/);
  });

  it('exactly one cursor interface and one cursor mechanism exist', () => {
    const read = (file) => fs.readFileSync(file, 'utf8');
    const declared = read('packages/db/types/index.d.ts');
    assert.strictEqual((declared.match(/interface QueryCursor</g) ?? []).length, 1);
    // linq declares one cursor-named shape: the §12 SOURCE adapter — what
    // `fromAsync` accepts as input — never a second pull protocol
    const named = fs.readdirSync('packages/linq/types')
      .flatMap((file) => [...read(`packages/linq/types/${file}`).matchAll(/interface (\w*Cursor)\b/g)]
        .map((match) => match[1]));
    assert.deepStrictEqual(named, ['AsyncCursor']);
    assert.strictEqual((read('packages/db/src/cursor.js').match(/export function createCursor\(/g) ?? []).length, 1);
    // every row iterator an engine opens is handed to createCursor as its
    // `open` source: no engine pulls rows through a protocol of its own.
    // The driver seam (`driver.js`, `drivers/`) wraps the binding's own
    // iterate and is the one place that may name it otherwise
    let sites = 0;
    for (const file of fs.readdirSync('packages/db/src').filter((name) => name.endsWith('.js'))) {
      if (file === 'driver.js') continue;
      const lines = read(`packages/db/src/${file}`).split('\n').filter((line) => line.includes('.iterate('));
      for (const line of lines) {
        sites++;
        assert.match(line, /open: \(\) =>|\(statement\) => statement\.iterate\(/,
          `${file}: ${line.trim()} — a row iterator is opened only as a cursor source`);
      }
    }
    assert.ok(sites >= 3, 'the collection, entity, graph and change readers open theirs this way');
  });
});
