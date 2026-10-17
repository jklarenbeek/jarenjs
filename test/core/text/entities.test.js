//@ts-check
/**
 * The HTML standard's named character references, the suite's one copy of
 * them: Markdown's character references and Mermaid's named entity codes
 * both read this table, and its packed bytes exist in exactly one source
 * file, so neither component carries a copy of its own.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { namedEntities } from '@jarenjs/core/text/entities';

describe('namedEntities', () => {
  it('holds the whole WHATWG table, each name to its one or two code points', () => {
    const table = namedEntities();
    assert.equal(table.size, 2125);
    assert.deepEqual(['amp', 'AMP', 'quot', 'lt', 'copy', 'NewLine', 'ngE', 'nope'].map((name) => table.get(name)),
      ['&', '&', '"', '<', '©', '\n', '≧̸', undefined]);
  });

  it('builds the table once', () => {
    assert.equal(namedEntities(), namedEntities());
  });

  it('is the only copy of the table in the source tree', () => {
    const root = new URL('../../../', import.meta.url);
    const holders = [];
    for (const parent of ['packages', 'components']) {
      for (const name of readdirSync(new URL(parent, root))) {
        const src = new URL(`${parent}/${name}/src/`, root);
        let files;
        try { files = readdirSync(src, { recursive: true }); }
        catch { continue; }
        for (const file of files) {
          if (!String(file).endsWith('.js')) continue;
          if (readFileSync(new URL(String(file), src), 'utf8').includes('AElig:c6,AMP:26')) holders.push(`${parent}/${name}/src/${file}`);
        }
      }
    }
    assert.deepEqual(holders, ['packages/core/src/text/entities.js']);
  });
});
