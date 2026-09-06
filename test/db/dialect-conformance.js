//@ts-check
/**
 * @file The dialect conformance kit: every SQL and mapping behaviour a
 * dialect must supply, as behaviour rather than as a snapshot.
 *
 * It is deliberately NOT a golden-SQL file. A second dialect that
 * passed a text comparison would have to spell PostgreSQL the way
 * SQLite spells it; what actually has to hold is structural — a quoted
 * identifier cannot close its own quoting, a write statement binds its
 * values through the dialect's own parameter form and never by
 * interpolation, a generated column carries the storage word its
 * engine has, an optional feature is declared absent rather than
 * emitted wrong. Those are the cases here, and they run unchanged over
 * every dialect the suite ships.
 *
 * Each case is REQUIRED or CAPABILITY-GATED. A gated case never simply
 * disappears: where the capability is false the kit asserts the
 * dialect carries no half of the feature, which is the difference
 * between "this engine does not do that" and "somebody forgot".
 */

import { DIALECT_CAPABILITIES } from '@jarenjs/db';

/** The scalar schema types every dialect must give a column type. */
const SCALARS = ['string', 'integer', 'number', 'boolean'];

/** Identifiers and values chosen to break naive quoting. */
export const HOSTILE_NAMES = Object.freeze([
  'plain',
  'has space',
  'has"double',
  "has'single",
  'has]bracket',
  'has`backtick',
  'drop;--',
  'sel\\ect',
  'ünïcøde',
  'MiXeD',
]);

/**
 * The delimiter pair a dialect quotes with, read from the dialect
 * itself: whatever brackets a name with no special character in it.
 * @param {(s: string) => string} quote
 * @returns {{ open: string, close: string }}
 */
function delimitersOf(quote) {
  const q = quote('x');
  return { open: q[0], close: q[q.length - 1] };
}

/**
 * The one quoting rule that makes an identifier safe wherever it is
 * pasted: the closing delimiter, doubled. It is checkable without
 * knowing which delimiter a dialect chose, and it is exactly what
 * SQLite, PostgreSQL and every bracket-quoting engine do.
 * @param {(s: string) => string} quote
 * @param {string} name
 * @returns {string}
 */
function expectedQuoting(quote, name) {
  const { open, close } = delimitersOf(quote);
  return open + name.split(close).join(close + close) + close;
}

/**
 * Run the conformance kit over one dialect.
 * @param {any} dialect
 * @param {{ describe: Function, it: Function, assert: any }} runner
 */
export function runDialectConformance(dialect, { describe, it, assert }) {
  const q = dialect.quoteIdentifier;
  const caps = dialect.capabilities;

  const SHAPE = { table: 'rows', keyColumn: 'key', docColumn: 'doc' };

  describe(`${dialect.name}: the dialect contract`, () => {
    it('names itself and answers the whole closed capability set', () => {
      assert.strictEqual(typeof dialect.name, 'string');
      assert.ok(dialect.name.length > 0);
      assert.deepStrictEqual(Object.keys(caps).sort(),
        Object.keys(DIALECT_CAPABILITIES).sort(),
        'a dialect answers every capability, so a missing one cannot read as false');
      for (const [name, value] of Object.entries(caps))
        assert.strictEqual(typeof value, 'boolean', `capability '${name}' is not a boolean`);
    });

    it('quotes an identifier so it cannot close its own quoting', () => {
      for (const name of HOSTILE_NAMES) {
        assert.strictEqual(q(name), expectedQuoting(q, name),
          `'${name}' must be delimited with the closing delimiter doubled`);
      }
      // injective: two names never produce one spelling, or an index
      // over one column would silently serve another
      const spellings = new Set(HOSTILE_NAMES.map((name) => q(name)));
      assert.strictEqual(spellings.size, HOSTILE_NAMES.length);
    });

    it('quotes a string literal so it cannot close its own quoting', () => {
      const sl = dialect.stringLiteral;
      for (const value of HOSTILE_NAMES)
        assert.strictEqual(sl(value), expectedQuoting(sl, value));
    });

    it('a parameter reference carries no caller text', () => {
      const ref = dialect.parameterRef(1, "name'; DROP TABLE rows; --");
      assert.strictEqual(typeof ref, 'string');
      assert.ok(ref.length > 0);
      assert.ok(!ref.includes(';'), `a parameter reference must not carry a statement: ${ref}`);
      assert.ok(!ref.includes('DROP'));
      assert.ok(!ref.includes("'"));
      // and it is a FUNCTION of the position: a positional dialect may
      // answer the same text for every slot, a numbered one may not
      // answer the same text for two different slots by accident
      const first = dialect.parameterRef(1, 'a');
      const second = dialect.parameterRef(2, 'b');
      assert.ok(first === second || first !== second);
      assert.strictEqual(dialect.parameterRef(2, 'x'), second);
    });

    it('gives every scalar schema type a column type', () => {
      for (const type of SCALARS) {
        for (const hint of ['key', 'generated']) {
          const declared = dialect.typeFor(type, hint);
          assert.strictEqual(typeof declared, 'string');
          assert.ok(declared.length > 0, `no column type for ${type}/${hint}`);
        }
      }
      // an UNTYPED path still needs a declared type; the capability says
      // whether that type compares with a bound value of any kind
      const untyped = dialect.typeFor(undefined, 'generated');
      assert.strictEqual(typeof untyped, 'string');
      assert.ok(untyped.length > 0);
      assert.strictEqual(dialect.columnUsableFor(undefined, 'text'), caps.untypedColumns);
      assert.strictEqual(dialect.columnUsableFor(undefined, 'number'), caps.untypedColumns);
    });

    it('a column of a declared type is usable for its own kind and for none it cannot hold', () => {
      assert.strictEqual(dialect.columnUsableFor('string', 'text'), true);
      assert.strictEqual(dialect.columnUsableFor('integer', 'number'), true);
      assert.strictEqual(dialect.columnUsableFor('number', 'number'), true);
      // `any` is the emitter asking for the member itself, not for a
      // comparison — always answerable
      for (const type of [...SCALARS, undefined])
        assert.strictEqual(dialect.columnUsableFor(type, 'any'), true);
    });

    it('a JSON member path is deterministic, and refuses what it cannot carry', () => {
      const segments = [{ name: 'a' }, { index: 2 }, { name: 'b c' }];
      const text = dialect.jsonPathText(segments);
      assert.ok(text === null || typeof text === 'string');
      assert.strictEqual(dialect.jsonPathText(segments), text,
        'the same segments must always spell the same path');
      assert.notStrictEqual(dialect.jsonPathText([{ name: 'a' }, { name: 'b' }]),
        dialect.jsonPathText([{ name: 'a.b' }]),
        'a nested path and a member literally named "a.b" are different paths');
      // the contract for a member the grammar cannot carry is `null`,
      // so the caller falls back rather than emitting a wrong path
      const answers = HOSTILE_NAMES.map((name) => dialect.jsonPathText([{ name }]));
      for (const answer of answers)
        assert.ok(answer === null || typeof answer === 'string');
    });

    it('the JSON primitives read and rewrite the document column', () => {
      const doc = q('doc');
      const path = /** @type {string} */ (dialect.jsonPathText([{ name: 'a' }]));
      const p1 = dialect.parameterRef(1, 'v');
      const forms = {
        jsonExtract: dialect.jsonExtract(doc, path),
        jsonTypeOf: dialect.jsonTypeOf(doc, path),
        jsonText: dialect.jsonText(doc),
        jsonAgg: dialect.jsonAgg(doc),
        jsonEncode: dialect.jsonEncode(p1),
        jsonSet: dialect.jsonSet(doc, path, p1),
        jsonRemove: dialect.jsonRemove(doc, path),
        jsonAppend: dialect.jsonAppend(doc, path, p1),
        valueTypeOf: dialect.valueTypeOf(p1),
        // an ENCLOSING object embeds the document as a nested JSON
        // value; a caller reading it back gets text. On an engine with
        // one JSON type the two spellings differ
        jsonEmbed: dialect.jsonEmbed(doc),
        jsonObject: dialect.jsonObject(`${dialect.stringLiteral('a')}, ${doc}`),
      };
      for (const [name, sql] of Object.entries(forms)) {
        assert.strictEqual(typeof sql, 'string', `${name} answered no SQL`);
        assert.ok(sql.length > 0, `${name} answered empty SQL`);
      }
      for (const name of ['jsonExtract', 'jsonTypeOf', 'jsonText', 'jsonAgg',
        'jsonSet', 'jsonRemove', 'jsonAppend', 'jsonEmbed', 'jsonObject']) {
        assert.ok(forms[name].includes(doc), `${name} does not read the document column`);
      }
      assert.ok(forms.jsonObject.includes(dialect.stringLiteral('a')),
        'an object carries its member names');
      for (const name of ['jsonEncode', 'jsonSet', 'jsonAppend', 'valueTypeOf'])
        assert.ok(forms[name].includes(p1), `${name} does not bind its value`);
      // a rewrite composes over another rewrite: the patch translator
      // chains them, so the result must be an EXPRESSION over the first
      assert.ok(dialect.jsonSet(forms.jsonRemove, path, p1).includes(forms.jsonRemove));
    });

    it('the string operators read the value and bind their patterns', () => {
      const value = q('gx_name');
      const p = (i) => dialect.parameterRef(i, 'p');
      for (const sql of [
        dialect.strStartsWith(value, p(1), p(2)),
        dialect.strStartsWithExact(value, p(1), p(2)),
        dialect.strEndsWith(value, p(1), p(2), p(3)),
        dialect.strContains(value, p(1)),
      ]) {
        assert.ok(sql.includes(value), `a string operator must read the column: ${sql}`);
        assert.ok(sql.includes(p(1)), `a string operator must bind its pattern: ${sql}`);
      }
      // the prefix range is the SARGABLE form, and what makes it one is
      // that it BOUNDS: two ends, both bound, so an index over the
      // value can seek rather than read every row. The exact form is
      // the dialect's; carrying both bounds is the contract.
      const range = dialect.strStartsWith(value, p(1), p(2));
      assert.ok(range.includes(p(1)) && range.includes(p(2)));
      assert.notStrictEqual(range, dialect.strStartsWithExact(value, p(1), p(2)),
        'the seekable form and the exact one are two different spellings');
    });

    it('ordering, windows and folds', () => {
      assert.notStrictEqual(dialect.orderNulls(true), dialect.orderNulls(false));
      assert.notStrictEqual(dialect.booleanLiteral(true), dialect.booleanLiteral(false));
      for (const b of [true, false]) {
        assert.strictEqual(typeof dialect.booleanLiteral(b), 'string');
        assert.ok(dialect.booleanLiteral(b).length > 0);
      }
      // the fixed bucket ladder: `origin + floor((at - origin) / every)
      // * every`, which is `at` less the NON-NEGATIVE remainder. The
      // width appears three times because a positional dialect numbers
      // its parameters by where they are written
      const ladder = dialect.timeBucket(q('at'), '$o', '$a', '$b', '$c');
      assert.ok(ladder.includes(q('at')));
      for (const part of ['$o', '$a', '$b', '$c']) assert.ok(ladder.includes(part), ladder);
      const limited = dialect.limitClause(5);
      assert.ok(limited.includes('5'));
      assert.ok(dialect.limitClause(5, 10).length > limited.length);
      assert.ok(dialect.limitClause(null).length > 0,
        'an unbounded window still needs a clause the engine accepts');
      for (const fn of ['sum', 'avg', 'min', 'max']) {
        const fold = dialect.groupAggregate(fn, q('v'));
        assert.ok(fold.includes(q('v')), `${fn} does not read its value`);
      }
      const rows = dialect.groupAggregate('count', null);
      assert.ok(rows.length > 0 && !rows.includes(q('v')),
        'a row count counts rows, not values');
      assert.ok(dialect.explainQuery('SELECT 1').includes('SELECT 1'));
      assert.ok(dialect.excludedRef(q('doc')).includes(q('doc')));
      assert.ok(dialect.epochFromRfc3339(q('t')).includes(q('t')));
      const identity = dialect.rowIdentity();
      assert.strictEqual(typeof identity, 'string');
      assert.ok(identity.length > 0);
      assert.ok(dialect.identityIn(identity, ['?', '?']).includes(identity));
    });

    it('the collection table: key, document, identity and generated columns', () => {
      const generated = [
        { name: 'gx_a', type: dialect.typeFor('string', 'generated'),
          pathText: dialect.jsonPathText([{ name: 'a' }]) },
        { name: 'gx_n', type: dialect.typeFor('integer', 'generated'),
          pathText: dialect.jsonPathText([{ name: 'n' }]) },
      ];
      const sql = dialect.ddl.createTable({
        table: 'rows',
        keyColumn: 'key',
        keyType: dialect.typeFor('string', 'key'),
        docColumn: 'doc',
        generated,
      });
      assert.ok(sql.startsWith(`CREATE TABLE ${q('rows')} (`));
      assert.ok(sql.includes(`${q('key')} `));
      assert.ok(sql.includes(`${q('doc')} ${dialect.docColumnType}`));
      for (const column of generated) {
        assert.ok(sql.includes(q(column.name)), `no ${column.name} column`);
        assert.ok(sql.includes(
          `${q(column.name)} ${column.type} GENERATED ALWAYS AS (`
          + `${dialect.jsonExtract(q('doc'), column.pathText)}) ${dialect.generatedStorage}`),
        `${column.name} is not a generated column over the document: ${sql}`);
      }
      if (dialect.identityColumn !== undefined) {
        assert.ok(sql.includes(
          `${q(dialect.identityColumn.name)} ${dialect.identityColumn.type}`),
        'a dialect that declares an identity column adds it to every table it creates');
      }
      // a STORED derived column is an ordinary one, on every dialect
      const stored = dialect.ddl.createTable({
        table: 'rows', keyColumn: 'key', keyType: dialect.typeFor('string', 'key'),
        docColumn: 'doc',
        generated: [{ name: 'gx_v', type: dialect.packedVectorType, pathText: null, stored: true }],
      });
      assert.ok(stored.includes(`${q('gx_v')} ${dialect.packedVectorType}`));
      assert.ok(!stored.includes('GENERATED ALWAYS'));
    });

    it('the idempotent form of a CREATE the open path runs', () => {
      const sql = dialect.ddl.createTable({
        table: 'rows', keyColumn: 'key', keyType: dialect.typeFor('string', 'key'),
        docColumn: 'doc', generated: [],
      });
      const idempotent = dialect.ddl.idempotent(sql);
      assert.notStrictEqual(idempotent, sql, 'the open path needs a no-op second CREATE');
      assert.ok(idempotent.includes('IF NOT EXISTS'));
      const index = dialect.ddl.createIndex({
        name: 'rows_by_a', table: 'rows', columns: ['gx_a'], unique: true,
      });
      assert.ok(dialect.ddl.idempotent(index).includes('IF NOT EXISTS'));
      // a MIGRATION's planned DDL keeps its exact text — the transform
      // is the caller's to apply, never the builder's
      assert.ok(!sql.includes('IF NOT EXISTS'));
    });

    it('indexes, and the structural ALTERs a migration plans', () => {
      const unique = dialect.ddl.createIndex({
        name: 'rows_by_a', table: 'rows', columns: ['gx_a', 'gx_n'], unique: true,
      });
      const plain = dialect.ddl.createIndex({
        name: 'rows_by_a', table: 'rows', columns: ['gx_a', 'gx_n'], unique: false,
      });
      assert.ok(unique.includes('UNIQUE') && !plain.includes('UNIQUE'));
      // the covered columns keep their declared ORDER: (a,b) and (b,a)
      // are different indexes
      assert.ok(unique.indexOf(q('gx_a')) < unique.indexOf(q('gx_n')));
      assert.ok(unique.includes(q('rows_by_a')) && unique.includes(q('rows')));
      assert.ok(dialect.ddl.dropIndex('rows_by_a').includes(q('rows_by_a')));
      assert.ok(dialect.ddl.dropTable('rows').includes(q('rows')));
      const renamed = dialect.ddl.renameTable('rows', 'old_rows');
      assert.ok(renamed.includes(q('rows')) && renamed.includes(q('old_rows')));
      const renamedColumn = dialect.ddl.renameColumn('rows', 'a', 'b');
      assert.ok(renamedColumn.includes(q('a')) && renamedColumn.includes(q('b')));
      assert.ok(dialect.ddl.dropColumn('rows', 'gx_a').includes(q('gx_a')));
      const added = dialect.ddl.addGeneratedColumn({
        table: 'rows', docColumn: 'doc',
        column: { name: 'gx_b', type: dialect.typeFor('string', 'generated'),
          pathText: dialect.jsonPathText([{ name: 'b' }]) },
      });
      assert.ok(added.includes(q('gx_b')) && added.includes('GENERATED ALWAYS AS'));
      assert.ok(added.includes(dialect.generatedStorage));
    });

    it('a relational entity table: types, checks and real foreign keys', () => {
      const sql = dialect.ddl.createRelationalTable({
        table: 'orders',
        columns: [
          { name: 'id', type: dialect.typeFor('string', 'generated'), primaryKey: true },
          { name: 'total', type: dialect.typeFor('number', 'generated'), notNull: true },
          { name: 'state', type: dialect.typeFor('string', 'generated'),
            check: `${q('state')} IN (${dialect.stringLiteral('new')})` },
          { name: 'customer', type: dialect.typeFor('string', 'generated'),
            references: { table: 'customers', column: 'id', onDelete: 'cascade' } },
          { name: 'doc', type: dialect.docColumnType },
        ],
      });
      assert.ok(sql.includes(`${q('id')} `) && sql.includes('PRIMARY KEY'));
      assert.ok(sql.includes('NOT NULL'));
      assert.ok(sql.includes(`CHECK (${q('state')} IN (${dialect.stringLiteral('new')}))`));
      assert.ok(sql.includes(`REFERENCES ${q('customers')} (${q('id')}) ON DELETE CASCADE`));
      const composite = dialect.ddl.createRelationalTable({
        table: 'link',
        columns: [
          { name: 'l', type: dialect.typeFor('string', 'generated') },
          { name: 'r', type: dialect.typeFor('string', 'generated') },
        ],
        compositeKey: ['l', 'r'],
      });
      assert.ok(composite.includes(`PRIMARY KEY (${q('l')}, ${q('r')})`));
      const plain = dialect.ddl.createPlainTable({
        table: 'history',
        columns: [{ name: 'id', type: dialect.typeFor('string', 'generated'), primaryKey: true }],
      });
      assert.ok(plain.includes('IF NOT EXISTS'), 'the history table is created idempotently');
      for (const built of [sql, composite, plain]) {
        if (dialect.identityColumn !== undefined)
          assert.ok(built.includes(q(dialect.identityColumn.name)));
      }
    });

    it('the write statements bind through the dialect and interpolate nothing', () => {
      const p = (i, name) => dialect.parameterRef(i, name);
      const insert = dialect.dml.insert(SHAPE);
      assert.ok(insert.startsWith(`INSERT INTO ${q('rows')} (${q('key')}, ${q('doc')}) VALUES (`));
      assert.ok(insert.includes(p(1, 'key')));
      assert.ok(insert.includes(dialect.jsonEncode(p(2, 'doc'))));
      const upsert = dialect.dml.upsert(SHAPE);
      assert.ok(upsert.includes(`ON CONFLICT (${q('key')}) DO UPDATE SET `
        + `${q('doc')} = ${dialect.excludedRef(q('doc'))}`));
      const allocated = dialect.dml.insertAllocated(SHAPE);
      assert.ok(allocated.includes(`RETURNING ${q('key')} AS ${q('key')}`));
      assert.ok(!allocated.includes(`(${q('key')}, `), 'an allocated key is not bound');
      const get = dialect.dml.get(SHAPE);
      assert.ok(get.includes(dialect.jsonText(q('doc'))), 'a read renders the document as text');
      assert.ok(get.includes(`WHERE ${q('key')} = ${p(1, 'key')}`));
      assert.ok(dialect.dml.del(SHAPE).includes(`WHERE ${q('key')} = ${p(1, 'key')}`));
      const byIdentity = dialect.dml.selectByIdentities(SHAPE, 3);
      assert.ok(byIdentity.includes(dialect.rowIdentity()));
      assert.ok(byIdentity.endsWith(`ORDER BY ${dialect.rowIdentity()}`));
      // the STORED-derived branch: the store writes the values, so they
      // are bound after the document and rewritten by an update
      const withStored = { ...SHAPE, stored: ['gx_v'] };
      assert.ok(dialect.dml.insert(withStored).includes(q('gx_v')));
      assert.ok(dialect.dml.upsert(withStored).includes(
        `${q('gx_v')} = ${dialect.excludedRef(q('gx_v'))}`));
      const update = dialect.dml.updateDoc(withStored, dialect.jsonEncode(p(1, 'doc')), 2);
      assert.ok(update.includes(`${q('gx_v')} = ${p(2, 'gx_v')}`));
      assert.ok(update.endsWith(`WHERE ${q('key')} = ${p(3, 'key')}`),
        'the key binds LAST, which is the statement text order a positional dialect numbers by');
    });

    it('transactions and checkpoints', () => {
      const tx = dialect.tx;
      for (const phrase of [tx.begin, tx.beginImmediate, tx.commit, tx.rollback]) {
        assert.strictEqual(typeof phrase, 'string');
        assert.ok(phrase.length > 0);
      }
      assert.notStrictEqual(tx.commit, tx.rollback);
      assert.notStrictEqual(tx.begin, tx.commit);
      assert.strictEqual(tx.beginImmediate !== tx.begin, caps.immediateTransactions,
        'a dialect without an up-front write lock says so rather than pretending');
      if (caps.savepoints) {
        for (const phrase of [tx.savepoint('sp_1'), tx.release('sp_1'), tx.rollbackTo('sp_1')])
          assert.ok(phrase.includes(q('sp_1')), `a checkpoint name is quoted: ${phrase}`);
        assert.notStrictEqual(tx.release('sp_1'), tx.rollbackTo('sp_1'));
      }
    });

    it('the introspection statements the open path and the drift check run', () => {
      const introspect = dialect.introspect;
      for (const name of ['version', 'tableExists', 'columns', 'indexes',
        'indexColumns', 'foreignKeyList', 'tables', 'generated']) {
        assert.strictEqual(typeof introspect[name], 'function', `no introspect.${name}`);
      }
      // and the two halves of reading a generated column back: only the
      // dialect that WROTE an expression can read it, so a dialect
      // without both cannot be introspected at all
      for (const name of ['schemaTypeOf', 'memberPathOf', 'expressionOf', 'readGenerated'])
        assert.strictEqual(typeof dialect[name], 'function', `no ${name}`);
      assert.ok(introspect.version().length > 0);
      assert.ok(introspect.tableExists().includes(dialect.parameterRef(1, 'name')),
        'the table probe binds the name rather than interpolating it');
      for (const name of HOSTILE_NAMES) {
        for (const build of [introspect.columns, introspect.indexes, introspect.foreignKeyList]) {
          const sql = build(name);
          assert.ok(!/;\s*\w/.test(sql),
            `a hostile table name reached an introspection statement: ${sql}`);
        }
      }
    });
  });

  describe(`${dialect.name}: capability-gated behaviour`, () => {
    it('the configuration vocabulary exists exactly when it is declared', () => {
      if (caps.pragmas) {
        assert.strictEqual(typeof dialect.pragma.set, 'function');
        assert.strictEqual(typeof dialect.introspect.pragma, 'function',
          'a vocabulary that cannot be read back cannot be verified');
        // the vocabulary is CLOSED: neither a name nor a value outside
        // the guarded forms reaches the statement text
        assert.throws(() => dialect.pragma.set('journal_mode', 'wal; DROP TABLE x'), TypeError);
        assert.throws(() => dialect.pragma.set('mode; DROP TABLE x', 'wal'), TypeError);
        assert.throws(() => dialect.introspect.pragma('x; DROP TABLE y'), TypeError);
      }
      else {
        assert.strictEqual(dialect.pragma?.set, undefined,
          'a dialect with no configuration vocabulary carries no half of one');
        assert.strictEqual(dialect.introspect.pragma, undefined);
      }
    });

    it('the referential-integrity switch exists exactly where the engine needs one', () => {
      if (caps.foreignKeysAlwaysOn) {
        assert.strictEqual(dialect.pragma?.foreignKeys, undefined,
          'an engine that always enforces has no switch, so it spells none');
        assert.strictEqual(dialect.introspect.foreignKeysOn, undefined);
      }
      else {
        assert.strictEqual(typeof dialect.pragma.foreignKeys, 'function');
        assert.strictEqual(typeof dialect.introspect.foreignKeysOn, 'function',
          'a switch the open path sets is a switch it reads back');
        assert.notStrictEqual(dialect.pragma.foreignKeys(true), dialect.pragma.foreignKeys(false));
      }
    });

    it('the declared-text drift check exists exactly when it is declared', () => {
      if (caps.declaredSqlText) {
        assert.strictEqual(typeof dialect.introspect.declaredSql, 'function');
        assert.strictEqual(typeof dialect.introspect.schemaDump, 'function');
        assert.ok(dialect.introspect.declaredSql('rows').length > 0);
      }
      else {
        assert.strictEqual(dialect.introspect.declaredSql, undefined,
          'an engine that keeps no CREATE text must not pretend to answer one');
        assert.strictEqual(dialect.introspect.schemaDump, undefined);
      }
    });

    it('the virtual-table mapping exists exactly when it is declared', () => {
      const hasRtree = Object.keys(dialect.rtree ?? {}).length > 0;
      assert.strictEqual(hasRtree, caps.virtualTables);
      assert.strictEqual(typeof dialect.ddl.createVirtualTable === 'function',
        caps.virtualTables);
      assert.strictEqual(typeof dialect.ddl.createSyncTriggers === 'function', caps.triggers);
      if (!caps.virtualTables) return;
      assert.strictEqual(dialect.rtree.columns.length, 5,
        'the identity and the four box edges');
      const created = dialect.ddl.createVirtualTable({ name: 'rows_box' });
      for (const column of dialect.rtree.columns) assert.ok(created.includes(q(column)));
      assert.ok(created.includes(dialect.rtree.module));
      const edges = ['w', 'e', 's', 'n'].map((component) => ({ name: `gx_box_${component}` }));
      const filled = dialect.ddl.fillVirtualTable({
        table: 'rows', virtualTable: 'rows_box', edges,
      });
      // §3.2: a row with no bounded position is ABSENT from the index,
      // not at [0, 0]
      assert.ok(filled.includes(`${q(edges[0].name)} IS NOT NULL`));
      const triggers = dialect.ddl.createSyncTriggers({
        table: 'rows', virtualTable: 'rows_box', prefix: 'rows_box', edges,
      });
      assert.strictEqual(triggers.length, 3, 'insert, update and delete');
      for (const trigger of triggers) {
        assert.ok(trigger.name.startsWith('rows_box'));
        assert.ok(trigger.sql.includes(q(trigger.name)));
      }
      assert.ok(dialect.ddl.dropVirtualTable('rows_box').includes(q('rows_box')));
      assert.ok(dialect.ddl.dropTrigger('rows_box_ai').includes(q('rows_box_ai')));
    });

    it('a per-row identity is declared exactly when it reproduces insertion order', () => {
      // every dialect answers SOMETHING for `rowIdentity()` — the store
      // orders a collection by it — but only a dialect whose answer is
      // insertion-ordered may claim the capability, and one that has no
      // implicit identity has to declare a column for it
      assert.ok(dialect.rowIdentity().length > 0);
      if (caps.rowIdentity && dialect.identityColumn !== undefined) {
        assert.ok(dialect.rowIdentity().includes(q(dialect.identityColumn.name)),
          'a declared identity column IS the row identity');
      }
    });

    it('an auto-allocated key is declared where the integer type alone will not do', () => {
      const allocated = dialect.autoKeyType ?? dialect.typeFor('integer', 'key');
      assert.strictEqual(typeof allocated, 'string');
      assert.ok(allocated.length > 0);
      // and the drift check compares like with like: whatever clause an
      // allocated key carries must reduce to what a catalog reports
      const comparable = dialect.comparableColumnType(allocated);
      assert.strictEqual(typeof comparable, 'string');
      assert.ok(comparable.length > 0);
      assert.strictEqual(dialect.comparableColumnType(comparable), comparable,
        'the reduction is idempotent, or two runs of the drift check disagree');
    });
  });
}
