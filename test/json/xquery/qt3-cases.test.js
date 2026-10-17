import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveCaseEnvironment, runCase } from '../../../benchmark/qt3-runner.js';

// Cases of the W3C QT3 suite, vendored with their environments (see the
// fixture's PROVENANCE.md): each must pass through the QT3 harness exactly
// as the scorecard runs it.
const cases = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'qt3-cases', 'cases.json'), 'utf8'));

describe('QT3 cases the front-end answers', () => {
  for (const testCase of cases) {
    it(`${testCase.set} ${testCase.name}`, () => {
      const resolved = resolveCaseEnvironment(testCase.environment);
      assert.ok(resolved.environment !== undefined, `environment: ${resolved.reason}`);
      const verdict = runCase(testCase, resolved.environment);
      assert.deepStrictEqual(verdict, { verdict: 'pass' }, testCase.test);
    });
  }
});
