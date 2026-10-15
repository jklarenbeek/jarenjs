//@ts-check
// compileAsync over the JSON-Schema-Test-Suite's reference cases: every case
// compiled with compileAsync, its remotes served from memory, gives the same
// answers and the same collected errors as a synchronous compile on a
// validator that was given the same documents beforehand.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JarenValidator } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';
import * as formats from '@jarenjs/formats';
import { getSchemaDraftByName } from '@jarenjs/refs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const remotesDir = path.join(fixtures, 'remote-refs', 'remotes');

/** The suite's remotes by the URI its harness serves them at. */
const remotes = new Map(fs.readdirSync(remotesDir, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.json'))
  .map((file) => [`http://localhost:1234/${file.split(path.sep).join('/')}`,
    JSON.parse(fs.readFileSync(path.join(remotesDir, file), 'utf8'))]));

/**
 * A validator set up as the suite's harness sets one up, without remotes.
 * @param {string} draft
 */
function validatorFor(draft) {
  const validator = new JarenValidator({ collectErrors: true, unknownFormats: 'ignore' })
    .addFormats(formats.numberFormats).addFormats(formats.stringFormats)
    .addFormats(formats.dateTimeFormats).addFormats(formats.jsonFormats);
  const seen = new Set();
  for (const name of [draft, 'draft6', 'draft7', 'draft2019-09', 'draft2020-12']) {
    const meta = getSchemaDraftByName(name);
    if (seen.has(meta.draft)) continue;
    seen.add(meta.draft);
    validator.addMetaSchema(meta.schema, meta.draft);
  }
  return validator;
}

/**
 * Compile, or the message compiling refused with.
 * @param {() => any} fn
 */
async function compiled(fn) {
  try {
    return { validate: await fn() };
  }
  catch (e) {
    return { refused: /** @type {Error} */ (e).message };
  }
}

const suites = [
  ['draft7', 'recursive-refs/draft7-ref.json'],
  ['draft7', 'remote-refs/tests/draft7/refRemote.json'],
  ['draft2019-09', 'remote-refs/tests/draft2019-09/ref.json'],
  ['draft2019-09', 'remote-refs/tests/draft2019-09/refRemote.json'],
  ['draft2019-09', 'remote-refs/tests/draft2019-09/vocabulary.json'],
  ['draft2020-12', 'recursive-refs/draft2020-12-ref.json'],
  ['draft2020-12', 'remote-refs/tests/draft2020-12/refRemote.json'],
  ['draft2020-12', 'recursive-refs/draft2020-12-dynamicRef.json'],
  ['draft2020-12', 'remote-refs/tests/draft2020-12/vocabulary.json'],
  ['draft2020-12', 'remote-refs/tests/draft2020-12/optional/format-assertion.json'],
];

const tally = { groups: 0, refused: 0, loading: 0, loads: 0, cases: 0, agreeing: 0 };

for (const [draft, file] of suites) {
  describe(`compileAsync agrees with compile: ${file}`, () => {
    const groups = JSON.parse(fs.readFileSync(path.join(fixtures, file), 'utf8'));
    for (const group of groups) {
      it(group.description, async () => {
        /** @type {string[]} */
        const served = [];
        const asyncValidator = validatorFor(draft);
        const outcome = await compiled(() => compileAsync(asyncValidator, group.schema, {
          loadSchema: async (uri) => {
            served.push(uri);
            if (!remotes.has(uri)) throw new Error(`no remote at ${uri}`);
            return remotes.get(uri);
          },
        }));
        assert.deepEqual(served, [...new Set(served)], 'every document is loaded once');
        if (!JSON.stringify(group.schema).includes('localhost:1234'))
          assert.deepEqual(served, [], 'a schema naming no remote loads nothing');

        const syncValidator = validatorFor(draft);
        for (const uri of served) syncValidator.addSchema(remotes.get(uri), `${uri}#`);
        const expected = await compiled(() => syncValidator.compile(group.schema));
        assert.deepEqual(outcome.refused, expected.refused);
        tally.groups++;
        if (served.length > 0) tally.loading++;
        tally.loads += served.length;
        if (!outcome.validate) {
          tally.refused++;
          return;
        }
        for (const test of group.tests) {
          const result = outcome.validate(test.data);
          assert.deepEqual(result, expected.validate(test.data), test.description);
          tally.cases++;
          if (result.valid === test.valid) tally.agreeing++;
        }
      });
    }
  });
}

it('the suite tally: every group compiles, and every case answers as the suite expects', () => {
  assert.deepEqual(tally, { groups: 173, refused: 0, loading: 52, loads: 55, cases: 375, agreeing: 375 });
});
