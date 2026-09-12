//@ts-check
import { WORKER_DEFAULTS, PROCESS_DEFAULTS } from '../packages/db/src/drivers/worker-protocol.js';

/** Execution credit tables derive from the same defaults the hosts validate. */
export const executionFacts = {
  name: 'execution host defaults',
  docs: () => ['packages/db/docs/HOSTS.md'],
  facts: () => ({
    'db.execution-options': () => '\n\n| Option | Thread worker | Process owner |\n|---|---:|---:|\n'
      + Object.keys(PROCESS_DEFAULTS).map((name) => `| \`${name}\` | ${WORKER_DEFAULTS[name] ?? '—'} | ${PROCESS_DEFAULTS[name]} |`).join('\n') + '\n\n',
  }),
};
