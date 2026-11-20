//@ts-check
/**
 * @file `@jarenjs/validate/output` (the output formats) and
 * `@jarenjs/validate/load` (`compileAsync`) load no validator, and no query
 * compiler either: the validator's modules take the names they share with
 * `@jarenjs/json` from the subpaths that hold them (`/pointer`, `/basic`),
 * never from its index, which re-exports the query compiler and with it
 * core's geo, series, date and conversion modules. Node loads every module
 * a static import names, so each import is measured in a fresh process.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { listing, loadedAmong, loadedBy } from '../lib/module-closure.js';

/** @param {string[]} urls @param {string} directory @returns {string[]} The modules of `directory` among `urls` */
const under = (urls, directory) => urls.filter((url) => url.includes(`/${directory}/`));

describe('the validator subpaths that load no validator', () => {
  /** @type {string[]|undefined} */
  let pointerAlone;
  // The JSON Pointer subpath loads two modules of the query folder itself:
  // the refusals of its descent.
  const pointer = () => pointerAlone ??= loadedBy('@jarenjs/json/pointer');

  for (const subpath of ['@jarenjs/validate/output', '@jarenjs/validate/load']) {
    it(`${subpath} loads neither the index of @jarenjs/json nor the query compiler`, () => {
      const loaded = loadedBy(subpath);
      const heavy = ['packages/json/src/index.js', 'packages/json/src/query/index.js', 'packages/json/src/query/compile.js',
        'packages/validate/src/index.js'];
      assert.deepStrictEqual(loadedAmong(loaded, heavy), [], listing(loaded));
      // every module of the query folder it loads, the JSON Pointer subpath loads alone
      assert.deepStrictEqual(listing(under(loaded, 'packages/json/src/query').filter((url) => !pointer().includes(url))), '');
      for (const directory of ['packages/core/src/geo', 'packages/core/src/series', 'packages/core/src/dates', 'packages/core/src/convert'])
        assert.deepStrictEqual(listing(under(loaded, directory)), '', directory);
    });
  }

  it('no module of the validator imports the index of @jarenjs/json', () => {
    const source = new URL('../../packages/validate/src/', import.meta.url);
    const importing = fs.readdirSync(source).filter((name) => name.endsWith('.js'))
      .filter((name) => /from\s+['"]@jarenjs\/json['"]/.test(fs.readFileSync(new URL(name, source), 'utf8')));
    assert.deepStrictEqual(importing, []);
  });
});
