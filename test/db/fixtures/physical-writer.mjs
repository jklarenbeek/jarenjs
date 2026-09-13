//@ts-check
/** An independent writer releases its lock while the parent's SQLite call waits. */
const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();
const db = await driver.open(process.argv[2], { timeout: 2000 });
const timeout = setTimeout(() => { db.close(); process.exit(1); }, 10000);
db.exec('BEGIN IMMEDIATE; UPDATE marker SET n=1');
process.stdout.write('ready\n');
process.stdin.once('data', () => {
  process.stdout.write('releasing\n');
  setTimeout(() => {
    db.exec('COMMIT');
    db.close();
    clearTimeout(timeout);
    process.exit(0);
  }, 200);
});
