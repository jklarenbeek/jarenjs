//@ts-check
/**
 * @file The PostgreSQL operations evidence comes from its producer, assembled
 * from the reports of the two checks that measure it.
 *
 * The fixtures are the reports inside the committed result: the producer
 * re-assembles them into a temporary directory and must reproduce them in
 * major order, pin the current bytes of exactly the inputs the committed
 * result pins, and keep the result it replaces and the one before that, and
 * nothing deeper. Each refusal exits 2 with one line and leaves the output it
 * would have replaced as it was, with no file beside it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildOperationsEvidence } from '../../scripts/generate-postgres-operations-evidence.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'generate-postgres-operations-evidence.js');
const COMMITTED_TEXT = readFileSync(join(ROOT, 'benchmark', 'postgres-operations-result.json'), 'utf8');
const COMMITTED = JSON.parse(COMMITTED_TEXT);
const KEYS = ['format', 'measuredAt', 'sourceHashes', 'logicalBackups', 'pitr'];

/** The PostgreSQL major a backup report was taken on. @param {any} report */
const majorOf = (report) => Number(/^(\d+)/.exec(report.postgres.version)?.[1]);
/** The majors the committed result covers, lowest first. */
const MAJORS = COMMITTED.logicalBackups.map(majorOf);
const [LOW, MIDDLE, HIGH] = MAJORS;

/** A result without the generations beneath it. @param {any} result */
const alone = (result) => {
  const { previous: _older, ...rest } = result;
  return rest;
};

/** Run the producer. @param {string[]} args */
const produce = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

describe('the operations evidence producer', () => {
  /** @type {string} */
  let dir;
  /** @type {Record<number, string>} */
  const backup = {};
  /** @type {string} */
  let recovery;
  /** @type {string} */
  let broken;
  /** @type {string[]} every backup report, the lowest major last */
  let backups;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'jaren-pg-operations-'));
    for (const report of COMMITTED.logicalBackups) {
      backup[majorOf(report)] = join(dir, `backup-${majorOf(report)}.json`);
      writeFileSync(backup[majorOf(report)], JSON.stringify(report, null, 2));
    }
    recovery = join(dir, 'recovery.json');
    writeFileSync(recovery, JSON.stringify(COMMITTED.pitr, null, 2));
    broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ "format": "jaren-postgres-backup/1", ');
    backups = [...MAJORS.slice(1), LOW].flatMap((major) => ['--backup', backup[major]]);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('covers three majors in the committed result it takes its fixtures from', () => {
    assert.strictEqual(MAJORS.length, 3);
    assert.deepStrictEqual(MAJORS, MAJORS.toSorted((a, b) => a - b));
  });

  it('assembles the reports in major order and pins the current bytes of the 17 inputs the committed result pins', () => {
    const at = mkdtempSync(join(dir, 'out-'));
    const out = join(at, 'result.json');
    const result = produce([...backups, '--recovery', recovery, '--out', out]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /^wrote [^\n]+, 17 pinned inputs, 0 previous measurements kept\n$/);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepStrictEqual(Object.keys(written), KEYS);
    assert.strictEqual(written.format, 'jaren-postgres-operations/1');
    assert.match(written.measuredAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepStrictEqual(written.logicalBackups, COMMITTED.logicalBackups);
    assert.deepStrictEqual(written.pitr, COMMITTED.pitr);
    const pinned = Object.keys(COMMITTED.sourceHashes);
    assert.strictEqual(pinned.length, 17);
    assert.deepStrictEqual(Object.keys(written.sourceHashes), pinned);
    for (const file of pinned) {
      assert.strictEqual(written.sourceHashes[file],
        createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex'), file);
    }
    assert.deepStrictEqual(readdirSync(at), ['result.json'], 'a file was left beside the output');
  });

  it('keeps the result it replaces and the one before that, and nothing deeper', () => {
    const out = join(mkdtempSync(join(dir, 'out-')), 'result.json');
    // four generations already there: the first run keeps the newest two
    const [g1, g2, g3, g4] = ['04', '03', '02', '01']
      .map((day) => ({ ...alone(COMMITTED), measuredAt: `2026-01-${day}T00:00:00.000Z` }));
    writeFileSync(out, JSON.stringify({ ...g1, previous: { ...g2, previous: { ...g3, previous: g4 } } }));
    const first = produce([...backups, '--recovery', recovery, '--out', out]);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.match(first.stdout, /, 2 previous measurements kept\n$/);
    const once = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepStrictEqual(Object.keys(once), [...KEYS, 'previous']);
    assert.deepStrictEqual(once.previous, { ...g1, previous: g2 });
    // a second run over the first one's output: that output moves down, g2 goes
    const second = produce([...backups, '--recovery', recovery, '--out', out]);
    assert.strictEqual(second.status, 0, second.stderr);
    const twice = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepStrictEqual(twice.previous, { ...alone(once), previous: g1 });
    assert.strictEqual('previous' in twice.previous.previous, false);
  });

  /** @type {{ name: string, args: () => string[], message: RegExp, existing?: () => string }[]} */
  const refusals = [
    { name: 'an unknown argument', args: () => ['--backups', backup[LOW]], message: /unexpected argument '--backups'/ },
    { name: 'a missing --recovery', args: () => backups, message: /--recovery <file> is required/ },
    { name: '--recovery given twice', args: () => [...backups, '--recovery', recovery, '--recovery', recovery],
      message: /--recovery given twice/ },
    { name: 'a backup report of the wrong format',
      args: () => ['--backup', recovery, '--backup', backup[MIDDLE], '--backup', backup[HIGH], '--recovery', recovery],
      message: /recovery\.json is a jaren-postgres-pitr\/1 report, expected jaren-postgres-backup\/1/ },
    { name: 'a recovery report of the wrong format', args: () => [...backups, '--recovery', backup[LOW]],
      message: new RegExp(`backup-${LOW}\\.json is a jaren-postgres-backup/1 report, expected jaren-postgres-pitr/1`) },
    { name: 'a major twice, naming the one missing too',
      args: () => ['--backup', backup[LOW], '--backup', backup[LOW], '--backup', backup[MIDDLE], '--recovery', recovery],
      message: new RegExp(`each matrix major \\(${MAJORS.join(', ')}\\) exactly once: duplicate ${LOW}; missing ${HIGH}\n$`) },
    { name: 'a missing major', args: () => ['--backup', backup[LOW], '--backup', backup[MIDDLE], '--recovery', recovery],
      message: new RegExp(`exactly once: missing ${HIGH}\n$`) },
    { name: 'a report that cannot be read',
      args: () => ['--backup', join(dir, 'absent.json'), '--backup', backup[MIDDLE], '--backup', backup[HIGH], '--recovery', recovery],
      message: /cannot read \S*absent\.json: ENOENT/ },
    { name: 'a report that is not JSON',
      args: () => ['--backup', broken, '--backup', backup[MIDDLE], '--backup', backup[HIGH], '--recovery', recovery],
      message: /cannot read \S*broken\.json: / },
    { name: 'an existing output that is not operations evidence', args: () => [...backups, '--recovery', recovery],
      existing: () => readFileSync(backup[LOW], 'utf8'),
      message: /result\.json is a jaren-postgres-backup\/1 report, expected jaren-postgres-operations\/1/ },
  ];
  for (const { name, args, message, existing } of refusals) {
    it(`refuses ${name} with one line, leaving the output as it was`, () => {
      const at = mkdtempSync(join(dir, 'out-'));
      const out = join(at, 'result.json');
      const before = existing?.() ?? COMMITTED_TEXT;
      writeFileSync(out, before);
      const result = produce([...args(), '--out', out]);
      assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
      assert.strictEqual(result.stdout, '');
      assert.match(result.stderr, /^generate-postgres-operations-evidence: [^\n]+\n$/);
      assert.match(result.stderr, message);
      assert.strictEqual(readFileSync(out, 'utf8'), before, 'the output changed');
      assert.deepStrictEqual(readdirSync(at), ['result.json'], 'a file was left beside the output');
    });
  }

  it('creates no output where there was none when it refuses after reading every input', () => {
    const at = mkdtempSync(join(dir, 'out-'));
    const result = produce(['--backup', backup[LOW], '--backup', backup[MIDDLE], '--recovery', recovery,
      '--out', join(at, 'result.json')]);
    assert.strictEqual(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.deepStrictEqual(readdirSync(at), []);
  });
});

describe('buildOperationsEvidence', () => {
  const backups = COMMITTED.logicalBackups;
  const base = { recovery: COMMITTED.pitr, majors: MAJORS, sourceHashes: COMMITTED.sourceHashes,
    measuredAt: '2026-01-01T00:00:00.000Z' };

  it('orders the backups by major without reordering its input, and adds no previous when there is none', () => {
    const shuffled = [backups[1], backups[2], backups[0]];
    const result = buildOperationsEvidence({ ...base, backups: shuffled });
    assert.deepStrictEqual(Object.keys(result), KEYS);
    assert.deepStrictEqual(result.logicalBackups, backups);
    assert.deepStrictEqual(shuffled, [backups[1], backups[2], backups[0]]);
  });

  it('keeps the previous result with at most its own previous', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((measuredAt) => ({ ...alone(COMMITTED), measuredAt }));
    const previousOf = (/** @type {any} */ previous) => buildOperationsEvidence({ ...base, backups, previous }).previous;
    assert.deepStrictEqual(previousOf(a), a);
    assert.deepStrictEqual(previousOf({ ...a, previous: b }), { ...a, previous: b });
    assert.deepStrictEqual(previousOf({ ...a, previous: { ...b, previous: c } }), { ...a, previous: b });
  });

  it('names every duplicated, missing and unexpected major at once', () => {
    const older = { ...backups[0], postgres: { ...backups[0].postgres, version: '15.9 (Debian 15.9-1.pgdg12+1)' } };
    assert.throws(() => buildOperationsEvidence({ ...base, backups: [backups[0], older, backups[0]] }), {
      message: `the backup reports must cover each matrix major (${MAJORS.join(', ')}) exactly once: `
        + `duplicate ${LOW}; missing ${MIDDLE}, ${HIGH}; outside the matrix 15`,
    });
  });

  it('refuses a report of the wrong format, a backup without a server version and an empty matrix', () => {
    assert.throws(() => buildOperationsEvidence({ ...base, backups: [COMMITTED.pitr, ...backups.slice(1)] }),
      { message: 'backup report 1 is a jaren-postgres-pitr/1 report, expected jaren-postgres-backup/1' });
    assert.throws(() => buildOperationsEvidence({ ...base, backups, recovery: backups[0] }),
      { message: 'the recovery report is a jaren-postgres-backup/1 report, expected jaren-postgres-pitr/1' });
    assert.throws(() => buildOperationsEvidence({ ...base, backups, previous: backups[0] }),
      { message: 'the previous result is a jaren-postgres-backup/1 report, expected jaren-postgres-operations/1' });
    assert.throws(() => buildOperationsEvidence({ ...base, backups, recovery: {} }),
      { message: 'the recovery report is not a report (it names no format), expected jaren-postgres-pitr/1' });
    assert.throws(() => buildOperationsEvidence({ ...base, backups: [{ ...backups[0], postgres: {} }, ...backups.slice(1)] }),
      { message: 'backup report 1 names no PostgreSQL version' });
    assert.throws(() => buildOperationsEvidence({ ...base, backups, majors: [] }),
      { message: 'the matrix names no PostgreSQL major' });
  });
});
