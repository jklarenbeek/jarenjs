//@ts-check
/**
 * @file T5 — the AI repair-record golden. The repair loop is
 * load-bearing, so the *exact record* the model receives is asserted
 * per coded family, driven through the public `createStructuredOutput`
 * surface (the same path a real repair takes).
 *
 * The contract this pins, relative to the pre-unification suite:
 *
 *  - app / flow / ai records are BYTE-IDENTICAL to before: their old
 *    bare `message` is now the `reason`, and the record reads `reason`.
 *  - query / jslt / jtlt / patch records LOSE exactly the duplicated
 *    code prefix and path suffix their old `message` carried — same
 *    information, less noise. The relation
 *    `err.message === \`${code}: ${record.message} at ${docPath}\``
 *    is asserted so "nothing else moved" is a checked fact, not prose.
 *
 * No compatibility flag exists, deliberately: a switch that changes
 * prompt content is a worse liability than the change itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JsonQueryCompileError } from '@jarenjs/json/query';
import { JsltCompileError } from '@jarenjs/json/jslt';
import { JtltCompileError } from '@jarenjs/json/jtlt';
import { JsonPatchCompileError } from '@jarenjs/json/patch';
import { AppCompileError, AppRuntimeError } from '@jarenjs/app';
import { FlowCompileError } from '@jarenjs/flow';
import { AiError } from '@jarenjs/ai';
import { createStructuredOutput } from '@jarenjs/ai/structured';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'repair-records.golden.json');

/**
 * Drive coded errors through the repair path and return the records the
 * model would receive (the exhausted-repairs return carries them).
 * @param {Error[]} errs
 * @returns {Promise<any[]>}
 */
async function recordsFor(errs) {
  const client = {
    endpoint: { provider: 'openai-compatible' },
    complete: async () => ({ message: { content: '{}' } }),
  };
  const structured = createStructuredOutput({
    client,
    schema: { type: 'object' },
    validator: () => ({ valid: false, errors: errs }),
    maxRepairs: 0,
  });
  const outcome = /** @type {{ errors: any[] }} */ (
    await structured.generate([{ role: 'user', content: 'go' }]));
  return outcome.errors;
}

/** One representative error per coded family, with realistic texts. */
const FAMILY = /** @type {[string, Error, 'bare' | 'composed'][]} */ ([
  ['query', new JsonQueryCompileError('JQ0002', "unknown operator '$frobnicate'", '/a'), 'composed'],
  ['jslt', new JsltCompileError('JT0003', 'a template body must be a vnode or a phrase', '/0/body'), 'composed'],
  ['jtlt', new JtltCompileError('TL0002', 'a rule needs a "match" pattern', '/rules/1'), 'composed'],
  ['patch', new JsonPatchCompileError('JP0001', 'an operation must carry an "op" member', '/2'), 'composed'],
  ['app', new AppCompileError('JA0005', 'the "subs" member must be an array of subscription entries', '/subs'), 'bare'],
  ['app-runtime', new AppRuntimeError('JA2008', "subscription 'tick' has no registered handler"), 'bare'],
  ['flow', new FlowCompileError('JF0006', "transition 0 leaves the undeclared state 'nope'", '/transitions/0/from'), 'bare'],
  ['ai', new AiError('AI0003', 'the provider answered with a malformed payload'), 'bare'],
]);

describe('T5 — the repair-record golden', async () => {
  const records = await recordsFor(FAMILY.map(([, err]) => err));
  const actual = FAMILY.map(([family], i) => ({ family, record: records[i] }));

  if (process.env.JAREN_UPDATE_GOLDENS) {
    fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 2) + '\n');
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

  it('every family record matches the golden exactly', () => {
    assert.deepStrictEqual(actual, golden);
  });

  it('bare-message families are byte-identical to the pre-unification record', () => {
    for (const [family, err, kind] of FAMILY) {
      if (kind !== 'bare') continue;
      const record = records[FAMILY.findIndex(([f]) => f === family)];
      // Before the unification these classes' `message` WAS the bare
      // reason; the record read `message`. It now reads `reason`, which
      // carries the same string — so the model sees the same bytes.
      assert.strictEqual(record.message, /** @type {any} */ (err).reason,
        `${family}: record.message must be the bare reason`);
      assert.strictEqual(/** @type {any} */ (err).message.includes(record.message), true,
        `${family}: the composed message must still contain the reason`);
    }
  });

  it('composed-message families lose exactly the duplicated code and path', () => {
    for (const [family, err, kind] of FAMILY) {
      if (kind !== 'composed') continue;
      const anyErr = /** @type {any} */ (err);
      const record = records[FAMILY.findIndex(([f]) => f === family)];
      assert.strictEqual(record.message, anyErr.reason);
      // The relation that proves "nothing else moved": the old record's
      // message was the composed form; the new record's message plus the
      // code and path reconstructs it exactly.
      assert.strictEqual(anyErr.message,
        `${record.code}: ${record.message} at ${record.docPath}`,
        `${family}: record must have lost exactly the code prefix and path suffix`);
    }
  });

  it('no record carries the code or the path inside its message text', () => {
    for (const { record } of actual) {
      assert.strictEqual(record.message.includes(record.code), false);
      if (record.docPath) {
        assert.strictEqual(record.message.includes(` at ${record.docPath}`), false);
      }
    }
  });
});
