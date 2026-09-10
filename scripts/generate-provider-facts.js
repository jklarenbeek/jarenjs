//@ts-check
import { readFileSync } from 'node:fs';

/** Measured provider behavior and resource costs through the shared derivation gate. */
export const providerFacts = {
  name: 'provider measurements',
  docs: () => ['benchmark/README.md', 'packages/contract/docs/PROVIDER-FORMAT.md'],
  facts: () => ({
    'providers.measurements': () => {
      const result = JSON.parse(readFileSync(new URL('../benchmark/providers-result.json', import.meta.url), 'utf8'));
      const manifest = JSON.parse(readFileSync(new URL('../test/adoption/manifest.json', import.meta.url), 'utf8'));
      if (result.freezeHash !== manifest.freezeHash) throw new Error('Provider measurements use a different fixture freeze');
      const ms = (value) => value.toFixed(2);
      return `\n\nMeasured on ${result.runtime.node}, ${result.runtime.platform}/${result.runtime.arch}, ${result.runtime.cpu}.\n\n`
        + '| Consumer | Rows | Requests / budget | Response bytes / budget | Retained reader ms | Native ingestion ms | Second writes / revisions | Teardown ms / remaining resources | Sampled heap / RSS MiB |\n'
        + '|---|---:|---|---|---:|---:|---|---|---|\n'
        + result.consumers.map((entry) => {
          const n = entry.native, budget = manifest.consumers.find((c) => c.id === entry.consumer).budgets.providers;
          return `| ${entry.consumer} | ${n.rows} | ${n.requests} / ${budget.pages} | ${n.bytes} / ${budget.bytes} | ${ms(entry.reference.elapsedMs)} | ${ms(n.elapsedMs)} | ${n.secondWrites} / ${n.secondRevisions} | ${ms(n.teardownMs)} / ${n.remainingHandles} | ${ms(n.sampledHeapBytes / 1048576)} / ${ms(n.rssBytes / 1048576)} |`;
        }).join('\n') + `\n\n${result.scope}\n\n`;
    },
  }),
};
