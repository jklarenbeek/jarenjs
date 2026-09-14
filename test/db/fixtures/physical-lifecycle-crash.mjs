//@ts-check
/** Kill at the native statement boundary, including the driver's own COMMIT. */
import { readFileSync, writeFileSync } from 'node:fs';
import { migrate } from '@jarenjs/db';
import { crashAt } from './abrupt-exit.js';

const [path, input, boundary] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(input, 'utf8'));
const drop = spec.migrations.at(-1).steps.find((step) => step.kind === 'table').plan.finish[0];
const kill = () => { writeFileSync(`${input}.boundary`, boundary); crashAt(boundary); };
const intercept = (db, execute) => new Proxy(db, {
  get(target, key) {
    if (key === execute) return (sql) => {
      if (boundary === 'commit' && sql === 'COMMIT') kill();
      const result = target[execute](sql);
      if (boundary === 'drop' && sql === drop) kill();
      return result;
    };
    if (key === 'prepare') return (sql) => {
      const statement = target.prepare(sql);
      if (boundary !== 'receipt' || !/^INSERT INTO "_jaren_migrations"/.test(sql)) return statement;
      return new Proxy(statement, { get(native, member) {
        if (member === 'run') return () => kill();
        const value = Reflect.get(native, member, native);
        return typeof value === 'function' ? value.bind(native) : value;
      } });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
let connection;
if (process.versions.bun) {
  const [{ Database }, { adaptBunDatabase }] = await Promise.all([import('bun:sqlite'), import('@jarenjs/db/bun')]);
  connection = adaptBunDatabase(intercept(new Database(path), 'run'));
}
else {
  const [{ DatabaseSync }, { adaptNodeDatabase }] = await Promise.all([import('node:sqlite'), import('@jarenjs/db/node')]);
  connection = adaptNodeDatabase(intercept(new DatabaseSync(path), 'exec'));
}
connection.exec('PRAGMA foreign_keys=ON');
migrate({ connection }, spec.migrations, spec.options);
connection.close();
throw new Error(`native crash boundary '${boundary}' was not reached`);
