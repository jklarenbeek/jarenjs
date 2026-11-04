//@ts-check
/**
 * Every example under every choice of every option select runs, through
 * the same boundary the page runs it with: an engine says what a switch
 * does to the source (a chart definition converted, a patch re-expressed,
 * a kernel's own example loaded), so an option never leaves a source the
 * new choice cannot read. The one exception is the lesson: a stricter
 * dialect shown the text its looser one accepts refuses it, and says why.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createPlayComponent } from '@jarenjs/play/component';
import { loadExample, switchPlayOption, runPlay } from '../../packages/website/src/boundaries/play.js';

const play = createPlayComponent();

/** The switches that refuse on purpose: what the stricter dialect refuses, as it says it. */
const LESSONS = new Map([
  ['josl-citizens mode=toml', /TOML has no null/],
  ['josl-records mode=toml', /root arrays \(\[\[\]\]\) are a JOSL extension/],
  ['jsonx-citizens mode=json', /JSONX1008/],
  ['jsonx-bigint mode=json', /JSONX1008/],
  ['csv-repair repair=strict', /CSV1002/],
]);

describe('play option switches', () => {
  it('leave every example a source its new choice runs, the stricter dialects\' lessons aside', async () => {
    let runs = 0;
    /** @type {string[]} */
    const failing = [];
    /** @type {Set<string>} */
    const taught = new Set();
    for (const example of play.examples) {
      for (const pane of play.engines[example.engine].optionPanes ?? []) {
        for (const { value } of pane.choices) {
          const slice = { ...loadExample(example.id), dataView: 'json', dataValue: null };
          const result = await runPlay({ ...slice, ...switchPlayOption(slice, pane.key, value) });
          runs++;
          const name = `${example.id} ${pane.key}=${value}`;
          const lesson = LESSONS.get(name);
          if (lesson !== undefined) {
            assert.strictEqual(result.ok, false, `${name} teaches a refusal`);
            assert.match(`${result.error?.code ?? ''} ${result.error?.message}`, lesson, name);
            taught.add(name);
          }
          else if (!result.ok) failing.push(`${name}: ${result.error?.message}`);
        }
      }
    }
    assert.deepStrictEqual(failing, []);
    assert.deepStrictEqual([...taught].sort(), [...LESSONS.keys()].sort());
    assert.ok(runs > 300, `every choice ran (${runs})`);
  });

  it('switching back undoes a conversion: the chart definition and the patch return as they were', async () => {
    for (const [id, key, away] of /** @type {const} */ ([['charts-heatmap', 'format', 'josl'], ['patch-merge', 'mode', 'patch']])) {
      const example = play.examples.find((e) => e.id === id);
      assert.ok(example !== undefined, id);
      const slice = { ...loadExample(id), dataView: 'json', dataValue: null };
      const there = { ...slice, ...switchPlayOption(slice, key, away) };
      const back = { ...there, ...switchPlayOption(there, key, slice.config[key] ?? play.engines[slice.engine].optionPanes[0].default) };
      const [pane] = Object.keys(slice.source);
      assert.deepStrictEqual(JSON.parse(back.source[pane]), JSON.parse(slice.source[pane]), id);
    }
  });
});
