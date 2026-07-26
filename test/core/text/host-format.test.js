//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isValidIRI,
  isValidIRIRef,
  isValidIdnHostname,
} from '@jarenjs/core/text';

/**
 * The official JSON-Schema-Test-Suite format cases for the three host
 * grammars with the most room to drift, run against the testers directly
 * — see `fixtures/format-suite/PROVENANCE.md` for why not through a
 * schema.
 */
const load = (name) => JSON.parse(
  readFileSync(new URL(`./fixtures/format-suite/${name}.json`, import.meta.url), 'utf8'));

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

describe('official format suite — iri', function () {
  it('agrees with every case', function () {
    const checked = runSuite(load('iri'), isValidIRI);
    assert.ok(checked >= 9, `expected the vendored suite to carry cases, got ${checked}`);
  });
});

describe('official format suite — iri-reference', function () {
  it('agrees with every case', function () {
    const checked = runSuite(load('iri-reference'), isValidIRIRef);
    assert.ok(checked >= 7, `expected the vendored suite to carry cases, got ${checked}`);
  });
});

describe('official format suite — idn-hostname', function () {
  it('agrees with every case', function () {
    const checked = runSuite(load('idn-hostname'), isValidIdnHostname);
    assert.ok(checked >= 50, `expected the vendored suite to carry cases, got ${checked}`);
  });
});

describe('IRI and IRI-reference agree with each other', function () {
  it('accepts every IRI as an IRI-reference', function () {
    // IRI-reference = IRI / irelative-ref, so the reference grammar is a
    // superset by construction. Two scanners share one production table,
    // and this is what catches them drifting apart.
    for (const groups of [load('iri'), load('iri-reference')]) {
      for (const group of groups) {
        for (const t of group.tests) {
          if (typeof t.data !== 'string' || !isValidIRI(t.data)) continue;
          assert.ok(isValidIRIRef(t.data),
            `${JSON.stringify(t.data)} is an IRI but not an IRI-reference`);
        }
      }
    }
  });
});
