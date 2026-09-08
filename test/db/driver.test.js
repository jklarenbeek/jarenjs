//@ts-check
/**
 * @file The driver seam: the import-graph guarantee (no runtime
 * builtin reaches module scope anywhere, none at all from the root
 * subpath), the coded unavailability of a foreign binding, capability
 * probing with the version floor, the sync-capable helpers, and the
 * connection surface (registration hatches, sessions, savepoint
 * transactions) over the real `node:sqlite`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  SQLITE_FLOOR, chain, toPromise, isThenable, compareVersions,
  openConnection, wrapStatement,
} from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { bunDriver, fromBunModule } from '@jarenjs/db/bun';
import { wasmDriver } from '@jarenjs/db/wasm';

const PKG_SRC = path.resolve('packages/db/src');

describe('a refused connection releases its raw handle', () => {
  for (const asynchronous of [false, true]) {
    for (const closeMode of ['success', 'throw', 'reject']) {
      it(`${asynchronous ? 'asynchronous' : 'synchronous'} probe failure with ${closeMode} cleanup`, async () => {
        const failure = new Error('probe failed');
        const closeError = new Error('close failed');
        let closes = 0;
        const raw = {
          close() {
            closes += 1;
            if (closeMode === 'throw') throw closeError;
            if (closeMode === 'reject') return Promise.reject(closeError);
            return asynchronous ? Promise.resolve() : undefined;
          },
        };
        await assert.rejects(async () => openConnection(raw, {
          dialect: nodeDriver().dialect,
          probe() {
            if (asynchronous) return Promise.reject(failure);
            throw failure;
          },
        }), (error) => {
          if (closeMode === 'success') assert.strictEqual(error, failure);
          else {
            assert.ok(error instanceof AggregateError);
            assert.deepStrictEqual(error.errors, [failure, closeError]);
          }
          return true;
        });
        assert.strictEqual(closes, 1);
      });
    }
  }
});

/** Static import specifiers of one source file (dynamic ones excluded). */
function staticImports(file) {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)]
    .map((match) => match[1]);
}

/** Recursively collect the relative-import closure of a module file. */
function importClosure(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const spec of staticImports(file)) {
    if (spec.startsWith('.'))
      importClosure(path.resolve(path.dirname(file), spec), seen);
  }
  return seen;
}

/** A bun:sqlite-shaped Database over node:sqlite, for the adapter. */
class BunShapedDatabase {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
  }
  run(sql) {
    this.db.exec(sql);
  }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    return {
      run: (...params) => statement.run(...params),
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params),
    };
  }
  close() {
    this.db.close();
  }
}

/**
 * The same double, plus the native lazy row iterator real `bun:sqlite`
 * has. The plain one deliberately omits it so the driver's
 * `all()`-composed fallback stays covered; this one proves the binding
 * FORWARDS a native cursor when the runtime provides one — without which
 * a query that streams on Node materialises every row in a compiled Bun
 * binary, on identical code and identical data.
 */
class BunShapedDatabaseWithCursor extends BunShapedDatabase {
  prepare(sql) {
    const statement = this.db.prepare(sql);
    return { ...super.prepare(sql), iterate: (...params) => statement.iterate(...params) };
  }
}

describe('the import graph (D6)', () => {
  it("the root export's closure contains no node: or bun: specifier", () => {
    const closure = importClosure(path.join(PKG_SRC, 'index.js'));
    for (const file of closure) {
      for (const spec of staticImports(file)) {
        assert.strictEqual(/^(node|bun):/.test(spec), false,
          `${path.relative(PKG_SRC, file)} imports '${spec}' at module scope`);
      }
    }
    // the guarantee is about the ROOT graph: driver modules are not in it
    assert.strictEqual([...closure].some((f) => f.includes('drivers')), false);
  });

  it('every driver module imports its builtin lazily, never at module scope', () => {
    for (const name of ['node.js', 'bun.js', 'wasm.js']) {
      const file = path.join(PKG_SRC, 'drivers', name);
      for (const spec of staticImports(file)) {
        assert.strictEqual(/^(node|bun):/.test(spec), false,
          `${name} imports '${spec}' at module scope`);
      }
    }
  });
});

describe('binding availability (JD0003)', () => {
  it('the Bun driver on Node fails open() with JD0003 and the loader cause', async () => {
    await assert.rejects(() => bunDriver().open(':memory:'), (error) => {
      assert.strictEqual(error.code, 'JD0003');
      assert.strictEqual(error.name, 'DbCompileError');
      assert.ok(error.cause instanceof Error, 'the loader error is the cause');
      return true;
    });
  });

  it('wasmDriver refuses a missing or shapeless handle with JD0003', () => {
    assert.throws(() => wasmDriver(undefined), (e) => e.code === 'JD0003');
    assert.throws(() => wasmDriver({}), (e) => e.code === 'JD0003');
  });
});

describe('capability probing', () => {
  it('the Node connection reports the probed table, floor-checked', async () => {
    const connection = await nodeDriver().open(':memory:');
    const caps = connection.capabilities;
    assert.strictEqual(connection.synchronous, true);
    assert.strictEqual(compareVersions(caps.version, SQLITE_FLOOR) >= 0, true);
    assert.strictEqual(caps.jsonb, true);
    assert.strictEqual(caps.sessions, true);
    assert.strictEqual(caps.userFunctions, true);
    assert.strictEqual(caps.deterministicIndexableFunctions, true);
    assert.strictEqual(caps.alterTableFull, false);
    // the slots every SQLite driver leaves EMPTY
    assert.strictEqual(caps.statementTimeout, false);
    assert.strictEqual(caps.rowEstimates, false);
    assert.strictEqual(Object.isFrozen(caps), true);
    connection.close();
  });

  it('the Bun adapter declares what bun:sqlite cannot do', () => {
    const connection = fromBunModule({ Database: BunShapedDatabase }, ':memory:');
    assert.strictEqual(connection.capabilities.sessions, false);
    assert.strictEqual(connection.capabilities.userFunctions, false);
    assert.strictEqual(connection.capabilities.deterministicIndexableFunctions, false);
    assert.strictEqual(connection.registerFunction, null);
    assert.strictEqual(connection.registerAggregate, null);
    assert.strictEqual(connection.session, null);
    connection.close();
  });

  it('a library below the floor is JD0001 naming the version found', () => {
    const raw = {
      exec: () => undefined,
      prepare: (sql) => ({
        run: () => undefined,
        get: () => (sql.includes('sqlite_version') ? { version: '3.44.2' } : undefined),
        all: () => [],
      }),
      close: () => undefined,
    };
    assert.throws(
      () => openConnection(raw, { dialect: nodeDriver().dialect }),
      (error) => {
        assert.strictEqual(error.code, 'JD0001');
        assert.match(error.message, /3\.44\.2/);
        assert.match(error.message, /3\.45\.0/);
        return true;
      });
  });
});

describe('the connection surface over node:sqlite', () => {
  it('registerFunction and registerAggregate reach the database', async () => {
    const connection = await nodeDriver().open(':memory:');
    connection.registerFunction('double_it', { deterministic: true }, (n) => n * 2);
    const doubled = await toPromise(chain(
      connection.prepare('SELECT double_it(21) AS answer'),
      (statement) => statement.get([])));
    assert.strictEqual(doubled.answer, 42);
    connection.registerAggregate('sum_it', {
      start: 0,
      step: (acc, value) => acc + value,
    });
    connection.exec('CREATE TABLE n (v INTEGER)');
    connection.exec('INSERT INTO n VALUES (1), (2), (3)');
    const summed = await toPromise(chain(
      connection.prepare('SELECT sum_it(v) AS total FROM n'),
      (statement) => statement.get([])));
    assert.strictEqual(summed.total, 6);
    connection.close();
  });

  it('session() captures a changeset', async () => {
    const connection = await nodeDriver().open(':memory:');
    connection.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)');
    const session = connection.session('t');
    connection.exec("INSERT INTO t VALUES ('a', 'x')");
    const changeset = session.changeset();
    assert.strictEqual(changeset instanceof Uint8Array, true);
    assert.strictEqual(changeset.byteLength > 0, true);
    connection.close();
  });

  it('transaction() nests via savepoints and rolls back exactly one level', async () => {
    const connection = await nodeDriver().open(':memory:');
    connection.exec('CREATE TABLE t (v TEXT)');
    const insert = (v) => connection.exec(`INSERT INTO t VALUES ('${v}')`);
    const rows = () => chain(connection.prepare('SELECT v FROM t ORDER BY v'),
      (statement) => chain(statement.all([]), (r) => r.map((x) => x.v)));

    const out = connection.transaction(() => {
      insert('outer');
      try {
        connection.transaction(() => {
          insert('inner');
          throw new Error('inner boom');
        });
      }
      catch (error) {
        assert.strictEqual(error.message, 'inner boom');
      }
      return 'kept';
    });
    assert.strictEqual(out, 'kept');
    assert.deepStrictEqual(rows(), ['outer'], 'the outer level survived the inner rollback');
    connection.close();
  });
});

describe('the sync-capable helpers', () => {
  it('chain applies without allocating on values, through promises otherwise', async () => {
    assert.strictEqual(chain(2, (n) => n + 1), 3);
    const promised = chain(Promise.resolve(2), (n) => n + 1);
    assert.strictEqual(isThenable(promised), true);
    assert.strictEqual(await promised, 3);
  });

  it('toPromise lifts exactly once; isThenable discriminates', async () => {
    assert.strictEqual(await toPromise(7), 7);
    const existing = Promise.resolve(8);
    assert.strictEqual(toPromise(existing), existing);
    assert.strictEqual(isThenable(null), false);
    assert.strictEqual(isThenable({ then: 1 }), false);
  });

  it('compareVersions orders numerically, not lexically', () => {
    assert.strictEqual(compareVersions('3.45.0', '3.45.0'), 0);
    assert.strictEqual(compareVersions('3.9.0', '3.45.0') < 0, true);
    assert.strictEqual(compareVersions('3.51.2', '3.45.0') > 0, true);
  });

  it('wrapStatement composes iterate over all when the binding lacks it', async () => {
    const wrapped = wrapStatement({
      run: () => undefined,
      get: () => undefined,
      all: () => [{ v: 1 }, { v: 2 }],
    });
    const iterated = [...await toPromise(wrapped.iterate([]))];
    assert.deepStrictEqual(iterated.map((r) => r.v), [1, 2]);
  });

  it('the Bun binding FORWARDS a native cursor when the runtime has one', async () => {
    // real `bun:sqlite` exposes `Statement.iterate`; the binding used to
    // assume it did not, so the driver composed a cursor over `all()` and
    // a query that streams on Node materialised every row on Bun
    const connection = await toPromise(
      fromBunModule({ Database: BunShapedDatabaseWithCursor }, ':memory:'));
    connection.exec('CREATE TABLE t (v INTEGER)');
    connection.exec('INSERT INTO t VALUES (1), (2), (3)');
    const statement = connection.prepare('SELECT v FROM t ORDER BY v');
    const cursor = await toPromise(statement.iterate([]));
    // a NATIVE cursor yields on demand; the `all()` fallback would already
    // hold every row before the first `next()`
    assert.strictEqual(Array.isArray(cursor), false);
    const first = cursor.next();
    assert.strictEqual(first.value.v, 1);
    assert.strictEqual(first.done, false);
    const rest = [];
    for (const row of { [Symbol.iterator]: () => cursor }) rest.push(row.v);
    assert.deepStrictEqual(rest, [2, 3]);
    connection.close();
  });

  it('and still composes one over all() when the binding lacks it', async () => {
    const connection = await toPromise(
      fromBunModule({ Database: BunShapedDatabase }, ':memory:'));
    connection.exec('CREATE TABLE t (v INTEGER)');
    connection.exec('INSERT INTO t VALUES (1), (2)');
    const statement = connection.prepare('SELECT v FROM t ORDER BY v');
    const values = [];
    for (const row of await toPromise(statement.iterate([]))) values.push(row.v);
    assert.deepStrictEqual(values, [1, 2]);
    connection.close();
  });

  it('adaptNodeDatabase wraps an already-open DatabaseSync, iterating lazily', async () => {
    const db = new DatabaseSync(':memory:');
    const connection = adaptNodeDatabase(db);
    connection.exec('CREATE TABLE t (v INTEGER)');
    connection.exec('INSERT INTO t VALUES (1), (2)');
    const statement = connection.prepare('SELECT v FROM t ORDER BY v');
    const values = [];
    for (const row of statement.iterate([])) values.push(row.v);
    assert.deepStrictEqual(values, [1, 2]);
    connection.close();
  });
});
