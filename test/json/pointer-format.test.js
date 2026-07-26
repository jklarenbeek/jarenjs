//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isValidJSONPointer,
  isValidRelativeJSONPointer,
  parseJSONPointer,
  parseRelativeJSONPointer,
} from '@jarenjs/json';

/**
 * The official JSON-Schema-Test-Suite format cases for `json-pointer` and
 * `relative-json-pointer`, run against the testers directly — see
 * `fixtures/pointer-format/PROVENANCE.md` for why not through a schema.
 *
 * This is the only *official* conformance oracle either grammar has; RFC 6901
 * ships a worked example table (covered in `pointer.test.js`) but no suite.
 */
const load = (name) => JSON.parse(
  readFileSync(new URL(`./fixtures/pointer-format/${name}.json`, import.meta.url), 'utf8'));

/** Format testers only constrain strings; every other type is valid. */
const runSuite = (groups, tester) => {
  let checked = 0;
  for (const group of groups) {
    for (const t of group.tests) {
      if (typeof t.data !== 'string') continue;
      assert.equal(tester(t.data), t.valid,
        `${group.description} / ${t.description}: ${JSON.stringify(t.data)}`);
      checked++;
    }
  }
  return checked;
};

describe('official format suite — json-pointer', function () {
  const groups = load('json-pointer');

  it('agrees with every case', function () {
    const checked = runSuite(groups, isValidJSONPointer);
    assert.ok(checked >= 30, `expected the vendored suite to carry cases, got ${checked}`);
  });

  it('keeps the parser and the format tester on the same grammar', function () {
    // Two independent implementations of one grammar: `basic.js` decides the
    // format, `pointer.js` parses. A case they disagree on is a bug in one of
    // them, and nothing else in the suite would catch the drift.
    for (const group of groups) {
      for (const t of group.tests) {
        if (typeof t.data !== 'string') continue;
        let parsed = true;
        try { parseJSONPointer(t.data); }
        catch { parsed = false; }
        assert.equal(parsed, isValidJSONPointer(t.data),
          `parser and tester disagree on ${JSON.stringify(t.data)}`);
      }
    }
  });
});

describe('official format suite — relative-json-pointer', function () {
  const groups = load('relative-json-pointer');

  it('agrees with every case', function () {
    const checked = runSuite(groups, isValidRelativeJSONPointer);
    assert.ok(checked >= 12, `expected the vendored suite to carry cases, got ${checked}`);
  });

  it('keeps the parser and the format tester on the same grammar', function () {
    for (const group of groups) {
      for (const t of group.tests) {
        if (typeof t.data !== 'string') continue;
        let parsed = true;
        try { parseRelativeJSONPointer(t.data); }
        catch { parsed = false; }
        assert.equal(parsed, isValidRelativeJSONPointer(t.data),
          `parser and tester disagree on ${JSON.stringify(t.data)}`);
      }
    }
  });

  it('rejects the index-manipulation form the suite still calls invalid', function () {
    // draft-bhutton-relative-json-pointer-00 adds `0+1`/`1-1`; the official
    // suite has not followed, so accepting them would fail conformance. When
    // the suite moves, this test is the thing that should fail first.
    for (const p of ['+1/foo/bar', '0+1', '1-1', '0+1#']) {
      assert.equal(isValidRelativeJSONPointer(p), false, p);
      assert.throws(() => parseRelativeJSONPointer(p), { name: 'JSONPointerSyntaxError' }, p);
    }
  });
});
