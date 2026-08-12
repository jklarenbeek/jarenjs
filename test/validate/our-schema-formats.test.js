//@ts-check
/**
 * @file The repo-wide format gate: every `format` name in a schema THIS
 * PROJECT ships must be one `@jarenjs/formats` actually implements, and
 * must actually assert when compiled.
 *
 * `@jarenjs/validate` defaults `unknownFormats` to `'ignore'`, because the
 * specification requires an unknown format to be treated as an annotation
 * and a library has to be able to compile a stranger's schema. That
 * default is right for a stranger's schema and wrong for ours: a `format`
 * we wrote names a check we intend to happen, and an unregistered name
 * compiles to a keyword that validates everything while looking exactly
 * like one that works.
 *
 * It is not hypothetical. The published `jaren-query` and `jaren-jslt`
 * grammars have declared `format: "json-path"` since they were written,
 * and nothing that compiled them registered `jsonFormats` — so no path
 * string was ever checked against RFC 9535 by that keyword, and no test
 * said so.
 *
 * This file tests the property directly rather than by compiling each
 * artifact: the grammars compose one another by `$ref` across two draft
 * families, so a compile-everything harness spends its time resolving
 * references and reports THOSE failures, which is not what anyone reading
 * a red run here should have to untangle. The names are what matter, plus
 * one end-to-end case proving the keyword bites once registered.
 *
 * A new schema naming a format we do not implement fails here. The fix is
 * to implement it, or to use a name we do — not to add it to a skip list.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

import { LEDGER_SCHEMAS } from '@jarenjs/ai/schemas/ledger';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Every format name the suite implements, across all five groups. */
const IMPLEMENTED = new Set([
  ...Object.keys(formats.stringFormats),
  ...Object.keys(formats.numberFormats),
  ...Object.keys(formats.dateTimeFormats),
  ...Object.keys(formats.jsonFormats),
  ...Object.keys(formats.geoFormats),
]);

/** A validator that knows every format, and refuses a name it does not. */
const strict = () => new JarenValidator({ unknownFormats: 'error', formatAssertion: true })
  .addFormats(formats.stringFormats)
  .addFormats(formats.numberFormats)
  .addFormats(formats.dateTimeFormats)
  .addFormats(formats.jsonFormats)
  .addFormats(formats.geoFormats);

/** Every `<package>/schemas/*.json` artifact this repo publishes. */
function shippedSchemas() {
  const found = [];
  for (const group of ['packages', 'components']) {
    const base = join(ROOT, group);
    for (const pkg of readdirSync(base)) {
      const dir = join(base, pkg, 'schemas');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.json')) found.push([`${group}/${pkg}/schemas/${file}`, join(dir, file)]);
      }
    }
  }
  return found;
}

/** Every `format` name anywhere in a schema document. */
function formatNames(node, into = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) formatNames(item, into);
  }
  else if (node !== null && typeof node === 'object') {
    if (typeof node.format === 'string') into.add(node.format);
    for (const value of Object.values(node)) formatNames(value, into);
  }
  return into;
}

describe('our own schemas name only formats we implement', function () {
  const artifacts = shippedSchemas();

  it('finds the shipped schema artifacts at all', function () {
    // a walk that silently found nothing would pass every assertion below
    assert.ok(artifacts.length >= 10,
      `expected the published schema artifacts, found ${artifacts.length}`);
    assert.ok(IMPLEMENTED.size >= 50, `expected the format registry, found ${IMPLEMENTED.size}`);
  });

  it('every format name in every shipped schema is implemented', function () {
    /** @type {string[]} */
    const missing = [];
    let checked = 0;
    for (const [label, path] of artifacts) {
      for (const name of formatNames(JSON.parse(readFileSync(path, 'utf8')))) {
        checked++;
        if (!IMPLEMENTED.has(name)) missing.push(`${label} declares format '${name}'`);
      }
    }
    assert.deepStrictEqual(missing, [],
      'a format nobody implements is a keyword that silently accepts everything');
    // the gate is only worth anything if it looked at something
    assert.ok(checked > 0, 'no format keyword was found in any shipped schema');
  });

  it('every format name in the JavaScript-defined schemas is implemented', function () {
    // shipped schemas are not all files: the ai ledger's live in a module
    for (const [kind, schema] of Object.entries(LEDGER_SCHEMAS)) {
      for (const name of formatNames(schema)) {
        assert.ok(IMPLEMENTED.has(name), `the ${kind} schema declares unimplemented '${name}'`);
      }
      assert.doesNotThrow(() => strict().compile(schema),
        `the ${kind} schema does not compile with every format asserted`);
    }
  });

  it('the grammars really do declare json-path, and it really does bite', function () {
    // the concrete case this file was written for: an assertion that
    // would have failed for as long as the grammars existed
    const query = JSON.parse(readFileSync(
      join(ROOT, 'packages/json/schemas/jaren-query.schema.json'), 'utf8'));
    assert.ok(formatNames(query).has('json-path'), 'the query grammar declares format: json-path');
    const validate = strict().compile({ type: 'string', format: 'json-path' });
    assert.strictEqual(validate('$.store.book[0].title'), true);
    assert.strictEqual(validate('not a path'), false,
      'an unregistered format would have accepted this');
  });

  it('and an unimplemented name is what the gate would catch', function () {
    // proving the gate can fail: the same walk over a schema naming a
    // format nobody implements
    const invented = { type: 'object', properties: { x: { type: 'string', format: 'not-a-real-format' } } };
    const names = [...formatNames(invented)];
    assert.deepStrictEqual(names, ['not-a-real-format']);
    assert.ok(!IMPLEMENTED.has(names[0]));
    assert.throws(() => strict().compile(invented), /Unknown format 'not-a-real-format'/);
  });
});
