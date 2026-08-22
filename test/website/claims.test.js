//@ts-check
/**
 * @file The site's hand-written claims, pinned to the things they
 * describe.
 *
 * Most figures on this site are derived at runtime from generated JSON.
 * A handful are not, because deriving them would cost bundle for no
 * reader benefit: the contract bindings' capability table, the render
 * vocabulary the package README lists, the suite and section counts,
 * the supported Node version. Those are written by hand — so each one
 * is asserted here against its source. Edit a documented cell without
 * editing the code behind it and this suite fails; add a capability
 * without documenting it and it fails too.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { openLocalClient } from '@jarenjs/contract/local';
import { servePort } from '@jarenjs/contract/port';
import { createMemoryLedger } from '@jarenjs/contract/ledger';

import { DOCS_SECTIONS } from '../../packages/website/src/content/docs.js';
import { SUITES } from '../../packages/website/src/boundaries/bench.js';
import { HOME_CONTENT } from '../../packages/website/src/content/home.js';
import { docsSections } from '../../packages/website/src/app/viewmodel.js';
import { buildSiteContent } from '../../scripts/generate-site-data.js';
import { UI_RULES } from '../../packages/website/src/views/ui.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const SITE_README = read('packages', 'website', 'README.md');

/** Every block of every docs section, flat. */
const docsBlocks = () => DOCS_SECTIONS.flatMap((s) => s.blocks);

/** The one docs block with this table title. */
function docsTable(title) {
  const found = docsBlocks().find((b) => b.kind === 'table' && b.title === title);
  assert.ok(found !== undefined, `the docs still carry the "${title}" table`);
  return found;
}

//#region the contract capability table

/** A contract with one operation of each kind the bindings can carry. */
const CONTRACT = compileContract({
  $contract: '0.1',
  id: 'pin',
  operations: {
    'thing.load': { kind: 'read', output: true, http: { method: 'GET', path: '/thing' } },
    'thing.save': {
      kind: 'command', input: { type: 'object' }, output: true,
      policy: { idempotency: 'optional' }, http: { method: 'POST', path: '/thing' },
    },
  },
});
const HANDLERS = { 'thing.load': () => 1, 'thing.save': () => 1 };

/** The three frozen tables the documented cells are read against. */
function bindings() {
  const channel = new MessageChannel();
  const port = servePort(CONTRACT, HANDLERS, { channel: channel.port1 });
  const table = {
    http: serveHttp(CONTRACT, HANDLERS, { ledger: createMemoryLedger() }).capabilities,
    local: openLocalClient(CONTRACT, HANDLERS).capabilities,
    port: port.capabilities,
  };
  port.close();
  channel.port1.close();
  channel.port2.close();
  return table;
}

/**
 * Documented cell → the capability member(s) that decide it. A binding
 * carries the row or it refuses it; the cell's wording says which, and
 * that is the only thing a reader takes away from the table.
 */
const ROW_CAPABILITY = {
  'status codes': (c) => c.status === true,
  'headers / etag': (c) => c.headers === true && c.etag === true,
  idempotency: (c) => c.idempotency === true,
  'stream (subscribe)': (c) => c.stream === true,
};

/** The two vocabularies a cell may speak — carried, or refused. */
const CARRIES = /^(yes|with a ledger|SSE, resumable|push frames)$/;
const REFUSES = /^(no|no \(status: null\)|no — stated)$/;

describe('the documented contract-binding capabilities are the frozen ones', function () {
  const documented = docsTable('What each binding carries');
  const bindingNames = documented.head.slice(1);

  it('documents the three bindings the packages actually publish', function () {
    assert.deepStrictEqual(documented.head, ['capability', 'http', 'local', 'port']);
    const caps = bindings();
    for (const name of bindingNames) {
      assert.strictEqual(caps[name].name, name, `${name} names itself`);
      assert.strictEqual(Object.isFrozen(caps[name]), true, `${name} publishes a frozen table`);
    }
  });

  it('every documented cell says what its binding does — twelve of them', function () {
    const caps = bindings();
    let checked = 0;
    for (const row of documented.rows) {
      const [capability, ...cells] = row.cells;
      const carries = ROW_CAPABILITY[capability];
      assert.ok(carries !== undefined,
        `the pin covers the "${capability}" row (a new row needs a new entry here)`);
      cells.forEach((cell, i) => {
        const binding = bindingNames[i];
        assert.ok(CARRIES.test(cell) || REFUSES.test(cell),
          `${binding} / ${capability}: "${cell}" is neither a carry nor a refusal`);
        assert.strictEqual(CARRIES.test(cell), carries(caps[binding]),
          `${binding} / ${capability}: the table says "${cell}"`);
        checked += 1;
      });
    }
    assert.strictEqual(checked, 12, 'the whole table is pinned, not a corner of it');
  });

  it('"with a ledger" is literally true: no ledger, no idempotency', function () {
    assert.strictEqual(
      serveHttp(CONTRACT, HANDLERS, { ledger: createMemoryLedger() }).capabilities.idempotency, true);
    // a contract that asks for none gets a server that says it carries none
    const plain = compileContract({
      $contract: '0.1',
      operations: { 'thing.load': { kind: 'read', output: true, http: { method: 'GET', path: '/thing' } } },
    });
    assert.strictEqual(
      serveHttp(plain, { 'thing.load': () => 1 }).capabilities.idempotency, false,
      'the qualifier in the docs is the whole claim — without a ledger the answer is no');
    // and a contract that DECLARES it is refused at construction rather
    // than served with the capability quietly off
    assert.throws(() => serveHttp(CONTRACT, HANDLERS),
      (/** @type {any} */ e) => e.code === 'JC1003');
  });
});

//#endregion

//#region the counts and lists the site's own README writes down

describe('the website README counts what the code holds', function () {
  const ONES = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
    'sixteen', 'seventeen', 'eighteen', 'nineteen',
  ];
  const TENS = { 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty' };
  /** `21` → `twenty-one` — the prose spells its counts out, so the pin does too. */
  function spell(n) {
    if (n < 20) return ONES[n];
    const tens = TENS[Math.floor(n / 10) * 10];
    assert.ok(tens !== undefined, `this pin cannot spell ${n} yet`);
    return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10]}`;
  }

  it('names every render-node kind `views/ui.js` renders, and no more', function () {
    const kinds = [...new Set(UI_RULES
      .map((rule) => /kind == '([a-z]+)'/.exec(rule.match)?.[1])
      .filter((k) => k !== undefined))].sort();
    const cell = /one rule per node kind \(([^)]*)\)/.exec(SITE_README);
    assert.ok(cell !== null, 'the architecture table still describes the generic UI');
    const listed = cell[1].split('/').map((s) => s.replace(/`/g, '').trim()).sort();
    assert.deepStrictEqual(listed, kinds,
      'a kind the site renders is a kind its README lists');
    assert.strictEqual(kinds.length, 13);
  });

  it('counts the benchmark suites it enumerates', function () {
    const suites = SUITES.filter((s) => s.key !== 'overview').length;
    assert.match(SITE_README, new RegExp(`Benchmarks, all ${spell(suites)} suites`, 'i'),
      `the README claims a suite count other than ${suites}`);
  });

  it('counts the documentation sections it advertises', function () {
    // what a reader sees is the site's own sections PLUS the ones the
    // packages committed, so the claim is pinned to the merged list
    const rendered = docsSections(buildSiteContent()).length;
    assert.match(SITE_README, new RegExp(`${spell(rendered)} documentation sections`, 'i'),
      `the README claims a section count other than ${rendered}`);
  });
});

describe('the docs page states the runtime it actually requires', function () {
  it('names the same major version every manifest\'s engines field does', function () {
    const manifests = ['package.json',
      ...JSON.parse(read('package.json')).workspaces
        .map((/** @type {string} */ d) => join(d.replace(/^\.\//, ''), 'package.json'))];
    const required = [...new Set(manifests
      .map((m) => JSON.parse(read(m)).engines?.node)
      .filter((/** @type {string | undefined} */ e) => e !== undefined))];
    assert.deepStrictEqual(required, ['>=24'],
      'the workspaces agree on one Node floor; the docs quote it');
    const major = required[0].replace('>=', '');
    const install = DOCS_SECTIONS.find((s) => s.id === 'installation');
    const prose = install.blocks.filter((b) => b.kind === 'p').map((b) => b.text).join(' ');
    assert.match(prose, new RegExp(`Node ${major} or newer`),
      `the installation section must say Node ${major}`);
  });
});

//#endregion

//#region the homepage carries no figure it did not measure

describe('the homepage engine cards', function () {
  /** Every collected card, with the workspace that wrote it. */
  const cards = () => buildSiteContent().packages.flatMap((/** @type {any} */ entry) =>
    entry.engines.map((/** @type {any} */ engine) => ({ name: entry.name, ...engine })));

  it('name a suite that publishes a headline, or no suite at all', function () {
    const meta = JSON.parse(read('packages', 'website', 'public', 'benchmarks', 'meta.json'));
    const measured = new Set(meta.headlines.map((/** @type {any} */ h) => h.key));
    for (const card of cards()) {
      if (card.suite === null) continue;
      assert.ok(measured.has(card.suite),
        `${card.name} maps its ${card.key} card to '${card.suite}', which publishes no headline`);
    }
  });

  it('are all written by the packages — the website authors none of them', function () {
    assert.strictEqual(HOME_CONTENT.engines, undefined,
      'an engine card in the website\'s own content document is the inversion undone');
    const source = read('packages', 'website', 'src', 'app', 'viewmodel.js');
    assert.ok(!source.includes('HOME_ENGINE_SUITE'),
      'the card → suite map is the package\'s own claim now, in its frontmatter');
    assert.ok(cards().length > 0, 'and the grid is not empty');
  });

  it('never state a figure: the measured line replaces the authored one', function () {
    // the frontmatter grammar refuses a digit in `perf`; this asserts it
    // over what the repository actually committed, mapped or not
    for (const card of cards()) {
      if (card.card.perf === null) continue;
      assert.doesNotMatch(card.card.perf, /[0-9]/,
        `${card.name}: the authored line for ${card.key} is a fallback, and a figure in it is`
        + ' dead the moment meta.json lands');
    }
  });

  it('opens the hero with the claim the derivation replaces, and no number', function () {
    const [first] = HOME_CONTENT.hero.points;
    assert.match(first, /JSON-Schema-Test-Suite/,
      'the first bullet is the conformance slot the measured score fills');
    for (const point of HOME_CONTENT.hero.points) {
      assert.doesNotMatch(point, /[0-9]/, 'the authored hero states no figure');
    }
  });
});

//#endregion
