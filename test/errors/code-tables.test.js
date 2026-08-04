//@ts-check
/**
 * @file The code-table drift gate: each coded package's RUNTIME code
 * table (the `CSV_CODES` shape) must list exactly the codes its format
 * doc's normative table documents. Before this gate the tables were
 * JSDoc prose "kept in sync by hand" (flow's own words) — a new code
 * without a doc row, or a doc row without a runtime entry, was
 * invisible. Now either direction fails here, naming the codes.
 *
 * Exempt, with reasons: josl already HAS the runtime table this shape
 * is named after (`CSV_CODES`, synced to its own docs by its own
 * tests); the JT/TL/JP/JW families and `AiError` have no normative
 * doc table to sync against (their code lists live in JSDoc), so a
 * sync test would have nothing to hold them to.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { QUERY_CODES } from '@jarenjs/json/query';
import { APP_CODES } from '@jarenjs/app';
import { FLOW_CODES } from '@jarenjs/flow';
import { LINQ_CODES } from '@jarenjs/linq';

/**
 * Extract every code with the given prefix from a format doc's
 * normative markdown tables (rows shaped `| JX0001 |` or `| \`JX0001\` |`).
 * @param {string} path
 * @param {string} prefix
 * @returns {string[]}
 */
function docCodes(path, prefix) {
  const text = fs.readFileSync(path, 'utf8');
  const pattern = new RegExp(`^\\|\\s*\`?(${prefix}[0-9]{4})\`?\\s*\\|`, 'gm');
  const codes = new Set();
  for (const match of text.matchAll(pattern)) codes.add(match[1]);
  return [...codes].sort();
}

const TABLES = /** @type {[string, Record<string, string>, string, string][]} */ ([
  ['QUERY_CODES', QUERY_CODES, 'packages/json/docs/QUERY-FORMAT.md', 'JQ'],
  ['APP_CODES', APP_CODES, 'packages/app/docs/APP-FORMAT.md', 'JA'],
  ['FLOW_CODES', FLOW_CODES, 'packages/flow/docs/FLOW-FORMAT.md', 'JF'],
  ['LINQ_CODES', LINQ_CODES, 'packages/linq/docs/LINQ-FORMAT.md', 'JL'],
]);

describe('runtime code tables match the format docs', () => {
  for (const [name, table, doc, prefix] of TABLES) {
    it(`${name} and ${doc} list exactly the same codes`, () => {
      const runtime = Object.keys(table).sort();
      const documented = docCodes(doc, prefix);
      assert.ok(documented.length > 0, `no ${prefix} table rows found in ${doc}`);
      assert.deepStrictEqual(runtime, documented);
    });

    it(`${name} entries are non-empty one-liners`, () => {
      for (const [code, meaning] of Object.entries(table)) {
        assert.strictEqual(typeof meaning, 'string', code);
        assert.ok(meaning.length > 0 && !meaning.includes('\n'), code);
      }
    });

    it(`${name} is frozen`, () => {
      assert.strictEqual(Object.isFrozen(table), true);
    });
  }
});
