//@ts-check
/**
 * @file The `@jarenjs/ai` documentation drift gate.
 *
 * Two facts about that package live in two places each: the ledger's
 * KINDS (a table in the README, `LEDGER_SCHEMAS` in the code) and the
 * budget STOP REASONS (a sentence in the README, string literals in the
 * agent loop). Both are contracts a reader acts on — "these are the
 * things a ledger can hold", "this is what a run stops with" — and both
 * are exactly the kind of prose that stays plausible for a year after
 * the code moved on.
 *
 * A count would only say that something drifted. These assert the NAMES,
 * in both directions, so the failure says which one — a kind the code
 * grew and nobody documented, or a kind the docs still promise and the
 * code no longer has.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEDGER_SCHEMAS } from '@jarenjs/ai';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const README = read('packages/ai/README.md');

describe('@jarenjs/ai documentation matches the code', () => {
  it('the README\'s ledger-kind table names exactly the schemas the ledger compiles', () => {
    const kinds = Object.keys(LEDGER_SCHEMAS).sort();
    const section = /The ledger holds ([a-z-]+) kinds[\s\S]*?\n\n([\s\S]*?)\n\n/.exec(README);
    assert.ok(section, 'the README no longer introduces the ledger kinds');

    // the table's first column, which is the documented name of a kind
    const documented = [...section[2].matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]).sort();
    assert.deepStrictEqual(documented, kinds,
      'the documented kinds and LEDGER_SCHEMAS disagree — one of them moved');
    // the sentence counts them too, and prose spells the number out
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    assert.strictEqual(words.indexOf(section[1]), kinds.length,
      `the README says "${section[1]}" kinds; the ledger compiles ${kinds.length}`);
  });

  it('every budget stop reason the loop can return is documented, and no other', () => {
    const source = read('packages/ai/src/agent.js');
    // the loop derives them (`budget-${dimension}`) from one list, which
    // is where the truth is: read the list, not the template
    const dimensions = /const BUDGET_DIMENSIONS = [^[]*\[([^\]]+)\]/.exec(source);
    assert.ok(dimensions, 'BUDGET_DIMENSIONS is no longer a literal list in agent.js');
    const reasons = [...dimensions[1].matchAll(/'([a-z]+)'/g)].map((m) => `budget-${m[1]}`).sort();

    const documented = [...README.matchAll(/`(budget-[a-z]+)`/g)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(documented)].sort(), reasons,
      'the README and the agent loop disagree about how a budgeted run stops');
  });
});
