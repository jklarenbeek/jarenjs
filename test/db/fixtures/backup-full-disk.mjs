// A backup into a file system that refuses to grow: run under a file-size
// limit smaller than the copy, it opens the store at argv[2] with this
// runtime's own driver, backs it up to argv[3], and prints one JSON line:
// the failure's code, its cleanup error, and every name in the target's
// directory that starts with the target's own name.
import { openStore } from '@jarenjs/db';
import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const [source, target] = process.argv.slice(2);
const driver = process.versions.bun
  ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();
const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } },
      key: '/id',
    },
  },
};
const store = await openStore(MODEL, { driver, path: source });
const error = await store.backupTo(target, { checkpoint: false }).then(() => null, (failure) => failure);
const cleanup = error?.cleanupError;
process.stdout.write(`${JSON.stringify({
  code: error?.code ?? null,
  cleanupError: cleanup === undefined ? null : String(cleanup?.code ?? cleanup?.message ?? cleanup),
  siblings: readdirSync(dirname(target)).filter((name) => name.startsWith(basename(target))),
})}\n`);
// closing may itself meet the file-size limit (its checkpoint writes); the
// report above is the outcome under test
await Promise.resolve(store.close()).catch(() => {});
