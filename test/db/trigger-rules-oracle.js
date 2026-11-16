//@ts-check
/**
 * @file The oracle for SQLite triggers read back as database rules: neutral
 * schemas whose hand-written triggers are each one family the reader maps,
 * a seeded stream of writes over them, and the run that replays the stream
 * on the original database and on a database that holds the rules the
 * original read back as, comparing which writes each refuses and what the
 * tables hold after every write.
 */
import { introspectModel, planInvariants } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { sqliteTriggers } from '@jarenjs/db/trigger-rules';

/** Every family the reader maps, each on tables of its own. Each fixture names its tables, the
 * values the stream writes into each column, and the SQL that creates them on each engine. */
export const TRIGGER_FIXTURES = [
  {
    name: 'same-row and UPDATE OF guards',
    sqlite: 'CREATE TABLE documents(id INTEGER PRIMARY KEY, status TEXT NOT NULL, title TEXT, sealed_at TEXT, owner_id INTEGER, active INTEGER NOT NULL)',
    postgres: 'CREATE TABLE documents(id integer PRIMARY KEY, status text NOT NULL, title text, sealed_at text, owner_id integer, active integer NOT NULL)',
    triggers: [
      "CREATE TRIGGER documents_final BEFORE UPDATE ON documents WHEN OLD.status <> 'draft' AND NOT (OLD.active = 1 AND NEW.active = 0) BEGIN SELECT RAISE(ABORT, 'final documents are immutable'); END",
      "CREATE TRIGGER documents_keep_final AFTER DELETE ON documents WHEN OLD.status IN ('final', 'sealed') BEGIN SELECT RAISE(ABORT, 'final documents are kept'); END",
      "CREATE TRIGGER documents_seal_once BEFORE UPDATE OF sealed_at ON documents WHEN OLD.sealed_at IS NOT NULL OR NEW.sealed_at IS NULL BEGIN SELECT RAISE(ABORT, 'a document is sealed once'); END",
      "CREATE TRIGGER documents_owner AFTER INSERT ON documents BEGIN SELECT RAISE(ABORT, 'an owner is positive and a title not empty') WHERE NEW.owner_id <= 0 OR NOT (NEW.title <> '') OR NEW.sealed_at <> '2026-01-01'; END",
      'CREATE TRIGGER documents_title BEFORE UPDATE OF title, owner_id ON documents WHEN NEW.title IS NOT OLD.title AND OLD.title IS NOT NULL AND NEW.owner_id IS OLD.owner_id BEGIN SELECT RAISE(ABORT, \'a title is set once\'); END',
    ],
    tables: { documents: { key: ['id'], values: { id: [1, 2, 3, 4, 5], status: ['draft', 'final', 'sealed'], title: [null, '', 'a', 'b'],
      sealed_at: [null, '2026-01-01', '2026-02-01'], owner_id: [null, -1, 0, 3], active: [0, 1] } } },
  },
  {
    name: 'cross-table guards',
    sqlite: 'CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT NOT NULL, sealed_at TEXT, code TEXT NOT NULL); CREATE UNIQUE INDEX orders_code ON orders(code); '
      + 'CREATE TABLE lines(id INTEGER PRIMARY KEY, order_id INTEGER, qty INTEGER NOT NULL, order_code TEXT)',
    postgres: 'CREATE TABLE orders(id integer PRIMARY KEY, status text NOT NULL, sealed_at text, code text NOT NULL); CREATE UNIQUE INDEX orders_code ON orders(code); '
      + 'CREATE TABLE lines(id integer PRIMARY KEY, order_id integer, qty integer NOT NULL, order_code text)',
    triggers: [
      "CREATE TRIGGER lines_draft_insert BEFORE INSERT ON lines WHEN (SELECT status FROM orders WHERE id = NEW.order_id) <> 'draft' BEGIN SELECT RAISE(ABORT, 'a line is added to a draft order'); END",
      "CREATE TRIGGER lines_draft_update BEFORE UPDATE ON lines WHEN (SELECT status FROM orders WHERE id = OLD.order_id) <> 'draft' OR (SELECT status FROM orders WHERE id = NEW.order_id) <> 'draft' BEGIN SELECT RAISE(ABORT, 'a line changes on a draft order'); END",
      "CREATE TRIGGER lines_draft_delete BEFORE DELETE ON lines WHEN 'draft' <> (SELECT status FROM orders WHERE id = OLD.order_id) BEGIN SELECT RAISE(ABORT, 'a line leaves a draft order'); END",
      'CREATE TRIGGER lines_unsealed BEFORE INSERT ON lines WHEN (SELECT sealed_at FROM orders WHERE id = NEW.order_id) IS NOT NULL BEGIN SELECT RAISE(ABORT, \'a sealed order takes no lines\'); END',
      'CREATE TRIGGER lines_code AFTER UPDATE OF order_code ON lines WHEN NEW.order_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders WHERE code = NEW.order_code) BEGIN SELECT RAISE(ABORT, \'an order code names an order\'); END',
      "CREATE TRIGGER orders_append_only BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'orders are kept'); END",
    ],
    tables: {
      orders: { key: ['id'], values: { id: [1, 2, 3, 4], status: ['draft', 'final'], sealed_at: [null, '2026-03-01'], code: ['a', 'b', 'c', 'd', 'e'] } },
      lines: { key: ['id'], values: { id: [1, 2, 3, 4, 5, 6], order_id: [null, 1, 2, 3, 4, 9], qty: [0, 1, 2], order_code: [null, 'a', 'b', 'c', 'z'] } },
    },
  },
  {
    name: 'probes by a non-unique index, lists and an unconditional UPDATE OF',
    sqlite: 'CREATE TABLE rooms(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, open INTEGER NOT NULL); CREATE INDEX rooms_kind ON rooms(kind); '
      + 'CREATE TABLE bookings(id INTEGER PRIMARY KEY, room_kind TEXT NOT NULL, nights INTEGER NOT NULL, note TEXT)',
    postgres: 'CREATE TABLE rooms(id integer PRIMARY KEY, kind text NOT NULL, open integer NOT NULL); CREATE INDEX rooms_kind ON rooms(kind); '
      + 'CREATE TABLE bookings(id integer PRIMARY KEY, room_kind text NOT NULL, nights integer NOT NULL, note text)',
    triggers: [
      "CREATE TRIGGER bookings_open_kind AFTER INSERT ON bookings WHEN NOT EXISTS (SELECT 1 FROM rooms WHERE kind = NEW.room_kind AND open = 1) BEGIN SELECT RAISE(ABORT, 'no open room of that kind'); END",
      "CREATE TRIGGER bookings_nights BEFORE UPDATE ON bookings WHEN NEW.nights NOT IN (1, 2, 3, 7) OR NEW.nights < OLD.nights OR NEW.note IN ('x', 'y') BEGIN SELECT RAISE(ABORT, 'nights only grow'); END",
      "CREATE TRIGGER rooms_kind_fixed BEFORE UPDATE OF kind ON rooms BEGIN SELECT RAISE(ABORT, 'a room keeps its kind'); END",
      "CREATE TRIGGER bookings_kept BEFORE DELETE ON bookings BEGIN SELECT RAISE(ABORT, 'bookings are kept'); END",
    ],
    tables: {
      rooms: { key: ['id'], values: { id: [1, 2, 3, 4], kind: ['single', 'double', 'suite'], open: [0, 1] } },
      bookings: { key: ['id'], values: { id: [1, 2, 3, 4, 5], room_kind: ['single', 'double', 'suite', 'attic'], nights: [1, 2, 3, 5, 7], note: [null, 'x', 'z'] } },
    },
  },
  {
    name: 'revision bumps',
    sqlite: 'CREATE TABLE counters(id INTEGER PRIMARY KEY, label TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0); '
      + 'CREATE TABLE stock(site TEXT NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (site, sku))',
    postgres: 'CREATE TABLE counters(id integer PRIMARY KEY, label text NOT NULL, revision integer NOT NULL DEFAULT 0); '
      + 'CREATE TABLE stock(site text NOT NULL, sku text NOT NULL, qty integer NOT NULL, revision integer NOT NULL DEFAULT 0, PRIMARY KEY (site, sku))',
    triggers: [
      'CREATE TRIGGER counters_bump AFTER UPDATE ON counters WHEN NEW.revision = OLD.revision BEGIN UPDATE counters SET revision = OLD.revision + 1 WHERE id = NEW.id; END',
      "CREATE TRIGGER counters_label BEFORE UPDATE OF label ON counters WHEN NEW.label = '' BEGIN SELECT RAISE(ABORT, 'a label is not empty'); END",
      'CREATE TRIGGER stock_bump AFTER UPDATE ON stock WHEN OLD.revision IS NEW.revision BEGIN UPDATE stock SET revision = OLD.revision + 1 WHERE sku = NEW.sku AND site = NEW.site; END',
      "CREATE TRIGGER stock_count BEFORE INSERT ON stock WHEN NEW.qty < 0 BEGIN SELECT RAISE(ABORT, 'stock is counted'); END",
    ],
    tables: {
      counters: { key: ['id'], values: { id: [1, 2, 3], label: ['', 'a', 'b'], revision: [0, 1, 5] } },
      stock: { key: ['site', 'sku'], values: { site: ['n', 's'], sku: ['p', 'q'], qty: [-1, 0, 4], revision: [0, 2] } },
    },
  },
];

/** A bump beside another UPDATE trigger, whose own UPDATE fires that trigger again: the bump stays a
 * trigger and the guard is read back, so the database the rules are installed in keeps the bump. */
export const KEPT_TRIGGER_FIXTURE = {
  name: 'a bump kept beside a guard read back',
  sqlite: 'CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0)',
  triggers: [
    'CREATE TRIGGER notes_bump AFTER UPDATE ON notes WHEN NEW.revision = OLD.revision BEGIN UPDATE notes SET revision = OLD.revision + 1 WHERE id = NEW.id; END',
    "CREATE TRIGGER notes_locked BEFORE UPDATE ON notes WHEN OLD.locked = 1 BEGIN SELECT RAISE(ABORT, 'a locked note is kept'); END",
  ],
  tables: { notes: { key: ['id'], values: { id: [1, 2, 3], body: ['a', 'b'], locked: [0, 1], revision: [0, 3] } } },
};

/** A seeded generator: the same seed writes the same stream. @param {number} seed */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value as SQL both engines read alike. @param {any} value */
const sqlValue = (value) => (value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`);

/**
 * The stream: inserts (a missing parent's key and NULLs among the values),
 * updates of one or two columns, same-value updates, updates and deletes of
 * several rows at once, and deletes — each a statement both engines run.
 * @param {any} fixture @param {number} seed @param {number} length @returns {string[]}
 */
export function writeStream(fixture, seed, length) {
  const next = random(seed);
  /** @param {any[]} values */
  const pick = (values) => values[Math.floor(next() * values.length)];
  const tables = Object.entries(fixture.tables);
  const writes = [];
  for (let i = 0; i < length; i++) {
    const [table, { key, values }] = pick(tables);
    const columns = Object.keys(values);
    const where = () => key.map((/** @type {string} */ column) => `${column} = ${sqlValue(pick(values[column]))}`).join(' AND ');
    const roll = next();
    if (roll < 0.4) writes.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => sqlValue(pick(values[column]))).join(', ')})`);
    else if (roll < 0.75) {
      const set = [...new Set([pick(columns), pick(columns)])].filter((column) => !key.includes(column) || next() < 0.2);
      if (set.length === 0) set.push(columns.find((column) => !key.includes(column)));
      writes.push(`UPDATE ${table} SET ${set.map((column) => `${column} = ${sqlValue(pick(values[column]))}`).join(', ')} WHERE ${where()}`);
    }
    else if (roll < 0.85) {
      const column = pick(columns.filter((name) => !key.includes(name)));
      writes.push(`UPDATE ${table} SET ${column} = ${column} WHERE ${where()}`);
    }
    else if (roll < 0.9) {
      const column = pick(columns.filter((name) => !key.includes(name)));
      writes.push(`UPDATE ${table} SET ${column} = ${sqlValue(pick(values[column]))} WHERE ${key[0]} IN (${sqlValue(pick(values[key[0]]))}, ${sqlValue(pick(values[key[0]]))})`);
    }
    else if (roll < 0.95) writes.push(`DELETE FROM ${table} WHERE ${where()}`);
    else writes.push(`DELETE FROM ${table} WHERE ${key[0]} IN (${sqlValue(pick(values[key[0]]))}, ${sqlValue(pick(values[key[0]]))})`);
  }
  return writes;
}

/** A write's outcome: it went through, or it was refused, with the refusal's message.
 * @param {() => Promise<unknown>} write @returns {Promise<{ refused: boolean, message: string }>} */
async function outcome(write) {
  try { await write(); return { refused: false, message: '' }; }
  catch (error) { return { refused: true, message: String(/** @type {any} */ (error)?.message) }; }
}

/** What every table of the fixture holds, in key order. @param {any} fixture @param {(sql: string) => Promise<any[]>} all */
async function contents(fixture, all) {
  const out = [];
  for (const [table, { key }] of Object.entries(fixture.tables)) {
    const rows = await all(`SELECT * FROM ${table} ORDER BY ${key.join(', ')}`);
    out.push(`${table}:${JSON.stringify(rows.map((row) => Object.keys(row).sort().map((column) => row[column])))}`);
  }
  return out.join('\n');
}

/**
 * The original: a SQLite database holding the fixture's tables and its
 * hand-written triggers, and the model and report `introspectModel` reads
 * off it with the SQLite trigger reader.
 * @param {any} fixture @returns {Promise<{ connection: any, model: any, report: readonly any[] }>}
 */
export async function original(fixture) {
  const connection = await nodeDriver().open(':memory:');
  connection.exec(fixture.sqlite);
  for (const sql of fixture.triggers) connection.exec(sql);
  const { model, report } = await introspectModel(connection, { triggers: sqliteTriggers });
  return { connection, model, report };
}

/**
 * Replay one stream on the original and on a subject that holds the rules
 * read back (a fresh database of the fixture's tables, the statements
 * `planInvariants` plans for the model installed in it, and every trigger
 * that was not read back as it was); the first write where the two refuse
 * differently or leave the tables holding different rows ends the run.
 * @param {any} fixture @param {any} engine - `sqliteEngine()` or `postgresEngine()` of the rule oracle
 * @param {string[]} writes
 * @returns {Promise<{ writes: number, refused: number, byTrigger: Record<string, number>,
 *   divergence: null | { at: number, sql: string, original: string, subject: string } }>}
 */
export async function differential(fixture, engine, writes) {
  const source = await original(fixture);
  const subject = await engine.fixture({ sqlite: fixture.sqlite, postgres: fixture.postgres });
  try {
    for (const statement of planInvariants(source.model, { dialect: subject.dialect })) await subject.exec(statement.sql);
    const kept = new Set(source.report.filter((row) => row.code === 'unmapped-object').map((row) => row.object));
    for (const sql of fixture.triggers) if ([...kept].some((name) => sql.startsWith(`CREATE TRIGGER ${name} `))) await subject.exec(sql);
    const all = (/** @type {string} */ sql) => Promise.resolve(source.connection.prepare(sql).all([]));
    // the trigger each message names, so a stream that never meets a trigger shows it
    const messages = new Map(fixture.triggers.map((/** @type {string} */ sql) => [/RAISE\(ABORT, '([^']*)'\)/.exec(sql)?.[1],
      /^CREATE TRIGGER (\w+)/.exec(sql)?.[1]]));
    /** @type {Record<string, number>} */
    const byTrigger = {};
    let refused = 0;
    for (let i = 0; i < writes.length; i++) {
      const a = await outcome(async () => source.connection.exec(writes[i]));
      const b = await outcome(() => subject.exec(writes[i]));
      if (a.refused) refused++;
      const trigger = messages.get(a.message);
      if (trigger !== undefined) byTrigger[trigger] = (byTrigger[trigger] ?? 0) + 1;
      const left = await contents(fixture, all), right = await contents(fixture, subject.all);
      if (a.refused !== b.refused || left !== right) return { writes: i + 1, refused, byTrigger,
        divergence: { at: i, sql: writes[i], original: `${a.message}\n${left}`, subject: `${b.message}\n${right}` } };
    }
    return { writes: writes.length, refused, byTrigger, divergence: null };
  }
  finally {
    source.connection.close();
    await subject.dispose();
  }
}
