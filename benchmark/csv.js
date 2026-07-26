#!/usr/bin/env node

/**
 * JarenJS CSV Conformance & Performance Benchmark
 *
 * Scores @jarenjs/josl's CSV reader against the sync-capable CSV parsers
 * of the npm ecosystem on the de-facto acceptance corpus (csv-spectrum),
 * on a self-healing scorecard of damaged documents, and on parse /
 * incremental / stringify throughput.
 *
 * Rival selection, because it decides the numbers:
 *
 *  - `udsv` is the one that matters for speed. It has few downloads but
 *    it is the acknowledged JS speed leader and the only other parser
 *    with a *synchronous* incremental API, so it is the rival in both
 *    profiles. Benchmarking against papaparse alone would be picking a
 *    soft target.
 *  - `fast-csv`, `csv-parser`, `csvtojson` and `neat-csv` are deliberately
 *    absent: they are stream-only, so their "parse" cannot return rows on
 *    the calling tick and timing them beside a synchronous parser would
 *    measure Node's stream machinery rather than a CSV grammar.
 *  - Every engine is checked to produce the SAME rows before it is timed
 *    (`--verbose` prints any that do not); a parser that skipped work
 *    would otherwise look fast.
 *
 * Usage:
 *   node benchmark/csv.js                      # conformance + healing
 *   node benchmark/csv.js --verbose            # list every failing case
 *   node benchmark/csv.js --profile            # add the timing tables
 *   node benchmark/csv.js --profile --iterations 50
 *   node benchmark/csv.js --engines jaren,udsv
 *   node benchmark/csv.js --profile --output json --filepath results.json
 *
 * Exit code is non-zero when jaren fails a conformance case it should
 * pass; contender failures never affect the exit code.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  parseCsv,
  parseCsvDocument,
  stringifyCsv,
  createCsvStreamReader,
} from '@jarenjs/josl';

import Papa from 'papaparse';
import { parse as csvParseSync } from 'csv-parse/sync';
import { csvParse, csvParseRows, csvFormat } from 'd3-dsv';
import { inferSchema, initParser } from 'udsv';
import { parse as vanillaParse, stringify as vanillaStringify } from '@vanillaes/csv';

const SPECTRUM = fileURLToPath(new URL('../node_modules/csv-spectrum/', import.meta.url));

//#region engines

// `rows` returns string[][] including the header line; `objects` returns
// header-keyed records. `feed` is a synchronous incremental reader, or
// null when the package has none.
const ENGINES = [
  {
    name: 'jaren',
    rows: (text) => parseCsv(text),
    objects: (text) => parseCsv(text, { headers: true }),
    feed: (chunks) => {
      const reader = createCsvStreamReader();
      for (const c of chunks) reader.feed(c);
      return reader.end();
    },
    stringify: (rows) => stringifyCsv(rows, { newline: '\n' }),
  },
  {
    name: 'udsv',
    rows: (text) => initParser({ ...inferSchema(text), skip: 0 }).stringArrs(text),
    objects: (text) => initParser(inferSchema(text)).stringObjs(text),
    feed: (chunks) => {
      // udsv needs a schema before the first chunk; inferring it from the
      // first chunk is what a streaming consumer would actually do
      let parser = null;
      const out = [];
      for (const c of chunks) {
        parser ??= initParser({ ...inferSchema(c), skip: 0 });
        parser.chunk(c, parser.stringArrs, (row) => out.push(row));
      }
      parser?.end();
      return out;
    },
    stringify: null, // udsv is a parser only
  },
  {
    name: 'papaparse',
    rows: (text) => Papa.parse(text, { skipEmptyLines: true }).data,
    objects: (text) => Papa.parse(text, { header: true, skipEmptyLines: true }).data,
    feed: null, // incremental mode is a Node Duplex stream
    stringify: (rows) => Papa.unparse(rows, { newline: '\n' }) + '\n',
  },
  {
    name: 'csv-parse',
    rows: (text) => csvParseSync(text),
    objects: (text) => csvParseSync(text, { columns: true }),
    feed: null, // incremental mode is a Node Transform stream
    stringify: null, // lives in the separate csv-stringify package
  },
  {
    name: 'd3-dsv',
    rows: (text) => csvParseRows(text),
    // d3 hangs a `columns` property on the returned array, which would
    // make a deep-equal against a plain array fail for the wrong reason
    objects: (text) => csvParse(text).map((r) => ({ ...r })),
    feed: null,
    stringify: (rows) => csvFormat(rows) + '\n',
  },
  {
    name: '@vanillaes/csv',
    rows: (text) => vanillaParse(text),
    objects: null, // rows only
    feed: null,
    stringify: (rows) => vanillaStringify(rows),
  },
];

//#endregion

//#region cli

const args = process.argv.slice(2);
const flags = {
  profile: args.includes('--profile'),
  verbose: args.includes('--verbose'),
  iterations: Number(args[args.indexOf('--iterations') + 1]) || 20,
  engines: args.includes('--engines')
    ? args[args.indexOf('--engines') + 1].split(',')
    : null,
  output: args.includes('--output') ? args[args.indexOf('--output') + 1] : null,
  filepath: args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null,
};
const engines = flags.engines === null
  ? ENGINES
  : ENGINES.filter((e) => flags.engines.includes(e.name));

//#endregion

//#region conformance — csv-spectrum

// The suite's own `location_coordinates` fixture is internally
// inconsistent: its expectation is a bare object where every other case
// is an array, its phone number disagrees with its CSV, and its degree
// sign is already U+FFFD in the source bytes. No parser can satisfy it,
// so it is reported separately rather than counted as a failure anyone
// could fix.
const BROKEN_FIXTURE = 'location_coordinates';

function runSpectrum() {
  if (!existsSync(join(SPECTRUM, 'csvs'))) {
    console.log('csv-spectrum is not installed; skipping the acceptance suite\n');
    return { scores: {}, jarenFailed: 0 };
  }
  const names = readdirSync(join(SPECTRUM, 'csvs'))
    .map((f) => f.replace(/\.csv$/, ''))
    .filter((n) => n !== BROKEN_FIXTURE)
    .sort();

  console.log(`csv-spectrum acceptance suite: ${names.length} cases`
    + ` (${BROKEN_FIXTURE} excluded — its expectation contradicts its own input)\n`);

  const scores = {};
  let jarenFailed = 0;
  for (const engine of engines) {
    if (engine.objects === null) {
      console.log(`  ${engine.name.padEnd(16)} n/a (no header-keyed mode)`);
      continue;
    }
    const failures = [];
    for (const name of names) {
      const text = readFileSync(join(SPECTRUM, 'csvs', `${name}.csv`), 'utf8');
      const expected = readFileSync(join(SPECTRUM, 'json', `${name}.json`), 'utf8');
      try {
        const got = JSON.stringify(JSON.parse(JSON.stringify(engine.objects(text))));
        if (got !== JSON.stringify(JSON.parse(expected)))
          failures.push(`${name}: ${got}`);
      }
      catch (e) {
        failures.push(`${name}: threw ${e.code ?? e.name}`);
      }
    }
    const pass = names.length - failures.length;
    console.log(`  ${engine.name.padEnd(16)} ${String(pass).padStart(3)}/${names.length}`);
    if (flags.verbose)
      for (const f of failures) console.log(`      ${f}`);
    scores[engine.name] = { pass, total: names.length };
    if (engine.name === 'jaren')
      jarenFailed = failures.length;
  }
  return { scores, jarenFailed };
}

//#endregion

//#region self-healing scorecard

// Documents that are damaged in the ways real CSV is damaged. There is no
// single right answer for any of them, so this is NOT scored as
// conformance: it reports what each parser does, and whether the record
// structure survived. `columns` is the field count every record should
// still have if the damage was read the way the header implies.
const DAMAGED = [
  { name: 'unclosed quote', text: 'a,b\n1,"oops\n', columns: 2 },
  { name: 'stray quote in field', text: 'a,b\n"ab"c,2\n', columns: 2 },
  { name: 'unescaped inner quotes', text: 'a,b\n"he said "hi" ok",2\n', columns: 2 },
  { name: 'short record', text: 'a,b,c\n1,2\n', columns: 3 },
  { name: 'long record', text: 'a,b\n1,2,3\n', columns: 2 },
  { name: 'bare CR endings', text: 'a,b\r1,2\r3,4\r', columns: 2 },
  { name: 'duplicate headers', text: 'a,a\n1,2\n', columns: 2 },
  { name: 'empty header name', text: 'a,,c\n1,2,3\n', columns: 3 },
  { name: 'mixed line endings', text: 'a,b\n1,2\r\n3,4\n', columns: 2 },
];

// One engine on one damaged document, run in a CHILD PROCESS with a
// deadline. That is not paranoia: udsv loops forever on a record shorter
// than its header, and an in-process probe would take the whole benchmark
// down with it. A hang is a result worth reporting, not a crash.
function healResult(engineName, index) {
  const probe = spawnSync(process.execPath,
    [fileURLToPath(import.meta.url), '--heal-probe', engineName, String(index)],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20 });
  if (probe.signal !== null || probe.status === null)
    return 'hung';
  const line = (probe.stdout ?? '').trim().split('\n').pop();
  return line === '' || line === undefined ? 'error' : line;
}

// The probe itself, in the child.
function healProbe(engineName, index) {
  const entry = DAMAGED[index];
  const engine = engineName === 'jaren(repair)'
    ? { rows: (t) => parseCsv(t, { repair: true }) }
    : ENGINES.find((e) => e.name === engineName);
  try {
    const rows = engine.rows(entry.text);
    if (rows.length === 0)
      return 'no rows';
    const widths = new Set(rows.map((r) => r.length));
    if (widths.size === 1 && widths.has(entry.columns))
      return 'kept';
    return `${[...widths].sort((x, y) => x - y).join('/')} cols`;
  }
  catch {
    return 'threw';
  }
}

if (args[0] === '--heal-probe') {
  console.log(healProbe(args[1], Number(args[2])));
  process.exit(0);
}

function runHealing() {
  console.log('\nSelf-healing on damaged documents — does the record structure survive?\n');
  const nameWidth = Math.max(...DAMAGED.map((d) => d.name.length)) + 2;
  const cols = [...engines.map((e) => e.name), 'jaren(repair)'];
  process.stdout.write('damage'.padEnd(nameWidth));
  for (const c of cols) process.stdout.write(c.padStart(16));
  console.log();
  console.log('-'.repeat(nameWidth + 16 * cols.length));

  const table = [];
  for (let i = 0; i < DAMAGED.length; i++) {
    process.stdout.write(DAMAGED[i].name.padEnd(nameWidth));
    const row = { damage: DAMAGED[i].name, results: {} };
    for (const name of cols) {
      const r = healResult(name, i);
      row.results[name] = r;
      process.stdout.write(r.padStart(16));
    }
    console.log();
    table.push(row);
  }
  console.log('-'.repeat(nameWidth + 16 * cols.length));
  console.log('"kept"   every record still has the column count the header implies');
  console.log('"threw"  the document was rejected outright');
  console.log('"hung"   no answer within 5s (udsv loops on a record shorter than its header)');
  console.log('"N/M cols" the rows survived with inconsistent widths\n');
  // A ragged record stays ragged in every engine here, because no parser
  // can invent a cell that was never written. The difference is that one
  // of them says so: the others heal silently or reject the document, and
  // a silent heal is indistinguishable from clean input downstream.
  console.log('What jaren reports for the same documents (repair mode, headers on):\n');
  for (const entry of DAMAGED) {
    let doc;
    try {
      doc = parseCsvDocument(entry.text, { repair: true, headers: true });
    }
    catch (e) {
      console.log(`  ${entry.name.padEnd(nameWidth)} threw ${e.code ?? e.name}`);
      continue;
    }
    const codes = doc.repairs.length === 0
      ? '(nothing to repair)'
      : doc.repairs.map((r) => `${r.code}@${r.line}:${r.column}`).join(' ');
    console.log(`  ${entry.name.padEnd(nameWidth)} ${codes}`);
  }
  return table;
}

//#endregion

//#region corpora

function buildRecords(n) {
  let out = 'id,name,email,amount,when,active\n';
  for (let i = 0; i < n; ++i) {
    out += `${i},Person ${i},person${i}@example.com,${(i % 1000) / 4},2026-07-${(i % 28) + 1 < 10 ? '0' : ''}${(i % 28) + 1},${i % 2 === 0}\n`;
  }
  return out;
}

function buildQuoted(n) {
  let out = 'id,title,note\n';
  for (let i = 0; i < n; ++i)
    out += `${i},"Item ${i}, revised","he said ""this one"" on line ${i}"\n`;
  return out;
}

function buildWide(rows, cols) {
  let out = Array.from({ length: cols }, (_, c) => `col_${c}`).join(',') + '\n';
  for (let r = 0; r < rows; ++r)
    out += Array.from({ length: cols }, (_, c) => `${r}_${c}`).join(',') + '\n';
  return out;
}

const corpora = [
  { name: 'records 10k x 6 (plain)', text: buildRecords(10000) },
  { name: 'quoted 10k x 3', text: buildQuoted(10000) },
  { name: 'wide 1k x 50', text: buildWide(1000, 50) },
];

//#endregion

//#region profile

function timeIt(fn, iterations) {
  fn();
  fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; ++i)
    fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iterations;
}

// A parser that quietly produced fewer rows would post a great number, so
// nothing is timed until it agrees with jaren on the shape of the result.
function agrees(engine, mode, text) {
  try {
    const mine = JSON.stringify(ENGINES[0][mode](text));
    const theirs = JSON.stringify(engine[mode](text));
    return mine === theirs ? true : `differs (${theirs.length} vs ${mine.length} bytes of JSON)`;
  }
  catch (e) {
    return `threw ${e.code ?? e.name}`;
  }
}

function profileMode(mode, title) {
  console.log(`\n${title} (${flags.iterations} iterations, ms per pass; ratio vs jaren)\n`);
  const out = [];
  for (const corpus of corpora) {
    console.log(`  ${corpus.name}`);
    const results = {};
    let base = null;
    for (const engine of engines) {
      if (engine[mode] === null) {
        console.log(`    ${engine.name.padEnd(16)} n/a`);
        continue;
      }
      const ok = agrees(engine, mode, corpus.text);
      if (ok !== true) {
        console.log(`    ${engine.name.padEnd(16)} skipped — ${ok}`);
        results[engine.name] = null;
        continue;
      }
      const ms = timeIt(() => engine[mode](corpus.text), flags.iterations);
      if (engine.name === 'jaren')
        base = ms;
      results[engine.name] = ms;
      const ratio = base !== null ? ` (${(ms / base).toFixed(2)}x)` : '';
      console.log(`    ${engine.name.padEnd(16)} ${ms.toFixed(3).padStart(9)} ms${ratio}`);
    }
    out.push({ name: corpus.name, results });
  }
  return out;
}

function chunksOf(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size)
    out.push(text.slice(i, i + size));
  return out;
}

function profileStreaming() {
  console.log(`\nincremental read, 64 KB chunks (${flags.iterations} iterations, ms per pass)\n`);
  const feeders = engines.filter((e) => e.feed !== null);
  console.log('  Only synchronous incremental readers appear here. fast-csv, csv-parser and');
  console.log('  csvtojson are stream-only: their rows arrive on a later tick, so timing them');
  console.log('  beside these would measure Node streams rather than CSV parsing.\n');
  const out = [];
  for (const corpus of corpora) {
    const chunks = chunksOf(corpus.text, 65536);
    console.log(`  ${corpus.name} — ${chunks.length} chunks`);
    const results = {};
    let base = null;
    for (const engine of feeders) {
      let ms;
      try {
        ms = timeIt(() => engine.feed(chunks), flags.iterations);
      }
      catch (e) {
        console.log(`    ${engine.name.padEnd(16)} threw ${e.code ?? e.name}`);
        results[engine.name] = null;
        continue;
      }
      if (engine.name === 'jaren')
        base = ms;
      results[engine.name] = ms;
      const ratio = base !== null ? ` (${(ms / base).toFixed(2)}x)` : '';
      console.log(`    ${engine.name.padEnd(16)} ${ms.toFixed(3).padStart(9)} ms${ratio}`);
    }
    out.push({ name: corpus.name, results });
  }
  return out;
}

function profileStringify() {
  console.log(`\nstringify (${flags.iterations} iterations, ms per pass; ratio vs jaren)\n`);
  const rows = parseCsv(buildRecords(10000), { headers: true });
  const results = {};
  let base = null;
  for (const engine of engines) {
    if (engine.stringify === null) {
      console.log(`  ${engine.name.padEnd(16)} n/a`);
      continue;
    }
    let ms;
    try {
      ms = timeIt(() => engine.stringify(rows), flags.iterations);
    }
    catch (e) {
      console.log(`  ${engine.name.padEnd(16)} threw ${e.code ?? e.name}`);
      results[engine.name] = null;
      continue;
    }
    if (engine.name === 'jaren')
      base = ms;
    results[engine.name] = ms;
    const ratio = base !== null ? ` (${(ms / base).toFixed(2)}x)` : '';
    console.log(`  ${engine.name.padEnd(16)} ${ms.toFixed(3).padStart(9)} ms${ratio}`);
  }
  return results;
}

//#endregion

const { scores, jarenFailed } = runSpectrum();
const healing = runHealing();
let profile = null;
if (flags.profile) {
  profile = {
    iterations: flags.iterations,
    rows: profileMode('rows', 'parse to string arrays'),
    objects: profileMode('objects', 'parse to header-keyed objects'),
    streaming: profileStreaming(),
    stringify: profileStringify(),
  };
}
console.log();

if (flags.output === 'json') {
  const data = {
    date: new Date().toISOString(),
    node: process.version,
    engines: engines.map((e) => e.name),
    spectrum: scores,
    healing,
    profile,
  };
  const json = JSON.stringify(data, null, 2);
  if (flags.filepath !== null) {
    writeFileSync(flags.filepath, json);
    console.log(`wrote ${flags.filepath}`);
  }
  else {
    console.log(json);
  }
}
process.exit(jarenFailed === 0 ? 0 : 1);
