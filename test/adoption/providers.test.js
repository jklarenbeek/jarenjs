//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readAdoption } from './evidence.js';
import { readProviderTranscript } from './provider-oracle.js';
import { compileJsonQuery } from '@jarenjs/json/query';

const fixture = readAdoption('fixtures/providers.json');
// These are application declarations run through the existing query compiler,
// not a second authority service or an external-effect reconciler.
const sameDestination = compileJsonQuery({ $eq: ['$.validated', '$.current'] });
const mayResend = compileJsonQuery({ $eq: ['$.certainty', 'not-applied'] });

describe('offline provider dialects and interrupted legs', () => {
  for (const dialect of fixture.dialects) {
    it(`${dialect.id}: lossless envelopes, partial pagination and independent authority`, () => {
      const before = JSON.stringify(dialect);
      const full = readProviderTranscript(dialect);
      assert.deepEqual(full.ids, dialect.expectedIds);
      assert.deepEqual(full.pages, dialect.pages);
      const partial = readProviderTranscript(dialect, dialect.partialAfter);
      assert.equal(partial.state, 'incomplete');
      assert.equal(partial.publishable, fixture.expected.partialPublication);
      assert.ok(partial.ids.length < full.ids.length);
      assert.equal(sameDestination(dialect.destination), false);
      assert.equal(sameDestination({ validated: dialect.destination.current, current: dialect.destination.current }), true);
      assert.deepEqual(readProviderTranscript(dialect), full);
      assert.equal(JSON.stringify(dialect), before);
    });
    it(`${dialect.id}: a lost response does not prove a safe resend`, () => {
      assert.equal(dialect.effect.sent, 1);
      assert.equal(mayResend({ certainty: dialect.effect.expected }), false);
      assert.equal(dialect.effect.allowedResends, 0);
      assert.equal(mayResend({ certainty: 'not-applied' }), true);
    });
  }
  it('GraphQL partial errors remain incomplete even at the last cursor', () => {
    const result = readProviderTranscript(fixture.dialects[1]);
    assert.equal(result.state, fixture.expected.partialGraphql);
    assert.equal(result.publishable, false);
  });
});
