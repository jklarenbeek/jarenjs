//@ts-check
/**
 * @file The formula translator's acceptance corpus (FORMULA-FORMAT,
 * "Translating a saved source"): 35 saved columns and rules of a plant
 * nursery, each translated with the host's declared helpers and
 * conventions, each checked against the trusted runner's outputs over the
 * corpus rows. A `translated` source agrees on every row; a
 * `translated-with-differences` one differs only on the rows made to show one
 * of its named differences; an `untranslatable` one names every reason.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileFormula, formulaDocument, checkFormulaParity } from '@jarenjs/json/formula';
import { migrateFormulas, translateFormulaBody } from '@jarenjs/json/formula/migrate';
import { compileNumberLocale, nl } from '@jarenjs/locales';
import * as oracle from './formula-corpus-oracle.js';

const corpus = JSON.parse(readFileSync(new URL('./formula-corpus.json', import.meta.url), 'utf8'));
const NOW = Date.parse(corpus.clock);
const MAX = 1.7976931348623157e308;

// the host's declarations: what its helpers are in query operators, and its conventions
const finite = (/** @type {string} */ v) => ({ $if: [{ '$is-null': { $default: [v, null] } }, false, { $le: [{ $abs: v }, MAX] }] });
const orNull = (/** @type {string} */ v, /** @type {any} */ q) => ({ $if: [finite(v), q, null] });
const CURRENCY = '€ #.##0,00;€ -#.##0,00';
const locales = { 'nl-NL': { decimalFormat: 'nl', grouping: '.', decimal: ',', currencies: { EUR: CURRENCY }, nan: 'NaN' } };
const numbers = [{ kind: 'helper', note: 'reads numbers; the helper also reads number text' }];
const sizes = [{ kind: 'helper', note: 'reads size text with the Dutch decimal format; the helper also reads a bare number with decimals' }];
const sizeOf = (/** @type {string[]} */ units) => ({ $if: [{ '$is-null': { $default: ['$v', null] } }, null,
  { $if: [{ $match: [{ $string: '$v' }, '[0-9]+'] }, { $number: { $string: '$v' } },
    units.reduceRight((/** @type {any} */ rest, unit) => ({ $default: [{ $quantity: [{ $string: '$v' }, unit, 'nl'] }, rest] }), null)] }] });
const helpers = {
  euro: { native: { params: ['v'], expression: { $if: [finite('$v'), { '$format-number': [{ $div: ['$v', 100] }, CURRENCY, 'nl'] }, '–'] } },
    returns: 'string', absent: false, nullable: false, differences: numbers },
  nearest5: { native: { params: ['v'], expression: orNull('$v', { $mul: [{ $round: [{ $div: ['$v', 5] }] }, 5] }) }, returns: 'number', absent: false, differences: numbers },
  upTo5: { native: { params: ['v'], expression: orNull('$v', { $mul: [{ $ceiling: { $div: ['$v', 5] } }, 5] }) }, returns: 'number', absent: false, differences: numbers },
  percentUp: { native: { params: ['v', 'p'], expression: { $if: [{ $and: [finite('$v'), finite('$p')] }, { $mul: ['$v', { $add: [1, { $div: ['$p', 100] }] }] }, null] } },
    returns: 'number', absent: false, differences: numbers },
  weightOf: { native: { params: ['v'], expression: sizeOf(['g']) }, returns: 'number', absent: false, differences: sizes },
  massOf: { native: { params: ['v'], expression: sizeOf(['g', 'ml']) }, returns: 'number', absent: false, differences: sizes },
  clean: { call: { name: 'clean', version: '1' } },
  capitalize: { call: { name: 'capitalize', version: '1' }, returns: 'string' },
  tidyList: { call: { name: 'tidyList', version: '1' }, returns: 'array', element: 'string', absent: false, nullable: false },
  distinct: { call: { name: 'distinct', version: '1' }, returns: 'array', element: 'string', absent: false, nullable: false },
  toSlug: { call: { name: 'toSlug', version: '1' } },
};
const OPTIONS = {
  column: { argument: 'record', helperObject: null, skip: null, explain: null, locales },
  rule: { argument: 'record', helperObject: 'lib', skip: 'LEAVE', explain: 'note', helpers, locales },
};
const formulaOptions = {
  decimalFormats: { nl: compileNumberLocale(nl).decimalFormat },
  helpers: Object.fromEntries(Object.entries(oracle.hostHelpers).map(([name, run]) => [name, { version: '1', run, trust: /** @type {const} */ ('pure'), cost: 1 }])),
};

/** The trusted runner's outcome for a row, in the formula outcome shape. @param {'column'|'rule'} kind @param {Function} fn @param {any} row */
function expectedOf(kind, fn, row) {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const raw = fn(structuredClone(row));
    const json = (/** @type {any} */ v) => JSON.parse(JSON.stringify(v));
    if (kind === 'column') return raw === undefined ? { kind: 'empty', values: [] } : { kind: 'value', value: json(raw) };
    if (raw === oracle.LEAVE || raw === undefined) return { kind: 'skip' };
    if (oracle.isNoted(raw))
      return raw.value === oracle.LEAVE || raw.value === undefined ? { kind: 'skip' } : { kind: 'explanation', text: raw.text, value: json(raw.value) };
    return { kind: 'value', value: json(raw) };
  }
  catch { return { kind: 'error' }; }
  finally { Date.now = realNow; }
}

const sources = [
  ...corpus.columns.map((/** @type {any} */ s) => ({ ...s, kind: /** @type {const} */ ('column'), fn: oracle.columns[s.id] })),
  ...corpus.rules.map((/** @type {any} */ s) => ({ ...s, kind: /** @type {const} */ ('rule'), fn: oracle.rules[s.id] })),
];
const kinds = (/** @type {any[]} */ list) => [...new Set(list.map((x) => x.kind))].sort();

describe('the formula corpus', () => {
  // Bun prints a function as its compiled text, not its source
  it('runs exactly the saved text: every trusted body is the fixture body', { skip: typeof globalThis.Bun !== 'undefined' && 'Bun prints a function\'s compiled text, not its source' }, () => {
    assert.strictEqual(sources.length, 35);
    for (const s of sources) {
      const text = s.fn.toString().split(`// body:${s.id}\n`)[1].split(`\n// end:${s.id}`)[0];
      assert.strictEqual(text, s.body, s.id);
    }
  });

  it('translates every source to the state it is expected to, naming the same differences and reasons', () => {
    const states = { translated: 0, 'translated-with-differences': 0, untranslatable: 0 };
    for (const s of sources) {
      const t = translateFormulaBody(s.body, OPTIONS[s.kind]);
      assert.deepStrictEqual({ state: t.state, differences: kinds(t.differences), reasons: kinds(t.reasons) }, corpus.expected[s.id], s.id);
      for (const entry of [...t.differences, ...t.reasons]) assert.ok(entry.at.line >= 1 && entry.at.column >= 1, `${s.id}: ${entry.kind} has a position`);
      states[t.state]++;
    }
    assert.deepStrictEqual(states, { translated: 20, 'translated-with-differences': 14, untranslatable: 1 });
  });

  it('agrees with the trusted runner on every row, but where a named difference was made to show', () => {
    for (const s of sources) {
      const t = translateFormulaBody(s.body, OPTIONS[s.kind]);
      if (t.state === 'untranslatable') continue;
      const formula = compileFormula(formulaDocument({ $formula: '1', id: s.id, revision: '1', expression: t.expression,
        ...(t.resultMode === 'outcome' ? { resultMode: 'outcome' } : {}), ...(t.helpers?.length ? { helpers: t.helpers } : {}) }), formulaOptions);
      const expected = corpus.rows.map((/** @type {any} */ row) => expectedOf(s.kind, s.fn, row));
      const parity = checkFormulaParity(formula, corpus.rows, expected, { context: { now: NOW }, maxMismatches: 51 });
      if (t.state === 'translated') assert.strictEqual(parity.differ, 0, `${s.id}: ${JSON.stringify(parity.mismatches[0])}`);
      for (const m of parity.mismatches) {
        const shows = corpus.rows[m.index].case;
        assert.ok(shows && kinds(t.differences).includes(shows), `${s.id} differs on row ${corpus.rows[m.index].id}, which shows no difference it names`);
      }
    }
  });

  it('every difference the corpus names is shown by a row where it bites', () => {
    const shown = new Set(corpus.rows.filter((/** @type {any} */ r) => r.case).map((/** @type {any} */ r) => r.case));
    assert.deepStrictEqual([...shown].sort(), ['date-parse', 'identity', 'prototype-key']);
  });

  it('migrates the corpus as saved sources: a second run, in any order, changes nothing', async () => {
    const saved = sources.map((s) => ({ id: s.id, label: s.id, enabled: true, storageVersion: 1, body: s.body }));
    const translate = (/** @type {any} */ list) => migrateFormulas(list, [], { translate: OPTIONS.rule, formula: formulaOptions });
    const first = await translate(saved.filter((s) => corpus.rules.some((/** @type {any} */ r) => r.id === s.id)));
    assert.strictEqual((await migrateFormulas(saved.filter((s) => first.records.some((r) => r.id === s.id)), first.records, { translate: OPTIONS.rule })).changed, 0);
    const reversed = await translate([...saved.filter((s) => corpus.rules.some((/** @type {any} */ r) => r.id === s.id))].reverse());
    const byId = (/** @type {any[]} */ records) => Object.fromEntries(records.map((r) => [r.id, r]));
    assert.deepStrictEqual(byId(reversed.records), byId(first.records), 'the translation does not depend on the order it ran in');
  });
});
