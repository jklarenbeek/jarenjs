//@ts-check
/**
 * @file The portability census: a machine-readable scan proving that no
 * SQLite spelling reaches a module outside `src/dialects/` and
 * `src/drivers/` except where a named, reasoned entry says it does.
 *
 * It reads the SQL the package writes, not its prose: a small scanner
 * walks each module's characters, ignores comments and regular
 * expressions, collects every string and template literal, and keeps
 * the ones that look like SQL. The SQLite-ism patterns then run over
 * those fragments only — which is why `typeof x === 'string'` and a
 * `/"((?:[^"]|"")*)"/` are not findings, and `SELECT json(?)` is.
 *
 * Every allowed module is allowed for a REASON, and the reason names
 * the capability that makes it honest rather than hidden. A module
 * outside the list must have no findings at all; that is the assertion
 * the second dialect rests on.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..',
  'packages', 'db', 'src');

/** What a template substitution leaves behind in the fragment: a hole
 * no SQL word can span, so an interpolated name never joins the word
 * beside it into one token. */
const SUBSTITUTION = '\uffff';

/**
 * Every string and template literal in a JavaScript module, in source
 * order. Comments and regular-expression literals are skipped, so a
 * pattern that merely mentions a quote character is not mistaken for
 * SQL. Template substitutions are dropped from the fragment — an
 * interpolated identifier is the dialect's business, and what the
 * census reads is the text the module itself wrote around it.
 * @param {string} source
 * @returns {string[]}
 */
export function stringLiterals(source) {
  /** @type {string[]} */
  const out = [];
  /** The last significant character, which decides `/` division from a
   * regular expression: after a value, `/` divides. */
  let previous = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && previous !== '' && !/[)\]}A-Za-z0-9_$]/.test(previous)) {
      // a regular expression: skip it whole, character classes included
      i++;
      let inClass = false;
      while (i < n) {
        const r = source[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { i++; break; }
        else if (r === '\n') break;
        i++;
      }
      previous = 'x';
      continue;
    }
    if (c === "'" || c === '"') {
      let text = '';
      i++;
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') { text += source[i + 1] ?? ''; i += 2; continue; }
        text += source[i];
        i++;
      }
      i++;
      out.push(text);
      previous = 'x';
      continue;
    }
    if (c === '`') {
      let text = '';
      i++;
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '$' && source[i + 1] === '{') {
          // step over the substitution, counting nested braces
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
              const quote = source[i];
              i++;
              while (i < n && source[i] !== quote) {
                if (source[i] === '\\') i++;
                i++;
              }
            }
            i++;
          }
          text += SUBSTITUTION;
          continue;
        }
        text += source[i];
        i++;
      }
      i++;
      out.push(text);
      previous = 'x';
      continue;
    }
    if (!/\s/.test(c)) previous = c;
    i++;
  }
  return out;
}

/**
 * A fragment worth reading as SQL. It must BEGIN with a statement word,
 * or with the clause word a concatenated fragment continues from —
 * which is how the store writes SQL and is never how it writes prose.
 * A sentence that merely names `PRAGMA foreign_keys` is a diagnostic,
 * not a statement, and a census that flagged it would train its reader
 * to skim the list.
 */
const SQL_SHAPE = new RegExp('^[\\s\\uffff]*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|'
  + 'PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VALUES|WITH|RETURNING|FROM|WHERE|SET|'
  + 'AND|OR|ON|GROUP|ORDER|LIMIT|JOIN|HAVING)\\b', 'i');

/**
 * The SQLite spellings a portable module must not write. Each is the
 * SYNTAX itself, never a word that merely appears in one — `STRICT` as
 * a table option, not the string "strict mode".
 */
const SQLITE_SPELLINGS = Object.freeze([
  { name: 'pragma', pattern: /\bPRAGMA\s+[a-z_]/i },
  { name: 'sqlite-catalog', pattern: /\bsqlite_(schema|master|version)\b/ },
  { name: 'pragma-table-function', pattern: /\bpragma_[a-z_]+\s*\(/ },
  { name: 'jsonb-function', pattern: /\bjsonb_[a-z_]+\s*\(/ },
  { name: 'sqlite-json-function',
    pattern: /\b(json_type|json_group_array|json_extract|json_quote|json_each)\s*\(|\bjson\s*\(/ },
  { name: 'sqlite-typeof', pattern: /\btypeof\s*\(/ },
  { name: 'rowid', pattern: /\browid\b/ },
  { name: 'strict-table-option', pattern: /\)\s*STRICT\b/ },
  { name: 'generated-storage-word', pattern: /GENERATED\s+ALWAYS\s+AS\s*\([^)]*\)\s*(VIRTUAL|STORED)/ },
  { name: 'autoincrement', pattern: /\bAUTOINCREMENT\b/i },
  { name: 'excluded-ref', pattern: /\bexcluded\./ },
  { name: 'julianday', pattern: /\bjulianday\s*\(/ },
  { name: 'instr', pattern: /\binstr\s*\(/ },
  { name: 'create-virtual-table', pattern: /\bCREATE\s+VIRTUAL\s+TABLE\b/i },
  // an identifier quoted by the module rather than by `quoteIdentifier`,
  // and a positional placeholder written rather than `parameterRef`
  { name: 'hand-quoted-identifier', pattern: /"{2}/ },
  { name: 'hand-written-placeholder', pattern: /[=(,]\s*\?/ },
]);

/**
 * The modules a SQLite spelling may reach, each with the reason it is
 * honest there. Every one of them is a subsystem the connection
 * capability table names absent on a driver that cannot run it, so the
 * assumption is DECLARED rather than discovered at the first statement.
 */
const SQLITE_ONLY_MODULES = Object.freeze({
  'jobs.js': 'the durable job queue writes its own statements; it is a SQLite-only '
    + "subsystem in 0.1, and `capabilities.jobs` is false on a connection that cannot run "
    + "it, so the store's job surface is absent there rather than failing at the first "
    + 'statement',
  'capture.js': 'the change ledger is built on the SQLite session extension and its '
    + 'JSONB decoding; `capabilities.changeCapture` is false where neither exists, and '
    + 'the live registry then refuses by name',
});

describe('the portability census (no unapproved SQLite spelling outside the dialect)', () => {
  const modules = fs.readdirSync(SRC).filter((file) => file.endsWith('.js')).sort();

  it('reads every module of the package', () => {
    // the census is only evidence if it actually looked: a rename that
    // emptied the scan would otherwise pass silently
    assert.ok(modules.length >= 40, `${modules.length} modules scanned`);
    assert.ok(modules.includes('store.js') && modules.includes('emit.js')
      && modules.includes('plan.js') && modules.includes('migrate.js'));
  });

  it('the scanner reads SQL out of literals and nothing else', () => {
    const found = stringLiterals([
      'const re = /"((?:[^"]|"")*)"/;',
      "const a = 'SELECT 1';",
      'const b = `SELECT ${x} FROM ${y}`;',
      '// SELECT commented',
      '/* SELECT blocked */',
      'if (typeof v === "string") return 1 / 2;',
    ].join('\n'));
    assert.ok(found.includes('SELECT 1'));
    assert.ok(found.some((f) => f === `SELECT ${SUBSTITUTION} FROM ${SUBSTITUTION}`));
    assert.ok(!found.some((f) => f.includes('commented') || f.includes('blocked')));
    assert.ok(found.includes('string'));
  });

  it('every module outside the dialect and the approved list is spelling-free', () => {
    /** @type {string[]} */
    const findings = [];
    for (const file of modules) {
      if (Object.hasOwn(SQLITE_ONLY_MODULES, file)) continue;
      const source = fs.readFileSync(path.join(SRC, file), 'utf8');
      for (const fragment of stringLiterals(source)) {
        if (!SQL_SHAPE.test(fragment)) continue;
        for (const spelling of SQLITE_SPELLINGS) {
          if (spelling.pattern.test(fragment))
            findings.push(`${file}: ${spelling.name} in ${JSON.stringify(fragment.slice(0, 96))}`);
        }
      }
    }
    assert.deepStrictEqual(findings, [],
      'a SQLite spelling reached a portable module; move it behind the dialect '
      + 'or name the module and its capability in SQLITE_ONLY_MODULES');
  });

  it('every approved module is approved for a stated capability reason', () => {
    for (const [file, why] of Object.entries(SQLITE_ONLY_MODULES)) {
      assert.ok(fs.existsSync(path.join(SRC, file)), `${file} is listed but does not exist`);
      assert.ok(why.length > 60, `${file}: the reason must name why it is honest`);
      assert.match(why, /capabilit|driver it opens/,
        `${file}: the reason must tie the assumption to a declared capability`);
    }
  });

  it('the approved modules really do carry the spellings they are approved for', () => {
    // an entry that has become unnecessary is rot: it would let a NEW
    // SQLite-ism into that module unnoticed
    for (const file of Object.keys(SQLITE_ONLY_MODULES)) {
      const source = fs.readFileSync(path.join(SRC, file), 'utf8');
      const hit = stringLiterals(source).some((fragment) =>
        SQL_SHAPE.test(fragment) && SQLITE_SPELLINGS.some((s) => s.pattern.test(fragment)));
      assert.ok(hit, `${file} no longer carries a SQLite spelling — drop it from the list`);
    }
  });

  it('a dialect and a driver import no third-party client, ever', () => {
    // the packed gate proves `@jarenjs/db/postgres` IMPORTS with nothing
    // installed; this makes it a rule rather than a fact about today.
    // The whole "injected client" claim rests on there being no seam to
    // leak through, because there is no import.
    for (const relative of ['dialects/postgres.js', 'drivers/postgres.js',
      'dialects/sqlite.js', 'dialects/rtree-ddl.js', 'dialects/expression-read.js']) {
      const source = fs.readFileSync(path.join(SRC, relative), 'utf8');
      const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
      for (const specifier of specifiers) {
        assert.ok(specifier.startsWith('.') || specifier.startsWith('@jarenjs/'),
          `${relative} imports '${specifier}' — a dialect and an injected driver import `
          + 'nothing outside the suite');
      }
      assert.ok(!/\brequire\s*\(/.test(source), `${relative} uses require()`);
      // and no dynamic import of one either
      for (const dynamic of [...source.matchAll(/\bimport\s*\(\s*'([^']+)'/g)].map((m) => m[1])) {
        assert.ok(dynamic.startsWith('.') || dynamic.startsWith('@jarenjs/'),
          `${relative} dynamically imports '${dynamic}'`);
      }
    }
  });

  it('the dialect and driver modules are where the spellings live', () => {
    for (const [dir, file] of [['dialects', 'sqlite.js'], ['drivers', 'node.js']]) {
      assert.ok(fs.existsSync(path.join(SRC, dir, file)));
    }
    const sqlite = fs.readFileSync(path.join(SRC, 'dialects', 'sqlite.js'), 'utf8');
    const spellings = stringLiterals(sqlite)
      .filter((fragment) => SQLITE_SPELLINGS.some((s) => s.pattern.test(fragment)));
    assert.ok(spellings.length > 0, 'the SQLite dialect is where SQLite is spelled');
  });
});
