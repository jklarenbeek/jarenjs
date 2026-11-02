//@ts-check
/**
 * @file The Node closure figures `docs/CONSUMING.md` publishes, derived
 * from `benchmark/node-closures.json` by `scripts/generate-closure-facts.js`:
 * one table per server package, over the subpaths its manifest names, and
 * the figures the paragraph above them quotes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { closureFigures, closureTable, SERVER_PACKAGES } from '../../scripts/generate-closure-facts.js';

const measurement = {
  runtime: 'v24.0.0',
  platform: 'linux x64',
  runs: 5,
  subpaths: {
    '@jarenjs/contract/webmcp': { modules: 1, byPackage: { contract: 1 }, heapBytes: 60000, heapSpreadBytes: 0 },
    '@jarenjs/contract': { modules: 140, byPackage: { contract: 12, core: 73, json: 26, validate: 29 }, heapBytes: 6290000, heapSpreadBytes: 4097 },
    '@jarenjs/contract/http': { modules: 46, byPackage: { contract: 17, core: 16, json: 7, validate: 6 }, heapBytes: 2063000, heapSpreadBytes: 120 },
    '@jarenjs/contractual': { modules: 2, byPackage: { contractual: 2 }, heapBytes: 1, heapSpreadBytes: 0 },
    '@jarenjs/core/dates': { modules: 3, byPackage: { core: 3 }, heapBytes: 150000, heapSpreadBytes: 0 },
    '@jarenjs/core/dates/zone': { modules: 2, byPackage: { core: 2 }, heapBytes: 100000, heapSpreadBytes: 0, wildcard: './dates/*' },
  },
};

describe('the Node closure tables', () => {
  it('list the subpaths a manifest names, the root first, with each module count, its split and the live heap', () => {
    assert.strictEqual(closureTable(measurement, '@jarenjs/contract'), [
      '',
      '| Subpath | Modules | By package | Live heap MiB |',
      '|---|---:|---|---:|',
      '| `.` | 140 | core 73, validate 29, json 26, contract 12 | 6.0 |',
      '| `./http` | 46 | contract 17, core 16, json 7, validate 6 | 2.0 |',
      '| `./webmcp` | 1 | contract 1 | 0.1 |',
      '',
    ].join('\n'));
  });

  it("leave a wildcard's files to the committed file", () => {
    assert.strictEqual(closureTable(measurement, '@jarenjs/core'), [
      '',
      '| Subpath | Modules | By package | Live heap MiB |',
      '|---|---:|---|---:|',
      '| `./dates` | 3 | core 3 | 0.1 |',
      '',
    ].join('\n'));
  });

  it('refuse a package the file has no subpath of rather than publish an empty table', () => {
    assert.throws(() => closureTable(measurement, '@jarenjs/db'), /benchmark\/node-closures\.json has no subpath of @jarenjs\/db/);
  });

  it('are one per server package, and the paragraph quotes the method from the file', () => {
    assert.deepStrictEqual(SERVER_PACKAGES, ['@jarenjs/contract', '@jarenjs/db', '@jarenjs/linq', '@jarenjs/json', '@jarenjs/validate', '@jarenjs/core']);
    const figures = closureFigures(() => measurement);
    assert.deepStrictEqual(Object.keys(figures), [
      'closure.contract', 'closure.db', 'closure.linq', 'closure.json', 'closure.validate', 'closure.core',
      'closure.runs', 'closure.spread', 'closure.host', 'closure.subpaths',
    ]);
    assert.strictEqual(figures['closure.contract'](), closureTable(measurement, '@jarenjs/contract'));
    // the widest spread between the runs of one subpath, rounded up: never understated
    assert.deepStrictEqual(['closure.runs', 'closure.spread', 'closure.host', 'closure.subpaths'].map((key) => figures[key]()),
      ['5', '5 KiB', 'Node v24.0.0 on linux x64', '6']);
  });
});
