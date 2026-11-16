//@ts-check
/**
 * @file The triggers the SQLite reader leaves unmapped, each with the first
 * construct it does not map: one trigger at a time over the same neutral
 * tables, so each reason is the trigger's own.
 */

/** The tables every negative trigger is created over. */
export const NEGATIVE_TABLES = [
  'CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT NOT NULL, sealed_at TEXT, code TEXT NOT NULL)',
  'CREATE UNIQUE INDEX orders_code ON orders(code)',
  'CREATE TABLE lines(id INTEGER PRIMARY KEY, order_id INTEGER, qty INTEGER NOT NULL, note TEXT)',
  'CREATE TABLE rooms(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, open INTEGER NOT NULL)',
  'CREATE INDEX rooms_kind ON rooms(kind)',
  'CREATE TABLE tags(id INTEGER PRIMARY KEY, label TEXT NOT NULL COLLATE NOCASE)',
  'CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, weight NUMERIC)',
  'CREATE TABLE audit(id INTEGER PRIMARY KEY, line_id INTEGER, operation TEXT)',
  'CREATE TABLE parcels(key TEXT PRIMARY KEY, doc BLOB NOT NULL)',
  'CREATE VIEW open_orders AS SELECT * FROM orders WHERE status = \'draft\'',
].join(';\n');

const raise = "BEGIN SELECT RAISE(ABORT, 'refused'); END";

/** Each negative shape: a label, its CREATE text and the reason it keeps.
 * @type {[string, string, string][]} */
export const NEGATIVE_TRIGGERS = [
  ['an aggregate over other rows', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN (SELECT count(*) FROM lines WHERE order_id = NEW.order_id) >= 10 ${raise}`,
    'an aggregate over other rows'],
  ['a probe of its own table', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN EXISTS (SELECT 1 FROM lines WHERE order_id = NEW.order_id) ${raise}`,
    'a probe of the trigger\'s own table'],
  ['two statements', "CREATE TRIGGER t BEFORE INSERT ON lines BEGIN SELECT RAISE(ABORT, 'a') WHERE NEW.qty < 0; SELECT RAISE(ABORT, 'b') WHERE NEW.qty > 9; END",
    'a trigger program with more than one statement'],
  ['a bump in a BEFORE trigger', 'CREATE TRIGGER t BEFORE UPDATE ON notes WHEN NEW.revision = OLD.revision BEGIN UPDATE notes SET revision = OLD.revision + 1 WHERE id = NEW.id; END',
    'an UPDATE in a BEFORE UPDATE trigger'],
  ['an INSTEAD OF trigger on a view', `CREATE TRIGGER t INSTEAD OF DELETE ON open_orders ${raise}`, 'an INSTEAD OF trigger, which writes a view'],
  ['a function', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN length(NEW.note) > 10 ${raise}`, 'a function call (\'length\')'],
  ['a CASE', "CREATE TRIGGER t BEFORE INSERT ON lines BEGIN SELECT CASE WHEN NEW.qty < 0 THEN RAISE(ABORT, 'refused') END; END", 'a CASE expression'],
  ['a LIKE', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN NEW.note LIKE 'x%' ${raise}`, 'a LIKE pattern'],
  ['a GLOB', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN NEW.note GLOB 'x*' ${raise}`, 'a GLOB pattern'],
  ['the NULL trap on a nullable column', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN (SELECT sealed_at FROM orders WHERE id = NEW.order_id) <> '2026-01-01' ${raise}`,
    'a comparison of the nullable \'orders.sealed_at\' read by a subquery, whose SQL NULL the comparison passes as it does a missing row'],
  ['RAISE(IGNORE)', 'CREATE TRIGGER t BEFORE INSERT ON lines WHEN NEW.qty < 0 BEGIN SELECT RAISE(IGNORE); END',
    'RAISE(IGNORE), which skips the row instead of refusing the write'],
  ['RAISE(FAIL)', "CREATE TRIGGER t BEFORE INSERT ON lines WHEN NEW.qty < 0 BEGIN SELECT RAISE(FAIL, 'refused'); END",
    'RAISE(FAIL), which keeps or undoes other writes as RAISE(ABORT) does not'],
  ['an audit insert', "CREATE TRIGGER t AFTER DELETE ON lines BEGIN INSERT INTO audit(line_id, operation) VALUES (OLD.id, 'delete'); END",
    'a program that writes rows (INSERT)'],
  ['a scalar subquery by a non-unique index', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN (SELECT open FROM rooms WHERE kind = NEW.note) = 0 ${raise}`,
    'a scalar subquery over \'rooms\' by columns no key or unique index covers, which reads its first row'],
  ['a BEFORE INSERT read of the row id', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN NEW.id < 0 ${raise}`,
    'a BEFORE INSERT read of the row id \'id\', which SQLite has not yet allocated'],
  ['a NOCASE column', `CREATE TRIGGER t BEFORE INSERT ON tags WHEN NEW.label = 'x' ${raise}`,
    'a text comparison on \'tags\', which declares a collation other than BINARY'],
  ['a literal SQLite converts by affinity', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN NEW.qty = '5' ${raise}`,
    'a comparison of a column with a value of another type, which SQLite converts by affinity'],
  ['a bump without its condition', 'CREATE TRIGGER t AFTER UPDATE ON notes BEGIN UPDATE notes SET revision = OLD.revision + 1 WHERE id = NEW.id; END',
    'a bump under a condition other than NEW.revision = OLD.revision'],
  ['a bump of another column', 'CREATE TRIGGER t AFTER UPDATE ON notes WHEN NEW.revision = OLD.revision BEGIN UPDATE notes SET id = OLD.revision + 1 WHERE id = NEW.id; END',
    'an UPDATE that does not set a column to its old value plus one'],
  ['a bump of another row', 'CREATE TRIGGER t AFTER UPDATE ON notes WHEN NEW.revision = OLD.revision BEGIN UPDATE notes SET revision = OLD.revision + 1 WHERE id = OLD.id; END',
    'an UPDATE of rows other than the new row by its key'],
  ['an unqualified column', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN qty < 0 ${raise}`, 'a column outside NEW and OLD'],
  ['arithmetic', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN NEW.qty + 1 > 5 ${raise}`, 'arithmetic'],
  ['an ordered comparison of another row', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN (SELECT open FROM rooms WHERE id = NEW.order_id) > 0 ${raise}`,
    'an ordered comparison of another row\'s column'],
  ['a BETWEEN', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN NEW.qty BETWEEN 1 AND 3 ${raise}`, 'a BETWEEN range'],
  ['OLD in an INSERT trigger', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN OLD.qty < 0 ${raise}`, 'a read of OLD in an INSERT trigger'],
  ['a probe of a view', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN NOT EXISTS (SELECT 1 FROM open_orders WHERE id = NEW.order_id) ${raise}`,
    'a probe of \'open_orders\', which this read does not derive as an entity'],
  ['a column no rule codec reads', `CREATE TRIGGER t BEFORE INSERT ON notes WHEN NEW.weight > 1 ${raise}`,
    'a read of the column \'weight\', whose type no rule codec reads'],
  ['a table laid out as the store owns it', `CREATE TRIGGER t BEFORE DELETE ON parcels ${raise}`,
    'the table \'parcels\' is not read back as a column layout: it holds a document, laid out as the store owns it, whose rules the store creates with the table'],
  ['a probe the lowering refuses', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN NOT EXISTS (SELECT 1 FROM orders WHERE status = NEW.note) ${raise}`,
    'the rule lowering refuses it: '],
  ['a store\'s rule program', `CREATE TRIGGER _jaren_rule_5_lines_insert AFTER INSERT ON lines ${raise}`,
    'the store names a declared rule\'s program so; the model that declares the rule opens the table'],
  ['a name that is no identifier', `CREATE TRIGGER "no delete" BEFORE DELETE ON lines ${raise}`, 'its name is not an identifier, the only kind a rule takes'],
  ['a probe term null-safe on both sides', `CREATE TRIGGER t BEFORE INSERT ON lines WHEN EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND sealed_at = NEW.note) ${raise}`,
    'a probe that matches the nullable \'sealed_at\' with a nullable column'],
  ['a RAISE message that is no literal', "CREATE TRIGGER t BEFORE INSERT ON lines BEGIN SELECT RAISE(ABORT, 'refused: ' || NEW.note); END",
    'a RAISE message that is not one text literal'],
];
