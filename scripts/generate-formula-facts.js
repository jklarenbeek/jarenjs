//@ts-check
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
/** Formula results derive from the measured runner and unchanged adoption freeze. */
export const formulaFacts = {
  name: 'formula measurements',
  docs: () => ['benchmark/README.md', 'packages/json/docs/FORMULA-FORMAT.md', 'packages/json/docs/QUERY-FORMAT.md'],
  facts: () => ({ 'format-number.intl': () => {
    // $format-number against Intl.NumberFormat: the committed runner's own result
    const result = JSON.parse(readFileSync(new URL('../benchmark/format-number-result.json', import.meta.url), 'utf8'));
    const hash = createHash('sha256').update(readFileSync(new URL('../benchmark/format-number.js', import.meta.url))).digest('hex');
    if (result.runnerHash !== hash) throw new Error('format-number agreement runner drift: rerun node benchmark/format-number.js --write');
    const n = (/** @type {number} */ v) => v.toLocaleString('en-US');
    return `${n(result.disagreements)} of ${n(result.values)} values (${n(result.sampled)} sampled with seed ${result.seed}, `
      + `${n(result.edges)} edge cases) differ from Intl.NumberFormat('${result.locale}', ${result.currency}) on ICU `
      + `${result.runtime.icu} (CLDR ${result.runtime.cldr})`;
  },
  'formula.measurements': () => {
    const result = JSON.parse(readFileSync(new URL('../benchmark/formula-result.json', import.meta.url), 'utf8'));
    const manifest = JSON.parse(readFileSync(new URL('../test/adoption/manifest.json', import.meta.url), 'utf8'));
    const hash = createHash('sha256').update(readFileSync(new URL('../benchmark/formulas.js', import.meta.url))).digest('hex');
    if (result.freezeHash !== manifest.freezeHash || result.runnerHash !== hash) throw new Error('Formula measurement fixture/runner drift');
    const ms = (n) => n.toFixed(2);
    return `\n\nMeasured on ${result.runtime.node}, ${result.runtime.platform}/${result.runtime.arch}, ${result.runtime.cpu}.\n\n`
      + '| Consumer | Rows | Static arithmetic ms | Native formula ms | Added cost ratio | Errors | Page rows | Heap / RSS MiB |\n'
      + '|---|---:|---:|---:|---:|---:|---:|---|\n'
      + result.consumers.map((r) => `| ${r.consumer} | ${r.rows} | ${ms(r.baselineMs)} | ${ms(r.evaluationMs)} | ${ms(r.overhead)}x | ${r.errors} | ${r.pageRows} | ${ms(r.sampledHeapBytes / 1048576)} / ${ms(r.rssBytes / 1048576)} |`).join('\n')
      + `\n\nSources: ${result.sources.originals} preserved, ${result.sources.translated} translated (${result.sources.withDifferences} with named differences), ${result.sources.untranslatable} untranslatable, ${result.sources.disabled} disabled. Original byte changes: ${result.sources.originalByteChanges}; repeat migration changes: ${result.sources.secondChanges}. Preview writes: ${result.command.previewWrites}; replay writes/revisions: ${result.command.secondWrites}/${result.command.secondRevisions}.\n\n${result.scope}\n\n`;
  } }),
};
