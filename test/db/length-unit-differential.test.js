/**
 * The validator's `lengthUnit: 'codepoint'` against the databases' own
 * counting: SQLite's `length()` and, under `JAREN_PG_URL`, PostgreSQL's
 * `char_length()`. For every string the database's count is the boundary:
 * `minLength`/`maxLength` of that count accept, one past it refuse. The
 * default grapheme unit and the `utf16` unit each disagree with the
 * databases on some string, which is why a host whose bounds mirror a
 * column's must choose the unit explicitly.
 */
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { JarenValidator } from '@jarenjs/validate';

const url = process.env.JAREN_PG_URL;
// Written as escapes, never literal characters (an editor may normalize those);
// no NUL, which neither database keeps inside text.
const CORPUS = [
  ['ascii', 'abc'],
  ['empty', ''],
  ['combining marks', 'ééé'],
  ['precomposed', 'été'],
  ['CR LF', 'a\r\nb'],
  ['surrogate pairs', '\u{1F600}\u{1F600}\u{1F600}'],
  ['astral beside ASCII', 'a\u{10348}b'],
  ['emoji ZWJ sequence', '\u{1F468}‍\u{1F469}‍\u{1F467}'],
  ['emoji modifier', '\u{1F44D}\u{1F3FD}'],
  ['regional indicators', '\u{1F1F3}\u{1F1F1}'],
  ['conjoining jamo', '각'],
  ['lone high surrogate', 'a\uD800b'],
  ['lone low surrogate', '\uDC00'],
  ['reversed pair', '\uDE00\uD83D'],
];
const UNITS = ['codepoint', 'grapheme', 'utf16'];
const validators = Object.fromEntries(UNITS.map((lengthUnit) => [lengthUnit, new JarenValidator({ lengthUnit })]));
const boundary = (lengthUnit, s, n) => {
  const v = validators[lengthUnit];
  const max = (m) => v.compile({ type: 'string', maxLength: m })(s);
  const min = (m) => v.compile({ type: 'string', minLength: m })(s);
  return { atMax: max(n), belowMax: n > 0 ? max(n - 1) : false, atMin: min(n), aboveMin: min(n + 1) };
};
const agrees = { atMax: true, belowMax: false, atMin: true, aboveMin: false };

function differential(count) {
  it('lengthUnit: codepoint answers every boundary as the database counts it', async () => {
    for (const [name, s] of CORPUS) {
      const n = await count(s);
      assert.equal(typeof n, 'number', name);
      assert.deepEqual(boundary('codepoint', s, n), agrees, `${name}: the database counts ${n}`);
    }
  });

  it('the grapheme default and utf16 each disagree with the database on some string', async () => {
    for (const unit of ['grapheme', 'utf16']) {
      const apart = [];
      for (const [name, s] of CORPUS) {
        const n = await count(s);
        if (JSON.stringify(boundary(unit, s, n)) !== JSON.stringify(agrees)) apart.push(name);
      }
      assert.ok(apart.length > 0, unit);
      if (unit === 'grapheme') assert.ok(apart.includes('combining marks') && apart.includes('emoji ZWJ sequence'), apart.join());
      else assert.ok(apart.includes('surrogate pairs') && !apart.includes('lone high surrogate'), apart.join());
    }
  });
}

describe('string length against SQLite length()', () => {
  let db, statement;
  before(() => { db = new DatabaseSync(':memory:'); statement = db.prepare('SELECT length(?) AS n'); });
  after(() => db.close());
  differential(async (s) => Number(statement.get(s).n));
});

describe('string length against PostgreSQL char_length()', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let client;
  before(async () => { client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 }); await client.connect(); });
  after(async () => { await client?.end(); });
  differential(async (s) => Number((await client.query('SELECT char_length($1::text) AS n', [s])).rows[0].n));
});
