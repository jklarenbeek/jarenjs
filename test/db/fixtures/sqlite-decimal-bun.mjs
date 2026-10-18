// Runs under Bun: reads the JSON number texts on stdin as bun:sqlite converts each to a double, by CAST, and by
// jsonb_extract those at the indexes `converted` names (the ones it hands back as a double). Prints the runtime, the
// SQLite version and the two readings.
import { Database } from 'bun:sqlite';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { texts, converted } = JSON.parse(input);
const db = new Database(':memory:');
const cast = db.query('SELECT CAST(?1 AS REAL) AS "v"');
const extract = db.query('SELECT jsonb_extract(jsonb(?1), \'$\') AS "v"');
const version = db.query('SELECT sqlite_version() AS "v"').get().v;
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', version, cast: texts.map((text) => cast.get(text).v),
  extract: converted.map((/** @type {number} */ i) => extract.get(texts[i]).v) })}\n`);
db.close();
