//@ts-check
/**
 * @file The pen-table registry (`scripts/generate-pen-index.js`).
 * `packages/linq/docs/LINQ-FORMAT.md` carries five blocks — the index,
 * the census, the refusal map, the subpath prices and every pen's
 * mapping table — that nobody writes: the registry splices them out of
 * the ten documents beside it, and `npm run docs:check` fails until the
 * binder agrees with them again.
 *
 * The runner those blocks are baked through is `scripts/lib/derive.js`
 * and is gated by `derive.test.js`; what is asserted here is the
 * DERIVATIONS — that the index is the directory, that a row added to a
 * pen document lands in the binder, and that every committed marker sits
 * where a renderer will see it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bake, scanSourceDirectives } from '@jarenjs/md';

import { NS, runDerivation } from '../../scripts/lib/derive.js';
import { penTables } from '../../scripts/generate-pen-index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS = join(ROOT, 'packages/linq/docs');
const BINDER = 'LINQ-FORMAT.md';
const REL = `packages/linq/docs/${BINDER}`;

/**
 * The measured figures these documents also carry — every key the pen
 * registry does not claim (`bundle.*` subpath prices, the client's
 * `orm.*` rows) — answered from the documents themselves. The sandbox is
 * a copy of a baked tree, so echoing each marker's current body keeps
 * them answered without dragging the measured-figure registry — and its
 * twenty-nine documents, none of which the sandbox holds — into these
 * fixtures.
 * @param {string} dir
 */
function measuredEcho(dir) {
  /** @type {Record<string, () => string>} */
  const facts = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    for (const directive of scanSourceDirectives(readFileSync(join(dir, file), 'utf8'), { ns: NS })
      .directives) {
      if (!directive.key.startsWith('pens.')) facts[directive.key] = () => directive.body;
    }
  }
  return { name: 'measured figures (echoed)', docs: () => [], facts: () => facts };
}

/** A throwaway root holding a copy of the pen documents. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'jaren-pen-index-'));
  const dir = join(root, 'packages/linq/docs');
  mkdirSync(dir, { recursive: true });
  cpSync(DOCS, dir, { recursive: true });
  return { root, dir, registries: [penTables, measuredEcho(dir)] };
}

const binderOf = (dir) => readFileSync(join(dir, BINDER), 'utf8');

describe('the five blocks are the binder\'s, and the derivations are theirs', () => {
  it('every marker is answered and every derivation carried', () => {
    const report = runDerivation({ root: ROOT, registries: [penTables], check: true });
    // the measured figures in these documents belong to the other
    // registry, so they are unanswered HERE and that is not a defect —
    // what must hold is that no `pens.*` derivation is missing a marker
    assert.deepStrictEqual(report.unused, [], 'a pen derivation the binder does not carry');
    assert.deepStrictEqual(report.unanswered.filter((line) => /'pens\./.test(line)), []);
  });

  it('the binder carries the five, in order, none orphaned', () => {
    const binder = readFileSync(join(DOCS, BINDER), 'utf8');
    const keys = [...binder.matchAll(new RegExp(`<!--${NS}:(pens\\.[a-z]+)-->`, 'g'))]
      .map((m) => m[1]);
    assert.deepStrictEqual(keys,
      ['pens.index', 'pens.census', 'pens.codes', 'pens.cost', 'pens.vocabulary']);
  });
});

describe('the index is the directory, and the directory is the index', () => {
  // The website reaches these documents through the binder and only
  // through it, so a document the index omits is one no reader of the
  // site can open — a failure every other gate is blind to.
  it('carries one row per document, each linking itself and stating its length', () => {
    const files = readdirSync(DOCS).filter((file) => file.endsWith('.md')).sort();
    const binder = readFileSync(join(DOCS, BINDER), 'utf8');
    const block = scanSourceDirectives(binder, { ns: NS }).directives
      .find((directive) => directive.key === 'pens.index')?.body ?? '';
    const rows = [...block.matchAll(/^\| \[([A-Za-z0-9._-]+\.md)\]\(\1\) \| ([\d,]+) \|/gm)];
    assert.deepStrictEqual(rows.map((row) => row[1]).sort(), files);
    for (const [, file, stated] of rows) {
      assert.strictEqual(Number(stated.replace(/,/g, '')),
        readFileSync(join(DOCS, file), 'utf8').split('\n').length - 1, `${file}'s stated length`);
    }
    assert.ok(binder.includes(`| **${files.length} documents** |`),
      'the census total must grow with the documents it counts');
  });

  it('a document the registry has not been told about is still walked', () => {
    // the docs list is the directory listing, never a literal — a
    // hard-coded list is how a new document comes to be unreachable
    assert.deepStrictEqual(penTables.docs(ROOT).sort(),
      readdirSync(DOCS).filter((file) => file.endsWith('.md')).sort()
        .map((file) => `packages/linq/docs/${file}`));
  });
});

describe('a hand-edited row is drift, and the write mode repairs it', () => {
  it('one character inside a baked block is reported and rewritten back', () => {
    const box = sandbox();
    const clean = binderOf(box.dir);
    // a real row, found rather than typed: a literal line count here goes
    // stale the first time any document grows
    writeFileSync(join(box.dir, BINDER), clean.replace(/^(\| \[SCHEMA-PEN\.md\][^|]*\| )([\d,]+)( \|)/m,
      (_, head, lines, tail) => `${head}${Number(lines.replace(/,/g, '')) - 1}${tail}`));
    assert.notStrictEqual(binderOf(box.dir), clean, 'the edit landed');

    const checked = runDerivation({ ...box, check: true });
    assert.strictEqual(checked.code, 1);
    assert.match(checked.drift.join('\n'), /pens\.index/);

    const written = runDerivation(box);
    assert.strictEqual(written.code, 0);
    assert.deepStrictEqual(written.rewritten, [REL]);
    assert.strictEqual(binderOf(box.dir), clean, 'the repair is the committed text, byte for byte');
    assert.deepStrictEqual(runDerivation(box).rewritten, [], 'and the bake is idempotent');
  });

  it('a row added to a pen document moves exactly that row', () => {
    const box = sandbox();
    const file = join(box.dir, 'JSLT-PEN.md');
    const jslt = readFileSync(file, 'utf8');
    const row = '| `nothing()` | nothing at all | never |';
    const anchor = jslt.indexOf('\n', jslt.indexOf('|---', jslt.indexOf('## 2. The mapping table')));
    writeFileSync(file, `${jslt.slice(0, anchor)}\n${row}${jslt.slice(anchor)}`);
    const before = binderOf(box.dir).split('\n');
    runDerivation(box);
    const added = binderOf(box.dir).split('\n').filter((line) => !before.includes(line));
    assert.ok(added.includes(row), `the new row reached the binder: ${added.join(' / ')}`);
    assert.strictEqual(added.filter((line) => line.startsWith('| `')).length, 1,
      'and nothing else in the block moved');
  });

  it('a derivation whose document lost the section it reads throws', () => {
    const box = sandbox();
    // the refusal map is derived from §1.3's own code table
    writeFileSync(join(box.dir, BINDER), binderOf(box.dir).replace(/^\| `JL01\d\d` \|.*$/gm, ''));
    const report = runDerivation(box);
    assert.strictEqual(report.code, 1);
    assert.match(report.unanswered.join('\n'), /pens\.codes: resolver threw — .*JL01xx table/);
    assert.deepStrictEqual(report.rewritten, []);
  });
});

describe('every committed marker sits where a renderer sees it', () => {
  it('none of the pen documents opens an HTML block over its own sentence', () => {
    const problems = readdirSync(DOCS).filter((file) => file.endsWith('.md')).flatMap((file) =>
      bake(readFileSync(join(DOCS, file), 'utf8'), { ns: NS, resolve: () => undefined })
        .diagnostics.map((message) => `${file}: ${message}`));
    assert.deepStrictEqual(problems, []);
  });
});

describe('the committed tree is current', () => {
  it('npm run docs:check is green on it', () => {
    try {
      execFileSync(process.execPath, ['scripts/derive-docs.js', '--check'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch (err) {
      assert.fail(`${/** @type {any} */ (err).stderr ?? ''}${/** @type {any} */ (err).stdout ?? ''}`);
    }
  });
});
