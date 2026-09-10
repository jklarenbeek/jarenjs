//@ts-check
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
/** Durable composition costs derived from the committed measurement and fixed limits. */
export const durableFacts = {
  name: 'durable measurements',
  docs: () => ['benchmark/README.md', 'packages/contract/docs/DURABLE.md'],
  facts: () => ({ 'durable.measurements': () => {
    const result = JSON.parse(readFileSync(new URL('../benchmark/durable-result.json', import.meta.url), 'utf8'));
    const manifest = readFileSync(new URL('../test/durable/manifest.json', import.meta.url));
    if (result.freezeHash !== createHash('sha256').update(manifest).digest('hex')) throw new Error('Durable measurement fixture drift');
    const ms = (n) => n.toFixed(2);
    return `\n\nMeasured on ${result.runtime.node}, ${result.runtime.platform}/${result.runtime.arch}, ${result.runtime.cpu}.\n\n`
      + '| Commands | Domain/outbox ms | Durable command ms | Receipt replay ms | Added cost ratio | Sends / unresolved resends | Second writes / revisions | Events | Heap / RSS MiB | Teardown ms / resources |\n'
      + '|---:|---:|---:|---:|---:|---|---|---:|---|---|\n'
      + result.consumers.map((r) => `| ${r.commands} | ${ms(r.baselineMs)} | ${ms(r.commandMs)} | ${ms(r.replayMs)} | ${ms(r.commandMs / r.baselineMs)}x | ${r.sends} / ${r.unresolvedResends} | ${r.secondWrites} / ${r.secondRevisions} | ${r.events} | ${ms(r.sampledHeapBytes / 1048576)} / ${ms(r.rssBytes / 1048576)} | ${ms(r.teardownMs)} / ${r.remainingResources} |`).join('\n')
      + `\n\n${result.scope}\n\n`;
  } }),
};
