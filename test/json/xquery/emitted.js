// Shared by the XQuery front-end tests that run what the parser emits:
// every emitted document must validate against both query-format schema
// artifacts before it is compiled and run.
import * as assert from 'node:assert';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseXQuery, compileXQuery, XQuerySyntaxError } from '@jarenjs/json/xquery';
import { JsonQueryRuntimeError } from '@jarenjs/json/query';

import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(__dirname, '..', '..', '..', 'packages', 'json', 'schemas');

function compileArtifact(name) {
  const schema = JSON.parse(fs.readFileSync(path.join(schemasDir, name), 'utf8'));
  const compiler = new JarenValidator({ formatAssertion: true });
  compiler.addFormats(formats.jsonFormats);
  return compiler.compile(schema);
}

const validators = [
  ['draft 2020-12 (canonical)', compileArtifact('jaren-query.schema.json')],
  ['draft-07 (twin)', compileArtifact('jaren-query.draft-07.schema.json')],
];

/** the document `text` emits, asserted valid under both schema artifacts */
export function validated(text) {
  const doc = parseXQuery(text);
  for (const [draft, validate] of validators) {
    assert.strictEqual(validate(doc), true,
      `emitted document must validate under ${draft}: ${JSON.stringify(doc)}`);
  }
  return doc;
}

/**
 * the result sequence of `text`, run with the externals; the array
 * constructor around it makes an empty result [] and a singleton [item]
 */
export function values(text, externals = {}) {
  validated(text);
  return compileXQuery(`[${text}]`)(null, externals);
}

/** asserts `text` runs into the engine's type error JQ2001 */
export function failsAtRun(text, externals = {}) {
  validated(text);
  assert.throws(() => compileXQuery(`[${text}]`)(null, externals), (e) => {
    assert.ok(e instanceof JsonQueryRuntimeError, `expected a runtime error, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, 'JQ2001', e.message);
    return true;
  });
}

/** asserts an XQuerySyntaxError whose message contains `part`, at `position` */
export function failsWith(src, part, position) {
  assert.throws(() => parseXQuery(src), (e) => {
    assert.ok(e instanceof XQuerySyntaxError, `expected XQuerySyntaxError, got ${e.name}: ${e.message}`);
    assert.ok(e.message.includes(part), `expected message to include ${JSON.stringify(part)}, got: ${e.message}`);
    assert.strictEqual(e.position, position);
    return true;
  });
}
