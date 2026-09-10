//@ts-check
import { readFileSync } from 'node:fs';
/** Public lexical costs and compatibility derive from the frozen consumer measurements. */
export const lexicalFacts = { name: 'lexical measurements', docs: () => ['benchmark/README.md', 'packages/core/docs/SEARCH.md'], facts: () => ({
  'lexical.measurements': () => {
    const result = JSON.parse(readFileSync(new URL('../benchmark/lexical-result.json', import.meta.url), 'utf8'));
    const manifest = JSON.parse(readFileSync(new URL('../test/adoption/manifest.json', import.meta.url), 'utf8'));
    if (result.freezeHash !== manifest.freezeHash) throw new Error('Lexical measurements use another fixture freeze');
    const ms = n => n.toFixed(2), mib = n => (n / 1048576).toFixed(2);
    return `\n\nMeasured on ${result.runtime.node}, ${result.runtime.platform}/${result.runtime.arch}, ${result.runtime.cpu}.\n\n`
      + '| Consumer / engine | Rows | Cold / warm ms | Query p95 ms | One update ms | Snapshot gzip bytes | Sampled heap / RSS high-water MiB | V8 heap ceiling MiB |\n'
      + '|---|---:|---|---:|---:|---:|---|---:|\n'
      + result.consumers.flatMap(c => ['reference', 'native'].map(engine => {
        const r = c[engine], s = r.metrics.search, m = r.metrics.resources;
        return `| ${c.consumer} / ${engine} | ${c.rows} | ${ms(s.coldIndexMs)} / ${ms(s.warmIndexMs)} | ${ms(s.queryMs)} | ${ms(r.incrementalMs)} | ${r.snapshotGzipBytes} | ${mib(m.sampledHeapBytes)} / ${mib(m.peakRssBytes)} | ${mib(m.peakHeapBytes)} |`;
      })).join('\n')
      + '\n\n| Consumer | Native logical index MiB | Peak update accounted MiB | Native teardown ms / remaining handles | Membership / order / score / native reload differences | Reference reload tie changes |\n'
      + '|---|---:|---:|---|---|---:|\n'
      + result.consumers.map(c => `| ${c.consumer} | ${mib(c.native.metrics.search.indexBytes)} | ${mib(c.native.peakAccountedBytes)} | ${ms(c.native.metrics.resources.teardownMs)} / ${c.native.metrics.resources.remainingHandles} | ${['missingOrExtra', 'order', 'score', 'nativeReload'].map(k => c.differences.reduce((n, d) => n + d[k], 0)).join(' / ')} | ${c.differences.reduce((n, d) => n + d.referenceReloadTies, 0)} |`).join('\n')
      + `\n\nBrowser gzip: native ${result.consumers[0].native.metrics.search.browserGzipBytes} bytes; reference ${result.consumers[0].reference.metrics.search.browserGzipBytes} bytes.\n\n`
      + result.scope + '\n\nNative build, reload and update costs exceed the reference; source-bound snapshots compress better. Cold tie compatibility deliberately differs from reference reload ordering. These synthetic results qualify the named bounded host, not downstream relevance or universal latency.\n\n';
  },
}) };
