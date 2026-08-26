//@ts-check
/**
 * @file The `docs/HOWTO.md` end-to-end vector example, executed.
 *
 * A how-to is a promise that the reader can copy the block and get the
 * printed answer. Prose gates catch a name that moved; they cannot catch
 * an example that no longer runs, and an example that no longer runs is
 * the worst kind of documentation — it costs a reader an hour before
 * they stop believing it.
 *
 * So this gate does not read the example, it RUNS it: every fence of the
 * section, concatenated in the order a reader would paste them, executed
 * as one module against the real packages, with a temporary store and
 * the deterministic reference embedder. Then it asserts the values the
 * document itself quotes in its `// →` comments — derived from the run,
 * never typed here — so a prose figure and a real answer cannot drift
 * apart in either direction.
 *
 * The floor matters as much as the assertions: a section slice that came
 * back empty would make every membership check pass over nothing, so the
 * fence count is pinned before anything is executed.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOWTO = fs.readFileSync(path.join(ROOT, 'docs/HOWTO.md'), 'utf8');

/** The heading whose fences make one runnable program. */
const HEADING = '## Storing and Recalling by Meaning';

/**
 * One top-level section: from its `## ` heading to the next `## `,
 * anchored past the heading's own line so it cannot match itself.
 * @param {string} text @param {string} heading @returns {string}
 */
function topLevelSection(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const from = text.indexOf('\n', start) + 1;
  const next = text.slice(from).search(/^## /m);
  return text.slice(start, next < 0 ? text.length : from + next);
}

const SECTION = topLevelSection(HOWTO, HEADING);
const FENCES = [...SECTION.matchAll(/```javascript\n([\s\S]*?)```/g)].map((m) => m[1]);

/**
 * The example's own bindings, read back out of the executed program.
 * @type {any}
 */
let ran = null;
/** @type {string | null} */
let scratch = null;

after(() => {
  if (scratch !== null) fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
});

describe('the HOWTO vector example runs, and answers what it says it answers', () => {
  it('the section is present and carries every fence the program needs', () => {
    assert.ok(SECTION.length > 0, `docs/HOWTO.md no longer has a "${HEADING}" section`);
    // the four steps the section promises: embed, store, ask, recall
    assert.strictEqual(FENCES.length, 4,
      'the example is no longer four javascript fences — the runner concatenates them in order');
  });

  it('every fence, concatenated in reading order, executes as one program', async () => {
    // inside node_modules so the example's bare `@jarenjs/*` specifiers
    // resolve exactly as they do for a consumer, and so a crashed run
    // can never leave a file the repository would notice
    const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-howto-'));
    scratch = path.join(dir, 'example.mjs');
    const epilogue = 'export { ranked, mode, swept, recalled };\n';
    fs.writeFileSync(scratch, `${FENCES.join('\n')}\n${epilogue}`);
    ran = await import(pathToFileURL(scratch).href);
    assert.ok(ran, 'the example produced no bindings');
  });

  it('the k-nearest query answers the ids the document prints, through the knn plan', () => {
    assert.deepStrictEqual(ran.ranked, ['n1', 'n2']);
    assert.strictEqual(ran.mode, 'knn');
    assert.ok(SECTION.includes(`// → ${util.inspect(ran.ranked)}`),
      `the document no longer prints ${util.inspect(ran.ranked)} for the k-nearest answer`);
    assert.ok(SECTION.includes(`// → ${util.inspect(ran.mode)}`),
      `the document no longer prints ${util.inspect(ran.mode)} for the plan mode`);
  });

  it('the ranked recall answers the memories, scores and skip count the document prints', () => {
    const evidence = ran.recalled.memories.map((/** @type {any} */ m) => m.evidence);
    const scores = ran.recalled.scores.map((/** @type {number} */ s) => s.toFixed(3));
    assert.deepStrictEqual(evidence, ['n1', 'n3']);
    assert.deepStrictEqual(scores, ['0.903', '0.838']);
    assert.strictEqual(ran.recalled.skipped, 0);
    assert.deepStrictEqual(ran.swept, { embedded: 3, remaining: 0 });
    for (const printed of [evidence, scores, ran.swept, ran.recalled.skipped]) {
      assert.ok(SECTION.includes(`// → ${util.inspect(printed)}`),
        `the document no longer prints ${util.inspect(printed)}`);
    }
  });
});
