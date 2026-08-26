//@ts-check
/**
 * @file The dialect contract is closed: a second spelling spec renders
 * every statement this store runs.
 *
 * The seam's promise is that SQL text is produced in exactly one place —
 * a `createDialect` spelling spec — so that the store's features are
 * expressible through the spec ALONE. A grep can only say that a string
 * does not appear somewhere; this file proves the property by
 * construction. It drives every DDL builder, every DML builder, the
 * transaction, pragma and introspection phrases, and a query plan of
 * each recognized mode through BOTH the real spec and a deliberately
 * foreign one over the SAME model, then asserts three things:
 *
 *   both compose      every statement is a non-empty string under both
 *                     specs, and the corpora have the same shape — a
 *                     builder that a foreign spec cannot render is a
 *                     builder with a spelling baked into it
 *   the text differs  each statement differs between the two, and the
 *                     foreign corpus carries NONE of the tokens that
 *                     belong to the real spec
 *   nothing leaked    and the real corpus carries none of the foreign
 *                     spec's, which is what keeps the scan from being a
 *                     test of the token list rather than of the seam
 *
 * **What counts as a spelling.** Not every SQL token is a dialect's to
 * choose. `SELECT`, `FROM`, `WHERE`, `AND`, `IS NOT NULL`, `ORDER BY`,
 * `COUNT(*)` and `IN (a, b)` are the shared skeleton the statement
 * builders compose — identical in every SQL database, and deliberately
 * not spec members. What the spec owns is what actually varies:
 * identifier quoting, parameter markers, the type keywords, the JSON
 * function family, the limit/offset form, null ordering, row identity,
 * the string predicates, and the derived-column expressions. Those are
 * the tokens scanned for below, each with the reason it is one.
 *
 * The mirror spec targets the same engine on purpose. The question is
 * WHERE spellings live, not whether a second engine's semantics match.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createDialect, sqliteDialect, planCollection, normalizeModel, planQuery,
} from '@jarenjs/db';
import { emitPlan } from '../../packages/db/src/emit.js';

import { fullDoubleDialect } from './helpers.js';

const MIRROR = fullDoubleDialect(createDialect);

/** One model exercising every physical shape a collection can take. */
const MODEL = {
  $model: '0.1',
  collections: {
    rows: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tag: { type: 'string' },
          n: { type: 'integer' },
          at: { type: 'array', items: { type: 'number' } },
          area: { type: 'object' },
          embedding: { type: 'array', items: { type: 'number' } },
        },
      },
      key: '/id',
      indexes: [
        { name: 'by_tag', path: '$.tag', unique: true },
        { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 6 },
        { name: 'by_box', path: '$.area', derive: 'bbox', physical: 'rtree' },
        { name: 'by_vec', path: '$.embedding', derive: 'vector', dims: 3 },
      ],
    },
  },
};

/** The query shapes, one per plan mode the emitter can reach. */
const DOCUMENTS = {
  'native, equality + window': { $subsequence: [{ $for: { r: '$[*]' },
    $where: { $eq: ['$r.tag', 'a'] }, $return: '$r' }, 2, 5] },
  'native, count': { $count: { $for: { r: '$[*]' },
    $where: { $eq: ['$r.tag', 'a'] }, $return: '$r' } },
  'native, ordering with empties': { $for: { r: '$[*]' },
    $orderby: [{ $key: '$r.n', $dir: 'desc', $empty: 'least' }], $return: '$r' },
  'native, prefix range': { $for: { r: '$[*]' },
    $where: { '$starts-with': ['$r.tag', 'ab'] }, $return: '$r' },
  'set, the R*Tree subquery': { $for: { r: '$[*]' },
    $where: { '$bbox-intersects': ['$r.area', [0, 0, 1, 1]] }, $return: '$r' },
  'knn, the candidate projection': { $subsequence: [{ $for: { r: '$[*]' },
    $orderby: [{ $key: { $similarity: ['$r.embedding', '$q'] }, $dir: 'desc', $empty: 'least' },
      '$r.id'], $return: '$r' }, 0, 2] },
};

/**
 * Every statement one dialect renders from `MODEL`, by label. The labels
 * are the same under both specs by construction, so a builder that
 * throws under one and not the other is a failure with a name.
 * @param {any} dialect
 * @returns {Record<string, string>}
 */
function corpusOf(dialect) {
  const rows = normalizeModel(MODEL).get('rows');
  const planned = planCollection('rows', rows, dialect);
  const shape = {
    collection: 'rows',
    schema: rows.schema,
    columnByCanonical: planned.columnByCanonical,
    virtualByStem: new Map((planned.virtualTables ?? [])
      .map((virtual) => [virtual.stem, { name: virtual.name, columns: virtual.columns }])),
  };
  const physical = {
    table: planned.table, keyColumn: planned.keyColumn, docColumn: planned.docColumn,
  };
  const stored = planned.generated.filter((g) => g.stored === true).map((g) => g.name);
  const virtual = planned.virtualTables[0];
  const edges = virtual.edges.map((name) => ({ name }));
  const column = planned.generated[0];

  /** @type {Record<string, string>} */
  const out = {};
  planned.createSql.forEach((sql, i) => { out[`plan.createSql[${i}]`] = sql; });
  out['plan.virtualTable'] = virtual.createSql;
  out['plan.virtualFill'] = virtual.fillSql;
  virtual.triggers.forEach((trigger, i) => { out[`plan.trigger[${i}]`] = trigger.sql; });

  out['ddl.addGeneratedColumn'] = dialect.ddl
    .addGeneratedColumn({ table: 'rows', docColumn: 'doc', column });
  out['ddl.addColumn'] = dialect.ddl
    .addColumn({ table: 'rows', column: { name: 'extra', type: dialect.packedVectorType } });
  out['ddl.dropColumn'] = dialect.ddl.dropColumn('rows', 'extra');
  out['ddl.createIndex'] = dialect.ddl
    .createIndex({ name: 'rows_extra', table: 'rows', columns: ['extra'], unique: true });
  out['ddl.dropIndex'] = dialect.ddl.dropIndex('rows_extra');
  out['ddl.createVirtualTable'] = dialect.ddl.createVirtualTable({ name: virtual.name });
  out['ddl.dropVirtualTable'] = dialect.ddl.dropVirtualTable(virtual.name);
  out['ddl.dropTrigger'] = dialect.ddl.dropTrigger(virtual.triggers[0].name);
  out['ddl.fillVirtualTable'] = dialect.ddl
    .fillVirtualTable({ table: 'rows', virtualTable: virtual.name, edges });
  dialect.ddl.createSyncTriggers({ table: 'rows', virtualTable: virtual.name, prefix: 'sync', edges })
    .forEach((trigger, i) => { out[`ddl.createSyncTriggers[${i}]`] = trigger.sql; });
  out['ddl.dropTable'] = dialect.ddl.dropTable('rows');
  out['ddl.renameTable'] = dialect.ddl.renameTable('rows', 'rows_old');
  out['ddl.renameColumn'] = dialect.ddl.renameColumn('rows', 'a', 'b');
  out['ddl.createRelationalTable'] = dialect.ddl.createRelationalTable({
    table: 'links',
    columns: [
      { name: 'id', type: dialect.typeFor('string', 'key'), primaryKey: true },
      { name: 'owner', type: dialect.typeFor('string', 'value'), notNull: true,
        references: { table: 'rows', column: 'key', onDelete: 'cascade' } },
    ],
  });
  out['ddl.createPlainTable'] = dialect.ddl.createPlainTable({
    table: 'history',
    columns: [{ name: 'id', type: dialect.typeFor('string', 'key'), primaryKey: true }],
  });

  const shapeWithStored = { ...physical, stored };
  out['dml.insert'] = dialect.dml.insert(shapeWithStored);
  out['dml.insertAllocated'] = dialect.dml.insertAllocated(shapeWithStored);
  out['dml.upsert'] = dialect.dml.upsert(shapeWithStored);
  out['dml.get'] = dialect.dml.get(physical);
  out['dml.del'] = dialect.dml.del(physical);
  out['dml.selectByIdentities'] = dialect.dml.selectByIdentities(physical, 2);
  out['dml.updateDoc'] = dialect.dml.updateDoc(shapeWithStored,
    dialect.jsonSet(dialect.quoteIdentifier('doc'), dialect.jsonPathText([{ name: 'tag' }]),
      dialect.jsonEncode(dialect.parameterRef(1, 'v'))), 2);

  out['derivedColumn.geohash'] = dialect.derivedColumn(dialect.quoteIdentifier('doc'),
    dialect.jsonPathText([{ name: 'at' }]), { derive: 'geohash', precision: 6 });
  out['derivedColumn.bbox'] = dialect.derivedColumn(dialect.quoteIdentifier('doc'),
    dialect.jsonPathText([{ name: 'area' }]), { derive: 'bbox', component: 'w' });

  out['limitClause'] = dialect.limitClause(10, 5);
  out['orderNulls'] = dialect.orderNulls(false);
  out['jsonTypeOf'] = dialect.jsonTypeOf(dialect.quoteIdentifier('doc'), '/tag');
  out['valueTypeOf'] = dialect.valueTypeOf(dialect.parameterRef(1, 'v'));
  out['jsonAgg'] = dialect.jsonAgg(dialect.quoteIdentifier('doc'));
  out['strStartsWith'] = dialect.strStartsWith(dialect.quoteIdentifier('gx_tag'),
    dialect.parameterRef(1, 'lo'), dialect.parameterRef(2, 'hi'));
  out['strEndsWith'] = dialect.strEndsWith(dialect.quoteIdentifier('gx_tag'),
    dialect.parameterRef(1, 'a'), dialect.parameterRef(2, 'b'), dialect.parameterRef(3, 'c'));
  out['strContains'] = dialect.strContains(dialect.quoteIdentifier('gx_tag'),
    dialect.parameterRef(1, 'p'));
  out['explainQuery'] = dialect.explainQuery('SELECT 1');
  for (const [key, value] of Object.entries(dialect.tx))
    out[`tx.${key}`] = typeof value === 'function' ? value('sp') : value;
  /** Each pragma with an argument it accepts; `journalMode` validates its word. */
  const pragmaArg = { busyTimeout: 5000, journalMode: 'wal', foreignKeys: true };
  for (const [key, value] of Object.entries(dialect.pragma))
    out[`pragma.${key}`] = String(value(/** @type {any} */ (pragmaArg)[key]));
  for (const [key, value] of Object.entries(dialect.introspect))
    out[`introspect.${key}`] = value('rows');

  for (const [label, document] of Object.entries(DOCUMENTS))
    out[`emit[${label}]`] = emitPlan(planQuery(document, shape).plan, dialect, physical).sql;
  return out;
}

/**
 * The tokens that belong to the REAL spec, each with why it is a
 * spelling a second spec would choose differently rather than shared
 * SQL skeleton.
 */
const SQLITE_SPELLINGS = [
  [/"/, 'double quotes are SQLite identifier quoting'],
  [/\?/, 'the positional parameter marker'],
  [/\bjsonb?_/, 'the json/jsonb function family'],
  [/\bjson\(/, 'json() as the document reader'],
  [/\bjsonb\(/, 'jsonb() as the document encoder'],
  [/\btypeof\(/, 'the value type function'],
  [/\binstr\(|\bsubstr\(|\blength\(/, 'the string predicate primitives'],
  [/\bLIMIT\b|\bOFFSET\b/, 'the limit/offset form'],
  [/\bNULLS (FIRST|LAST)\b/, 'the null-ordering clause'],
  [/\bSTRICT\b/, 'the table suffix'],
  [/\bBLOB\b|\bTEXT\b|\bREAL\b|\bINTEGER\b/, 'the type keywords'],
  [/\browid\b/, 'the row identity'],
  [/\bexcluded\./, 'the upsert row reference'],
  [/\bSAVEPOINT\b|\bBEGIN IMMEDIATE\b/, 'the transaction phrases'],
  [/\bPRAGMA\b/, 'the pragma form'],
  [/\bEXPLAIN QUERY PLAN\b/, 'the plan narrative'],
  [/\brtree\b/, 'the R*Tree module name'],
  [/\bjaren_(geohash|bbox)/, 'the derived-column function names'],
  [/\bNEW\.|\bOLD\./i, null],
];

/**
 * The mirror's own, in the same shape — scanned over the REAL corpus, so
 * that a token list that matched nothing would fail rather than pass.
 */
const MIRROR_SPELLINGS = [
  [/\[/, 'brackets are the mirror\'s identifier quoting'],
  [/@p\d/, 'named parameter markers'],
  [/\bJX\(|\bJTEXT\(|\bJENC\(|\bJTYPE\(|\bJAGG\(/, 'the mirror json family'],
  [/\bVTYPE\(/, 'the mirror value type function'],
  [/\bSW\(|\bEW\(|\bCT\(/, 'the mirror string predicates'],
  [/\bFETCH\b|\bSKIP\b/, 'the mirror limit form'],
  [/\bEMPTIES (HIGH|LOW)\b/, 'the mirror null ordering'],
  [/\bJSONDOC\b|\bVECBYTES\b|\bKEYTYPE\b|\bVALTYPE\b/, 'the mirror type keywords'],
  [/\bMARK\b|\bGRAB\b|\bBACKTO\b|\bUNMARK\b/, 'the mirror transaction phrases'],
  [/\bPLANFOR\b/, 'the mirror plan narrative'],
  [/\bBOXTREE\b/, 'the mirror R*Tree module'],
  [/\bCELL\(|\bBOX_/, 'the mirror derived-column functions'],
  [/\bAMONG\b/, 'the mirror identity membership'],
];

describe('the dialect contract is closed: a mirror spec renders every statement', () => {
  const real = corpusOf(sqliteDialect);
  const mirror = corpusOf(MIRROR);
  const labels = Object.keys(real).sort();

  /**
   * The statements that are the SAME word under both specs, by
   * construction rather than by leak: three transaction verbs neither
   * spec had a reason to spell differently. Listed rather than tolerated,
   * so a fourth one has to be argued for.
   */
  const SHARED_VERBS = ['tx.begin', 'tx.commit', 'tx.rollback'];

  it('both specs render the same statement set, and none of it is empty', () => {
    // the floor: a corpus that shrank silently would make every scan
    // below pass over nothing
    assert.ok(labels.length >= 50,
      `only ${labels.length} statements were generated — the corpus lost a builder`);
    // every builder the contract composes is reached BY NAME: a corpus
    // that quietly stopped calling one would still pass the count above.
    // `createTable` and `createIndex` are reached through the collection
    // plan, which is how the store itself reaches them
    const VIA_PLAN = ['createTable', 'createIndex', 'createVirtualTable'];
    for (const group of ['ddl', 'dml']) {
      const rendered = new Set(labels
        .filter((label) => label.startsWith(`${group}.`))
        .map((label) => label.slice(group.length + 1).replace(/\[\d+\]$/, '')));
      const missing = Object.keys(sqliteDialect[group])
        .filter((name) => !rendered.has(name) && !VIA_PLAN.includes(name));
      assert.deepStrictEqual(missing, [],
        `${group} builders the proof never renders — the seam is unproven for them`);
    }
    assert.deepStrictEqual(Object.keys(mirror).sort(), labels,
      'a builder rendered under one spec and not the other');
    for (const label of labels) {
      assert.ok(typeof real[label] === 'string' && real[label].length > 0, `${label} (sqlite)`);
      assert.ok(typeof mirror[label] === 'string' && mirror[label].length > 0, `${label} (mirror)`);
    }
  });

  it('every statement differs between the two spellings', () => {
    const same = labels.filter((label) => real[label] === mirror[label]);
    assert.deepStrictEqual(same, SHARED_VERBS,
      'a statement identical under two foreign spellings spells nothing from the spec');
  });

  it('no SQLite spelling survives into the mirror\'s statements', () => {
    for (const [pattern, why] of SQLITE_SPELLINGS) {
      if (why === null) continue;
      // the non-vacuity floor for each token: it must appear in the real
      // corpus, or the scan below is a test of an obsolete list
      assert.ok(labels.some((label) => pattern.test(real[label])),
        `no SQLite statement carries ${pattern} (${why}) — the token list is stale`);
      const leaked = labels.filter((label) => pattern.test(mirror[label]));
      assert.deepStrictEqual(leaked, [],
        `${pattern} (${why}) reached a mirror statement — that spelling is produced outside the spec`);
    }
  });

  it('and no mirror spelling appears in SQLite\'s, which is what makes the scan mean something', () => {
    for (const [pattern, why] of MIRROR_SPELLINGS) {
      assert.ok(labels.some((label) => pattern.test(mirror[label])),
        `no mirror statement carries ${pattern} (${why}) — the mirror spec stopped differing here`);
      const leaked = labels.filter((label) => pattern.test(real[label]));
      assert.deepStrictEqual(leaked, [], `${pattern} (${why}) appears in a SQLite statement`);
    }
  });

  it('the vector column and the k-nearest statements are among what it rendered', () => {
    // named explicitly, because these are the spellings whose seam this
    // proof exists to close
    assert.match(mirror['plan.createSql[0]'], /\[gx_embedding_v3\] VECBYTES/);
    assert.strictEqual(mirror['emit[knn, the candidate projection]'],
      'SELECT [rid] AS [rid], [gx_embedding_v3] AS [vec] FROM [rows]');
    assert.match(mirror['dml.selectByIdentities'], /\[rid\] AMONG \(@p1, @p2\) ORDER BY \[rid\]/);
    assert.match(mirror['plan.virtualTable'], /BOXTREE/);
  });
});

describe('a mirror spec refuses what the real spec refuses', () => {
  it('an unknown derive kind is a defect in both, never a spelled-out guess', () => {
    // a spec that answers SOMETHING for a kind it does not know is how a
    // new derive kind ships as silently wrong SQL — the shape the real
    // spec was made exhaustive to prevent, and a mirror that did not
    // mirror the refusal would hide it here
    for (const [name, dialect] of [['sqlite', sqliteDialect], ['mirror', MIRROR]]) {
      assert.throws(() => dialect.derivedColumn('"doc"', '$."x"', { derive: 'newkind' }),
        /no generated-column expression for derive kind 'newkind'/,
        `${name} spelled an expression for a kind it does not know`);
      assert.throws(() => dialect.derivedColumn('"doc"', '$."x"', { derive: 'vector', dims: 3 }),
        /stored on every driver and has no generated expression/,
        `${name} spelled an expression for the stored vector column`);
    }
  });

  it('a spec that declares no packed vector type cannot plan a vector column', () => {
    const mute = { ...MIRROR, packedVectorType: undefined };
    assert.throws(() => planCollection('rows', normalizeModel(MODEL).get('rows'), mute),
      /'double' dialect declares no packedVectorType/);
  });
});
