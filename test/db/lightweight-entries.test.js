//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { compileEntityModel, normalizeEntities, explainMapping } from '@jarenjs/db/model';
import { defineModel, object, integer } from '@jarenjs/linq/model';

it('lightweight public imports do not load store, migration, jobs, capture or replication owners', async () => {
  for (const entry of ['query', 'model', 'entity', 'relational']) {
    const result = await build({ stdin: { contents: `import * as api from '@jarenjs/db/${entry}'; console.log(api);`, resolveDir: process.cwd() },
      bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', external: ['bun:sqlite', 'pg'], logLevel: 'silent' });
    const files = Object.keys(result.metafile.inputs);
    assert.ok(files.length > 10, 'the dependency closure was traversed');
    assert.deepEqual(files.filter((file) => /packages\/db\/src\/(store|migrate|jobs|capture|replication)\.js$/.test(file)), [], entry);
  }
});

it('one-pass entity metadata retains the existing normalization and mapping contracts', () => {
  const model = defineModel({ entities: { Item: object({ id: integer().identity('auto') })
    .physical({ table: 'items', columns: { id: { name: 'id', codec: 'integer', null: 'reject' } } }) } });
  const first = compileEntityModel(model), second = compileEntityModel(model);
  assert.deepEqual(first.entities, normalizeEntities(model));
  assert.deepEqual(first.mapping, explainMapping(model));
  assert.deepEqual(first, second); assert.notEqual(first.entities, second.entities);
  assert.equal(first.mapping.entities.Item.columns, first.entities.get('Item').physical.columns);
});
