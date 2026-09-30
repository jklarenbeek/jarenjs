//@ts-check
/**
 * @file The `@jarenjs/db` README's runnable examples, executed.
 *
 * An example that no longer runs is the worst kind of documentation, and
 * a prose gate cannot see one. So these fences are RUN, as written: each
 * is written into `node_modules` (so its bare `@jarenjs/*` specifiers
 * resolve as a consumer's do), imported, and its bindings read back. The
 * values its `// →` lines print are asserted from the run, never typed
 * here, so a printed figure and a real answer cannot drift apart.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const README = fs.readFileSync(path.join(ROOT, 'packages/db/README.md'), 'utf8');

/**
 * The first `js` fence after `marker`, and the text up to its end.
 * @param {string} marker
 * @returns {{ code: string, section: string } | null}
 */
function exampleAfter(marker) {
  const from = README.indexOf(marker);
  if (from < 0) return null;
  const fence = /```js\n([\s\S]*?)```/.exec(README.slice(from));
  if (fence === null) return null;
  return { code: fence[1], section: README.slice(from, from + fence.index + fence[0].length) };
}

/**
 * Run one fence as a module and answer its named bindings.
 * @param {string} code @param {string[]} names
 * @returns {Promise<any>}
 */
async function run(code, names) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-db-readme-'));
  try {
    const file = path.join(dir, 'example.mjs');
    fs.writeFileSync(file, `${code}\nexport { ${names.join(', ')} };\n`);
    return await import(pathToFileURL(file).href);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every value must appear in the section as a `// →` line. */
const printed = (/** @type {string} */ section, /** @type {any[]} */ values) => {
  for (const value of values) assert.ok(section.includes(`// → ${util.inspect(value)}`), `the example no longer prints ${util.inspect(value)}`);
};

describe("the db README's runnable examples", () => {
  it('retry and the hold limit (Operating a store) run as written and answer what they print', async () => {
    const example = exampleAfter('Retry and the hold limit, end to end');
    assert.ok(example !== null, 'packages/db/README.md no longer carries the retry-and-hold example');
    const ran = await run(example.code, ['claimed', 'code', 'holdTimeoutMs', 'after', 'expired']);
    assert.deepEqual(ran.claimed, { n: 42, attempt: 2 }, 'the retried claim commits on attempt 2 over the concurrent write');
    assert.equal(ran.code, 'JD2098');
    assert.ok(ran.expired.elapsedMs >= ran.holdTimeoutMs, 'the rollback began at the limit, not before');
    assert.equal(ran.after, 42, "nothing of the expired body's write remains");
    printed(example.section, [ran.claimed, { code: ran.code, holdTimeoutMs: ran.holdTimeoutMs }, ran.after]);
  });

  it('the writer lock, the isolation floor and the owner lease (Operating a store) run as written and answer what they print', async () => {
    const example = exampleAfter('The writer lock, the isolation floor and the owner lease, end to end');
    assert.ok(example !== null, 'packages/db/README.md no longer carries the isolation-and-owner example');
    const ran = await run(example.code, ['owner', 'isolation', 'writerLock', 'refusal', 'ran', 'reopened']);
    assert.equal(ran.owner, 'lease');
    assert.deepEqual([...ran.isolation], ['serializable']);
    assert.equal(ran.writerLock, true);
    assert.deepEqual(ran.refusal, { code: 'JD2061', holder: 'api-1', retryable: true }, 'the second owner is refused by name');
    assert.deepEqual(ran.ran, { n: 42, level: 'serializable' });
    assert.equal(ran.reopened, 42, 'close() released the lease at once');
    printed(example.section, [{ owner: ran.owner, isolation: [...ran.isolation] }, ran.writerLock,
      ran.refusal, ran.ran, ran.reopened]);
  });

  it('relational statements through a store (Existing relational stores) run as written and answer what they print', async () => {
    const example = exampleAfter('A store carries the same engine as `store.relational`');
    assert.ok(example !== null, 'packages/db/README.md no longer carries the store-bound relational example');
    const ran = await run(example.code, ['taken', 'refused', 'qty', 'orders']);
    assert.equal(ran.taken, 1, 'the stock moved with the order');
    assert.equal(ran.refused, 'out of stock');
    assert.equal(ran.qty, 3, 'the refused transaction took nothing');
    assert.deepEqual(ran.orders, ['o-1'], 'and its order went with it');
    printed(example.section, [ran.taken, ran.refused, ran.qty, ran.orders]);
  });
});
