//@ts-check
/** Interruption seams surround actual native receipt writes and backup publication. */
import { readFileSync } from 'node:fs';
import { migrate, adoptMigrationHistory, openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { bunDriver } from '@jarenjs/db/bun';
import { crashAt } from './fixtures/abrupt-exit.js';

const [file, input, point] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(input, 'utf8'));
const driver = process.versions.bun ? bunDriver() : nodeDriver();

const wrap = (connection) => ({
  ...connection,
  prepare(sql, metadata) {
    const statement = connection.prepare(sql, metadata);
    return {
      ...statement,
      run(params) {
        const result = statement.run(params);
        const normal = sql.startsWith('INSERT INTO "_jaren_migrations"');
        const identity = sql.startsWith('INSERT INTO "_jaren_migration_identity"');
        if (point === 'normal' && normal
          || point === 'side' && identity && params[0] === 'receipt:1'
          || point === 'adopt-header' && identity && params[0] === 'header'
          || point === 'adopt-receipt' && identity && params[0] === 'receipt:0') crashAt(point);
        return result;
      },
    };
  },
  transaction: (fn, ...args) => connection.transaction((scope) => fn(wrap(scope)), ...args),
  ...(connection.backup ? {
    backup: {
      ...connection.backup,
      async copy(...args) {
        const value = await connection.backup.copy(...args);
        if (point === 'copy') crashAt(point);
        return value;
      },
      async rename(...args) {
        if (point === 'publish-before') crashAt(point);
        const value = await connection.backup.rename(...args);
        if (point === 'publish-after') crashAt(point);
        return value;
      },
    },
  } : {}),
});
const wrapped = { ...driver, open: async (...args) => wrap(await driver.open(...args)) };

if (point === 'copy' || point.startsWith('publish')) {
  const store = await openStore(spec.model, { driver: wrapped, path: file, adopt: true });
  try {
    await store.backupTo(`${file}.backup`, { checkpoint: false });
  }
  finally {
    await store.close();
  }
}
else if (point.startsWith('adopt')) {
  await adoptMigrationHistory({ driver: wrapped, path: file }, spec.migrations,
    { observed: spec.observed, model: spec.model });
}
else {
  await migrate({ driver: wrapped, path: file }, spec.migrations,
    { baseline: spec.model, model: spec.model, shadow: false });
}
