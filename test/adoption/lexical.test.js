//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compareLexicalAnswers } from '../../benchmark/lexical-compare.js';
import { readAdoption, verifyFreeze, assessBudget } from './evidence.js';

it('lexical measurements pin their source and preserve every frozen answer and resource ceiling', () => {
  const manifest = readAdoption('manifest.json'); verifyFreeze(manifest);
  const report = JSON.parse(readFileSync(new URL('../../benchmark/lexical-result.json', import.meta.url), 'utf8'));
  assert.equal(report.freezeHash, manifest.freezeHash); assert.equal(report.format, 'lexical-measurements/1');
  assert.equal(Object.keys(report.sourceHashes).length, 8);
  for (const [file, hash] of Object.entries(report.sourceHashes))
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../../${file}`, import.meta.url))).digest('hex'), hash, `Re-measure changed lexical source: ${file}`);
  for (const consumer of manifest.consumers) {
    const measured = report.consumers.find(c => c.consumer === consumer.id);
    assert.equal(measured.rows, consumer.rows);
    assert.equal(measured.differences.length, readAdoption('fixtures/search.json').queries.length);
    for (const diff of measured.differences) for (const key of ['missingOrExtra', 'order', 'score', 'nativeReload']) assert.equal(diff[key], 0, `${consumer.id} ${diff.query} ${key}`);
    for (const name of ['search', 'resources']) {
      const assessment = assessBudget(consumer.budgets[name], measured.native.metrics[name]);
      assert.deepEqual(assessment, measured.budgets[name]);
      assert.ok(assessment.every(metric => metric.status === 'pass'), JSON.stringify(assessment));
    }
  }
});

it('lexical evidence refuses missing reload tails, nonfinite scores and substituted members', () => {
  const expected = [{ id: 'a', score: 1 }, { id: 'b', score: 1 }];
  assert.equal(compareLexicalAnswers('tea', expected, expected, expected, []).nativeReload, 2);
  assert.ok(compareLexicalAnswers('tea', expected, expected, expected, expected.slice(0, 1)).nativeReload > 0);
  assert.equal(compareLexicalAnswers('tea', expected, [{ id: 'x', score: NaN }], expected, []).missingOrExtra, 3);
  assert.ok(compareLexicalAnswers('tea', expected, [{ id: 'x', score: NaN }], expected, []).score > 0);
});
